ALTER TABLE "File"
  ADD COLUMN IF NOT EXISTS "status" varchar DEFAULT 'ready' NOT NULL;

ALTER TABLE "File" DROP CONSTRAINT IF EXISTS check_file_status;

ALTER TABLE "File" ADD CONSTRAINT check_file_status
  CHECK ("status" IN ('uploading', 'processing', 'ready', 'failed'));

CREATE INDEX IF NOT EXISTS idx_file_user_status_created
  ON "File"("userId", "status", "createdAt" DESC);
