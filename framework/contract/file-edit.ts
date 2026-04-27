import { z } from 'zod';

const NonEmptyString = z.string().min(1);

const WriteEdit = z.object({
  op: z.literal('write'),
  path: NonEmptyString,
  contents: z.string(),
});

const PatchEdit = z.object({
  op: z.literal('patch'),
  path: NonEmptyString,
  diff: NonEmptyString,
});

const DeleteEdit = z.object({
  op: z.literal('delete'),
  path: NonEmptyString,
});

const RenameEdit = z.object({
  op: z.literal('rename'),
  from: NonEmptyString,
  to: NonEmptyString,
});

export const FileEditSchema = z.discriminatedUnion('op', [
  WriteEdit,
  PatchEdit,
  DeleteEdit,
  RenameEdit,
]);

export type FileEdit = z.infer<typeof FileEditSchema>;
