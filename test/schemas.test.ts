import { expect } from 'expect';
import { describe, test } from 'node:test';
import { categorySchema, severitySchema } from '../src/schemas/common.ts';
import { findingsContainerSchema } from '../src/schemas/container.ts';
import { findingSchema, findingSchemaStrict } from '../src/schemas/finding.ts';
import { parseOk } from './helpers/parse-ok.ts';

describe('severitySchema', () => {
  test('lowercases and trims, falling back to medium', () => {
    expect(severitySchema.parse('CRITICAL')).toBe('critical');
    expect(severitySchema.parse('  high ')).toBe('high');
    expect(severitySchema.parse('nonsense')).toBe('medium');
  });

  test('defaults missing values to medium', () => {
    expect(severitySchema.parse(undefined)).toBe('medium');
    expect(severitySchema.parse(null)).toBe('medium');
    expect(severitySchema.parse(123)).toBe('medium');
  });
});

describe('categorySchema', () => {
  test('lowercases and trims, falling back to other', () => {
    expect(categorySchema.parse('BUG')).toBe('bug');
    expect(categorySchema.parse('  Security ')).toBe('security');
    expect(categorySchema.parse('weird')).toBe('other');
  });

  test('defaults missing values to other', () => {
    expect(categorySchema.parse(undefined)).toBe('other');
    expect(categorySchema.parse(null)).toBe('other');
    expect(categorySchema.parse(0)).toBe('other');
  });
});

describe('findingSchemaStrict', () => {
  test('defaults side to RIGHT', () => {
    const data = parseOk(
      findingSchemaStrict.safeParse({
        path: 'a.ts',
        content: 'x',
        category: 'bug',
        severity: 'high',
        start_line: 1,
      }),
    );
    expect(data.side).toBe('RIGHT');
  });

  test('clears end_line when smaller than start_line', () => {
    const data = parseOk(
      findingSchemaStrict.safeParse({
        path: 'a.ts',
        content: 'x',
        category: 'bug',
        severity: 'high',
        side: 'RIGHT',
        start_line: 5,
        end_line: 2,
      }),
    );
    expect(data.end_line).toBeUndefined();
  });

  test('allows RIGHT side without start_line (returns undefined)', () => {
    const data = parseOk(
      findingSchemaStrict.safeParse({
        path: 'a.ts',
        content: 'x',
        category: 'bug',
        severity: 'high',
        side: 'RIGHT',
      }),
    );
    expect(data.start_line).toBeUndefined();
  });

  test('drops start_line for LEFT side', () => {
    const data = parseOk(
      findingSchemaStrict.safeParse({
        path: 'a.ts',
        content: 'x',
        category: 'bug',
        severity: 'high',
        side: 'LEFT',
        start_line: 1,
      }),
    );
    expect(data.start_line).toBeUndefined();
  });

  test('coerces numeric string line numbers', () => {
    const data = parseOk(
      findingSchemaStrict.safeParse({
        path: 'a.ts',
        content: 'x',
        category: 'bug',
        severity: 'high',
        side: 'RIGHT',
        start_line: '3',
      }),
    );
    expect(data.start_line).toBe(3);
  });
});

describe('findingSchema', () => {
  test('defaults severity to medium when missing', () => {
    const data = parseOk(
      findingSchema.safeParse({
        path: 'a.ts',
        content: 'x',
        category: 'bug',
        side: 'RIGHT',
        start_line: 1,
      }),
    );
    expect(data?.severity).toBe('medium');
  });

  test('returns null for RIGHT side without start_line', () => {
    const data = parseOk(
      findingSchema.safeParse({
        path: 'a.ts',
        content: 'x',
        category: 'bug',
        severity: 'high',
        side: 'RIGHT',
      }),
    );
    expect(data).toBeNull();
  });
});

describe('findingsContainerSchema', () => {
  test('accepts unknown extra keys', () => {
    const data = parseOk(
      findingsContainerSchema.safeParse({
        findings: [{ path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 }],
        meta: 'ignored',
      }),
    );
    expect(data.findings).toHaveLength(1);
  });

  test('accepts an empty object', () => {
    const result = findingsContainerSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
