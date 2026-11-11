import { z } from "zod";
import { SourceLocationSchema, SourceRelationSchema, RetrievalQuerySchema } from "./shared";

export const ExperienceSchema = z.object({
  experience_id: z.string().min(1),
  type: z.enum(["work", "project", "education", "other"]),
  organization: z.string().optional(),
  title: z.string().optional(),
  content: z.string().min(1),
  source_location: SourceLocationSchema.optional(),
});

export const ClaimSchema = z.object({
  claim_id: z.string().min(1),
  content: z.string().min(1),
  source_location: SourceLocationSchema.optional(),
  source_relations: z.array(SourceRelationSchema).default([]),
});

export const Call1OutputSchema = z.object({
  analysis_id: z.string().min(1),
  experiences: z.array(ExperienceSchema).min(1),
  claims: z.array(ClaimSchema),
  queries: z.array(RetrievalQuerySchema),
  source_relations: z.array(SourceRelationSchema).default([]),
});
export type Call1Output = z.infer<typeof Call1OutputSchema>;