import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import {
  deleteFileByIdForUser,
  getKnowledgeFilesByIdsForUser,
} from "@/lib/db/queries";
import { deleteStoredUploadFile } from "@/lib/files/storage";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const [knowledgeFile] = await getKnowledgeFilesByIdsForUser({
    ids: [id],
    userId: session.user.id,
  });

  if (!knowledgeFile) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const deletedFile = await deleteFileByIdForUser({
    id: knowledgeFile.id,
    userId: session.user.id,
  });

  if (!deletedFile) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const diskDeleted = await deleteStoredUploadFile(deletedFile.storedName);

  return NextResponse.json({
    id: deletedFile.id,
    deleted: true,
    diskDeleted,
  });
}
