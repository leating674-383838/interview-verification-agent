# 代码节选（仅供展示）

不是完整可运行的工程，只挑能说明技术落地的几个文件：

| 文件 | 说明 |
|---|---|
| `mastra/workflows/resume-analysis.ts` | 一个 Mastra Workflow 的编排：简历解析与声明提取 |
| `lib/deepseek.ts` | 大模型调用封装：网络错误 / 429 / 5xx 指数退避重试 |
| `lib/schemas/call1.ts`、`shared.ts` | 用 Zod 定义的结构化输出契约（Call 1 与公共枚举） |
| `lib/chunk.ts` | RAG 切块：按字符数切分并带重叠，避免语义在边界处丢失 |

Prompt 原文、测试数据与真实候选人资料不公开。
