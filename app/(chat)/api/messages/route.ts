import { auth } from "@/app/(auth)/auth";
import {
  deleteMessagesByChatIdAfterTimestamp,
  getChatById,
  getMessageById,
  getMessagesByChatId,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { convertToUIMessages } from "@/lib/utils";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId");

  if (!chatId) {
    return Response.json({ error: "chatId required" }, { status: 400 });
  }

  const [session, chat, messages] = await Promise.all([
    auth(),
    getChatById({ conversationId: chatId }),
    getMessagesByChatId({ conversationId: chatId }),
  ]);

  if (!chat) {
    return Response.json({
      messages: [],
      visibility: "private",
      userId: null,
      isReadonly: false,
    });
  }

  if (
    chat.visibility === "private" &&
    (!session?.user || session.user.id !== chat.userId)
  ) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const isReadonly = !session?.user || session.user.id !== chat.userId;

  return Response.json({
    title: chat.title,
    messages: convertToUIMessages(messages),
    visibility: chat.visibility,
    userId: chat.userId,
    isReadonly,
  });
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let id: string | undefined;
  let chatId: string | undefined;

  try {
    const body = await request.json();
    id = body.id;
    chatId = body.chatId;
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  if (!id) {
    return Response.json({ error: "message id required" }, { status: 400 });
  }

  let message: DBMessage | undefined = (await getMessageById({ id }))[0];

  if (!message && chatId) {
    const chat = await getChatById({ conversationId: chatId });
    if (!chat || chat.userId !== session.user.id) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }

    const messages = await getMessagesByChatId({ conversationId: chatId });
    message = [...messages].reverse().find((item) => item.role === "assistant");
  }

  if (!message) {
    return Response.json({ error: "message not found" }, { status: 404 });
  }

  const chat = await getChatById({ conversationId: message.chatId });
  if (!chat || chat.userId !== session.user.id) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  await deleteMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
  });

  return Response.json({ ok: true });
}
