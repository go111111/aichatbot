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
  getFileChunksByFileIdsForUser,
  getFilesByChatIdForUser,
  getFilesByIdsForUser,
  getMessageById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage, FileChunk, FileRecord } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { checkIpRateLimit } from "@/lib/ratelimit";
import { deleteStoredUploadFile } from "@/lib/files/storage";
import {
  appendStreamChunk,
  markStreamCache,
  startStreamCache,
} from "@/lib/stream-cache";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

const stoppedResponseText = "Generation stopped.";
const failedResponseText =
  "I couldn't complete this response. It may be a network issue or the model provider is temporarily unavailable. Please try again or regenerate the response.";
const KNOWLEDGE_TOP_K = 5;
const FALLBACK_CHUNK_COUNT = 3;
const LEGACY_CHUNK_CHAR_LENGTH = 1200;
const LEGACY_CHUNK_OVERLAP_CHARS = 150;

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

function getReferencedFileIds(message?: ChatMessage) {
  if (!message) {
    return [];
  }

  return Array.from(
    new Set(
      message.parts
        .filter((part) => part.type === "file")
        .map((part) => (part as { fileId?: string }).fileId)
        .filter((fileId): fileId is string => Boolean(fileId))
    )
  );
}

function getUserQuestionText(message?: ChatMessage) {
  if (!message) {
    return "";
  }

  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

function addKeyword(keywords: Map<string, number>, keyword: string) {
  const normalizedKeyword = keyword.toLowerCase().trim();

  if (normalizedKeyword.length < 2) {
    return;
  }

  keywords.set(normalizedKeyword, (keywords.get(normalizedKeyword) ?? 0) + 1);
}

function extractKeywords(text: string) {
  const keywords = new Map<string, number>();
  const englishTokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const cjkSegments = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const stopwords = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "what",
    "how",
    "why",
    "请问",
    "这个",
    "文件",
    "内容",
    "一下",
    "帮我",
    "总结",
    "如何",
    "怎么",
  ]);

  for (const token of englishTokens) {
    if (!stopwords.has(token)) {
      addKeyword(keywords, token);
    }
  }

  for (const segment of cjkSegments) {
    if (!stopwords.has(segment)) {
      addKeyword(keywords, segment);
    }

    for (let index = 0; index < segment.length - 1; index += 1) {
      const bigram = segment.slice(index, index + 2);
      if (!stopwords.has(bigram)) {
        addKeyword(keywords, bigram);
      }
    }

    for (let index = 0; index < segment.length - 2; index += 1) {
      const trigram = segment.slice(index, index + 3);
      if (!stopwords.has(trigram)) {
        addKeyword(keywords, trigram);
      }
    }
  }

  return Array.from(keywords.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 16)
    .map(([keyword]) => keyword);
}

function countOccurrences(content: string, keyword: string) {
  let count = 0;
  let fromIndex = 0;

  while (fromIndex < content.length) {
    const matchIndex = content.indexOf(keyword, fromIndex);

    if (matchIndex === -1) {
      break;
    }

    count += 1;
    fromIndex = matchIndex + keyword.length;
  }

  return count;
}

function scoreChunk(content: string, keywords: string[]) {
  const normalizedContent = content.toLowerCase();

  return keywords.reduce((score, keyword) => {
    const occurrences = countOccurrences(normalizedContent, keyword);
    const weight = keyword.length >= 4 ? 2 : 1;
    return score + occurrences * weight;
  }, 0);
}

function createLegacyChunksFromFiles(files: FileRecord[]) {
  const parsedFiles = files.filter(
    (currentFile) => currentFile.parseStatus === "parsed" && currentFile.content
  );

  return parsedFiles.flatMap((currentFile) => {
    const content = (currentFile.content ?? "").trim();
    const chunks: FileChunk[] = [];
    let start = 0;
    let chunkIndex = 0;

    while (start < content.length) {
      const end = Math.min(start + LEGACY_CHUNK_CHAR_LENGTH, content.length);
      const chunk = content.slice(start, end).trim();

      if (chunk) {
        chunks.push({
          id: `${currentFile.id}-${chunkIndex}`,
          fileId: currentFile.id,
          userId: currentFile.userId,
          chatId: currentFile.chatId,
          chunkIndex,
          content: chunk,
          charCount: chunk.length,
          createdAt: currentFile.createdAt,
        });
        chunkIndex += 1;
      }

      if (end >= content.length) {
        break;
      }

      start = Math.max(0, end - LEGACY_CHUNK_OVERLAP_CHARS);
    }

    return chunks;
  });
}

function buildRetrievedKnowledgeContext({
  files,
  chunks,
  questionText,
}: {
  files: FileRecord[];
  chunks: FileChunk[];
  questionText: string;
}) {
  const fileNameById = new Map(files.map((currentFile) => [currentFile.id, currentFile.originalName]));
  const chunkedFileIds = new Set(chunks.map((chunk) => chunk.fileId));
  const legacyChunks = createLegacyChunksFromFiles(
    files.filter((currentFile) => !chunkedFileIds.has(currentFile.id))
  );
  const availableChunks = [...chunks, ...legacyChunks];

  if (availableChunks.length === 0) {
    return "";
  }

  const keywords = extractKeywords(questionText);
  const rankedChunks = availableChunks
    .map((chunk) => ({
      chunk,
      score: keywords.length > 0 ? scoreChunk(chunk.content, keywords) : 0,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.chunk.fileId.localeCompare(b.chunk.fileId) ||
        a.chunk.chunkIndex - b.chunk.chunkIndex
    );

  const hasKeywordHit = rankedChunks.some((rankedChunk) => rankedChunk.score > 0);
  const selectedChunks = hasKeywordHit
    ? rankedChunks.slice(0, KNOWLEDGE_TOP_K)
    : availableChunks.slice(0, FALLBACK_CHUNK_COUNT).map((chunk) => ({
        chunk,
        score: 0,
      }));

  return selectedChunks
    .map(({ chunk, score }) => {
      const fileName = fileNameById.get(chunk.fileId) ?? "uploaded file";
      return `### ${fileName} | chunk ${chunk.chunkIndex + 1} | score ${score}\n${chunk.content}`;
    })
    .join("\n\n");
}

function prepareMessagesForModel({
  messages,
  supportsVision,
}: {
  messages: ChatMessage[];
  supportsVision: boolean;
}) {
  if (supportsVision) {
    return messages;
  }

  return messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => part.type !== "file"),
  })) as ChatMessage[];
}

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
    const streamCacheInput = {
      conversationId,
      messageId: assistantMessageId,
      requestId: streamRequestId,
    };

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
      await startStreamCache(streamCacheInput);
    }

    // Get model capabilities
    const modelCapabilities = await getCapabilities();
    const capabilities = modelCapabilities[chatModel];
    const isReasoningModel = capabilities?.reasoning === true;
    const supportsTools = capabilities?.tools === true;
    const supportsVision = capabilities?.vision === true;
    const referencedFileIds = getReferencedFileIds(userMessage);
    const referencedFiles =
      referencedFileIds.length > 0
        ? await getFilesByIdsForUser({
            ids: referencedFileIds,
            userId: session.user.id,
            chatId: conversationId,
          })
        : [];

    if (referencedFiles.length !== referencedFileIds.length) {
      return new ChatbotError(
        "forbidden:upload",
        "One or more uploaded files do not belong to this conversation."
      ).toResponse();
    }

    const referencedChunks =
      referencedFileIds.length > 0
        ? await getFileChunksByFileIdsForUser({
            fileIds: referencedFileIds,
            userId: session.user.id,
            chatId: conversationId,
          })
        : [];
    const knowledgeContext = buildRetrievedKnowledgeContext({
      files: referencedFiles,
      chunks: referencedChunks,
      questionText: getUserQuestionText(userMessage),
    });
    const modelUiMessages = prepareMessagesForModel({
      messages: uiMessages,
      supportsVision,
    });
    const baseSystemPrompt = systemPrompt({ requestHints, supportsTools });
    // Durable file metadata and chunks live in PostgreSQL; Redis remains for short-lived stream state and rate limits.
    // This lexical scorer is the swappable point for a later pgvector/embedding retriever.
    const systemPromptWithKnowledge = knowledgeContext
      ? `${baseSystemPrompt}\n\nUse the following retrieved knowledge chunks when they are relevant. If the chunks are not relevant, answer normally.\n\n<retrieved_knowledge>\n${knowledgeContext}\n</retrieved_knowledge>`
      : baseSystemPrompt;

    // Convert to model messages
    const modelMessages = await convertToModelMessages(modelUiMessages);
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
          system: systemPromptWithKnowledge,
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
              if (!isToolApprovalFlow) {
                await appendStreamChunk({
                  ...streamCacheInput,
                  type: "text",
                  content: chunk.text,
                });
              }
            }
            if (chunk.type === "reasoning-delta") {
              partialAssistantReasoning += chunk.text;
              if (!isToolApprovalFlow) {
                await appendStreamChunk({
                  ...streamCacheInput,
                  type: "reasoning",
                  content: chunk.text,
                });
              }
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
                await markStreamCache({
                  ...streamCacheInput,
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
              await markStreamCache({
                ...streamCacheInput,
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
            await markStreamCache({
              ...streamCacheInput,
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
            await markStreamCache({
              ...streamCacheInput,
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
          markStreamCache({
            ...streamCacheInput,
            status: "error",
          }).catch((cacheError) => {
            console.error("Failed to mark Redis stream as error:", cacheError);
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

  const chatFiles = await getFilesByChatIdForUser({
    chatId: conversationId,
    userId: session.user.id,
  });
  const deletedChat = await deleteChatById({ conversationId });
  const diskDeleteResults = await Promise.all(
    chatFiles.map((currentFile) => deleteStoredUploadFile(currentFile.storedName))
  );
  const deletedFiles = diskDeleteResults.filter(Boolean).length;
  const deletedChatPayload = deletedChat ?? { id: conversationId };

  return Response.json(
    {
      ...deletedChatPayload,
      deletedFiles,
      failedFileDeletes: chatFiles.length - deletedFiles,
    },
    { status: 200 }
  );
}
