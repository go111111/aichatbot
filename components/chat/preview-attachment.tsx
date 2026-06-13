import Image from "next/image";
import type { Attachment } from "@/lib/types";
import { Spinner } from "../ui/spinner";
import { CrossSmallIcon } from "./icons";

export const PreviewAttachment = ({
  attachment,
  isUploading = false,
  uploadStatus,
  progress,
  error,
  onRemove,
}: {
  attachment: Attachment;
  isUploading?: boolean;
  uploadStatus?: "uploading" | "processing" | "error";
  progress?: number;
  error?: string;
  onRemove?: () => void;
}) => {
  const { name, url, contentType, parseStatus } = attachment;
  const isImage = contentType?.startsWith("image");
  const isTextLike =
    contentType === "text/plain" ||
    contentType === "text/markdown" ||
    contentType === "text/csv" ||
    contentType === "application/json";
  const label =
    contentType === "application/pdf" ? "PDF" : isTextLike ? "Text" : "File";
  const statusLabel =
    parseStatus === "parsed"
      ? isImage
        ? "OCR parsed"
        : "Parsed"
      : parseStatus === "error"
        ? isImage
          ? "OCR failed"
          : "Parse error"
        : parseStatus === "unsupported"
          ? "Preview only"
          : null;

  return (
    <div
      className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-border/40 bg-muted"
      data-testid="input-attachment-preview"
    >
      {isImage ? (
        <>
          <Image
            alt={name ?? "attachment"}
            className="size-full object-cover"
            height={96}
            src={url}
            unoptimized={url.startsWith("/api/files/")}
            width={96}
          />
          {statusLabel && (
            <span className="absolute right-1 bottom-1 left-1 truncate rounded bg-black/60 px-1 py-0.5 text-center text-[10px] text-white backdrop-blur-sm">
              {statusLabel}
            </span>
          )}
        </>
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center text-muted-foreground text-xs">
          <span className="font-medium text-foreground/70">{label}</span>
          {statusLabel && (
            <span className="max-w-full truncate text-[10px]">
              {statusLabel}
            </span>
          )}
          <span className="max-w-full truncate text-[10px]">{name}</span>
        </div>
      )}

      {(isUploading || uploadStatus) && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-xl bg-black/50 px-2 text-center text-white backdrop-blur-sm"
          data-testid="input-attachment-loader"
        >
          {uploadStatus === "error" ? (
            <>
              <span className="font-medium text-[11px]">Error</span>
              <span className="line-clamp-2 text-[10px] text-white/80">
                {error ?? "Upload failed"}
              </span>
            </>
          ) : (
            <>
              <Spinner className="size-5" />
              <span className="text-[10px]">
                {uploadStatus === "processing"
                  ? "Processing"
                  : typeof progress === "number"
                    ? `${progress}%`
                    : "Uploading"}
              </span>
            </>
          )}
        </div>
      )}

      {onRemove &&
        !isUploading &&
        uploadStatus !== "processing" &&
        uploadStatus !== "uploading" && (
        <button
          className={`absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition-opacity hover:bg-black/80 ${
            uploadStatus === "error" ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          onClick={onRemove}
          type="button"
        >
          <CrossSmallIcon size={10} />
        </button>
        )}
    </div>
  );
};
