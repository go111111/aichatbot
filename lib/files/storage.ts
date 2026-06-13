import { unlink } from "node:fs/promises";
import path from "node:path";

export function getUploadDir() {
  return (
    process.env.UPLOAD_DIR ||
    path.join(/*turbopackIgnore: true*/ process.cwd(), "uploads")
  );
}

export function getStoredUploadPath(storedName: string) {
  const uploadDir = path.resolve(getUploadDir());
  const filePath = path.resolve(uploadDir, storedName);

  if (!filePath.startsWith(`${uploadDir}${path.sep}`)) {
    return null;
  }

  return filePath;
}

export async function deleteStoredUploadFile(storedName: string) {
  const filePath = getStoredUploadPath(storedName);

  if (!filePath) {
    return false;
  }

  try {
    await unlink(/* turbopackIgnore: true */ filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return true;
    }

    console.error("Failed to delete uploaded file from disk", {
      storedName,
      code,
    });
    return false;
  }
}
