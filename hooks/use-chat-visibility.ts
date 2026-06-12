"use client";

import { useMemo } from "react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { updateChatVisibility } from "@/app/(chat)/actions";
import {
  type ChatHistory,
  getChatHistoryPaginationKey,
} from "@/components/chat/sidebar-history";
import type { VisibilityType } from "@/components/chat/visibility-selector";

export function useChatVisibility({
  chatId,
  initialVisibilityType,
}: {
  chatId: string;
  initialVisibilityType: VisibilityType;
}) {
  const { mutate, cache } = useSWRConfig();
  const history: ChatHistory[] | undefined = cache.get(
    unstable_serialize(getChatHistoryPaginationKey)
  )?.data;

  const { data: localVisibility, mutate: setLocalVisibility } = useSWR(
    `${chatId}-visibility`,
    null
  );

  const visibilityType = useMemo(() => {
    if (localVisibility) {
      return localVisibility;
    }

    const chat = history
      ?.flatMap((page) => page.chats)
      .find((currentChat) => currentChat.id === chatId);

    if (!chat) {
      return initialVisibilityType;
    }

    return chat.visibility;
  }, [history, chatId, initialVisibilityType, localVisibility]);

  const setVisibilityType = (updatedVisibilityType: VisibilityType) => {
    setLocalVisibility(updatedVisibilityType, false);

    mutate<ChatHistory[]>(
      unstable_serialize(getChatHistoryPaginationKey),
      (current) =>
        current?.map((page) => ({
          ...page,
          chats: page.chats.map((chat) =>
            chat.id === chatId
              ? { ...chat, visibility: updatedVisibilityType }
              : chat
          ),
        })),
      { revalidate: false }
    );

    mutate(
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/messages?chatId=${chatId}`,
      (current: any) =>
        current ? { ...current, visibility: updatedVisibilityType } : current,
      { revalidate: false }
    );

    const chatExists = history
      ?.flatMap((page) => page.chats)
      .some((chat) => chat.id === chatId);

    if (!chatExists) {
      toast.success(
        `New chat will be ${updatedVisibilityType === "public" ? "public" : "private"}`
      );
      return;
    }

    updateChatVisibility({
      chatId,
      visibility: updatedVisibilityType,
    })
      .then(() => {
        toast.success(
          `Chat is now ${updatedVisibilityType === "public" ? "public" : "private"}`
        );
      })
      .catch(() => {
        setLocalVisibility(visibilityType, false);
        mutate(unstable_serialize(getChatHistoryPaginationKey));
        mutate(
          `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/messages?chatId=${chatId}`
        );
        toast.error("Failed to update chat visibility");
      });
  };

  return { visibilityType, setVisibilityType };
}
