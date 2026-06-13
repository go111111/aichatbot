import Image from "next/image";
import type { Attachment } from "@/lib/types";
import { Spinner } from "../ui/spinner";
import { CrossSmallIcon } from "./icons";

export const PreviewAttachment = ({
  attachment,
  isUploading = false,
  onRemove,
}: {
  attachment: Attachment;
  isUploading?: boolean;
  onRemove?: () => void;
}) => {
  const { name, url, contentType, parseStatus } = attachment;
  const isTextLike =
    contentType === "text/plain" ||
    contentType === "text/markdown" ||
    contentType === "text/csv" ||
    contentType === "application/json";
  const label = contentType === "application/pdf" ? "PDF" : isTextLike ? "Text" : "File";
  const statusLabel =
    parseStatus === "parsed"
      ? "Parsed"
      : parseStatus === "error"
        ? "Parse error"
        : parseStatus === "unsupported"
          ? "Preview only"
          : null;

  return (
    <div
      className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-border/40 bg-muted"
      data-testid="input-attachment-preview"
    >
      {contentType?.startsWith("image") ? (
        <Image
          alt={name ?? "attachment"}
          className="size-full object-cover"
          height={96}
          src={url}
          unoptimized={url.startsWith("/api/files/")}
          width={96}
        />
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

      {isUploading && (
        <div
          className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 backdrop-blur-sm"
          data-testid="input-attachment-loader"
        >
          <Spinner className="size-5" />
        </div>
      )}

      {onRemove && !isUploading && (
        <button
          className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/80 group-hover:opacity-100"
          onClick={onRemove}
          type="button"
        >
          <CrossSmallIcon size={10} />
        </button>
      )}
    </div>
  );
};
