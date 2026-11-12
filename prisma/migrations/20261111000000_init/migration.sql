CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "Conversation" (
  "id" TEXT PRIMARY KEY, "title" TEXT NOT NULL DEFAULT 'New conversation',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "Message" (
  "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, "role" TEXT NOT NULL,
  "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE
);
CREATE TABLE "MemoryChunk" (
  "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, "content" TEXT NOT NULL, "topic" TEXT,
  "entities" JSONB NOT NULL DEFAULT '[]', "metadata" JSONB NOT NULL DEFAULT '{}',
  "startAt" TIMESTAMP(3) NOT NULL, "endAt" TIMESTAMP(3) NOT NULL,
  "embedding" vector(768), "searchVector" tsvector,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemoryChunk_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE
);
CREATE TABLE "Entity" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "normalizedName" TEXT NOT NULL UNIQUE, "type" TEXT NOT NULL);
CREATE TABLE "EntityMention" (
  "id" TEXT PRIMARY KEY, "entityId" TEXT NOT NULL, "messageId" TEXT NOT NULL, "conversationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EntityMention_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE,
  CONSTRAINT "EntityMention_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE,
  CONSTRAINT "EntityMention_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE,
  CONSTRAINT "EntityMention_entityId_messageId_key" UNIQUE ("entityId", "messageId")
);
CREATE TABLE "ConversationSummary" (
  "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL UNIQUE, "summary" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationSummary_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE
);
CREATE TABLE "ResearchSource" (
  "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, "messageId" TEXT NOT NULL,
  "title" TEXT NOT NULL, "url" TEXT NOT NULL, "snippet" TEXT NOT NULL,
  "publishedAt" TIMESTAMP(3), "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceType" TEXT NOT NULL DEFAULT 'web', "metadata" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "ResearchSource_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE,
  CONSTRAINT "ResearchSource_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE,
  CONSTRAINT "ResearchSource_messageId_url_key" UNIQUE ("messageId", "url")
);
CREATE TABLE "ResearchClaim" (
  "id" TEXT PRIMARY KEY, "entityId" TEXT NOT NULL, "attribute" TEXT NOT NULL, "value" TEXT NOT NULL,
  "validAt" TIMESTAMP(3), "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceId" TEXT, "messageId" TEXT,
  CONSTRAINT "ResearchClaim_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE,
  CONSTRAINT "ResearchClaim_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL
);
CREATE INDEX "Conversation_updatedAt_idx" ON "Conversation"("updatedAt");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "MemoryChunk_conversationId_startAt_endAt_idx" ON "MemoryChunk"("conversationId", "startAt", "endAt");
CREATE INDEX "EntityMention_conversationId_createdAt_idx" ON "EntityMention"("conversationId", "createdAt");
CREATE INDEX "ResearchSource_conversationId_retrievedAt_idx" ON "ResearchSource"("conversationId", "retrievedAt");
CREATE INDEX "ResearchClaim_entityId_attribute_recordedAt_idx" ON "ResearchClaim"("entityId", "attribute", "recordedAt");
CREATE INDEX "MemoryChunk_searchVector_idx" ON "MemoryChunk" USING GIN ("searchVector");
CREATE INDEX "MemoryChunk_embedding_idx" ON "MemoryChunk" USING hnsw ("embedding" vector_cosine_ops);
