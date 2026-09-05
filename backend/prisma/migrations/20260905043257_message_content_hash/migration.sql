-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "contentHash" VARCHAR(64);

-- CreateIndex
CREATE INDEX "Message_sessionId_forUserId_role_contentHash_idx" ON "Message"("sessionId", "forUserId", "role", "contentHash");
