import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import {
  ensureChatAccess,
  getContentType,
  getSafeFilename,
  persistUploadedFile,
  STANDARD_UPLOAD_MAX_BYTES,
  writeUploadedBuffer,
} from "@/lib/files/upload";

const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= STANDARD_UPLOAD_MAX_BYTES, {
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
      const canUseChat = await ensureChatAccess({
        chatId,
        userId: session.user.id,
      });

      if (!canUseChat) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const safeName = getSafeFilename(filename);
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    try {
      const storedName = `${Date.now()}-${randomUUID()}-${safeName}`;
      await writeUploadedBuffer({
        storedName,
        buffer: fileBuffer,
      });
      const savedFile = await persistUploadedFile({
        userId: session.user.id,
        chatId,
        originalName: filename,
        storedName,
        contentType,
        size: file.size,
        buffer: fileBuffer,
      });

      return NextResponse.json(savedFile);
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
