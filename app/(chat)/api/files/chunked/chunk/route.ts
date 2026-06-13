import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { CHUNKED_UPLOAD_CHUNK_BYTES } from "@/lib/files/upload";
import { readManifest, saveChunk } from "@/lib/files/chunked-upload";

const ChunkSchema = z.object({
  uploadId: z.string().uuid(),
  chunkIndex: z.coerce.number().int().min(0),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const parsed = ChunkSchema.safeParse({
    uploadId: formData.get("uploadId"),
    chunkIndex: formData.get("chunkIndex"),
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid chunk metadata" }, { status: 400 });
  }

  const chunk = formData.get("chunk") as Blob | null;

  if (!chunk) {
    return NextResponse.json({ error: "Missing chunk" }, { status: 400 });
  }

  if (chunk.size > CHUNKED_UPLOAD_CHUNK_BYTES) {
    return NextResponse.json({ error: "Chunk is too large" }, { status: 400 });
  }

  const manifest = await readManifest({
    userId: session.user.id,
    uploadId: parsed.data.uploadId,
  });

  if (!manifest) {
    return NextResponse.json({ error: "Upload session not found" }, { status: 404 });
  }

  try {
    await saveChunk({
      manifest,
      chunkIndex: parsed.data.chunkIndex,
      buffer: Buffer.from(await chunk.arrayBuffer()),
    });

    return NextResponse.json({
      uploadId: manifest.uploadId,
      chunkIndex: parsed.data.chunkIndex,
      receivedChunks: manifest.receivedChunks.length,
      totalChunks: manifest.totalChunks,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save chunk" },
      { status: 400 }
    );
  }
}
