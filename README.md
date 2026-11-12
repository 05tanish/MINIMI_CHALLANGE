# Minimi Context-Aware Research Agent

A conversational research app that retrieves relevant prior discussions, searches the web for current evidence, compares the two, and returns a cited answer. It uses a controlled JavaScript modular monolith rather than an open-ended tool loop.

## Features

- Persistent conversations and messages in PostgreSQL/Neon.
- Hybrid history retrieval: PostgreSQL full-text search, Gemini embeddings with pgvector, entity mentions, temporal filters and reciprocal rank fusion.
- Tavily web search with URL deduplication, timestamps, bounded concurrency and partial-failure reporting.
- Gemini answer generation streamed to a responsive React UI over SSE.
- Citation IDs validated against the search results attached to the answer.
- Zod validation, rate limits, Helmet, configurable CORS and structured Pino logs.

## Architecture

See [DESIGN.md](./DESIGN.md) for the flow diagram, database choices, temporal behavior, trade-offs and scaling notes. Originals remain in `Message`; memory chunks and embeddings are derived retrieval aids.

## Stack

Node.js ES modules, Express 5, React, Vite, Tailwind CSS, Prisma, PostgreSQL/pgvector, Gemini API, Tavily Search API, Vitest and Supertest.

## Requirements

- Node.js 20 or newer and npm.
- PostgreSQL with pgvector (local PostgreSQL or Neon).
- Gemini API key for model answers and embeddings.
- Tavily API key for web research.

The server can start without provider keys so health and setup diagnostics work; missing providers are reported rather than simulated. The chat route requires a configured database to persist the request.

## Install and configure

```sh
npm install
cp .env.example .env
```

Set `DATABASE_URL`, `GEMINI_API_KEY` and `TAVILY_API_KEY` in `.env`. The server and Prisma scripts also accept `DATABASE_URL_DEVELOPMENT` / `GEMINI_API_KEY_DEVELOPMENT` and production equivalents, selected using `NODE_ENV`; tests do not silently use the development database. Gemini text generation uses low thinking by default and can fall back across models after a bounded timeout; configure `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS` and `GEMINI_MODEL_TIMEOUT_MS` for your provider account. For Neon, use its pooled connection string for the runtime. Ensure pgvector is available to the database role before applying the migration.

## Database migrations

```sh
npm run db:generate
npm run db:migrate
```

The checked-in SQL migration creates relational tables and pgvector/full-text indexes. `prisma migrate deploy` only applies pending migrations; it does not reset or drop data. For local schema iteration, use `npm run db:migrate:dev` against a disposable development database. Back up hosted data before schema changes.

## Run locally

```sh
npm run dev
```

The frontend runs at http://localhost:5173 and the API at http://localhost:3001. Use `npm run dev:client` or `npm run dev:server` to run one service. Production static assets can be built with `npm run build`; serve `client/dist` through a static host such as Vercel and deploy the Node API on Render or another Node host.

## Tests

```sh
npm test
```

Unit tests cover routing, dates, entity extraction, chunking, RRF, citations and retries. API tests cover validation and readiness behavior. `tests/evaluation/scenarios.json` contains 20 evaluation scenarios, including all three assignment examples; these are scenario fixtures, not an automated live-provider scorecard. Database/provider integration should be run against configured services with secrets kept outside source control.

## API

- `POST /api/chat` — JSON `{ "conversationId?": "...", "message": "..." }`; responds with SSE events: `conversation`, `progress`, `delta`, `done`, or `error`.
- `GET /api/conversations?limit=20&cursor=...` — paginated history.
- `GET /api/conversations/:id` — messages and attached sources.
- `PATCH /api/conversations/:id` — rename via `{ "title": "..." }`.
- `DELETE /api/conversations/:id` — cascade-delete the conversation and dependent history.
- `GET /api/health` — app and database readiness plus provider configuration state.

Responses use `{ success, data, error }` where applicable. SSE progress names are high-level UI stages and do not expose model reasoning.

## Security status

The repository ignores environment files, local provider config, credentials, private key/keystore formats, local databases, logs, build output and common deployment state. Keep real credentials in `.env` locally and in the hosting provider's secret store after deployment. Do not commit `.env`.

The API currently has **no authentication or per-user authorization**. CORS and rate limiting do not restrict access to data: anyone who can reach the API can list, read, rename or delete conversations. Do not expose it publicly with private data until authentication and conversation ownership checks are implemented.

## Deployment

Deploy the client build to Vercel with `client` as the project root (or configure the root build command `npm run build` and output `client/dist`). Deploy the API with `npm start`, set `PORT`, `CLIENT_ORIGIN`, `DATABASE_URL`, `GEMINI_API_KEY`, `TAVILY_API_KEY` and the desired limits, then apply migrations via `npm run db:migrate`. Use a pooled Neon runtime URL and an appropriate direct URL only if your migration workflow requires it. Free-tier quotas and provider terms change; check current provider documentation before launch.

## Limitations

- There is no authentication or per-user data isolation; this is a single-workspace assignment implementation and should not be exposed publicly with private conversation data.
- Date parsing covers common phrases and nearest-past month/day behavior; it does not yet ask follow-up questions for every ambiguous date.
- Topic grouping uses contiguous extracted entity sets, not an LLM topic segmenter.
- The automated evaluation set is declarative; external-service and full database evaluation needs configured credentials and a test database.
- Streaming begins after research is complete and streams the answer generation, while the UI shows research stages first.
