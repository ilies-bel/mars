/**
 * ReviewPacket — the persisted output of a review-step review agent.
 *
 * Two discriminated variants:
 *   'full-review'    — a comprehensive review producing a flat findings list.
 *   'targeted-diff'  — a per-file/per-hunk review grouped by changed file.
 *
 * Schema ownership: the `review_packet_json` text column in `tasks`
 * (pg-schema.ts migration 0002). This module carries no DDL.
 */

import { z } from 'zod'

const FindingSchema = z.object({
  category: z.enum(['correctness', 'security', 'style', 'test-coverage']),
  severity: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
})

const FileReviewSchema = z.object({
  path: z.string(),
  hunks: z.array(
    z.object({
      header: z.string(),
      findings: z.array(FindingSchema),
    }),
  ),
})

export const ReviewPacketSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('full-review'),
    findings: z.array(FindingSchema),
    generatedAt: z.string(),
  }),
  z.object({
    type: z.literal('targeted-diff'),
    byFile: z.array(FileReviewSchema),
    generatedAt: z.string(),
  }),
])

export type ReviewPacket = z.infer<typeof ReviewPacketSchema>
