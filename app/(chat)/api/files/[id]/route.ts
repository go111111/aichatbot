import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import {
  deleteFileByIdForUser,
  getChatById,
  getFilesByIdsForUser,
} from "@/lib/db/queries";

function getUploadDir() {
  return (
    process.env.UPLOAD_DIR ||
    path.join(/*turbopackIgnore: true*/ process.cwd(), "uploads")
  );
}

function getContentDisposition(filename: string) {
  const encodedFilename = encodeURIComponent(filename);
  const fallbackFilename = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${fallbackFilename}"; filename*=UTF-8''${encodedFilename}`;
}

function getStoredFilePath(storedName: string) {
  const uploadDir = path.resolve(getUploadDir());
  const filePath = path.resolve(uploadDir, storedName);

  if (!filePath.startsWith(`${uploadDir}${path.sep}`)) {
    return null;
  }

  return filePath;
}

async function getOwnedFile({
  id,
  userId,
}: {
  id: string;
  userId: string;
}) {
  const [uploadedFile] = await getFilesByIdsForUser({
    ids: [id],
    userId,
  });

  if (!uploadedFile) {
    return { error: "not_found" as const };
  }

  if (uploadedFile.chatId) {
    const owningChat = await getChatById({ conversationId: uploadedFile.chatId });

    if (!owningChat || owningChat.userId !== userId) {
      return { error: "forbidden" as const };
    }
  }

  return { uploadedFile };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await getOwnedFile({ id, userId: session.user.id });

  if (result.error === "not_found") {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  if (result.error === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const uploadedFile = result.uploadedFile;
  const filePath = getStoredFilePath(uploadedFile.storedName);

  if (!filePath) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const fileStats = await stat(/* turbopackIgnore: true */ filePath);
    const fileStream = Readable.toWeb(createReadStream(filePath));

    return new Response(fileStream as BodyInit, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": getContentDisposition(uploadedFile.originalName),
        "Content-Length": String(fileStats.size),
        "Content-Type": uploadedFile.mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const result = await getOwnedFile({ id, userId: session.user.id });

  if (result.error === "not_found") {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  if (result.error === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const uploadedFile = result.uploadedFile;
  const filePath = getStoredFilePath(uploadedFile.storedName);
  const deletedFile = await deleteFileByIdForUser({
    id: uploadedFile.id,
    userId: session.user.id,
  });

  if (!deletedFile) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  let diskDeleted = false;

  if (filePath) {
    try {
      await unlink(/* turbopackIgnore: true */ filePath);
      diskDeleted = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        diskDeleted = true;
      } else {
        console.error("Failed to delete uploaded file from disk", {
          fileId: uploadedFile.id,
          storedName: uploadedFile.storedName,
          code,
        });
      }
    }
  }

  return NextResponse.json({
    id: deletedFile.id,
    deleted: true,
    diskDeleted,
  });
}
