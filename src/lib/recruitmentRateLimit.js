import Redis from "ioredis";
import { createHash } from "node:crypto";
let redis;
export async function consumeRecruitmentLimit(
  key,
  { limit = 60, windowSeconds = 60, client } = {},
) {
  if (!client) {
    if (!process.env.REDIS_URL)
      throw Object.assign(new Error("Rate limit service unavailable"), {
        status: 503,
        code: "HR-5902",
      });
    redis ??= new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      enableOfflineQueue: false,
    });
    if (redis.status === "wait") await redis.connect();
    client = redis;
  }
  const bucket = "hr:recruitment:rate:" + createHash("sha256").update(key).digest("hex");
  try {
    const count = Number(
      await client.eval(
        "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end;return n",
        1,
        bucket,
        windowSeconds,
      ),
    );
    if (count > limit)
      throw Object.assign(new Error("Too many requests"), { status: 429, code: "HR-5903" });
    return { remaining: Math.max(0, limit - count) };
  } catch (e) {
    if (e.status === 429) throw e;
    throw Object.assign(new Error("Rate limit service unavailable"), {
      status: 503,
      code: "HR-5902",
    });
  }
}

export function closeRecruitmentRateLimit() {
  redis?.disconnect();
  redis = undefined;
}
