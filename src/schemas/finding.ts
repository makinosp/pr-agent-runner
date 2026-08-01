import { z } from 'zod';
import { categorySchema, severitySchema } from './common.ts';

export type Finding = z.infer<typeof findingSchemaStrict>;

const baseFindingSchema = z.object({
  path: z.string().min(1),
  content: z.string().trim().min(1),
  start_line: z.coerce.number().int().positive().optional(),
  end_line: z.coerce.number().int().positive().optional(),
  suggestion: z.string().trim().optional(),
  category: categorySchema,
  severity: severitySchema,
  side: z.enum(['LEFT', 'RIGHT']).catch('RIGHT'),
});

const normalizeEndLine = (finding: z.infer<typeof baseFindingSchema>): z.infer<typeof baseFindingSchema> =>
  finding.start_line !== undefined && finding.end_line !== undefined && finding.end_line < finding.start_line
    ? { ...finding, end_line: undefined }
    : finding;

export const findingSchema = baseFindingSchema
  .transform(normalizeEndLine)
  .transform((finding): z.infer<typeof baseFindingSchema> | null =>
    finding.side === 'RIGHT' && finding.start_line === undefined ? null : finding,
  );

export const findingSchemaStrict = baseFindingSchema.transform((finding) => {
  const normalized = normalizeEndLine(finding);
  if (normalized.side === 'LEFT') return { ...normalized, start_line: undefined };
  return normalized;
});

/**
 * Resolve the end_line of a finding. If end_line is undefined, return start_line.
 * Assumes start_line is a number (called for RIGHT-side findings).
 */
export const resolveEndLine = (finding: Finding & { start_line: number }): number =>
  typeof finding.end_line === 'number' ? finding.end_line : finding.start_line;
