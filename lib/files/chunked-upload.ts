import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  CHUNKED_UPLOAD_CHUNK_BYTES,
  getSafeFilename,
  getUploadDir,
  persistUploadedFile,
} from "./upload";
import { deleteStoredUploadFile } from "./storage";

export type ChunkedUploadManifest = {
  uploadId: string;
  userId: string;
  chatId: string | null;
  filename: string;
  safeName: string;
  contentType: string;
  size: number;
  totalChunks: number;
  receivedChunks: number[];
  fingerprint?: string;
  createdAt: string;
};

function getChunkedRootDir() {
  return path.join(getUploadDir(), ".tmp", "chunked");
}

export function getChunkedUploadDir({
  userId,
  uploadId,
}: {
  userId: string;
  uploadId: string;
}) {
  return path.join(getChunkedRootDir(), getSafeFilename(userId), uploadId);
}

export function getManifestPath({
  userId,
  uploadId,
}: {
  userId: string;
  uploadId: string;
}) {
  return path.join(getChunkedUploadDir({ userId, uploadId }), "manifest.json");
}

export function getChunkPath({
  userId,
  uploadId,
  chunkIndex,
}: {
  userId: string;
  uploadId: string;
  chunkIndex: number;
}) {
  return path.join(
    getChunkedUploadDir({ userId, uploadId }),
    `${chunkIndex}.part`
  );
}

export async function saveManifest(manifest: ChunkedUploadManifest) {
  const uploadDir = getChunkedUploadDir({
    userId: manifest.userId,
    uploadId: manifest.uploadId,
  });
  await mkdir(uploadDir, { recursive: true });
  await writeFile(
    getManifestPath({
      userId: manifest.userId,
      uploadId: manifest.uploadId,
    }),
    JSON.stringify(manifest, null, 2)
  );
}

export async function readManifest({
  userId,
  uploadId,
}: {
  userId: string;
  uploadId: string;
}) {
  try {
    const content = await readFile(getManifestPath({ userId, uploadId }), "utf8");
    return JSON.parse(content) as ChunkedUploadManifest;
  } catch {
    return null;
  }
}

export async function findReusableManifest({
  userId,
  chatId,
  contentType,
  size,
  fingerprint,
}: {
  userId: string;
  chatId: string | null;
  contentType: string;
  size: number;
  fingerprint?: string;
}) {
  if (!fingerprint) {
    return null;
  }

  const userUploadDir = path.join(getChunkedRootDir(), getSafeFilename(userId));
  let uploadDirs: Dirent[];

  try {
    uploadDirs = await readdir(userUploadDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const uploadDir of uploadDirs) {
    if (!uploadDir.isDirectory()) {
      continue;
    }

    const manifest = await readManifest({
      userId,
      uploadId: uploadDir.name,
    });

    if (
      manifest?.fingerprint === fingerprint &&
      manifest.chatId === chatId &&
      manifest.contentType === contentType &&
      manifest.size === size
    ) {
      return manifest;
    }
  }

  return null;
}

export async function deleteChunkedUpload({
  userId,
  uploadId,
}: {
  userId: string;
  uploadId: string;
}) {
  await rm(getChunkedUploadDir({ userId, uploadId }), {
    recursive: true,
    force: true,
  });
}

export async function saveChunk({
  manifest,
  chunkIndex,
  buffer,
}: {
  manifest: ChunkedUploadManifest;
  chunkIndex: number;
  buffer: Buffer;
}) {
  if (chunkIndex < 0 || chunkIndex >= manifest.totalChunks) {
    throw new Error("Chunk index out of range");
  }

  const isLastChunk = chunkIndex === manifest.totalChunks - 1;
  const expectedChunkSize = isLastChunk
    ? manifest.size - CHUNKED_UPLOAD_CHUNK_BYTES * (manifest.totalChunks - 1)
    : CHUNKED_UPLOAD_CHUNK_BYTES;

  if (!isLastChunk && buffer.byteLength > CHUNKED_UPLOAD_CHUNK_BYTES) {
    throw new Error("Chunk is too large");
  }

  if (buffer.byteLength !== expectedChunkSize) {
    throw new Error("Chunk size does not match upload manifest");
  }

  await writeFile(
    getChunkPath({
      userId: manifest.userId,
      uploadId: manifest.uploadId,
      chunkIndex,
    }),
    buffer
  );

  const receivedChunks = new Set(manifest.receivedChunks);
  receivedChunks.add(chunkIndex);
  manifest.receivedChunks = Array.from(receivedChunks).sort((a, b) => a - b);
  await saveManifest(manifest);
}

export function isUploadComplete(manifest: ChunkedUploadManifest) {
  return manifest.receivedChunks.length === manifest.totalChunks;
}

export async function completeChunkedUpload(manifest: ChunkedUploadManifest) {
  if (!isUploadComplete(manifest)) {
    throw new Error("Upload is incomplete");
  }

  const storedName = `${Date.now()}-${manifest.uploadId}-${manifest.safeName}`;
  const targetPath = path.join(getUploadDir(), storedName);
  await mkdir(getUploadDir(), { recursive: true });

  try {
    for (let chunkIndex = 0; chunkIndex < manifest.totalChunks; chunkIndex += 1) {
      await pipeline(
        createReadStream(
          getChunkPath({
            userId: manifest.userId,
            uploadId: manifest.uploadId,
            chunkIndex,
          })
        ),
        createWriteStream(targetPath, {
          flags: chunkIndex === 0 ? "w" : "a",
        })
      );
    }

    const targetStats = await stat(targetPath);

    if (targetStats.size !== manifest.size) {
      throw new Error("Merged file size does not match upload manifest");
    }

    const savedFile = await persistUploadedFile({
      userId: manifest.userId,
      chatId: manifest.chatId,
      originalName: manifest.filename,
      storedName,
      contentType: manifest.contentType,
      size: manifest.size,
      filePath: targetPath,
    });

    await deleteChunkedUpload({
      userId: manifest.userId,
      uploadId: manifest.uploadId,
    });

    return savedFile;
  } catch (error) {
    await deleteStoredUploadFile(storedName);
    await deleteChunkedUpload({
      userId: manifest.userId,
      uploadId: manifest.uploadId,
    });
    throw error;
  }
}
