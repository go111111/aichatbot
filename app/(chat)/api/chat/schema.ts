import { z } from "zod";

const uploadUrlSchema = z.string().refine((value) => {
  if (value.startsWith("/uploads/")) {
    return true;
  }
  if (/^\/api\/files\/[0-9a-f-]{36}$/i.test(value)) {
    return true;
  }
  return z.string().url().safeParse(value).success;
}, "File URL must be an absolute URL or an application file URL");

const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().trim().min(1).max(4000),
});

const filePartSchema = z.object({
  type: z.literal("file"),
  fileId: z.string().uuid().optional(),
  mediaType: z.enum([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
  ]),
  name: z.string().min(1).max(255),
  url: uploadUrlSchema,
  size: z.number().positive().max(20 * 1024 * 1024).optional(),
});

const partSchema = z.union([textPartSchema, filePartSchema]);

const userMessageSchema = z.object({
  id: z.string().uuid().optional(),
  role: z.literal("user"),
  parts: z.array(partSchema).min(1),
});

const toolApprovalMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(z.record(z.unknown())),
});

export const postRequestBodySchema = z
  .object({
    id: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
    message: userMessageSchema.optional(),
    messages: z.array(toolApprovalMessageSchema).optional(),
    selectedChatModel: z.string().min(1).max(100),
    selectedVisibilityType: z.enum(["public", "private"]),
    stream: z.boolean().optional().default(true),
    requestId: z.string().uuid().optional(),
  })
  .refine((body) => body.conversationId || body.id, {
    message: "conversationId is required",
    path: ["conversationId"],
  })
  .refine((body) => body.message || body.messages, {
    message: "message or messages is required",
    path: ["message"],
  })
  .transform((body) => ({
    ...body,
    conversationId: body.conversationId ?? body.id!,
  }));

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;

export const streamChunkSchema = z.object({
  type: z.enum(["chunk", "done", "error", "abort"]),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  requestId: z.string().uuid(),
  timestamp: z.number(),
  status: z
    .enum(["pending", "streaming", "done", "error", "aborted"])
    .optional(),
  payload: z
    .object({
      type: z.string(),
      data: z.unknown().optional(),
      content: z.string().optional(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
        })
        .optional(),
    })
    .optional(),
});

export type StreamChunk = z.infer<typeof streamChunkSchema>;
