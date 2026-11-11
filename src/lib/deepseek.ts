import { z } from "zod";

const BASE_URL = "https://api.deepseek.com/v1";
const NETWORK_RETRY_DELAYS_MS = [2000, 5000]; // 2s, 5s 退避

// 4xx（除 429）是客户端/账户类错误（余额不足 402、密钥无效 401、参数错误 400 等），重试没有意义，
// 必须直接抛出。之前这类错误是在 try 里 throw 的，又被外层 catch 当成「网络异常」重试了两次，
// 白等 7 秒才失败（日志里的「网络请求异常，2000ms 后重试」就是这个）。
class DeepSeekApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callDeepSeekRaw(messages: { role: string; content: string }[]) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages,
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text();
        // 5xx / 429 这类瞬时性故障才重试，4xx（除429）类客户端错误直接抛错不重试
        if ((res.status >= 500 || res.status === 429) && attempt < NETWORK_RETRY_DELAYS_MS.length) {
          console.warn(`[deepseek] 请求失败 status=${res.status}，${NETWORK_RETRY_DELAYS_MS[attempt]}ms 后重试（第${attempt + 1}次）`);
          await sleep(NETWORK_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new DeepSeekApiError(res.status, `DeepSeek API error: ${res.status} ${bodyText}`);
      }
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content);
    } catch (e) {
      lastError = e;
      if (e instanceof DeepSeekApiError) throw e; // 已判定不可重试（或已用完重试次数）的 HTTP 错误
      // fetch 本身抛错（网络超时/ECONNRESET等），且还有重试次数时才重试
      if (attempt < NETWORK_RETRY_DELAYS_MS.length) {
        console.warn(`[deepseek] 网络请求异常，${NETWORK_RETRY_DELAYS_MS[attempt]}ms 后重试（第${attempt + 1}次）:`, (e as Error).message);
        await sleep(NETWORK_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

export const callDeepSeek = callDeepSeekRaw;

export async function callDeepSeekStructured<T>(
  messages: { role: string; content: string }[],
  schema: z.ZodType<T>,
  maxRetries = 1
): Promise<T> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const msgs = lastError
      ? [
          ...messages,
          {
            role: "user" as const,
            content: `上一轮返回的 JSON 未通过结构化 Schema 校验。

请重新生成一个完整 JSON。

本次校验错误如下：
${lastError}

重新生成时必须：
1. 严格保持原始 system prompt 中定义的字段名和字段层级；
2. 不得删除任何必填字段；
3. 不得增加 Schema 中不存在的字段；
4. 严格按照原始 prompt 中规定的字段映射关系生成；
5. 所有数组字段即使没有内容也必须输出 []；
6. 不要输出 Markdown、代码块或解释文字；
7. 只输出完整 JSON 对象。`,
          },
        ]
      : messages;

    const raw = await callDeepSeekRaw(msgs);

    // 临时调试：用于确认 DeepSeek 实际返回内容。
    console.log(
      `[deepseek][structured] attempt=${attempt + 1} raw output:`,
      JSON.stringify(raw, null, 2)
    );

    const parsed = schema.safeParse(raw);

    if (parsed.success) {
      console.log(
        `[deepseek][structured] schema validation passed on attempt=${attempt + 1}`
      );
      return parsed.data;
    }

    lastError = parsed.error.message;

    console.error(
      `[deepseek][structured] schema validation failed on attempt=${attempt + 1}:`,
      lastError
    );
  }

  throw new Error(
    `DeepSeek 结构化输出校验失败（已重试${maxRetries}次）: ${lastError}`
  );
}