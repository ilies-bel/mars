import { z } from 'zod';
import { FeatureIdSchema, TaskIdSchema } from './task.ts';

export const QuestionKindSchema = z.enum([
  'refine_feature',
  'unblock_task',
  'resolve_conflict',
  'approve_checkpoint',
]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

export const QuestionSchema = z.object({
  questionKind: QuestionKindSchema,
  taskIds: z.array(TaskIdSchema),
  featureId: FeatureIdSchema.optional(),
  prompt: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  answer: z.string().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;
