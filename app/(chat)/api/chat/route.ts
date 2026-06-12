import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
} from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import {
  allowedModelIds,
  DEFAULT_CHAT_MODEL,
  getCapabilities,
} from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { createDocument } from "@/lib/ai/tools/create-document";
import { editDocument } from "@/lib/ai/tools/edit-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { checkIpRateLimit } from "@/lib/ratelimit";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

const stoppedResponseText = "Generation stopped.";
const failedResponseText =
  "I couldn't complete this response. It may be a network issue or the model provider is temporarily unavailable. Please try again or regenerate the response.";

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

/**
 * POST /api/chat - Handle AI conversation with streaming
 *
 * Endpoint for sending messages and receiving AI responses.
 * Supports streaming responses with standard chunk format.
 *
 * Request:
 * {
 *   conversationId: string,      // UUID of the conversation
 *   message: { role, parts },    // User message
 *   selectedChatModel: string,   // Model to use
 *   selectedVisibilityType: string,
 *   stream: boolean,             // Default: true
 *   requestId?: string           // For tracking and reconnection
 * }
 *
 * Response (streaming):
 * {
 *   type: "chunk|done|error",
 *   conversationId: string,
 *   messageId: string,
 *   requestId: string,
 *   timestamp: number,
 *   status: "streaming|done|error|aborted",
 *   payload: { ... }
 * }
 */
export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (error) {
    return new ChatbotError("bad_request:api",
      "Invalid request body. Check parameters: conversationId, message, selectedChatModel, selectedVisibilityType").toResponse();
  }

  try {
    // Extract and rename 'conversationId' from request
    const {
      conversationId,
      message,
      messages,
      selectedChatModel,
      selectedVisibilityType,
      stream = true,
      requestId: providedRequestId
    } = requestBody;

    // Validate conversationId
    if (!conversationId) {
      return new ChatbotError("bad_request:api",
        "conversationId is required").toResponse();
    }

    // Check authentication
    const session = await auth();
    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    // Validate model
    const chatModel = allowedModelIds.has(selectedChatModel)
      ? selectedChatModel
      : DEFAULT_CHAT_MODEL;

    // Rate limiting by IP
    const forwardedFor = request.headers.get("x-forwarded-for");
    const clientIp =
      forwardedFor?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      undefined;
    await checkIpRateLimit(clientIp);

    // Check user entitlements
    const userType: UserType = session.user.type;
    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 1,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    // Determine if this is a tool approval flow
    const isToolApprovalFlow = Boolean(messages);
    const userMessage = message
      ? ({
          ...message,
          id: message.id ?? generateUUID(),
        } as ChatMessage)
      : undefined;

    // Get or create chat
    const chat = await getChatById({ conversationId });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      // Verify ownership
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ conversationId });
    } else if (userMessage?.role === "user") {
      // Create new chat
      await saveChat({
        id: conversationId,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message: userMessage });
    } else {
      return new ChatbotError("not_found:chat",
        "Conversation not found and no message provided").toResponse();
    }

    // Build UI messages
    let uiMessages: ChatMessage[];

    if (isToolApprovalFlow && messages) {
      const dbMessages = convertToUIMessages(messagesFromDb);
      const approvalStates = new Map(
        messages.flatMap(
          (m) =>
            m.parts
              ?.filter(
                (p: Record<string, unknown>) =>
                  p.state === "approval-responded" ||
                  p.state === "output-denied"
              )
              .map((p: Record<string, unknown>) => [
                String(p.toolCallId ?? ""),
                p,
              ]) ?? []
        )
      );
      uiMessages = dbMessages.map((msg) => ({
        ...msg,
        parts: msg.parts.map((part) => {
          if (
            "toolCallId" in part &&
            approvalStates.has(String(part.toolCallId))
          ) {
            return { ...part, ...approvalStates.get(String(part.toolCallId)) };
          }
          return part;
        }),
      })) as ChatMessage[];
    } else {
      uiMessages = [
        ...convertToUIMessages(messagesFromDb),
        userMessage as ChatMessage,
      ];
    }

    // Get location hints from headers
    const requestHints: RequestHints = {
      longitude: request.headers.get("x-user-longitude") ?? undefined,
      latitude: request.headers.get("x-user-latitude") ?? undefined,
      city: request.headers.get("x-user-city") ?? undefined,
      country: request.headers.get("x-user-country") ?? undefined,
    };

    // Save user message to database
    if (userMessage?.role === "user") {
      const [existingUserMessage] = await getMessageById({
        id: userMessage.id,
      });

      if (!existingUserMessage) {
        await saveMessages({
          messages: [
            {
              chatId: conversationId,
              id: userMessage.id,
              role: "user",
              parts: userMessage.parts,
              attachments: [],
              status: "done",
              createdAt: new Date(),
              updatedAt: new Date(),
              requestId: null,
            },
          ],
        });
      }
    }

    // Generate assistant message ID and request ID
    const assistantMessageId = generateUUID();
    const streamRequestId = providedRequestId ?? generateUUID();

    if (!isToolApprovalFlow) {
      await saveMessages({
        messages: [
          {
            chatId: conversationId,
            id: assistantMessageId,
            role: "assistant",
            parts: [],
            attachments: [],
            status: "pending",
            requestId: streamRequestId,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });
    }

    // Get model capabilities
    const modelCapabilities = await getCapabilities();
    const capabilities = modelCapabilities[chatModel];
    const isReasoningModel = capabilities?.reasoning === true;
    const supportsTools = capabilities?.tools === true;

    // Convert to model messages
    const modelMessages = await convertToModelMessages(uiMessages);
    let partialAssistantText = "";
    let partialAssistantReasoning = "";
    let hasMarkedStreaming = false;

    // Create streaming response
    const messageStream = createUIMessageStream({
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
      execute: async ({ writer: dataStream }) => {
        const result = streamText({
          model: getLanguageModel(chatModel),
          abortSignal: request.signal,
          system: systemPrompt({ requestHints, supportsTools }),
          messages: modelMessages,
          stopWhen: stepCountIs(5),
          experimental_activeTools: supportsTools
            ? [
                "getWeather",
                "createDocument",
                "editDocument",
                "updateDocument",
                "requestSuggestions",
              ]
            : [],
          tools: {
            getWeather,
            createDocument: createDocument({
              session,
              dataStream,
              modelId: chatModel,
            }),
            editDocument: editDocument({ dataStream, session }),
            updateDocument: updateDocument({
              session,
              dataStream,
              modelId: chatModel,
            }),
            requestSuggestions: requestSuggestions({
              session,
              dataStream,
              modelId: chatModel,
            }),
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: "stream-text",
          },
          onChunk: async ({ chunk }) => {
            if (!isToolApprovalFlow && !hasMarkedStreaming) {
              hasMarkedStreaming = true;
              await updateMessage({
                id: assistantMessageId,
                status: "streaming",
              });
            }
            if (chunk.type === "text-delta") {
              partialAssistantText += chunk.text;
            }
            if (chunk.type === "reasoning-delta") {
              partialAssistantReasoning += chunk.text;
            }
          },
          onAbort: async () => {
            const text = partialAssistantText.trim();
            const reasoning = partialAssistantReasoning.trim();

            // Only save if there's actual content
            if (!text && !reasoning) {
              if (!isToolApprovalFlow) {
                await updateMessage({
                  id: assistantMessageId,
                  parts: [{ type: "text", text: stoppedResponseText }],
                  status: "aborted",
                });
              }
              return;
            }

            if (!isToolApprovalFlow) {
              await updateMessage({
                id: assistantMessageId,
                parts: [
                  ...(reasoning
                    ? [{ type: "reasoning", text: reasoning } as const]
                    : []),
                  {
                    type: "text",
                    text: `${text}${text ? "\n\n" : ""}_Generation stopped._`,
                  },
                ],
                status: "aborted",
              });
            }
          },
        });

        // Merge AI response stream
        dataStream.merge(
          result.toUIMessageStream({ sendReasoning: isReasoningModel })
        );

        // Update chat title if new chat
        if (titlePromise) {
          try {
            const title = await titlePromise;
            dataStream.write({ type: "data-chat-title", data: title });
            await updateChatTitleById({ chatId: conversationId, title });
          } catch (_) {
            /* non-fatal */
          }
        }
      },
      generateId: () => (isToolApprovalFlow ? generateUUID() : assistantMessageId),
      onFinish: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          // Handle tool approval flow
          for (const finishedMsg of finishedMessages) {
            const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
            if (existingMsg) {
              await updateMessage({
                id: finishedMsg.id,
                parts: finishedMsg.parts,
                status: "done",
              });
            } else {
              await saveMessages({
                messages: [
                  {
                    id: finishedMsg.id,
                    role: finishedMsg.role,
                    parts: finishedMsg.parts,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    attachments: [],
                    chatId: conversationId,
                    status: "done",
                    requestId: streamRequestId,
                  },
                ],
              });
            }
          }
        } else if (finishedMessages.length > 0) {
          // Update assistant message with final content and status
          const assistantMsg = [...finishedMessages]
            .reverse()
            .find((m) => m.role === "assistant");

          if (assistantMsg) {
            await updateMessage({
              id: assistantMessageId,
              parts: assistantMsg.parts,
              status: "done",
            });
          } else {
            const text = partialAssistantText.trim();
            const reasoning = partialAssistantReasoning.trim();
            await updateMessage({
              id: assistantMessageId,
              parts: [
                ...(reasoning
                  ? [{ type: "reasoning", text: reasoning } as const]
                  : []),
                ...(text ? [{ type: "text", text } as const] : []),
              ],
              status: "done",
            });
          }
        }
      },
      onError: (error) => {
        console.error("Model stream failed:", error);
        if (!isToolApprovalFlow) {
          updateMessage({
            id: assistantMessageId,
            parts: [{ type: "text", text: failedResponseText }],
            status: "error",
          }).catch((updateError) => {
            console.error("Failed to mark assistant message as error:", updateError);
          });
        }
        return "Oops, an error occurred!";
      },
    });

    return createUIMessageStreamResponse({
      stream: messageStream,
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            await createStreamId({
              streamId: streamRequestId,
              chatId: conversationId
            });
            await streamContext.createNewResumableStream(
              streamRequestId,
              () => sseStream
            );
          }
        } catch (_) {
          /* non-critical */
        }
      },
    });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    console.error("Unhandled error in chat API:", error);
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId") ?? searchParams.get("id");

  if (!conversationId) {
    return new ChatbotError("bad_request:api",
      "conversationId parameter is required").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ conversationId });

  if (!chat || chat.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ conversationId });

  return Response.json(deletedChat, { status: 200 });
}
