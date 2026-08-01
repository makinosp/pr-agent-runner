import type { Finding } from '../src/schemas/finding.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewableRightLineMap, splitFindingsForReview } from '../src/domain/reviewable-lines.ts';

test('buildReviewableRightLineMap collects visible right-side lines from each hunk', () => {
  const reviewableLines = buildReviewableRightLineMap([
    {
      filename: 'src/example.ts',
      patch: [
        '@@ -2,4 +2,5 @@ export const value = 1;',
        ' context one',
        '-old line',
        '+new line',
        ' context two',
        '@@ -20,0 +21,2 @@ export const extra = true;',
        '+added one',
        '+added two',
      ].join('\n'),
    },
  ]);

  assert.deepEqual([...(reviewableLines.get('src/example.ts') ?? [])], [2, 3, 4, 21, 22]);
});

test('splitFindingsForReview downgrades non-diff and LEFT-side findings to summary', () => {
  const findings: Finding[] = [
    {
      path: 'src/example.ts',
      start_line: 3,
      category: 'bug',
      severity: 'high',
      content: 'inlineable',
      side: 'RIGHT',
    },
    {
      path: 'src/example.ts',
      start_line: 10,
      category: 'bug',
      severity: 'medium',
      content: 'outside patch',
      side: 'RIGHT',
    },
    {
      path: 'src/example.ts',
      start_line: 2,
      end_line: 5,
      category: 'style',
      severity: 'low',
      content: 'range includes hidden lines',
      side: 'RIGHT',
    },
    {
      path: 'src/example.ts',
      category: 'documentation',
      severity: 'low',
      content: 'left side finding',
      side: 'LEFT',
    },
  ];

  const reviewableLines = buildReviewableRightLineMap([
    {
      filename: 'src/example.ts',
      patch: ['@@ -2,2 +2,3 @@ export const value = 1;', ' context one', '+new line', ' context two'].join('\n'),
    },
  ]);

  const { inlineComments, summaryComments } = splitFindingsForReview(findings, reviewableLines);

  assert.equal(inlineComments.length, 1);
  assert.equal(inlineComments[0]?.start_line, 3);
  assert.equal(summaryComments.length, 3);
  assert.deepEqual(
    summaryComments.map(({ content }) => content),
    ['outside patch', 'range includes hidden lines', 'left side finding'],
  );
});

test('buildReviewableRightLineMap ignores empty or missing patches', () => {
  const reviewableLines = buildReviewableRightLineMap([
    { filename: 'src/empty.ts', patch: '' },
    { filename: 'src/missing.ts' },
    { filename: 'src/whitespace.ts', patch: '   ' },
  ]);

  assert.equal(reviewableLines.size, 0);
});

test('buildReviewableRightLineMap skips "\\ No newline" trailer lines', () => {
  const reviewableLines = buildReviewableRightLineMap([
    {
      filename: 'src/noeol.ts',
      patch: ['@@ -1,2 +1,2 @@ const a = 1;', ' context', '+added', '\\ No newline at end of file'].join('\n'),
    },
  ]);

  assert.deepEqual([...(reviewableLines.get('src/noeol.ts') ?? [])], [1, 2]);
});

test('buildReviewableRightLineMap handles multiple files independently', () => {
  const reviewableLines = buildReviewableRightLineMap([
    { filename: 'a.ts', patch: ['@@ -1,1 +1,1 @@', ' line'].join('\n') },
    { filename: 'b.ts', patch: ['@@ -5,1 +5,1 @@', ' line'].join('\n') },
  ]);

  assert.equal(reviewableLines.size, 2);
  assert.deepEqual([...(reviewableLines.get('a.ts') ?? [])], [1]);
  assert.deepEqual([...(reviewableLines.get('b.ts') ?? [])], [5]);
});

test('splitFindingsForReview keeps multi-line RIGHT finding when all lines are reviewable', () => {
  const findings: Finding[] = [
    {
      path: 'src/example.ts',
      start_line: 2,
      end_line: 4,
      category: 'bug',
      severity: 'high',
      content: 'full range',
      side: 'RIGHT',
    },
  ];

  const reviewableLines = buildReviewableRightLineMap([
    {
      filename: 'src/example.ts',
      patch: ['@@ -2,3 +2,3 @@', ' c1', ' c2', ' c3'].join('\n'),
    },
  ]);

  const { inlineComments, summaryComments } = splitFindingsForReview(findings, reviewableLines);

  assert.equal(inlineComments.length, 1);
  assert.equal(summaryComments.length, 0);
});

test('splitFindingsForReview downgrades finding with start_line below 1', () => {
  const findings: Finding[] = [
    {
      path: 'src/example.ts',
      start_line: 0,
      category: 'bug',
      severity: 'high',
      content: 'invalid line',
      side: 'RIGHT',
    },
  ];

  const reviewableLines = buildReviewableRightLineMap([
    { filename: 'src/example.ts', patch: ['@@ -1,1 +1,1 @@', ' line'].join('\n') },
  ]);

  const { inlineComments, summaryComments } = splitFindingsForReview(findings, reviewableLines);

  assert.equal(inlineComments.length, 0);
  assert.equal(summaryComments.length, 1);
});

test('splitFindingsForReview downgrades finding for unknown file', () => {
  const findings: Finding[] = [
    {
      path: 'src/unknown.ts',
      start_line: 1,
      category: 'bug',
      severity: 'high',
      content: 'no patch',
      side: 'RIGHT',
    },
  ];

  const reviewableLines = buildReviewableRightLineMap([]);

  const { inlineComments, summaryComments } = splitFindingsForReview(findings, reviewableLines);

  assert.equal(inlineComments.length, 0);
  assert.equal(summaryComments.length, 1);
});
