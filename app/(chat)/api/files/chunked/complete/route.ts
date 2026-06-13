import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import {
  completeChunkedUpload,
  isUploadComplete,
  readManifest,
} from "@/lib/files/chunked-upload";

const CompleteSchema = z.object({
  uploadId: z.string().uuid(),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = CompleteSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid upload session" }, { status: 400 });
  }

  const manifest = await readManifest({
    userId: session.user.id,
    uploadId: parsed.data.uploadId,
  });

  if (!manifest) {
    return NextResponse.json({ error: "Upload session not found" }, { status: 404 });
  }

  if (!isUploadComplete(manifest)) {
    return NextResponse.json(
      {
        error: "Upload is incomplete",
        receivedChunks: manifest.receivedChunks.length,
        totalChunks: manifest.totalChunks,
      },
      { status: 409 }
    );
  }

  try {
    const savedFile = await completeChunkedUpload(manifest);
    return NextResponse.json(savedFile);
  } catch (_error) {
    return NextResponse.json({ error: "Failed to complete upload" }, { status: 500 });
  }
}
