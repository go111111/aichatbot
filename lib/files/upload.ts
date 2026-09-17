/**
 * 上传入库：解析（PDF / 文本 / OCR）→ File 行 → chunkTextContent → FileChunk 行。
 * url 一律 /api/files/{id}，禁止暴露 uploads 静态直链。
 * chatId 传 null 时写入用户知识库；传会话 id 时为聊天附件。
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  getChatById,
  saveFileChunks,
  saveUploadedFile,
} from "@/lib/db/queries";
import { getUploadDir } from "./storage";

export { getUploadDir };

/** ≤20MB 直传；20–100MB 走 lib/files/chunked-upload.ts 分片合并后再调 persistUploadedFile */
export const STANDARD_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const CHUNKED_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const CHUNKED_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

const MAX_PARSED_TEXT_CHARS = 200_000;
const MAX_TEXT_PARSE_BYTES = MAX_PARSED_TEXT_CHARS * 4;
const CHUNK_CHAR_LENGTH = 1200;
const MIN_SEMANTIC_CHUNK_CHARS = 600;
const CHUNK_OVERLAP_CHARS = 150;
const SEMANTIC_BOUNDARY_MARKERS = [
  "\n\n",
  "\n",
  "\u3002",
  "\uff01",
  "\uff1f",
  ".",
  "!",
  "?",
  ";",
  "\uff1b",
  "\uff0c",
  ",",
];

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

const PARSEABLE_PDF_TYPES = new Set(["application/pdf"]);
const OCR_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const OCR_LANGUAGES = process.env.OCR_LANGUAGES || "eng+chi_sim";
const OCR_LANG_PATH = process.env.OCR_LANG_PATH;
const IMAGE_OCR_MAX_BYTES = getPositiveIntegerEnv(
  "IMAGE_OCR_MAX_BYTES",
  5 * 1024 * 1024
);
const IMAGE_OCR_TIMEOUT_MS = getPositiveIntegerEnv(
  "IMAGE_OCR_TIMEOUT_MS",
  15_000
);

export function getContentType(input: { type?: string }, filename: string) {
  if (input.type && ALLOWED_CONTENT_TYPES.has(input.type)) {
    return input.type;
  }

  return FALLBACK_CONTENT_TYPES_BY_EXTENSION[
    path.extname(filename).toLowerCase()
  ];
}

export function getSafeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getOcrCacheDir() {
  return path.join(getUploadDir(), ".cache", "tesseract");
}

function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function ensureChatAccess({
  chatId,
  userId,
}: {
  chatId?: string | null;
  userId: string;
}) {
  if (!chatId) {
    return true;
  }

  const existingChat = await getChatById({ conversationId: chatId });
  return !existingChat || existingChat.userId === userId;
}

function normalizeParsedText(content: string) {
  return content.replace(/\r\n/g, "\n").trim().slice(0, MAX_PARSED_TEXT_CHARS);
}

function parseTextContent(buffer: Buffer) {
  try {
    const content = normalizeParsedText(buffer.toString("utf8"));
    return content
      ? { content, parseStatus: "parsed" as const }
      : { content: null, parseStatus: "unsupported" as const };
  } catch {
    return { content: null, parseStatus: "error" as const };
  }
}

async function readWholeUpload({
  buffer,
  filePath,
}: {
  buffer?: Buffer;
  filePath?: string;
}) {
  if (buffer) {
    return buffer;
  }

  if (!filePath) {
    return null;
  }

  return readFile(filePath);
}

async function getUploadByteLength({
  buffer,
  filePath,
}: {
  buffer?: Buffer;
  filePath?: string;
}) {
  if (buffer) {
    return buffer.byteLength;
  }

  if (!filePath) {
    return 0;
  }

  const fileStats = await stat(filePath);
  return fileStats.size;
}

function withTimeout<T>({
  promise,
  timeoutMs,
  timeoutMessage,
}: {
  promise: Promise<T>;
  timeoutMs: number;
  timeoutMessage: string;
}) {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

async function parsePdfContent({
  buffer,
  filePath,
}: {
  buffer?: Buffer;
  filePath?: string;
}) {
  try {
    const data = await readWholeUpload({ buffer, filePath });

    if (!data) {
      return { content: null, parseStatus: "error" as const };
    }

    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data });

    try {
      const result = await parser.getText();
      const content = normalizeParsedText(result.text ?? "");

      return content
        ? { content, parseStatus: "parsed" as const }
        : { content: null, parseStatus: "unsupported" as const };
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    console.error("Failed to parse PDF upload", error);
    return { content: null, parseStatus: "error" as const };
  }
}

async function parseImageContent({
  buffer,
  filePath,
}: {
  buffer?: Buffer;
  filePath?: string;
}) {
  try {
    const byteLength = await getUploadByteLength({ buffer, filePath });

    if (byteLength > IMAGE_OCR_MAX_BYTES) {
      return { content: null, parseStatus: "unsupported" as const };
    }

    const image = filePath ?? buffer;

    if (!image) {
      return { content: null, parseStatus: "error" as const };
    }

    const { recognize } = await import("tesseract.js");
    const cachePath = getOcrCacheDir();
    await mkdir(cachePath, { recursive: true });
    const result = await withTimeout({
      promise: recognize(image, OCR_LANGUAGES, {
        cachePath,
        ...(OCR_LANG_PATH ? { langPath: OCR_LANG_PATH } : {}),
        logger: () => undefined,
      }),
      timeoutMs: IMAGE_OCR_TIMEOUT_MS,
      timeoutMessage: "Image OCR timed out",
    });
    const content = normalizeParsedText(result.data.text ?? "");

    return content
      ? { content, parseStatus: "parsed" as const }
      : { content: null, parseStatus: "unsupported" as const };
  } catch (error) {
    console.error("Failed to OCR image upload", error);
    return { content: null, parseStatus: "error" as const };
  }
}

export async function parseUploadContent({
  contentType,
  buffer,
  filePath,
}: {
  contentType: string;
  buffer?: Buffer;
  filePath?: string;
}) {
  if (PARSEABLE_PDF_TYPES.has(contentType)) {
    return parsePdfContent({ buffer, filePath });
  }

  if (OCR_IMAGE_TYPES.has(contentType)) {
    return parseImageContent({ buffer, filePath });
  }

  if (!PARSEABLE_TEXT_TYPES.has(contentType)) {
    return { content: null, parseStatus: "unsupported" as const };
  }

  if (buffer) {
    return parseTextContent(buffer);
  }

  if (!filePath) {
    return { content: null, parseStatus: "error" as const };
  }

  try {
    const fileHandle = await open(filePath, "r");

    try {
      const contentBuffer = Buffer.alloc(MAX_TEXT_PARSE_BYTES);
      const { bytesRead } = await fileHandle.read(
        contentBuffer,
        0,
        MAX_TEXT_PARSE_BYTES,
        0
      );
      return parseTextContent(contentBuffer.subarray(0, bytesRead));
    } finally {
      await fileHandle.close();
    }
  } catch {
    return { content: null, parseStatus: "error" as const };
  }
}

/** 定长约 1200 字 + 在句号/换行等边界切分 + 150 字 overlap，供 RAG 检索 */
export function chunkTextContent(content: string) {
  const normalizedContent = content.replace(/\r\n/g, "\n").trim();

  if (!normalizedContent) {
    return [];
  }

  const chunks: Array<{
    chunkIndex: number;
    content: string;
    charCount: number;
  }> = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < normalizedContent.length) {
    const hardEnd = Math.min(start + CHUNK_CHAR_LENGTH, normalizedContent.length);
    const end =
      hardEnd >= normalizedContent.length
        ? hardEnd
        : findSemanticChunkEnd(normalizedContent, start, hardEnd);
    const chunk = normalizedContent.slice(start, end).trim();

    if (chunk) {
      chunks.push({
        chunkIndex,
        content: chunk,
        charCount: chunk.length,
      });
      chunkIndex += 1;
    }

    if (hardEnd >= normalizedContent.length) {
      break;
    }

    start = Math.max(0, end - CHUNK_OVERLAP_CHARS);
  }

  return chunks;
}

function findSemanticChunkEnd(content: string, start: number, hardEnd: number) {
  const minEnd = Math.min(start + MIN_SEMANTIC_CHUNK_CHARS, hardEnd);
  let bestEnd = -1;

  for (const marker of SEMANTIC_BOUNDARY_MARKERS) {
    const boundaryIndex = content.lastIndexOf(marker, hardEnd);
    const candidateEnd = boundaryIndex + marker.length;

    if (boundaryIndex >= minEnd && candidateEnd > bestEnd) {
      bestEnd = candidateEnd;
    }
  }

  return bestEnd > start ? bestEnd : hardEnd;
}

/** 解析完成后写 File；成功解析则同步写入 FileChunk（无异步队列） */
export async function persistUploadedFile({
  userId,
  chatId,
  originalName,
  storedName,
  contentType,
  size,
  buffer,
  filePath,
}: {
  userId: string;
  chatId?: string | null;
  originalName: string;
  storedName: string;
  contentType: string;
  size: number;
  buffer?: Buffer;
  filePath?: string;
}) {
  const parsed = await parseUploadContent({ contentType, buffer, filePath });
  const fileId = randomUUID();
  const protectedUrl = `/api/files/${fileId}`;
  const status = parsed.parseStatus === "error" ? "failed" : "ready";
  const [savedFile] = await saveUploadedFile({
    id: fileId,
    userId,
    chatId,
    originalName,
    storedName,
    url: protectedUrl,
    mimeType: contentType,
    size,
    content: parsed.content,
    parseStatus: parsed.parseStatus,
    status,
  });
  const chunks = parsed.content ? chunkTextContent(parsed.content) : [];

  if (chunks.length > 0) {
    await saveFileChunks({
      chunks: chunks.map((chunk) => ({
        fileId: savedFile.id,
        userId,
        chatId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        charCount: chunk.charCount,
      })),
    });
  }

  return {
    id: savedFile.id,
    url: protectedUrl,
    pathname: getSafeFilename(originalName),
    contentType,
    size,
    status: savedFile.status,
    parseStatus: parsed.parseStatus,
    textPreview: parsed.content?.slice(0, 600) ?? null,
  };
}

export async function writeUploadedBuffer({
  storedName,
  buffer,
}: {
  storedName: string;
  buffer: Buffer;
}) {
  const uploadDir = getUploadDir();
  await mkdir(uploadDir, { recursive: true });
  const targetPath = path.join(uploadDir, storedName);
  await writeFile(targetPath, buffer);
  return targetPath;
}
