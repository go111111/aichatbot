-- Add status tracking to messages
ALTER TABLE "Chat" ADD COLUMN "updatedAt" timestamp DEFAULT now() NOT NULL;

ALTER TABLE "Message_v2" ADD COLUMN "status" varchar DEFAULT 'done' NOT NULL;
ALTER TABLE "Message_v2" ADD COLUMN "requestId" uuid;
ALTER TABLE "Message_v2" ADD COLUMN "updatedAt" timestamp DEFAULT now() NOT NULL;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_message_chat_created 
  ON "Message_v2"("chatId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_message_chat_status 
  ON "Message_v2"("chatId", "status");

CREATE INDEX IF NOT EXISTS idx_chat_user_created 
  ON "Chat"("userId", "createdAt" DESC);

-- Add constraint for valid status values
ALTER TABLE "Message_v2" ADD CONSTRAINT check_message_status 
  CHECK (status IN ('pending', 'streaming', 'done', 'error', 'aborted'));
