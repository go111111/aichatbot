/**
 * 进行中的 AI 流式输出在 Redis 里的短缓存（非 RAG chunk、非消息持久化）。
 *
 * 键结构（每条 assistant 消息一条流）：
 *   chat:stream:{conversationId}:{messageId}:meta  — Hash（status、requestId、offset）
 *   chat:stream:{conversationId}:{messageId}:chunks — List（已推送的 text/reasoning 片段 JSON）
 *
 * 持久化在 PostgreSQL Message_v2；断线重连时 getStreamSnapshot 按 offset 补拉。
 * 未配置 Redis 时所有方法 no-op，不影响主流程。
 */
import "server-only";

import { getRedisClient } from "./redis";

const STREAM_CACHE_TTL_SECONDS = 30 * 60;

type StreamStatus = "pending" | "streaming" | "done" | "error" | "aborted";

type StreamCacheInput = {
  conversationId: string;
  messageId: string;
  requestId: string;
};

type StreamChunkInput = StreamCacheInput & {
  type: "text" | "reasoning";
  content: string;
};

function getBaseKey({ conversationId, messageId }: Pick<StreamCacheInput, "conversationId" | "messageId">) {
  return `chat:stream:${conversationId}:${messageId}`;
}

function getChunkKey(input: Pick<StreamCacheInput, "conversationId" | "messageId">) {
  return `${getBaseKey(input)}:chunks`;
}

function getMetaKey(input: Pick<StreamCacheInput, "conversationId" | "messageId">) {
  return `${getBaseKey(input)}:meta`;
}

async function refreshTtl(
  input: Pick<StreamCacheInput, "conversationId" | "messageId">
) {
  const redis = await getRedisClient();

  if (!redis) {
    return;
  }

  await redis
    .multi()
    .expire(getChunkKey(input), STREAM_CACHE_TTL_SECONDS)
    .expire(getMetaKey(input), STREAM_CACHE_TTL_SECONDS)
    .exec();
}

export async function startStreamCache(input: StreamCacheInput) {
  const redis = await getRedisClient();

  if (!redis) {
    return;
  }

  const now = new Date().toISOString();
  await redis
    .multi()
    .del(getChunkKey(input))
    .hSet(getMetaKey(input), {
      conversationId: input.conversationId,
      messageId: input.messageId,
      requestId: input.requestId,
      status: "pending",
      offset: "0",
      startedAt: now,
      updatedAt: now,
    })
    .expire(getChunkKey(input), STREAM_CACHE_TTL_SECONDS)
    .expire(getMetaKey(input), STREAM_CACHE_TTL_SECONDS)
    .exec();
}

export async function appendStreamChunk(input: StreamChunkInput) {
  if (!input.content) {
    return;
  }

  const redis = await getRedisClient();

  if (!redis) {
    return;
  }

  const offset = await redis.rPush(
    getChunkKey(input),
    JSON.stringify({
      type: input.type,
      content: input.content,
      createdAt: new Date().toISOString(),
    })
  );

  await redis.hSet(getMetaKey(input), {
    status: "streaming",
    offset: String(offset),
    updatedAt: new Date().toISOString(),
  });
  await refreshTtl(input);
}

export async function markStreamCache(
  input: StreamCacheInput & { status: StreamStatus }
) {
  const redis = await getRedisClient();

  if (!redis) {
    return;
  }

  await redis.hSet(getMetaKey(input), {
    status: input.status,
    updatedAt: new Date().toISOString(),
  });
  await refreshTtl(input);
}

export async function getStreamSnapshot({
  conversationId,
  messageId,
  offset = 0,
}: {
  conversationId: string;
  messageId: string;
  offset?: number;
}) {
  const redis = await getRedisClient();

  if (!redis) {
    return null;
  }

  const [meta, chunks] = await Promise.all([
    redis.hGetAll(getMetaKey({ conversationId, messageId })),
    redis.lRange(getChunkKey({ conversationId, messageId }), offset, -1),
  ]);

  if (!meta || Object.keys(meta).length === 0) {
    return null;
  }

  return {
    meta,
    chunks: chunks.map((chunk) => JSON.parse(chunk)),
    nextOffset: offset + chunks.length,
  };
}
