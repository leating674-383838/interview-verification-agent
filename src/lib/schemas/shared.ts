import { z } from "zod";

export const SourceRelationSchema = z.object({
  type: z.enum([
    "analysis", "experience", "claim", "direction", "verification_target",
    "question", "statement", "fact", "evidence", "requirement",
    "enterprise_knowledge", "round", "single_round_summary",
    // 新增：Call13（跨轮聚合，cross_round_analysis_id 字段）的输出本身也是 Call14 追溯链路
    // （Call14 → Call13 → Call12 → Call11/Evidence）里的一环，之前枚举里漏了这个类型——
    // 真实报错（final-aggregation 的 call14-final-summary 步骤）：模型在 source_relations
    // 里引用 Call13 结果时填了一个不在枚举里的 type，Zod 校验直接失败。call13/call14 的
    // Prompt 之前没有像 call4.ts 那样列出允许的枚举值（问题5的教训），模型只能自己瞎猜。
    "cross_round_analysis",
  ]),
  id: z.string(),
  relation: z.string(),
});
export type SourceRelation = z.infer<typeof SourceRelationSchema>;

export const SourceLocationSchema = z.object({
  source_type: z.enum(["resume", "transcript", "annotation_file"]),
  file_id: z.string(),
  page: z.number().optional(),
  paragraph: z.number().optional(),
  line_start: z.number().optional(),
  line_end: z.number().optional(),
  text_offset_start: z.number().optional(),
  text_offset_end: z.number().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

export const QuestionStatusSchema = z.enum([
  "GENERATED", "SELECTED", "ADJUSTED", "REMOVED", "REPLACED",
]);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

export const QuestionEntitySchema = z.object({
  question_id: z.string().min(1),
  parent_question_id: z.string().nullable(),
  question_text: z.string().min(1),
  verification_target: z.string().min(1),
  source_relations: z.array(SourceRelationSchema),
  status: QuestionStatusSchema,
});
export type QuestionEntity = z.infer<typeof QuestionEntitySchema>;

export const RetrievalQuerySchema = z.object({
  query_id: z.string().min(1),
  query: z.string().min(1),
});
export type RetrievalQuery = z.infer<typeof RetrievalQuerySchema>;
// 追加到 src/lib/schemas/shared.ts

export const EvidenceStatusSchema = z.enum([
  "sufficient",
  "partially_sufficient",
  "insufficient",
  "contradictory",
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EvidenceFoundStatusSchema = z.enum([
  "RELEVANT_EVIDENCE_FOUND",
  "NO_RELEVANT_EVIDENCE",
]);
export type EvidenceFoundStatus = z.infer<typeof EvidenceFoundStatusSchema>;

export const MatchingStatusSchema = z.enum([
  "matched",
  "partially_matched",
  "not_confirmed",
  "contradictory",
]);
export type MatchingStatus = z.infer<typeof MatchingStatusSchema>;

export const CompositeStatusSchema = z.enum([
  "MATCHED_VERIFIED",
  "MATCHED_WITH_DOUBTS",
  "UNVERIFIED_INSUFFICIENT",
  "MATCH_CONFLICT",
]);
export type CompositeStatus = z.infer<typeof CompositeStatusSchema>;

// src/lib/schemas/shared.ts 新增
export const FeedbackIntentSchema = z.enum([
  "SCOPE_PREFERENCE",   // ①范围与偏好约束
  "DEPTH_GRANULARITY",  // ②粒度与深度调优
  "NEW_DIMENSION",      // ③补充新视角/维度
  "EXCLUDE_CONTENT",    // ④摒弃/剔除已有内容
  "STYLE_TONE",         // ⑤表达风格/语气重构
  "RETAIN_EXPAND",      // ⑥已选问题保留/扩展
]);
export type FeedbackIntent = z.infer<typeof FeedbackIntentSchema>;

// ============================================================
// Call 11-14 固定模板扩展（本次新增）
// 背景：Schema V1 文档第20-23节对 Call11-14 的定义只覆盖事实/能力/疑点/冲突/匹配状态，
// 不包含「单轮面试总结表」「候选人总总结表」要求的基本信息/面试官评价/面试决策三大板块，
// 这三块按规定必须严格区分来源：
//   1. BasicInfoSchema       —— 系统真实字段直接拼入，不由 LLM 生成，缺失必须显示 "未记录"
//   2. InterviewerFeedbackRecordSchema —— 系统已有的面试官反馈原文，工作流直传不改写，不由 LLM 改写或代笔
//   3. DecisionBlockSchema  —— summary/strengths/weaknesses 由 AI 基于 Call11/13 事实归纳生成，
//      actual_status/decided_by 必须读系统已有决策记录，没有则固定输出 "未记录"，不允许 LLM 自行判定录用/淘汰
export const BasicInfoSchema = z.object({
  candidate_name: z.string(), // 系统真实字段，candidates.candidate_name
  gender: z.string(),         // 现有数据库无此字段，固定 "未记录"，不由 AI 推测
  age: z.string(),            // 同上，固定 "未记录"
  education: z.string(),      // 同上，固定 "未记录"
  school: z.string().optional(), // 毕业院校：从简历抓取，抓不到「未记录」；.optional() 兼容旧快照
  contact: z.string(),        // 同上，固定 "未记录"
  position: z.string(),       // 系统真实字段，projects.project_info 中解析或 projects.project_name
  interview_stage: z.string(), // 系统真实字段，interview_rounds.round_name（或跨轮时为已完成轮次列表）
});
export type BasicInfo = z.infer<typeof BasicInfoSchema>;

export const InterviewerFeedbackRecordSchema = z.object({
  round_id: z.string(),
  round_name: z.string(),
  // 轮次序号（interview_rounds.round_no），用于总总结表「第N轮面试官评价」。round_name 是用户可改的文字
  // （实测同一项目里出现过「第一轮面试」「第2轮面试」两种写法），不能拿来当序号。.optional() 兼容旧快照。
  round_no: z.number().optional(),
  // 面试官昵称：生成时记触发任务的用户，展示时再用当轮决策人覆盖（见 lib/roundOperators.ts）；
  // 都没有来源才是 "未记录"，不由 AI 生成
  interviewer_name: z.string(),
  feedback_text: z.string(),    // 没有已记录反馈时固定 "未记录"，有则原文直传，不由 AI 改写
  has_record: z.boolean(),      // 明确标记该条是否来自系统已有记录，前端根据它决定是否显示"未记录"样式
});
export type InterviewerFeedbackRecord = z.infer<typeof InterviewerFeedbackRecordSchema>;

export const DecisionBlockSchema = z.object({
  summary: z.string(),               // AI 基于已有事实/证据归纳的综合总结
  strengths: z.array(z.string()),    // AI 基于已有事实/证据归纳的优势，没有足够依据则输出 []
  weaknesses: z.array(z.string()),   // 同上，不足
  actual_status: z.string(),         // 系统已记录的实际决策，没有则固定 "未记录"，不由 AI 自行判定
  decided_by: z.string(),            // 实际决策人/实际面试官，没有则 "未记录"
  has_decision_record: z.boolean(),  // 明确标记 actual_status 是否来自系统已有决策记录
});
export type DecisionBlock = z.infer<typeof DecisionBlockSchema>;

// 真实报错（round-summary/final-aggregation 两个 workflow 都有同样的架构性问题，不只是
// Call14 这一次）：call12.ts/call14.ts 的 Prompt 都明确要求模型输出 interview_decision/
// final_decision 这个对象（summary/strengths/weaknesses），但 actual_status/decided_by/
// has_decision_record 这三个字段按设计是"系统代码填充，模型不需要输出"（Prompt 里也是这么
// 写的）。问题是 callDeepSeekStructured 校验模型原始输出时，之前直接用的是上面这个完整
// DecisionBlockSchema（三个系统字段都是必填 z.string()/z.boolean()），模型按 Prompt 要求
// 不填这三个字段，Zod 校验必然失败——这不是模型输出格式不稳定，是校验 Schema 本身用错了
// （验证"模型该输出什么"应该用只含模型负责的三个字段的子集，不是最终落库用的完整结构）。
// 这个子集 Schema 专门给 callDeepSeekStructured 校验原始模型输出用，拿到结果后由 workflow
// 代码把 actual_status/decided_by/has_decision_record 填进去，拼成符合完整
// DecisionBlockSchema 的对象再落库——两层 Schema 分工明确，不是弱化校验。
export const DecisionBlockLLMSchema = z.object({
  summary: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
});
export type DecisionBlockLLM = z.infer<typeof DecisionBlockLLMSchema>;