import { assertCandidateNotDeleted } from "../../lib/candidateDelete";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { callDeepSeekStructured } from "../../lib/deepseek";
import { buildCall1Prompt } from "../../lib/prompts/call1";
import { buildCall2Prompt } from "../../lib/prompts/call2";
import { Call1OutputSchema } from "../../lib/schemas/call1";
import { Call2OutputSchema } from "../../lib/schemas/call2";
import { getCandidateResumeText } from "../../lib/resume-text";
import { searchKnowledge } from "../../lib/knowledge";
import { persistGeneratedFile } from "../../lib/generatedFiles";

const WorkflowInputSchema = z.object({
  candidateId: z.string(),
  projectId: z.string(),
  roundId: z.string(),
  uploadedBy: z.string().optional().default("system"),
});

const call1Step = createStep({
  id: "call1-resume-structuring",
  inputSchema: WorkflowInputSchema,
  outputSchema: WorkflowInputSchema.extend({ call1: Call1OutputSchema }),
  execute: async ({ inputData }) => {
    const { candidateId, projectId, roundId } = inputData;

    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .select("project_info")
      .eq("id", projectId)
      .single();
    if (error || !project) throw new Error(`项目未找到: ${projectId}`);

    const resumeText = await getCandidateResumeText(candidateId);
    const prompt = buildCall1Prompt({
      resume_text: resumeText,
      job_requirements: project.project_info,
    });
    const call1 = await callDeepSeekStructured(
      [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      Call1OutputSchema
    );

    return { candidateId, projectId, roundId, uploadedBy: inputData.uploadedBy ?? "system", call1 };
  },
});

const call2Step = createStep({
  id: "call2-direction-identification",
  inputSchema: call1Step.outputSchema,
  outputSchema: WorkflowInputSchema.extend({ call1: Call1OutputSchema, call2: Call2OutputSchema }),
  execute: async ({ inputData }) => {
    const { candidateId, projectId, roundId, call1 } = inputData;
    const uploadedBy = inputData.uploadedBy ?? "system";

    const { data: project, error } = await supabaseAdmin
      .from("projects")
      .select("project_info")
      .eq("id", projectId)
      .single();
    if (error || !project) throw new Error(`项目未找到: ${projectId}`);

    const ragChunks: string[] = [];
    for (const q of call1.queries) {
      const results = await searchKnowledge(projectId, q.query, 5);
      for (const r of results) ragChunks.push(r.content);
    }

    const prompt = buildCall2Prompt({
      structured_experience: call1.experiences,
      claims: call1.claims,
      job_info: project.project_info,
      enterprise_knowledge: ragChunks.join("\n---\n"),
    });
    const call2 = await callDeepSeekStructured(
      [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      Call2OutputSchema
    );

    await assertCandidateNotDeleted(candidateId); // 对话已被删除则丢弃结果
    const { error: snapshotError } = await supabaseAdmin.from("interview_analysis_snapshot").insert({
      interview_round_id: roundId,
      project_id: projectId,
      candidate_id: candidateId,
      analysis_type: "resume_analysis",
      payload: { call1, call2 },
    });
    if (snapshotError) throw snapshotError;

    // 2026-10-19 补：之前这里只插了快照，从没调用过 persistGeneratedFile——"简历标注文件"
    // 解析完之后既不会出现在准备轮的"当轮生成文件"按钮下，也不会出现在项目"来源"对应候选人的
    // 文件夹里，是真漏了这一步（Call5-6/Call11-12/Call13-14 都有这行，唯独 Call1-2 没有）。
    // roundId 这里是准备轮（round_no=0）的真实 id——简历解析固定发生在准备轮，所以挂真实
    // roundId（不是 null），"当轮生成文件"才能按轮次读到；resume-annotation 因此按轮次级
    // 类型处理，不是像 final-summary 那样的候选人级类型（见 generatedFiles.ts）。
    await persistGeneratedFile({
      projectId,
      candidateId,
      roundId,
      fileType: "resume-annotation",
      uploadedBy,
    });

    return { candidateId, projectId, roundId, uploadedBy, call1, call2 };
  },
});

export const resumeAnalysisWorkflow = createWorkflow({
  id: "resume-analysis",
  inputSchema: WorkflowInputSchema,
  outputSchema: call2Step.outputSchema,
})
  .then(call1Step)
  .then(call2Step)
  .commit();