CREATE TABLE IF NOT EXISTS "FileChunk" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fileId" uuid NOT NULL REFERENCES "File"("id"),
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "chatId" uuid REFERENCES "Chat"("id"),
  "chunkIndex" integer NOT NULL,
  "content" text NOT NULL,
  "charCount" integer NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_chunk_file_index
  ON "FileChunk"("fileId", "chunkIndex");

CREATE INDEX IF NOT EXISTS idx_file_chunk_user_file
  ON "FileChunk"("userId", "fileId");
