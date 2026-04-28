import { z } from 'zod';
import { FeatureIdSchema, TaskIdSchema } from './task.ts';
import { QuestionSchema } from './question.ts';

export const InboxItemKindSchema = z.enum(['question', 'action', 'decision']);
export type InboxItemKind = z.infer<typeof InboxItemKindSchema>;

export const PrioritySchema = z.enum(['blocker', 'high', 'normal', 'low']);
export type Priority = z.infer<typeof PrioritySchema>;

export const InboxItemStateSchema = z.enum(['open', 'resolved', 'dismissed']);
export type InboxItemState = z.infer<typeof InboxItemStateSchema>;

export const InboxItemCategorySchema = z.enum(['defect', 'gate']);
export type InboxItemCategory = z.infer<typeof InboxItemCategorySchema>;

export const RootCauseSchema = z.enum([
  'missing_context',
  'ambiguous_prompt',
  'weak_adapter',
  'feature_underspecified',
  'genuine_human_judgment',
  'context_bloat',
]);
export type RootCause = z.infer<typeof RootCauseSchema>;

const InboxContextSchema = z.object({
  files: z.array(z.string().min(1)).optional(),
  excerpts: z
    .array(
      z.object({
        path: z.string().min(1),
        lines: z.string().min(1),
      }),
    )
    .optional(),
  agentNotes: z.string().optional(),
  relatedFeatureIds: z.array(FeatureIdSchema).optional(),
  relatedTaskIds: z.array(TaskIdSchema).optional(),
});

const QuestionPayloadSchema = z.object({
  kind: z.literal('question'),
  question: QuestionSchema,
});

const ActionPayloadSchema = z.object({
  kind: z.literal('action'),
  instruction: z.string().min(1),
  verifyHint: z.string().optional(),
});

const DecisionPayloadSchema = z.object({
  kind: z.literal('decision'),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        consequence: z.string().optional(),
      }),
    )
    .min(1),
});

export const InboxItemPayloadSchema = z.discriminatedUnion('kind', [
  QuestionPayloadSchema,
  ActionPayloadSchema,
  DecisionPayloadSchema,
]);
export type InboxItemPayload = z.infer<typeof InboxItemPayloadSchema>;

const ResolutionNoteSchema = z.object({
  kind: z.enum(['harness_fix', 'one_off_answer']),
  notes: z.string().min(1),
  commitRef: z.string().min(1).optional(),
});

const InboxItemIdSchema = z.string().regex(/^[0-9a-f]{8}-[a-z0-9][a-z0-9-]{0,39}$/, {
  message: 'InboxItem id must be <8-hex>-<kebab-slug ≤40 chars> (per CONTRACTS §6.1)',
});

const InboxItemBaseSchema = z.object({
  id: InboxItemIdSchema,
  kind: InboxItemKindSchema,
  category: InboxItemCategorySchema,
  priority: PrioritySchema,
  title: z.string().min(1),
  body: z.string().min(1),
  context: InboxContextSchema,
  state: InboxItemStateSchema,
  raisedBy: z.string().min(1),
  raisedAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
  resolution: z.string().optional(),
  payload: InboxItemPayloadSchema,
  rootCause: RootCauseSchema.optional(),
  resolutionNote: ResolutionNoteSchema.optional(),
});

export const InboxItemSchema = InboxItemBaseSchema.refine(
  (item) => item.kind === item.payload.kind,
  { message: 'InboxItem.kind must match payload.kind', path: ['payload', 'kind'] },
).refine(
  (item) =>
    item.state !== 'resolved' || item.resolvedAt !== undefined,
  { message: 'resolved items must carry resolvedAt', path: ['resolvedAt'] },
);
export type InboxItem = z.infer<typeof InboxItemSchema>;
