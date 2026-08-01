import assert from 'node:assert/strict';
import test from 'node:test';
import { categorySchema, severitySchema } from '../src/schemas/common.ts';
import { findingsContainerSchema } from '../src/schemas/container.ts';
import { findingSchema, findingSchemaStrict } from '../src/schemas/finding.ts';

test('severitySchema lowercases and trims, falling back to medium', () => {
  assert.equal(severitySchema.parse('CRITICAL'), 'critical');
  assert.equal(severitySchema.parse('  high '), 'high');
  assert.equal(severitySchema.parse('nonsense'), 'medium');
});

test('severitySchema defaults missing values to medium', () => {
  assert.equal(severitySchema.parse(undefined), 'medium');
  assert.equal(severitySchema.parse(null), 'medium');
  assert.equal(severitySchema.parse(123), 'medium');
});

test('categorySchema lowercases and trims, falling back to other', () => {
  assert.equal(categorySchema.parse('BUG'), 'bug');
  assert.equal(categorySchema.parse('  Security '), 'security');
  assert.equal(categorySchema.parse('weird'), 'other');
});

test('categorySchema defaults missing values to other', () => {
  assert.equal(categorySchema.parse(undefined), 'other');
  assert.equal(categorySchema.parse(null), 'other');
  assert.equal(categorySchema.parse(0), 'other');
});

test('findingSchemaStrict defaults side to RIGHT', () => {
  const result = findingSchemaStrict.safeParse({
    path: 'a.ts',
    content: 'x',
    category: 'bug',
    severity: 'high',
    start_line: 1,
  });
  assert.ok(result.success);
  assert.equal(result.data.side, 'RIGHT');
});

test('findingSchemaStrict clears end_line when smaller than start_line', () => {
  const result = findingSchemaStrict.safeParse({
    path: 'a.ts',
    content: 'x',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
    start_line: 5,
    end_line: 2,
  });
  assert.ok(result.success);
  assert.equal(result.data.end_line, undefined);
});

test('findingSchemaStrict allows RIGHT side without start_line (returns undefined)', () => {
  const result = findingSchemaStrict.safeParse({
    path: 'a.ts',
    content: 'x',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
  });
  assert.ok(result.success);
  assert.equal(result.data?.start_line, undefined);
});

test('findingSchemaStrict drops start_line for LEFT side', () => {
  const result = findingSchemaStrict.safeParse({
    path: 'a.ts',
    content: 'x',
    category: 'bug',
    severity: 'high',
    side: 'LEFT',
    start_line: 1,
  });
  assert.ok(result.success);
  assert.equal(result.data.start_line, undefined);
});

test('findingSchemaStrict coerces numeric string line numbers', () => {
  const result = findingSchemaStrict.safeParse({
    path: 'a.ts',
    content: 'x',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
    start_line: '3',
  });
  assert.ok(result.success);
  assert.equal(result.data.start_line, 3);
});

test('findingSchema defaults severity to medium when missing', () => {
  const result = findingSchema.safeParse({
    path: 'a.ts',
    content: 'x',
    category: 'bug',
    side: 'RIGHT',
    start_line: 1,
  });
  assert.ok(result.success);
  assert.equal(result.data?.severity, 'medium');
});

test('findingSchema returns null for RIGHT side without start_line', () => {
  const result = findingSchema.safeParse({
    path: 'a.ts',
    content: 'x',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
  });
  assert.ok(result.success);
  assert.equal(result.data, null);
});

test('findingsContainerSchema accepts unknown extra keys', () => {
  const result = findingsContainerSchema.safeParse({
    findings: [{ path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 }],
    meta: 'ignored',
  });
  assert.ok(result.success);
  assert.equal(result.data.findings?.length, 1);
});

test('findingsContainerSchema accepts an empty object', () => {
  const result = findingsContainerSchema.safeParse({});
  assert.equal(result.success, true);
});
