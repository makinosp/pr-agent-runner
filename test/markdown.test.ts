import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommentBody, escapeMarkdown } from '../src/output/markdown.ts';

test('escapeMarkdown escapes backslash, asterisk and underscore', () => {
  assert.equal(escapeMarkdown('a\\b'), 'a\\\\b');
  assert.equal(escapeMarkdown('a*b'), 'a\\*b');
  assert.equal(escapeMarkdown('a_b'), 'a\\_b');
});

test('escapeMarkdown does not escape hyphens', () => {
  assert.equal(escapeMarkdown('a-b'), 'a-b');
});

test('escapeMarkdown handles undefined as empty string', () => {
  assert.equal(escapeMarkdown(undefined), '');
});

test('escapeMarkdown leaves plain text untouched', () => {
  assert.equal(escapeMarkdown('hello world 123'), 'hello world 123');
});

test('escapeMarkdown preserves inline code', () => {
  assert.equal(escapeMarkdown('use `code` here'), 'use `code` here');
});

test('escapeMarkdown preserves fenced code blocks', () => {
  const input = '```ts\nconst x = 1;\n```';
  assert.equal(escapeMarkdown(input), input);
});

test('escapeMarkdown escapes special chars outside code but keeps code intact', () => {
  const input = 'fix *this* and `keep code` and *more*';
  assert.equal(escapeMarkdown(input), 'fix \\*this\\* and `keep code` and \\*more\\*');
});

test('buildCommentBody includes category and severity header', () => {
  const body = buildCommentBody({
    path: 'a.ts',
    content: 'do thing',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
  });
  assert.match(body, /^\[bug · high\]/);
  assert.match(body, /do thing/);
});

test('buildCommentBody appends suggestion when present', () => {
  const body = buildCommentBody({
    path: 'a.ts',
    content: 'do thing',
    suggestion: 'do other thing',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
  });
  assert.match(body, /Suggestion:\n/);
  assert.match(body, /```\ndo other thing\n```/);
});

test('buildCommentBody wraps multi-line suggestion in a fenced code block', () => {
  const body = buildCommentBody({
    path: 'a.ts',
    content: 'do thing',
    suggestion: 'line one\n  indented line two\nline three',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
  });
  assert.match(body, /Suggestion:\n```\nline one\n  indented line two\nline three\n```/);
});

test('buildCommentBody does not double-wrap an already fenced suggestion', () => {
  const body = buildCommentBody({
    path: 'a.ts',
    content: 'do thing',
    suggestion: '```ts\nconst x = 1;\n```',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
  });
  assert.match(body, /Suggestion:\n```ts\nconst x = 1;\n```/);
  assert.doesNotMatch(body, /````/);
});

test('buildCommentBody omits suggestion when blank', () => {
  const body = buildCommentBody({
    path: 'a.ts',
    content: 'do thing',
    suggestion: '   ',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
  });
  assert.doesNotMatch(body, /Suggestion:/);
});

test('buildCommentBody keeps code formatting in content and suggestion', () => {
  const body = buildCommentBody({
    path: 'a.ts',
    content: 'use `code` here',
    suggestion: 'try *bold*',
    category: 'security',
    severity: 'critical',
    side: 'RIGHT',
  });
  assert.match(body, /use `code` here/);
  assert.match(body, /Suggestion:\n```\ntry \*bold\*\n```/);
});
