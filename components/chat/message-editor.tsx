"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatMessage } from "@/lib/types";

export async function submitEditedMessage({
  chatId,
  message,
  text,
  setMessages,
  regenerate,
}: {
  chatId: string;
  message: ChatMessage;
  text: string;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
}) {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/messages`,
    {
      method: "DELETE",
      body: JSON.stringify({ id: message.id, chatId }),
    }
  );

  if (!response.ok) {
    throw new Error("Failed to delete trailing messages");
  }

  setMessages((messages) => {
    const index = messages.findIndex((m) => m.id === message.id);
    if (index === -1) {
      return messages;
    }

    return [
      ...messages.slice(0, index),
      { ...message, parts: [{ type: "text" as const, text }] },
    ];
  });

  regenerate();
}
