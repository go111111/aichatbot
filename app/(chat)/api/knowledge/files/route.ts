import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import { getKnowledgeFilesByUser } from "@/lib/db/queries";

function toKnowledgeFileResponse(file: Awaited<ReturnType<typeof getKnowledgeFilesByUser>>[number]) {
  return {
    id: file.id,
    name: file.originalName,
    url: file.url,
    contentType: file.mimeType,
    size: file.size,
    status: file.status,
    parseStatus: file.parseStatus,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const files = await getKnowledgeFilesByUser({ userId: session.user.id });

  return NextResponse.json({
    files: files.map(toKnowledgeFileResponse),
  });
}
