import type { Finding } from '../src/schemas/finding.ts';
import { expect } from 'expect';
import { describe, test } from 'node:test';
import { buildReviewableRightLineMap, splitFindingsForReview } from '../src/domain/reviewable-lines.ts';

describe('buildReviewableRightLineMap', () => {
  test('collects visible right-side lines from each hunk', () => {
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

    expect([...(reviewableLines.get('src/example.ts') ?? [])]).toEqual([2, 3, 4, 21, 22]);
  });

  test('ignores empty or missing patches', () => {
    const reviewableLines = buildReviewableRightLineMap([
      { filename: 'src/empty.ts', patch: '' },
      { filename: 'src/missing.ts' },
      { filename: 'src/whitespace.ts', patch: '   ' },
    ]);

    expect(reviewableLines.size).toBe(0);
  });

  test('skips "\\ No newline" trailer lines', () => {
    const reviewableLines = buildReviewableRightLineMap([
      {
        filename: 'src/noeol.ts',
        patch: ['@@ -1,2 +1,2 @@ const a = 1;', ' context', '+added', '\\ No newline at end of file'].join('\n'),
      },
    ]);

    expect([...(reviewableLines.get('src/noeol.ts') ?? [])]).toEqual([1, 2]);
  });

  test('handles multiple files independently', () => {
    const reviewableLines = buildReviewableRightLineMap([
      { filename: 'a.ts', patch: ['@@ -1,1 +1,1 @@', ' line'].join('\n') },
      { filename: 'b.ts', patch: ['@@ -5,1 +5,1 @@', ' line'].join('\n') },
    ]);

    expect(reviewableLines.size).toBe(2);
    expect([...(reviewableLines.get('a.ts') ?? [])]).toEqual([1]);
    expect([...(reviewableLines.get('b.ts') ?? [])]).toEqual([5]);
  });
});

describe('splitFindingsForReview', () => {
  test('downgrades non-diff and LEFT-side findings to summary', () => {
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

    expect(inlineComments).toHaveLength(1);
    expect(inlineComments[0]?.start_line).toBe(3);
    expect(summaryComments).toHaveLength(3);
    expect(summaryComments.map(({ content }) => content)).toEqual([
      'outside patch',
      'range includes hidden lines',
      'left side finding',
    ]);
  });

  test('keeps multi-line RIGHT finding when all lines are reviewable', () => {
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

    expect(inlineComments).toHaveLength(1);
    expect(summaryComments).toHaveLength(0);
  });

  test('downgrades finding with start_line below 1', () => {
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

    expect(inlineComments).toHaveLength(0);
    expect(summaryComments).toHaveLength(1);
  });

  test('downgrades finding for unknown file', () => {
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

    expect(inlineComments).toHaveLength(0);
    expect(summaryComments).toHaveLength(1);
  });
});

