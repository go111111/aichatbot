import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { getChatById, saveFileChunks, saveUploadedFile } from "@/lib/db/queries";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_PARSED_TEXT_CHARS = 200_000;
const CHUNK_CHAR_LENGTH = 1200;
const CHUNK_OVERLAP_CHARS = 150;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);
const FALLBACK_CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};
const PARSEABLE_TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

function getUploadDir() {
  return (
    process.env.UPLOAD_DIR ||
    path.join(/*turbopackIgnore: true*/ process.cwd(), "uploads")
  );
}

function getContentType(file: Blob, filename: string) {
  if (ALLOWED_CONTENT_TYPES.has(file.type)) {
    return file.type;
  }

  return FALLBACK_CONTENT_TYPES_BY_EXTENSION[
    path.extname(filename).toLowerCase()
  ];
}

function parseTextContent(buffer: Buffer, contentType: string) {
  if (!PARSEABLE_TEXT_TYPES.has(contentType)) {
    return { content: null, parseStatus: "unsupported" as const };
  }

  try {
    const content = buffer.toString("utf8").slice(0, MAX_PARSED_TEXT_CHARS);
    return { content, parseStatus: "parsed" as const };
  } catch {
    return { content: null, parseStatus: "error" as const };
  }
}

function chunkTextContent(content: string) {
  const normalizedContent = content.replace(/\r\n/g, "\n").trim();

  if (!normalizedContent) {
    return [];
  }

  const chunks: Array<{ chunkIndex: number; content: string; charCount: number }> = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < normalizedContent.length) {
    const end = Math.min(start + CHUNK_CHAR_LENGTH, normalizedContent.length);
    const chunk = normalizedContent.slice(start, end).trim();

    if (chunk) {
      chunks.push({
        chunkIndex,
        content: chunk,
        charCount: chunk.length,
      });
      chunkIndex += 1;
    }

    if (end >= normalizedContent.length) {
      break;
    }

    start = Math.max(0, end - CHUNK_OVERLAP_CHARS);
  }

  return chunks;
}

const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= MAX_FILE_SIZE, {
      message: "File size should be less than 20MB",
    }),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;
    const chatId = String(formData.get("chatId") ?? "") || null;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.errors
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    const filename = (formData.get("file") as File).name;
    const contentType = getContentType(file, filename);

    if (!contentType) {
      return NextResponse.json(
        {
          error:
            "File type should be image, PDF, plain text, Markdown, CSV, or JSON",
        },
        { status: 400 }
      );
    }

    if (chatId) {
      const existingChat = await getChatById({ conversationId: chatId });

      if (existingChat && existingChat.userId !== session.user.id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    try {
      const uploadDir = getUploadDir();
      await mkdir(uploadDir, { recursive: true });

      const fileId = randomUUID();
      const protectedUrl = `/api/files/${fileId}`;
      const storedName = `${Date.now()}-${fileId}-${safeName}`;
      const targetPath = path.join(uploadDir, storedName);
      await writeFile(targetPath, fileBuffer);
      const parsed = parseTextContent(fileBuffer, contentType);
      const [savedFile] = await saveUploadedFile({
        id: fileId,
        userId: session.user.id,
        chatId,
        originalName: filename,
        storedName,
        url: protectedUrl,
        mimeType: contentType,
        size: file.size,
        content: parsed.content,
        parseStatus: parsed.parseStatus,
      });
      const chunks = parsed.content ? chunkTextContent(parsed.content) : [];

      if (chunks.length > 0) {
        await saveFileChunks({
          chunks: chunks.map((chunk) => ({
            fileId: savedFile.id,
            userId: session.user.id,
            chatId,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            charCount: chunk.charCount,
          })),
        });
      }

      return NextResponse.json({
        id: savedFile.id,
        url: protectedUrl,
        pathname: safeName,
        contentType,
        size: file.size,
        parseStatus: parsed.parseStatus,
        textPreview: parsed.content?.slice(0, 600) ?? null,
      });
    } catch (_error) {
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
  } catch (_error) {
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
