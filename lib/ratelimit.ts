/**
 * 生产环境按客户端 IP 限制 /api/chat 调用频率（与登录用户配额 entitlements 互补）。
 * 滑动窗口近似实现：INCR + 首次 EXPIRE 1h；超过 MAX_MESSAGES 抛 rate_limit:chat。
 */
import { isProductionEnvironment } from "@/lib/constants";
import { ChatbotError } from "@/lib/errors";
import { getRedisClient } from "@/lib/redis";

const MAX_MESSAGES = 10;
const TTL_SECONDS = 60 * 60;

export async function checkIpRateLimit(ip: string | undefined) {
  if (!isProductionEnvironment || !ip) {
    return;
  }

  const redis = await getRedisClient();
  if (!redis?.isReady) {
    return;
  }

  try {
    const key = `ip-rate-limit:${ip}`;
    const [count] = await redis
      .multi()
      .incr(key)
      .expire(key, TTL_SECONDS, "NX")
      .exec();

    if (typeof count === "number" && count > MAX_MESSAGES) {
      throw new ChatbotError("rate_limit:chat");
    }
  } catch (error) {
    if (error instanceof ChatbotError) {
      throw error;
    }
  }
}
