import { auth } from "@/app/(auth)/auth";
import { getChatById, getMessagesByChatId } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { getStreamSnapshot } from "@/lib/stream-cache";
import { z } from "zod";

/**
 * GET /api/resume
 * 
 * Retrieve message history for conversation recovery
 * Used when a streaming connection is interrupted
 * 
 * Query Parameters:
 * - conversationId: UUID of the conversation
 * - lastMessageId: (optional) Return messages after this ID for pagination
 * - limit: (optional) Number of messages to return (default: 50, max: 100)
 * 
 * Response:
 * {
 *   conversationId: string
 *   messages: Message[]
 *   hasMore: boolean  // true if there are more messages to load
 *   lastMessageTimestamp: string  // ISO timestamp of last message
 * }
 */

const querySchema = z.object({
  id: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  lastMessageId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine((body) => body.conversationId || body.id, {
  message: "conversationId is required",
  path: ["conversationId"],
}).transform((body) => ({
  ...body,
  conversationId: body.conversationId ?? body.id!,
}));

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const parsed = querySchema.safeParse({
      id: searchParams.get("id") ?? undefined,
      conversationId: searchParams.get("conversationId") ?? undefined,
      lastMessageId: searchParams.get("lastMessageId") ?? undefined,
      limit: searchParams.get("limit"),
    });

    if (!parsed.success) {
      return new ChatbotError(
        "bad_request:api",
        "Invalid parameters: conversationId and limit required"
      ).toResponse();
    }

    const { conversationId, lastMessageId, limit } = parsed.data;

    const session = await auth();
    if (!session?.user?.id) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    // Verify chat ownership
    const chat = await getChatById({ conversationId });
    if (!chat) {
      return new ChatbotError("not_found:chat").toResponse();
    }

    if (chat.userId !== session.user.id) {
      return new ChatbotError("forbidden:chat").toResponse();
    }

    // Get all messages for this conversation
    const allMessages = await getMessagesByChatId({ conversationId });

    // Find the index of the last message if specified
    let startIndex = 0;
    if (lastMessageId) {
      startIndex = allMessages.findIndex((msg) => msg.id === lastMessageId) + 1;
      if (startIndex === 0) {
        // Message not found, return empty
        return Response.json(
          {
            conversationId,
            messages: [],
            hasMore: false,
            lastMessageTimestamp: new Date().toISOString(),
          },
          { status: 200 }
        );
      }
    }

    // Get the requested slice of messages
    const messages = allMessages.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allMessages.length;
    const lastMessageTimestamp =
      messages.length > 0
        ? messages[messages.length - 1].updatedAt ||
          messages[messages.length - 1].createdAt
        : new Date();

    return Response.json(
      {
        conversationId,
        messages,
        hasMore,
        lastMessageTimestamp: lastMessageTimestamp.toISOString(),
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Resume error:", error);
    return new ChatbotError(
      "bad_request:api",
      "Failed to retrieve conversation history"
    ).toResponse();
  }
}

/**
 * POST /api/resume/reconnect
 * 
 * Attempt to reconnect a streaming request
 * Returns the status of a previous request for reconnection
 * 
 * Request Body:
 * {
 *   conversationId: UUID
 *   requestId: UUID (from original request)
 * }
 * 
 * Response:
 * {
 *   conversationId: string
 *   requestId: string
 *   status: "pending" | "streaming" | "done" | "error" | "aborted"
 *   lastMessageId: string  // ID of the last message for this request
 *   canReconnect: boolean  // true if request can be resumed
 * }
 */

const reconnectSchema = z.object({
  id: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  requestId: z.string().uuid(),
  offset: z.coerce.number().int().min(0).default(0),
}).refine((body) => body.conversationId || body.id, {
  message: "conversationId is required",
  path: ["conversationId"],
}).transform((body) => ({
  ...body,
  conversationId: body.conversationId ?? body.id!,
}));

export async function POST(request: Request) {
  try {
    const parsed = reconnectSchema.safeParse(await request.json());

    if (!parsed.success) {
      return new ChatbotError(
        "bad_request:api",
        "conversationId and requestId are required"
      ).toResponse();
    }

    const { conversationId, requestId, offset } = parsed.data;

    const session = await auth();
    if (!session?.user?.id) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    // Verify chat ownership
    const chat = await getChatById({ conversationId });
    if (!chat) {
      return new ChatbotError("not_found:chat").toResponse();
    }

    if (chat.userId !== session.user.id) {
      return new ChatbotError("forbidden:chat").toResponse();
    }

    // Get messages for this conversation
    const messages = await getMessagesByChatId({ conversationId });

    // Find the message with matching requestId
    const targetMessage = messages.find((msg) => msg.requestId === requestId);

    if (!targetMessage) {
      return Response.json(
        {
          conversationId,
          requestId,
          status: "unknown",
          lastMessageId: null,
          canReconnect: false,
        },
        { status: 200 }
      );
    }

    // Determine if we can reconnect based on status
    const canReconnect =
      targetMessage.status === "pending" || targetMessage.status === "streaming";
    const streamSnapshot = canReconnect
      ? await getStreamSnapshot({
          conversationId,
          messageId: targetMessage.id,
          offset,
        })
      : null;

    return Response.json(
      {
        conversationId,
        requestId,
        status: targetMessage.status,
        lastMessageId: targetMessage.id,
        canReconnect,
        stream: streamSnapshot,
        partialContent: canReconnect ? targetMessage.parts : undefined,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Reconnect error:", error);
    return new ChatbotError(
      "bad_request:api",
      "Failed to check request status"
    ).toResponse();
  }
}
