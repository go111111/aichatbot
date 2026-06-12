"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateChatTitle } from "@/app/(chat)/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function RenameChatDialog({
  chatId,
  onOpenChange,
  onRenamed,
  open,
  title,
}: {
  chatId: string;
  onOpenChange: (open: boolean) => void;
  onRenamed?: (title: string) => void;
  open: boolean;
  title: string;
}) {
  const [value, setValue] = useState(title);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setValue(title);
    }
  }, [open, title]);

  const normalizedTitle = value.trim().replace(/\s+/g, " ");
  const canSubmit =
    normalizedTitle.length > 0 && normalizedTitle !== title.trim();

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Rename chat</DialogTitle>
          <DialogDescription>
            Give this conversation a clear name for the sidebar history.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || isPending) {
              return;
            }

            startTransition(async () => {
              try {
                await updateChatTitle({ chatId, title: normalizedTitle });
                onRenamed?.(normalizedTitle);
                onOpenChange(false);
                toast.success("Chat renamed");
              } catch (error) {
                toast.error(
                  error instanceof Error
                    ? error.message
                    : "Failed to rename chat"
                );
              }
            });
          }}
        >
          <Input
            autoFocus
            maxLength={80}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Chat title"
            value={value}
          />

          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={!canSubmit || isPending} type="submit">
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
