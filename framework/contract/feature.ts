import { z } from 'zod';
import { FeatureIdSchema, TaskSchema } from './task.ts';

export const FeatureStatusSchema = z.enum([
  'draft',
  'ready',
  'in_progress',
  'done',
  'failed',
  'halted',
]);
export type FeatureStatus = z.infer<typeof FeatureStatusSchema>;

export const FeatureSchema = z.object({
  id: FeatureIdSchema,
  goal: z.string().min(1),
  status: FeatureStatusSchema,
  origin: z.enum(['user', 'retro']),
  taskCount: z.number().int().nonnegative(),
  readyTaskCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  storeId: z.string().min(1).optional(),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const FeatureWithTasksSchema = FeatureSchema.extend({
  tasks: z.array(TaskSchema),
});
export type FeatureWithTasks = z.infer<typeof FeatureWithTasksSchema>;
