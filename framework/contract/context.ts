import { z } from 'zod';

export const SearchHitSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  col: z.number().int().positive(),
  text: z.string(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const TreeEntryKindSchema = z.enum(['file', 'dir']);
export type TreeEntryKind = z.infer<typeof TreeEntryKindSchema>;

export const TreeEntrySchema = z.object({
  path: z.string().min(1),
  kind: TreeEntryKindSchema,
  size: z.number().int().nonnegative().optional(),
});
export type TreeEntry = z.infer<typeof TreeEntrySchema>;
