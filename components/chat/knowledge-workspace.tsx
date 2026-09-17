"use client";

import {
  CheckIcon,
  FileTextIcon,
  HomeIcon,
  LibraryIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActiveChat } from "@/hooks/use-active-chat";
import type { KnowledgeFile } from "@/lib/types";
import { cn } from "@/lib/utils";

const STANDARD_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const CHUNKED_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const FINGERPRINT_SAMPLE_BYTES = 1024 * 1024;
const KNOWLEDGE_FILE_ACCEPT =
  ".pdf,.txt,.md,.csv,.json,.jpg,.jpeg,.png,.webp,application/pdf,text/plain,text/markdown,text/csv,application/json,image/jpeg,image/png,image/webp";
const SUPPORTED_KNOWLEDGE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SUPPORTED_KNOWLEDGE_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
]);

type KnowledgeFilesResponse = {
  files: KnowledgeFile[];
};

type LocalUpload = {
  id: string;
  name: string;
  status: "uploading" | "processing" | "failed";
  progress: number;
  error?: string;
};

const fetchKnowledgeFiles = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Failed to load knowledge files");
  }

  return response.json() as Promise<KnowledgeFilesResponse>;
};

function getFileExtension(name: string) {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

function canUploadKnowledgeFile(file: Pick<File, "name" | "type">) {
  return (
    SUPPORTED_KNOWLEDGE_TYPES.has(file.type) ||
    SUPPORTED_KNOWLEDGE_EXTENSIONS.has(getFileExtension(file.name))
  );
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function getKnowledgeStatus(file: KnowledgeFile) {
  if (file.status === "failed" || file.parseStatus === "error") {
    return { label: "Failed", tone: "text-destructive" };
  }

  if (file.status === "uploading") {
    return { label: "Uploading", tone: "text-blue-600" };
  }

  if (file.status === "processing") {
    return { label: "Processing", tone: "text-amber-600" };
  }

  if (file.parseStatus === "unsupported") {
    return { label: "Stored only", tone: "text-muted-foreground" };
  }

  return { label: "Ready", tone: "text-emerald-600" };
}

function isSelectable(file: KnowledgeFile) {
  return file.status === "ready" && file.parseStatus === "parsed";
}

function arrayBufferToHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function createFileFingerprint(file: File) {
  const metadata = `${file.name}:${file.type}:${file.size}:${file.lastModified}`;

  if (!globalThis.crypto?.subtle) {
    return metadata;
  }

  const firstSample = await file
    .slice(0, Math.min(file.size, FINGERPRINT_SAMPLE_BYTES))
    .arrayBuffer();
  const lastSample =
    file.size > FINGERPRINT_SAMPLE_BYTES
      ? await file
          .slice(Math.max(0, file.size - FINGERPRINT_SAMPLE_BYTES), file.size)
          .arrayBuffer()
      : new ArrayBuffer(0);
  const combinedSample = new Uint8Array(
    firstSample.byteLength + lastSample.byteLength
  );
  combinedSample.set(new Uint8Array(firstSample), 0);
  combinedSample.set(new Uint8Array(lastSample), firstSample.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", combinedSample);

  return `${metadata}:${arrayBufferToHex(digest)}`;
}

async function readError(response: Response, fallback: string) {
  try {
    const { error } = await response.json();
    return error ?? fallback;
  } catch {
    return fallback;
  }
}

export function KnowledgeWorkspace() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { selectedDocumentIds, setSelectedDocumentIds } = useActiveChat();
  const [query, setQuery] = useState("");
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { data, isLoading, mutate } = useSWR<KnowledgeFilesResponse>(
    `${basePath}/api/knowledge/files`,
    fetchKnowledgeFiles,
    { revalidateOnFocus: false }
  );
  const files = data?.files ?? [];
  const filteredFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return files;
    }

    return files.filter((file) =>
      file.name.toLowerCase().includes(normalizedQuery)
    );
  }, [files, query]);

  const updateUpload = useCallback((id: string, patch: Partial<LocalUpload>) => {
    setUploads((currentUploads) =>
      currentUploads.map((upload) =>
        upload.id === id ? { ...upload, ...patch } : upload
      )
    );
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((currentUploads) =>
      currentUploads.filter((upload) => upload.id !== id)
    );
  }, []);

  const uploadStandardFile = useCallback(
    async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${basePath}/api/files/upload`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(await readError(response, "Upload failed"));
      }

      return response.json();
    },
    [basePath]
  );

  const uploadChunkedFile = useCallback(
    async (file: File, uploadId: string) => {
      const fingerprint = await createFileFingerprint(file);
      const initiateResponse = await fetch(
        `${basePath}/api/files/chunked/initiate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            size: file.size,
            fingerprint,
          }),
        }
      );

      if (!initiateResponse.ok) {
        throw new Error(
          await readError(initiateResponse, "Failed to start upload")
        );
      }

      const uploadSession = await initiateResponse.json();
      const chunkSize = Number(uploadSession.chunkSize);
      const totalChunks = Number(uploadSession.totalChunks);
      const remoteUploadId = String(uploadSession.uploadId);
      const uploadedChunks = new Set<number>(uploadSession.uploadedChunks ?? []);
      let completedChunks = uploadedChunks.size;

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        if (uploadedChunks.has(chunkIndex)) {
          continue;
        }

        const formData = new FormData();
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        formData.append("uploadId", remoteUploadId);
        formData.append("chunkIndex", String(chunkIndex));
        formData.append("chunk", file.slice(start, end));

        const chunkResponse = await fetch(
          `${basePath}/api/files/chunked/chunk`,
          {
            method: "POST",
            body: formData,
          }
        );

        if (!chunkResponse.ok) {
          throw new Error(
            await readError(
              chunkResponse,
              `Failed to upload chunk ${chunkIndex + 1}`
            )
          );
        }

        completedChunks += 1;
        updateUpload(uploadId, {
          progress: Math.round((completedChunks / totalChunks) * 90),
        });
      }

      updateUpload(uploadId, { progress: 95, status: "processing" });
      const completeResponse = await fetch(
        `${basePath}/api/files/chunked/complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadId: remoteUploadId }),
        }
      );

      if (!completeResponse.ok) {
        throw new Error(
          await readError(completeResponse, "Failed to complete upload")
        );
      }

      return completeResponse.json();
    },
    [basePath, updateUpload]
  );

  const uploadFile = useCallback(
    async (file: File, uploadId: string) => {
      if (file.size > CHUNKED_UPLOAD_MAX_BYTES) {
        throw new Error("File size should be less than 100MB");
      }

      updateUpload(uploadId, { progress: 35, status: "uploading" });

      if (file.size > STANDARD_UPLOAD_MAX_BYTES) {
        return uploadChunkedFile(file, uploadId);
      }

      const processingTimer = setTimeout(() => {
        updateUpload(uploadId, { progress: 75, status: "processing" });
      }, 800);

      try {
        return await uploadStandardFile(file);
      } finally {
        clearTimeout(processingTimer);
      }
    },
    [updateUpload, uploadChunkedFile, uploadStandardFile]
  );

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      const selectedFiles = Array.from(fileList ?? []);

      if (selectedFiles.length === 0) {
        return;
      }

      const supportedFiles = selectedFiles.filter(canUploadKnowledgeFile);
      const unsupportedCount = selectedFiles.length - supportedFiles.length;

      if (unsupportedCount > 0) {
        toast.error(
          "Only PDF, text, Markdown, CSV, JSON, JPG, PNG, and WebP files are supported."
        );
      }

      if (supportedFiles.length === 0) {
        if (inputRef.current) {
          inputRef.current.value = "";
        }
        return;
      }

      const uploadItems = supportedFiles.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        status: "uploading" as const,
        progress: 0,
        file,
      }));
      setUploads((currentUploads) => [
        ...currentUploads,
        ...uploadItems.map(({ file: _file, ...item }) => item),
      ]);

      await Promise.all(
        uploadItems.map(async (item) => {
          try {
            await uploadFile(item.file, item.id);
            updateUpload(item.id, { progress: 100, status: "processing" });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Failed to upload file";
            updateUpload(item.id, { error: message, status: "failed" });
            toast.error(message);
          }
        })
      );

      await mutate();
      setUploads((currentUploads) =>
        currentUploads.filter((upload) => upload.status === "failed")
      );

      if (inputRef.current) {
        inputRef.current.value = "";
      }
    },
    [mutate, updateUpload, uploadFile]
  );

  const toggleDocument = useCallback(
    (id: string) => {
      setSelectedDocumentIds((currentIds) =>
        currentIds.includes(id)
          ? currentIds.filter((currentId) => currentId !== id)
          : [...currentIds, id]
      );
    },
    [setSelectedDocumentIds]
  );

  const deleteFile = useCallback(
    async (id: string) => {
      setDeletingId(id);

      try {
        const response = await fetch(`${basePath}/api/knowledge/files/${id}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          throw new Error(await readError(response, "Failed to delete file"));
        }

        setSelectedDocumentIds((currentIds) =>
          currentIds.filter((currentId) => currentId !== id)
        );
        await mutate();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to delete file"
        );
      } finally {
        setDeletingId(null);
      }
    },
    [basePath, mutate, setSelectedDocumentIds]
  );

  return (
    <main className="flex h-dvh min-w-0 bg-background">
      <aside className="hidden w-[250px] shrink-0 border-r border-border/50 bg-muted/30 p-4 md:flex md:flex-col">
        <div className="mb-5 flex items-center gap-2">
          <LibraryIcon className="size-5 text-muted-foreground" />
          <div className="font-semibold text-xl">Knowledge</div>
        </div>
        <div className="relative mb-4">
          <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
          <Input
            className="h-10 rounded-lg bg-background pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            value={query}
          />
        </div>
        <nav className="flex flex-col gap-1 text-sm">
          <Link
            className="flex h-9 items-center gap-2 rounded-lg px-3 text-muted-foreground hover:bg-background"
            href="/"
          >
            <HomeIcon className="size-4" />
            Chat home
          </Link>
          <Link
            className="flex h-9 items-center gap-2 rounded-lg bg-primary/10 px-3 text-primary"
            href="/knowledge"
          >
            <LibraryIcon className="size-4" />
            Knowledge base
          </Link>
        </nav>
        <div className="mt-8 text-muted-foreground text-xs">Selected for chat</div>
        <div className="mt-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm">
          {selectedDocumentIds.length} document
          {selectedDocumentIds.length === 1 ? "" : "s"}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-5 py-6 md:px-8">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="font-semibold text-2xl">知识库</h1>
              <p className="mt-1 text-muted-foreground text-sm">
                Upload documents here, then select ready files for chat retrieval.
              </p>
            </div>
            <Button
              className="gap-2 rounded-lg"
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              <UploadIcon className="size-4" />
              Upload
            </Button>
            <input
              accept={KNOWLEDGE_FILE_ACCEPT}
              className="hidden"
              multiple
              onChange={(event) => handleFiles(event.target.files)}
              ref={inputRef}
              type="file"
            />
          </header>

          <div className="grid gap-4 md:grid-cols-3">
            <button
              className="flex h-24 items-center gap-4 rounded-lg border border-border/70 px-5 text-left transition-colors hover:bg-muted/40"
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PlusIcon className="size-5" />
              </div>
              <div>
                <div className="font-medium">上传文档</div>
                <div className="text-muted-foreground text-sm">
                  PDF, Markdown, text, CSV, JSON, images
                </div>
              </div>
            </button>
            <div className="flex h-24 items-center gap-4 rounded-lg border border-border/70 px-5">
              <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
                <CheckIcon className="size-5" />
              </div>
              <div>
                <div className="font-medium">可用于聊天</div>
                <div className="text-muted-foreground text-sm">
                  {files.filter(isSelectable).length} ready documents
                </div>
              </div>
            </div>
            <div className="flex h-24 items-center gap-4 rounded-lg border border-border/70 px-5">
              <div className="flex size-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600">
                <LibraryIcon className="size-5" />
              </div>
              <div>
                <div className="font-medium">全部文档</div>
                <div className="text-muted-foreground text-sm">
                  {files.length} total files
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="font-semibold text-lg">全部知识库</div>
            <div className="relative w-full max-w-xs">
              <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
              <Input
                className="rounded-lg pl-9"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索知识库"
                value={query}
              />
            </div>
          </div>

          {(uploads.length > 0 || isLoading || filteredFiles.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {uploads.map((upload) => (
                <div
                  className="flex min-h-28 flex-col justify-between rounded-lg border border-border/70 p-4"
                  key={upload.id}
                >
                  <div className="flex items-start gap-3">
                    <Loader2Icon
                      className={cn("mt-0.5 size-4 shrink-0", {
                        "animate-spin text-primary": upload.status !== "failed",
                        "text-destructive": upload.status === "failed",
                      })}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-sm">
                        {upload.name}
                      </div>
                      <div className="mt-1 text-muted-foreground text-xs">
                        {upload.status === "failed"
                          ? (upload.error ?? "Failed")
                          : `${upload.progress}% ${upload.status}`}
                      </div>
                    </div>
                    <Button
                      aria-label={`Remove ${upload.name}`}
                      className="size-7 shrink-0"
                      onClick={() => removeUpload(upload.id)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}

              {isLoading && (
                <div className="rounded-lg border border-border/70 p-4 text-muted-foreground text-sm">
                  Loading documents...
                </div>
              )}

              {filteredFiles.map((file) => {
                const status = getKnowledgeStatus(file);
                const selectable = isSelectable(file);
                const selected = selectedDocumentIds.includes(file.id);

                return (
                  <div
                    className={cn(
                      "group/file flex min-h-36 flex-col justify-between rounded-lg border border-border/70 p-4 transition-colors",
                      selected && "border-primary/50 bg-primary/5"
                    )}
                    key={file.id}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <FileTextIcon className="size-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{file.name}</div>
                        <div className="mt-1 flex items-center gap-2 text-xs">
                          <span className={status.tone}>{status.label}</span>
                          <span className="text-muted-foreground">
                            {formatFileSize(file.size)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-5 flex items-center justify-between gap-2">
                      <Button
                        className="h-8 gap-1.5 rounded-lg"
                        disabled={!selectable}
                        onClick={() => toggleDocument(file.id)}
                        size="sm"
                        type="button"
                        variant={selected ? "default" : "outline"}
                      >
                        {selected && <CheckIcon className="size-3.5" />}
                        {selected ? "Selected" : "Use in chat"}
                      </Button>
                      <Button
                        aria-label={`Delete ${file.name}`}
                        className="size-8"
                        disabled={deletingId === file.id}
                        onClick={() => deleteFile(file.id)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        {deletingId === file.id ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : (
                          <Trash2Icon className="size-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!isLoading && uploads.length === 0 && filteredFiles.length === 0 && (
            <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-border/70 text-center">
              <LibraryIcon className="mb-3 size-8 text-muted-foreground" />
              <div className="font-medium">No documents yet</div>
              <div className="mt-1 text-muted-foreground text-sm">
                Upload supported files to create your knowledge base.
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
