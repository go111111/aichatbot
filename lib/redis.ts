import "server-only";

import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;
let connectPromise: Promise<RedisClient | null> | null = null;

export function isRedisConfigured() {
  return Boolean(process.env.REDIS_URL);
}

export async function getRedisClient() {
  if (!process.env.REDIS_URL) {
    return null;
  }

  if (client?.isReady) {
    return client;
  }

  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", () => undefined);
  }

  connectPromise ??= client
    .connect()
    .then(() => client)
    .catch(() => {
      client = null;
      return null;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

export async function checkRedisConnection() {
  const redis = await getRedisClient();

  if (!redis) {
    return false;
  }

  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}
