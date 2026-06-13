"use client";

import { PanelLeftIcon, PencilIcon } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
import { getChatHistoryPaginationKey } from "./sidebar-history";
import { ShareIcon } from "./icons";
import { RenameChatDialog } from "./rename-chat-dialog";
import { VisibilitySelector, type VisibilityType } from "./visibility-selector";

function PureChatHeader({
  canRename,
  chatTitle,
  chatId,
  selectedVisibilityType,
  isReadonly,
}: {
  canRename: boolean;
  chatTitle: string;
  chatId: string;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
}) {
  const { state, toggleSidebar, isMobile } = useSidebar();
  const { mutate } = useSWRConfig();
  const [renameOpen, setRenameOpen] = useState(false);
  const copyShareLink = async () => {
    if (selectedVisibilityType !== "public") {
      toast.info("Make this chat public before sharing.");
      return;
    }

    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
    const url = `${window.location.origin}${basePath}/chat/${chatId}`;
    await navigator.clipboard.writeText(url);
    toast.success("Share link copied");
  };

  if (state === "collapsed" && !isMobile) {
    return null;
  }

  return (
    <header className="sticky top-0 flex h-14 items-center justify-between gap-3 border-b border-sidebar-border/50 bg-sidebar px-3">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          className="md:hidden"
          onClick={toggleSidebar}
          size="icon-sm"
          variant="ghost"
        >
          <PanelLeftIcon className="size-4" />
        </Button>

        <div className="group/title flex min-w-0 items-center gap-1.5">
          <h1 className="max-w-[48vw] truncate text-[13px] font-medium text-sidebar-foreground sm:max-w-[360px]">
            {chatTitle}
          </h1>
          {!isReadonly && canRename && (
            <Button
              className="size-7 shrink-0 text-sidebar-foreground/40 opacity-0 transition-opacity hover:text-sidebar-foreground group-hover/title:opacity-100 focus-visible:opacity-100"
              onClick={() => setRenameOpen(true)}
              size="icon-sm"
              title="Rename chat"
              variant="ghost"
            >
              <PencilIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {!isReadonly && (
        <div className="flex shrink-0 items-center gap-2">
          <VisibilitySelector
            chatId={chatId}
            selectedVisibilityType={selectedVisibilityType}
          />
          <Button
            className="gap-1.5 rounded-lg border-border/50 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:ring-0 focus-visible:border-border/50 active:translate-y-0"
            onClick={copyShareLink}
            size="sm"
            title="Copy public share link"
            variant="outline"
          >
            <ShareIcon />
            <span className="hidden sm:inline">Share</span>
          </Button>
        </div>
      )}

      <RenameChatDialog
        chatId={chatId}
        onOpenChange={setRenameOpen}
        onRenamed={() => {
          mutate(
            `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/messages?chatId=${chatId}`
          );
          mutate(unstable_serialize(getChatHistoryPaginationKey));
        }}
        open={renameOpen}
        title={chatTitle}
      />
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader, (prevProps, nextProps) => {
  return (
    prevProps.chatId === nextProps.chatId &&
    prevProps.canRename === nextProps.canRename &&
    prevProps.chatTitle === nextProps.chatTitle &&
    prevProps.selectedVisibilityType === nextProps.selectedVisibilityType &&
    prevProps.isReadonly === nextProps.isReadonly
  );
});
