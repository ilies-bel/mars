import { z } from 'zod';
import { FileEditSchema } from './file-edit.ts';

export const BuildResultSchema = z.object({
  edits: z.array(FileEditSchema),
  checkpointHint: z.string().optional(),
  done: z.boolean(),
});

export type BuildResult = z.infer<typeof BuildResultSchema>;
