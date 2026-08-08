import { z } from 'zod';

export type Severity = z.infer<typeof severitySchema>;
export type Category = z.infer<typeof categorySchema>;

const severityValues = ['critical', 'high', 'medium', 'low'] as const satisfies string[];
const categoryValues = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'test',
  'style',
  'documentation',
  'other',
] as const satisfies string[];

const normalizedEnum = <T extends readonly string[]>(
  values: T,
  fallback: T[number],
): z.ZodType<T[number], unknown> =>
  z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase().trim() : ''), z.enum(values).catch(fallback));

export const severitySchema = normalizedEnum(severityValues, 'medium');
export const categorySchema = normalizedEnum(categoryValues, 'other');
