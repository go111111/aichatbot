CREATE TABLE IF NOT EXISTS "File" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "chatId" uuid,
  "originalName" text NOT NULL,
  "storedName" text NOT NULL,
  "url" text NOT NULL,
  "mimeType" varchar(128) NOT NULL,
  "size" integer NOT NULL,
  "content" text,
  "parseStatus" varchar DEFAULT 'unsupported' NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_user_created
  ON "File"("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_file_chat_created
  ON "File"("chatId", "createdAt" DESC);

ALTER TABLE "File" ADD CONSTRAINT check_file_parse_status
  CHECK ("parseStatus" IN ('parsed', 'unsupported', 'error'));
