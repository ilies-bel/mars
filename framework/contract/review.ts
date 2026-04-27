import { z } from 'zod';

export const VerdictSchema = z.enum(['pass', 'fail', 'needs-changes']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const FindingSchema = z.object({
  severity: z.enum(['info', 'warn', 'error']),
  message: z.string().min(1),
  path: z.string().min(1).optional(),
  line: z.number().int().nonnegative().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewSchema = z.object({
  verdict: VerdictSchema,
  findings: z.array(FindingSchema),
});
export type Review = z.infer<typeof ReviewSchema>;
