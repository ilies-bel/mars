import { z } from 'zod';
import { BuildResultSchema } from './build-result.ts';
import { FeatureWithTasksSchema } from './feature.ts';
import { QuestionSchema } from './question.ts';
import { ReviewSchema } from './review.ts';

const FeatureIntent = z.object({
  kind: z.literal('feature'),
  feature: FeatureWithTasksSchema,
});

const BuildIntent = z.object({
  kind: z.literal('build'),
  result: BuildResultSchema,
});

const ReviewIntent = z.object({
  kind: z.literal('review'),
  review: ReviewSchema,
});

const QuestionIntent = z.object({
  kind: z.literal('question'),
  question: QuestionSchema,
});

export const IntentSchema = z.discriminatedUnion('kind', [
  FeatureIntent,
  BuildIntent,
  ReviewIntent,
  QuestionIntent,
]);

export type Intent = z.infer<typeof IntentSchema>;
