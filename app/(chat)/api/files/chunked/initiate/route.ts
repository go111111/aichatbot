import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import {
  CHUNKED_UPLOAD_CHUNK_BYTES,
  CHUNKED_UPLOAD_MAX_BYTES,
  ensureChatAccess,
  getContentType,
  getSafeFilename,
} from "@/lib/files/upload";
import { saveManifest } from "@/lib/files/chunked-upload";

const InitiateSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().optional().default(""),
  size: z.number().int().positive().max(CHUNKED_UPLOAD_MAX_BYTES),
  chatId: z.string().uuid().optional().nullable(),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = InitiateSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid upload metadata" }, { status: 400 });
  }

  const { filename, size, chatId } = parsed.data;
  const contentType = getContentType({ type: parsed.data.contentType }, filename);

  if (!contentType) {
    return NextResponse.json(
      { error: "File type should be image, PDF, plain text, Markdown, CSV, or JSON" },
      { status: 400 }
    );
  }

  const canUseChat = await ensureChatAccess({
    chatId,
    userId: session.user.id,
  });

  if (!canUseChat) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const uploadId = randomUUID();
  const totalChunks = Math.ceil(size / CHUNKED_UPLOAD_CHUNK_BYTES);

  await saveManifest({
    uploadId,
    userId: session.user.id,
    chatId: chatId ?? null,
    filename,
    safeName: getSafeFilename(filename),
    contentType,
    size,
    totalChunks,
    receivedChunks: [],
    createdAt: new Date().toISOString(),
  });

  return NextResponse.json({
    uploadId,
    chunkSize: CHUNKED_UPLOAD_CHUNK_BYTES,
    totalChunks,
  });
}
