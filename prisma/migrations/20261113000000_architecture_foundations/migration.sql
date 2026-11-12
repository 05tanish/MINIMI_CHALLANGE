ALTER TABLE "ResearchClaim" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'memory';
ALTER TABLE "ResearchClaim" ADD COLUMN "evidenceKey" TEXT;
ALTER TABLE "ResearchClaim" ADD COLUMN "userId" TEXT;
ALTER TABLE "ResearchClaim" ADD COLUMN "conversationId" TEXT;
-- Legacy claims without a message or source have no safe tenant owner.
-- Remove those orphaned rows rather than assigning a synthetic user that
-- would violate tenant isolation and the User foreign key.
DELETE FROM "ResearchClaim" rc
WHERE NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."id" = rc."messageId")
  AND NOT EXISTS (SELECT 1 FROM "ResearchSource" s WHERE s."id" = rc."sourceId");
UPDATE "ResearchClaim" rc SET
  "conversationId" = COALESCE(
    (SELECT m."conversationId" FROM "Message" m WHERE m."id" = rc."messageId"),
    (SELECT s."conversationId" FROM "ResearchSource" s WHERE s."id" = rc."sourceId")
  ),
  "userId" = COALESCE(
    (SELECT c."userId" FROM "Conversation" c WHERE c."id" = COALESCE(
      (SELECT m."conversationId" FROM "Message" m WHERE m."id" = rc."messageId"),
      (SELECT s."conversationId" FROM "ResearchSource" s WHERE s."id" = rc."sourceId")
    )),
    NULL
  );
UPDATE "ResearchClaim" rc SET "sourceId" = NULL
WHERE rc."sourceId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "ResearchSource" s WHERE s."id" = rc."sourceId");
UPDATE "ResearchClaim" SET "evidenceKey" = 'legacy:' || "id" WHERE "evidenceKey" IS NULL;
ALTER TABLE "ResearchClaim" ALTER COLUMN "evidenceKey" SET NOT NULL;
ALTER TABLE "ResearchClaim" ALTER COLUMN "userId" SET NOT NULL;
CREATE UNIQUE INDEX "ResearchClaim_evidenceKey_key" ON "ResearchClaim"("evidenceKey");
CREATE INDEX "ResearchClaim_userId_entityId_attribute_recordedAt_idx" ON "ResearchClaim"("userId", "entityId", "attribute", "recordedAt");
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "ResearchSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ChatTurn" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userMessageId" TEXT NOT NULL,
  "assistantMessageId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatTurn_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatTurn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ChatTurn_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ChatTurn_userMessageId_fkey" FOREIGN KEY ("userMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ChatTurn_assistantMessageId_fkey" FOREIGN KEY ("assistantMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ChatTurn_userMessageId_key" ON "ChatTurn"("userMessageId");
CREATE UNIQUE INDEX "ChatTurn_assistantMessageId_key" ON "ChatTurn"("assistantMessageId");
CREATE UNIQUE INDEX "ChatTurn_userId_idempotencyKey_key" ON "ChatTurn"("userId", "idempotencyKey");
CREATE INDEX "ChatTurn_userId_createdAt_idx" ON "ChatTurn"("userId", "createdAt");
CREATE INDEX "ChatTurn_status_updatedAt_idx" ON "ChatTurn"("status", "updatedAt");

CREATE TABLE "ChatTurnEvent" (
  "id" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatTurnEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatTurnEvent_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "ChatTurn"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ChatTurnEvent_turnId_sequence_key" ON "ChatTurnEvent"("turnId", "sequence");
CREATE INDEX "ChatTurnEvent_turnId_createdAt_idx" ON "ChatTurnEvent"("turnId", "createdAt");

CREATE TABLE "OutboxEvent" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutboxEvent_status_runAt_createdAt_idx" ON "OutboxEvent"("status", "runAt", "createdAt");
CREATE INDEX "OutboxEvent_aggregateId_status_idx" ON "OutboxEvent"("aggregateId", "status");

ALTER TABLE "Message" ADD COLUMN "searchVector" tsvector;
UPDATE "Message" SET "searchVector" = to_tsvector('simple', "content");
CREATE FUNCTION minimi_message_search_update() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', NEW."content");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Message_searchVector_update" BEFORE INSERT OR UPDATE OF "content" ON "Message"
  FOR EACH ROW EXECUTE FUNCTION minimi_message_search_update();
CREATE INDEX "Message_searchVector_idx" ON "Message" USING GIN ("searchVector");
