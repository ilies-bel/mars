import { z } from 'zod';

const ID_PATTERN = /^[0-9a-f]{8}-[a-z0-9][a-z0-9-]{0,39}$/;

export const TaskIdSchema = z.string().regex(ID_PATTERN, {
  message: 'TaskId must be <8-hex>-<kebab-slug ≤40 chars> (per CONTRACTS §3.1)',
});
export type TaskId = z.infer<typeof TaskIdSchema>;

export const FeatureIdSchema = z.string().regex(ID_PATTERN, {
  message: 'FeatureId must be <8-hex>-<kebab-slug ≤40 chars> (per CONTRACTS §3.1)',
});
export type FeatureId = z.infer<typeof FeatureIdSchema>;

export const TaskStateSchema = z.enum([
  'to_refine',
  'ready_for_execution',
  'awaiting_human',
  'done',
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskHistoryEntrySchema = z.object({
  at: z.string().datetime({ offset: true }),
  kind: z.enum([
    'created',
    'state_change',
    'claimed',
    'released',
    'reviewer_reject',
    'human_dismiss',
    'failed',
  ]),
  from: TaskStateSchema.optional(),
  to: TaskStateSchema.optional(),
  by: z.string().min(1).optional(),
  note: z.string().optional(),
});
export type TaskHistoryEntry = z.infer<typeof TaskHistoryEntrySchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  featureId: FeatureIdSchema,
  title: z.string().min(1),
  deps: z.array(TaskIdSchema),
  acceptance: z.array(z.string().min(1)).min(1),
  state: TaskStateSchema,

  claimedBy: z.string().min(1).optional(),
  claimedAt: z.string().datetime({ offset: true }).optional(),
  claimedPid: z.number().int().positive().optional(),
  claimedHost: z.string().min(1).optional(),

  pendingInboxItemId: z.string().min(1).optional(),
  sourceInboxItemIds: z.array(z.string().min(1)).optional(),

  history: z.array(TaskHistoryEntrySchema).optional(),
});
export type Task = z.infer<typeof TaskSchema>;
