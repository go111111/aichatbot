import { ChatbotError } from "../errors";
import type { Attachment } from "../types";

/**
 * Upload a file to the server
 * @param file - The file to upload
 * @returns The uploaded file metadata
 */
export async function uploadFile(file: File): Promise<Attachment> {
  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/files/upload`,
      {
        method: "POST",
        body: formData,
      }
    );

    if (!response.ok) {
      const { code, cause } = await response.json();
      throw new ChatbotError(code, cause);
    }

    const data = await response.json();
    return {
      id: data.id,
      name: data.pathname,
      url: data.url,
      contentType: data.contentType,
      size: data.size,
      parseStatus: data.parseStatus,
      textPreview: data.textPreview,
    };
  } catch (error) {
    if (error instanceof ChatbotError) {
      throw error;
    }
    throw new ChatbotError(
      "internal_error:upload",
      error instanceof Error ? error.message : "Failed to upload file"
    );
  }
}

/**
 * Delete an uploaded file by file id or protected file URL.
 * Legacy `/api/upload?name=...` deletion is intentionally not used for the
 * protected file flow because deletion must pass through ownership checks.
 */
export async function deleteUploadedFile(fileIdOrUrl: string): Promise<void> {
  const fileId = fileIdOrUrl.startsWith("/api/files/")
    ? fileIdOrUrl.split("/").at(-1)
    : fileIdOrUrl;

  if (!fileId) {
    throw new ChatbotError("bad_request:upload", "File id is required");
  }

  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/files/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
      }
    );

    if (!response.ok) {
      const { code, cause } = await response.json();
      throw new ChatbotError(code, cause);
    }
  } catch (error) {
    if (error instanceof ChatbotError) {
      throw error;
    }
    throw new ChatbotError(
      "internal_error:upload",
      error instanceof Error ? error.message : "Failed to delete file"
    );
  }
}

/**
 * Validate file before upload
 * @param file - The file to validate
 * @param maxSize - Maximum file size in bytes (default: 20MB)
 * @returns Error message if validation fails, undefined if valid
 */
export function validateFile(
  file: File,
  maxSize: number = 20 * 1024 * 1024
): string | undefined {
  const allowedMimeTypes = new Set([
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

  if (!allowedMimeTypes.has(file.type)) {
    return `File type ${file.type} is not allowed`;
  }

  if (file.size > maxSize) {
    return `File size exceeds ${Math.round(maxSize / (1024 * 1024))}MB limit`;
  }

  return undefined;
}
