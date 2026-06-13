"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import equal from "fast-deep-equal";
import {
  ArrowUpIcon,
  BrainIcon,
  EyeIcon,
  LockIcon,
  WrenchIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  type ChangeEvent,
  cloneElement,
  type Dispatch,
  memo,
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { useLocalStorage, useWindowSize } from "usehooks-ts";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  type ChatModel,
  chatModels,
  DEFAULT_CHAT_MODEL,
  type ModelCapabilities,
} from "@/lib/ai/models";
import type { Attachment, ChatMessage } from "@/lib/types";
import { cn, generateUUID } from "@/lib/utils";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../ai-elements/prompt-input";
import { Button } from "../ui/button";
import { PaperclipIcon, StopIcon } from "./icons";
import { PreviewAttachment } from "./preview-attachment";
import {
  type ChatHistory,
  getChatHistoryPaginationKey,
} from "./sidebar-history";
import {
  type SlashCommand,
  SlashCommandMenu,
  slashCommands,
} from "./slash-commands";
import { SuggestedActions } from "./suggested-actions";
import type { VisibilityType } from "./visibility-selector";

function setCookie(name: string, value: string) {
  const maxAge = 60 * 60 * 24 * 365;
  // biome-ignore lint/suspicious/noDocumentCookie: needed for client-side cookie setting
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}`;
}

const TEXT_ATTACHMENT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);
const TEXT_ATTACHMENT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"]);
const TEXT_ATTACHMENT_ACCEPT =
  ".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json";
const VISION_ATTACHMENT_ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,application/pdf";
const OCR_ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const STANDARD_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const CHUNKED_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

type UploadQueueItem = {
  id: string;
  name: string;
  status: "uploading" | "processing" | "error";
  progress: number;
  error?: string;
};

function getFileExtension(name: string) {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

function isTextAttachment(file: Pick<File, "name" | "type">) {
  return (
    TEXT_ATTACHMENT_TYPES.has(file.type) ||
    TEXT_ATTACHMENT_EXTENSIONS.has(getFileExtension(file.name))
  );
}

function canServerParseAttachment(file: Pick<File, "name" | "type">) {
  return (
    isTextAttachment(file) ||
    file.type === "application/pdf" ||
    OCR_ATTACHMENT_TYPES.has(file.type)
  );
}

function PureMultimodalInput({
  chatId,
  input,
  setInput,
  status,
  stop,
  attachments,
  setAttachments,
  messages,
  setMessages,
  sendMessage,
  className,
  selectedVisibilityType,
  selectedModelId,
  onModelChange,
  editingMessage,
  onCancelEdit,
  isLoading,
}: {
  chatId: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  stop: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  messages: UIMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage:
    | UseChatHelpers<ChatMessage>["sendMessage"]
    | (() => Promise<void>);
  className?: string;
  selectedVisibilityType: VisibilityType;
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
  isLoading?: boolean;
}) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { setTheme, resolvedTheme } = useTheme();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { width } = useWindowSize();
  const hasAutoFocused = useRef(false);
  useEffect(() => {
    if (!hasAutoFocused.current && width) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
        hasAutoFocused.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [width]);

  const [localStorageInput, setLocalStorageInput] = useLocalStorage(
    "input",
    ""
  );

  useEffect(() => {
    if (textareaRef.current) {
      const domValue = textareaRef.current.value;
      const finalValue = domValue || localStorageInput || "";
      setInput(finalValue);
    }
  }, [localStorageInput, setInput]);

  useEffect(() => {
    setLocalStorageInput(input);
  }, [input, setLocalStorageInput]);

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = event.target.value;
    setInput(val);

    if (val.startsWith("/") && !val.includes(" ")) {
      setSlashOpen(true);
      setSlashQuery(val.slice(1));
      setSlashIndex(0);
    } else {
      setSlashOpen(false);
    }
  };

  const handleSlashSelect = (cmd: SlashCommand) => {
    setSlashOpen(false);
    setInput("");
    switch (cmd.action) {
      case "new":
        router.push("/");
        break;
      case "clear":
        setMessages(() => []);
        break;
      case "rename":
        toast("Rename is available from the sidebar chat menu.");
        break;
      case "model": {
        const modelBtn = document.querySelector<HTMLButtonElement>(
          "[data-testid='model-selector']"
        );
        modelBtn?.click();
        break;
      }
      case "theme":
        setTheme(resolvedTheme === "dark" ? "light" : "dark");
        break;
      case "delete":
        toast("Delete this chat?", {
          action: {
            label: "Delete",
            onClick: () => {
              fetch(
                `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/chat?id=${chatId}`,
                { method: "DELETE" }
              );
              router.push("/");
              toast.success("Chat deleted");
            },
          },
        });
        break;
      case "purge":
        toast("Delete all chats?", {
          action: {
            label: "Delete all",
            onClick: () => {
              fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/history`, {
                method: "DELETE",
              });
              router.push("/");
              toast.success("All chats deleted");
            },
          },
        });
        break;
      default:
        break;
    }
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const { data: modelsResponse } = useSWR(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/models`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false, dedupingInterval: 3_600_000 }
  );
  const capabilities: Record<string, ModelCapabilities> | undefined =
    modelsResponse?.capabilities ?? modelsResponse;
  const selectedModelCapabilities =
    capabilities?.[selectedModelId] ??
    chatModels.find((model) => model.id === selectedModelId)?.capabilities;
  const supportsVisionAttachments = selectedModelCapabilities?.vision === true;
  const fileInputAccept = `${TEXT_ATTACHMENT_ACCEPT},${VISION_ATTACHMENT_ACCEPT}`;

  const getOptimisticTitle = useCallback((text: string) => {
    const normalized = text.trim().replace(/\s+/g, " ");
    if (!normalized) {
      return "New chat";
    }
    return normalized.length > 42 ? `${normalized.slice(0, 42)}...` : normalized;
  }, []);

  const submitForm = useCallback(() => {
    const isFirstMessage = messages.length === 0;
    const optimisticTitle = getOptimisticTitle(input);
    window.history.pushState(
      {},
      "",
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
    );

    if (isFirstMessage) {
      mutate(
        unstable_serialize(getChatHistoryPaginationKey),
        (current?: ChatHistory[]) => {
          const optimisticChat = {
            id: chatId,
            createdAt: new Date(),
            updatedAt: new Date(),
            title: optimisticTitle,
            userId: "",
            visibility: selectedVisibilityType,
          };

          if (!current || current.length === 0) {
            return [{ chats: [optimisticChat], hasMore: false }];
          }

          if (current.some((page) => page.chats.some((chat) => chat.id === chatId))) {
            return current.map((page) => ({
              ...page,
              chats: page.chats.map((chat) =>
                chat.id === chatId ? { ...chat, title: optimisticTitle } : chat
              ),
            }));
          }

          const [firstPage, ...restPages] = current;
          return [
            {
              ...firstPage,
              chats: [optimisticChat, ...firstPage.chats],
            },
            ...restPages,
          ];
        },
        { revalidate: false }
      );
    }

    const attachmentParts = attachments.map((attachment) => ({
        type: "file" as const,
        fileId: attachment.id,
        url: attachment.url,
        name: attachment.name,
        mediaType: attachment.contentType,
        size: attachment.size,
      }));

    sendMessage({
      role: "user",
      parts: [
        ...attachmentParts,
        ...(input.trim() ? [{ type: "text" as const, text: input }] : []),
      ],
    });

    setAttachments([]);
    setLocalStorageInput("");
    setInput("");

    if (width && width > 768) {
      textareaRef.current?.focus();
    }
  }, [
    input,
    getOptimisticTitle,
    setInput,
    attachments,
    sendMessage,
    setAttachments,
    setLocalStorageInput,
    width,
    chatId,
    messages.length,
    mutate,
    selectedVisibilityType,
  ]);

  const updateUploadQueueItem = useCallback(
    (id: string, patch: Partial<UploadQueueItem>) => {
      setUploadQueue((items) =>
        items.map((item) => (item.id === id ? { ...item, ...patch } : item))
      );
    },
    []
  );

  const uploadChunkedFile = useCallback(
    async (file: File, queueId: string) => {
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
      let uploadId: string | undefined;
      const cancelChunkedUpload = async () => {
        if (!uploadId) {
          return;
        }

        await fetch(`${basePath}/api/files/chunked/initiate`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploadId }),
        }).catch(() => {
          // The visible failure state is more important than blocking the UI on cleanup.
        });
      };

      const initiateResponse = await fetch(
        `${basePath}/api/files/chunked/initiate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            size: file.size,
            chatId,
          }),
        }
      );

      if (!initiateResponse.ok) {
        const { error } = await initiateResponse.json();
        throw new Error(error ?? "Failed to start upload");
      }

      const uploadSession = await initiateResponse.json();
      uploadId = uploadSession.uploadId;
      const activeUploadId = String(uploadId);
      const { chunkSize, totalChunks } = uploadSession;

      try {
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
          const start = chunkIndex * chunkSize;
          const end = Math.min(start + chunkSize, file.size);
          const formData = new FormData();
          formData.append("uploadId", activeUploadId);
          formData.append("chunkIndex", String(chunkIndex));
          formData.append("chunk", file.slice(start, end));

          const chunkResponse = await fetch(`${basePath}/api/files/chunked/chunk`, {
            method: "POST",
            body: formData,
          });

          if (!chunkResponse.ok) {
            const { error } = await chunkResponse.json();
            throw new Error(error ?? `Failed to upload chunk ${chunkIndex + 1}`);
          }

          updateUploadQueueItem(queueId, {
            progress: Math.round(((chunkIndex + 1) / totalChunks) * 90),
            status: "uploading",
          });
        }

        updateUploadQueueItem(queueId, {
          progress: 95,
          status: "processing",
        });

        const completeResponse = await fetch(
          `${basePath}/api/files/chunked/complete`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uploadId: activeUploadId }),
          }
        );

        if (!completeResponse.ok) {
          const { error } = await completeResponse.json();
          throw new Error(error ?? "Failed to complete upload");
        }

        return completeResponse.json();
      } catch (error) {
        await cancelChunkedUpload();
        throw error;
      }
    },
    [chatId, updateUploadQueueItem]
  );

  const uploadFile = useCallback(async (file: File, queueId: string) => {
    const canParseOnServer = canServerParseAttachment(file);

    if (file.size > CHUNKED_UPLOAD_MAX_BYTES) {
      throw new Error("File size should be less than 100MB");
    }

    if (!canParseOnServer && !supportsVisionAttachments) {
      toast.info(
        "This file can be stored and previewed, but this model cannot read it directly."
      );
    } else if (
      OCR_ATTACHMENT_TYPES.has(file.type) &&
      !supportsVisionAttachments
    ) {
      toast.info(
        "This model cannot see images directly. The server will try OCR and use recognized text when available."
      );
    }

    if (file.size > STANDARD_UPLOAD_MAX_BYTES) {
      return uploadChunkedFile(file, queueId);
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("chatId", chatId);

    let processingTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      updateUploadQueueItem(queueId, {
        progress: 35,
        status: "uploading",
      });
      const requestPromise = fetch(
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/files/upload`,
        {
          method: "POST",
          body: formData,
        }
      );
      processingTimer = setTimeout(() => {
        updateUploadQueueItem(queueId, {
          progress: 75,
          status: "processing",
        });
      }, 800);
      const response = await requestPromise;

      if (response.ok) {
        updateUploadQueueItem(queueId, {
          progress: 90,
          status: "processing",
        });
        const data = await response.json();
        const { id, url, pathname, contentType, size, parseStatus, textPreview } = data;

        return {
          id,
          url,
          name: pathname,
          contentType,
          size,
          parseStatus,
          textPreview,
        };
      }
      const { error } = await response.json();
      throw new Error(error ?? "Failed to upload file");
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error("Failed to upload file, please try again!");
    } finally {
      if (processingTimer) {
        clearTimeout(processingTimer);
      }
    }
  }, [chatId, supportsVisionAttachments, updateUploadQueueItem, uploadChunkedFile]);

  const removeAttachment = useCallback(
    (attachment: Attachment) => {
      setAttachments((currentAttachments) =>
        currentAttachments.filter((a) => a.url !== attachment.url)
      );

      if (attachment.id) {
        fetch(
          `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/files/${attachment.id}`,
          { method: "DELETE" }
        ).catch(() => {
          toast.error("Failed to delete uploaded file");
        });
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [setAttachments]
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      const queueItems = files.map((file) => ({
        id: generateUUID(),
        name: file.name,
        status: "uploading" as const,
        progress: 0,
      }));

      setUploadQueue((items) => [...items, ...queueItems]);

      try {
        const uploadedAttachments = await Promise.all(
          files.map(async (file, index) => {
            const queueItem = queueItems[index];

            try {
              const attachment = await uploadFile(file, queueItem.id);
              updateUploadQueueItem(queueItem.id, {
                progress: 100,
                status: "processing",
              });
              return attachment;
            } catch (error) {
              updateUploadQueueItem(queueItem.id, {
                status: "error",
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to upload file",
              });
              return undefined;
            }
          })
        );
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment): attachment is Attachment => attachment !== undefined
        );

        setAttachments((currentAttachments) => [
          ...currentAttachments,
          ...successfullyUploadedAttachments,
        ]);
      } catch (_error) {
        toast.error("Failed to upload files");
      } finally {
        setUploadQueue((items) =>
          items.filter((item) => item.status === "error")
        );
      }
    },
    [setAttachments, updateUploadQueueItem, uploadFile]
  );

  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) {
        return;
      }

      const imageItems = Array.from(items).filter((item) =>
        item.type.startsWith("image/")
      );

      if (imageItems.length === 0) {
        return;
      }

      event.preventDefault();

      const queueItems = imageItems
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
        .map((file) => ({
          id: generateUUID(),
          name: file.name || "Pasted image",
          file,
          status: "uploading" as const,
          progress: 0,
        }));

      setUploadQueue((prev) => [
        ...prev,
        ...queueItems.map(({ file: _file, ...item }) => item),
      ]);

      try {
        const uploadedAttachments = await Promise.all(
          queueItems.map(async (item) => {
            try {
              return await uploadFile(item.file, item.id);
            } catch (error) {
              updateUploadQueueItem(item.id, {
                status: "error",
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to upload pasted image",
              });
              return undefined;
            }
          })
        );
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) =>
            attachment !== undefined &&
            attachment.url !== undefined &&
            attachment.contentType !== undefined
        );

        setAttachments((curr) => [
          ...curr,
          ...(successfullyUploadedAttachments as Attachment[]),
        ]);
      } catch (_error) {
        toast.error("Failed to upload pasted image(s)");
      } finally {
        setUploadQueue((items) =>
          items.filter((item) => item.status === "error")
        );
      }
    },
    [setAttachments, updateUploadQueueItem, uploadFile]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.addEventListener("paste", handlePaste);
    return () => textarea.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  const canSubmit = input.trim().length > 0 || attachments.length > 0;
  const hasActiveUpload = uploadQueue.some(
    (item) => item.status === "uploading" || item.status === "processing"
  );

  return (
    <div className={cn("relative flex w-full flex-col gap-4", className)}>
      {editingMessage && onCancelEdit && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>Editing message</span>
          <button
            className="rounded px-1.5 py-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
            onMouseDown={(e) => {
              e.preventDefault();
              onCancelEdit();
            }}
            type="button"
          >
            Cancel
          </button>
        </div>
      )}

      {!editingMessage &&
        !isLoading &&
        messages.length === 0 &&
        attachments.length === 0 &&
        uploadQueue.length === 0 && (
          <SuggestedActions
            chatId={chatId}
            selectedVisibilityType={selectedVisibilityType}
            sendMessage={sendMessage}
          />
        )}

      <input
        accept={fileInputAccept}
        className="pointer-events-none fixed -top-4 -left-4 size-0.5 opacity-0"
        multiple
        onChange={handleFileChange}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />

      <div className="relative">
        {slashOpen && (
          <SlashCommandMenu
            onClose={() => setSlashOpen(false)}
            onSelect={handleSlashSelect}
            query={slashQuery}
            selectedIndex={slashIndex}
          />
        )}
      </div>

      <PromptInput
        className="[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/30 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-shadow [&>div]:duration-300 [&>div]:focus-within:shadow-[var(--shadow-composer-focus)]"
        onSubmit={() => {
          if (input.startsWith("/")) {
            const query = input.slice(1).trim();
            const cmd = slashCommands.find((c) => c.name === query);
            if (cmd) {
              handleSlashSelect(cmd);
            }
            return;
          }
          if (!input.trim() && attachments.length === 0) {
            return;
          }
          if (status === "ready" || status === "error") {
            submitForm();
          } else {
            toast.error("Please wait for the model to finish its response!");
          }
        }}
      >
        {(attachments.length > 0 || uploadQueue.length > 0) && (
          <div
            className="flex w-full self-start flex-row gap-2 overflow-x-auto px-3 pt-3 no-scrollbar"
            data-testid="attachments-preview"
          >
            {attachments.map((attachment) => (
              <PreviewAttachment
                attachment={attachment}
                key={attachment.url}
                onRemove={() => removeAttachment(attachment)}
              />
            ))}

            {uploadQueue.map((item) => (
              <PreviewAttachment
                attachment={{
                  url: "",
                  name: item.name,
                  contentType: "",
                }}
                error={item.error}
                isUploading={item.status !== "error"}
                key={item.id}
                onRemove={
                  item.status === "error"
                    ? () =>
                        setUploadQueue((items) =>
                          items.filter((currentItem) => currentItem.id !== item.id)
                        )
                    : undefined
                }
                progress={item.progress}
                uploadStatus={item.status}
              />
            ))}
          </div>
        )}
        <PromptInputTextarea
          className="min-h-24 text-[13px] leading-relaxed px-4 pt-3.5 pb-1.5 placeholder:text-muted-foreground/35"
          data-testid="multimodal-input"
          onChange={handleInput}
          onKeyDown={(e) => {
            if (slashOpen) {
              const filtered = slashCommands.filter((cmd) =>
                cmd.name.startsWith(slashQuery.toLowerCase())
              );
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIndex((i) => Math.min(i + 1, filtered.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                if (filtered[slashIndex]) {
                  handleSlashSelect(filtered[slashIndex]);
                }
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlashOpen(false);
                return;
              }
            }
            if (e.key === "Escape" && editingMessage && onCancelEdit) {
              e.preventDefault();
              onCancelEdit();
            }
          }}
          placeholder={
            editingMessage ? "Edit your message..." : "Ask anything..."
          }
          ref={textareaRef}
          value={input}
        />
        <PromptInputFooter className="px-3 pb-3">
          <PromptInputTools>
            <AttachmentsButton
              fileInputRef={fileInputRef}
              selectedModelId={selectedModelId}
              status={status}
            />
            <ModelSelectorCompact
              onModelChange={onModelChange}
              selectedModelId={selectedModelId}
            />
          </PromptInputTools>

          {status === "submitted" || status === "streaming" ? (
            <StopButton chatId={chatId} setMessages={setMessages} stop={stop} />
          ) : (
            <PromptInputSubmit
              className={cn(
                "h-7 w-7 rounded-xl transition-all duration-200",
                canSubmit
                  ? "bg-foreground text-background hover:opacity-85 active:scale-95"
                  : "bg-muted text-muted-foreground/25 cursor-not-allowed"
              )}
              data-testid="send-button"
              disabled={!canSubmit || hasActiveUpload}
              status={status}
              variant="secondary"
            >
              <ArrowUpIcon className="size-4" />
            </PromptInputSubmit>
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.input !== nextProps.input) {
      return false;
    }
    if (prevProps.status !== nextProps.status) {
      return false;
    }
    if (!equal(prevProps.attachments, nextProps.attachments)) {
      return false;
    }
    if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
      return false;
    }
    if (prevProps.selectedModelId !== nextProps.selectedModelId) {
      return false;
    }
    if (prevProps.editingMessage !== nextProps.editingMessage) {
      return false;
    }
    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }
    if (prevProps.messages.length !== nextProps.messages.length) {
      return false;
    }

    return true;
  }
);

function PureAttachmentsButton({
  fileInputRef,
  status,
  selectedModelId,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  status: UseChatHelpers<ChatMessage>["status"];
  selectedModelId: string;
}) {
  const { data: modelsResponse } = useSWR(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/models`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false, dedupingInterval: 3_600_000 }
  );

  const caps: Record<string, ModelCapabilities> | undefined =
    modelsResponse?.capabilities ?? modelsResponse;
  const hasVision = caps?.[selectedModelId]?.vision ?? false;
  const isDisabled = status !== "ready";

  return (
    <Button
      className={cn(
        "h-7 w-7 rounded-lg border border-border/40 p-1 transition-colors",
        isDisabled
          ? "text-muted-foreground/30 cursor-not-allowed"
          : hasVision
            ? "text-foreground hover:border-border hover:text-foreground"
            : "text-muted-foreground hover:border-border hover:text-foreground"
      )}
      data-testid="attachments-button"
      disabled={isDisabled}
      onClick={(event) => {
        event.preventDefault();
        fileInputRef.current?.click();
      }}
      title={hasVision ? "Attach files" : "Attach files"}
      variant="ghost"
    >
      <PaperclipIcon size={14} style={{ width: 14, height: 14 }} />
    </Button>
  );
}

const AttachmentsButton = memo(PureAttachmentsButton);

function PureModelSelectorCompact({
  selectedModelId,
  onModelChange,
}: {
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: modelsData } = useSWR(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/models`,
    (url: string) => fetch(url).then((r) => r.json()),
    { revalidateOnFocus: false, dedupingInterval: 3_600_000 }
  );

  const capabilities: Record<string, ModelCapabilities> | undefined =
    modelsData?.capabilities ?? modelsData;
  const dynamicModels: ChatModel[] | undefined = modelsData?.models;
  const activeModels = dynamicModels ?? chatModels;

  const selectedModel =
    activeModels.find((m: ChatModel) => m.id === selectedModelId) ??
    activeModels.find((m: ChatModel) => m.id === DEFAULT_CHAT_MODEL) ??
    activeModels[0];
  const provider = selectedModel.provider;

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button
          className="h-8 max-w-[240px] justify-between gap-2 rounded-lg border border-border/40 bg-background/70 px-2.5 text-[12px] text-muted-foreground shadow-none transition-colors hover:border-border hover:text-foreground"
          data-testid="model-selector"
          variant="ghost"
        >
          <span className="hidden text-[11px] text-muted-foreground/70 sm:inline">
            Model
          </span>
          {provider && <ModelSelectorLogo provider={provider} />}
          <ModelSelectorName>{selectedModel.name}</ModelSelectorName>
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Model selection">
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          {(() => {
            const allModels = activeModels;

            const grouped: Record<
              string,
              { model: ChatModel; curated: boolean }[]
            > = {};
            for (const model of allModels) {
              const key = "_available";
              if (!grouped[key]) {
                grouped[key] = [];
              }
              grouped[key].push({ model, curated: true });
            }

            const sortedKeys = Object.keys(grouped).sort((a, b) => {
              if (a === "_available") {
                return -1;
              }
              if (b === "_available") {
                return 1;
              }
              return a.localeCompare(b);
            });

            const providerNames: Record<string, string> = {
              alibaba: "Alibaba",
              anthropic: "Anthropic",
              "arcee-ai": "Arcee AI",
              bytedance: "ByteDance",
              cohere: "Cohere",
              deepseek: "DeepSeek",
              google: "Google",
              inception: "Inception",
              kwaipilot: "Kwaipilot",
              meituan: "Meituan",
              meta: "Meta",
              minimax: "MiniMax",
              mistral: "Mistral",
              moonshotai: "Moonshot",
              morph: "Morph",
              nvidia: "Nvidia",
              openai: "OpenAI",
              perplexity: "Perplexity",
              "prime-intellect": "Prime Intellect",
              xiaomi: "Xiaomi",
              xai: "xAI",
              zai: "Zai",
            };

            return sortedKeys.map((key) => (
              <ModelSelectorGroup
                heading={
                  key === "_available"
                    ? "Available"
                    : (providerNames[key] ?? key)
                }
                key={key}
              >
                {grouped[key].map(({ model, curated }) => {
                  const modelCapabilities = capabilities?.[model.id];
                  return (
                    <ModelSelectorItem
                      className={cn(
                        "flex w-full items-start gap-2 py-2",
                        model.id === selectedModel.id &&
                          "border-b border-dashed border-foreground/50",
                        !curated && "opacity-40 cursor-default"
                      )}
                      key={model.id}
                      onSelect={() => {
                        if (!curated) {
                          return;
                        }
                        onModelChange?.(model.id);
                        setCookie("chat-model", model.id);
                        setOpen(false);
                        setTimeout(() => {
                          document
                            .querySelector<HTMLTextAreaElement>(
                              "[data-testid='multimodal-input']"
                            )
                            ?.focus();
                        }, 50);
                      }}
                      value={model.id}
                    >
                      <ModelSelectorLogo
                        className="mt-0.5"
                        provider={model.provider}
                      />
                      <div className="min-w-0 flex-1">
                        <ModelSelectorName className="block">
                          {model.name}
                        </ModelSelectorName>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {model.description}
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {modelCapabilities?.tools && (
                            <CapabilityTag icon={<WrenchIcon />} label="Tools" />
                          )}
                          {modelCapabilities?.vision && (
                            <CapabilityTag icon={<EyeIcon />} label="Vision" />
                          )}
                          {modelCapabilities?.reasoning && (
                            <CapabilityTag
                              icon={<BrainIcon />}
                              label="Reasoning"
                            />
                          )}
                        </div>
                      </div>
                      <div className="ml-auto flex items-center gap-2 pt-0.5 text-foreground/70">
                        {!curated && (
                          <LockIcon className="size-3 text-muted-foreground/50" />
                        )}
                      </div>
                    </ModelSelectorItem>
                  );
                })}
              </ModelSelectorGroup>
            ));
          })()}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

const ModelSelectorCompact = memo(PureModelSelectorCompact);

function CapabilityTag({
  icon,
  label,
}: {
  icon: ReactElement<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {cloneElement(icon, { className: "size-3" })}
      {label}
    </span>
  );
}

function PureStopButton({
  chatId,
  stop,
  setMessages,
}: {
  chatId: string;
  stop: () => void;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
}) {
  const { mutate } = useSWRConfig();

  return (
    <Button
      className="h-7 w-7 rounded-xl bg-foreground p-1 text-background transition-all duration-200 hover:opacity-85 active:scale-95 disabled:bg-muted disabled:text-muted-foreground/25 disabled:cursor-not-allowed"
      data-testid="stop-button"
      onClick={(event) => {
        event.preventDefault();
        stop();
        setMessages((messages) => {
          const lastMessage = messages.at(-1);
          if (lastMessage?.role === "assistant") {
            const hasContent = lastMessage.parts?.some(
              (part) =>
                (part.type === "text" && part.text?.trim()) ||
                (part.type === "reasoning" &&
                  "text" in part &&
                  part.text?.trim()) ||
                part.type.startsWith("tool-")
            );

            if (hasContent) {
              return messages;
            }

            return [
              ...messages.slice(0, -1),
              {
                ...lastMessage,
                metadata: {
                  ...lastMessage.metadata,
                  createdAt:
                    lastMessage.metadata?.createdAt ??
                    new Date().toISOString(),
                  status: "aborted" as const,
                },
                parts: [{ type: "text" as const, text: "Generation stopped." }],
              },
            ];
          }

          return [
            ...messages,
            {
              id: generateUUID(),
              role: "assistant" as const,
              metadata: {
                createdAt: new Date().toISOString(),
                status: "aborted" as const,
              },
              parts: [{ type: "text" as const, text: "Generation stopped." }],
            },
          ];
        });
        toast("Generation stopped. Partial response is kept.");
        setTimeout(() => {
          mutate(
            `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/messages?chatId=${chatId}`
          );
          mutate(unstable_serialize(getChatHistoryPaginationKey));
        }, 800);
      }}
    >
      <StopIcon size={14} />
    </Button>
  );
}

const StopButton = memo(PureStopButton);
