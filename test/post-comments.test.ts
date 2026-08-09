import { expect } from 'expect';
import { describe, test } from 'node:test';
import {
  CATEGORIES,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONTENT_SIMILARITY_THRESHOLD,
  DEFAULT_OVERLAP_THRESHOLD,
  NO_ROUTING,
  SEVERITY_RANK,
  buildRoutePolicy,
  chunkArray,
  isBotComment,
  isDuplicateComment,
  isDuplicateContent,
  jaccardSimilarity,
  lineSpan,
  normalizeContent,
  overlapsHistory,
  resolveBatchSize,
  resolveContentThreshold,
  resolveThreshold,
  sameCommentSpan,
  shouldRoute,
  sortCommentsDeterministically,
} from '../src/domain/post-comments.ts';

describe('resolveBatchSize', () => {
  test('returns the parsed size for valid positive integers', () => {
    expect(resolveBatchSize('10')).toBe(10);
    expect(resolveBatchSize(1)).toBe(1);
  });

  test('falls back to DEFAULT_BATCH_SIZE for invalid values', () => {
    expect(resolveBatchSize('0')).toBe(DEFAULT_BATCH_SIZE);
    expect(resolveBatchSize('-3')).toBe(DEFAULT_BATCH_SIZE);
    expect(resolveBatchSize('abc')).toBe(DEFAULT_BATCH_SIZE);
    expect(resolveBatchSize(undefined)).toBe(DEFAULT_BATCH_SIZE);
    expect(resolveBatchSize(null)).toBe(DEFAULT_BATCH_SIZE);
    expect(resolveBatchSize('')).toBe(DEFAULT_BATCH_SIZE);
  });
});

describe('chunkArray', () => {
  test('partitions into contiguous slices of at most size', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('yields one chunk of exact size when length is a multiple', () => {
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('returns an empty list for an empty input', () => {
    expect(chunkArray([], 5)).toEqual([]);
  });
});

describe('sortCommentsDeterministically', () => {
  const comment = (path: string, start_line?: number, end_line?: number) => ({ path, start_line, end_line });

  test('sorts by path then start_line then end_line', () => {
    const input = [comment('b.ts', 5), comment('a.ts', 10, 12), comment('a.ts', 2), comment('a.ts', 10, 11)];
    const sorted = sortCommentsDeterministically(input);
    expect(sorted.map((c) => `${c.path}:${c.start_line}:${c.end_line}`)).toEqual([
      'a.ts:2:undefined',
      'a.ts:10:11',
      'a.ts:10:12',
      'b.ts:5:undefined',
    ]);
  });

  test('keeps the original order for identical keys', () => {
    const input = [comment('a.ts', 1, 3), comment('a.ts', 1, 3)];
    const sorted = sortCommentsDeterministically(input);
    expect(sorted[0]).toBe(input[0]);
    expect(sorted[1]).toBe(input[1]);
  });

  test('does not mutate the input array', () => {
    const input = [comment('b.ts'), comment('a.ts')];
    sortCommentsDeterministically(input);
    expect(input[0].path).toBe('b.ts');
    expect(input[1].path).toBe('a.ts');
  });
});

describe('lineSpan', () => {
  const lineSpanCases: ReadonlyArray<
    [
      string,
      { line?: number | null; start_line?: number | null },
      { start: number; end: number; multiline: boolean } | null,
    ]
  > = [
      ['resolves a single-line comment from line', { line: 3 }, { start: 3, end: 3, multiline: false }],
      [
        'resolves a multi-line comment from start_line and line',
        { start_line: 2, line: 5 },
        { start: 2, end: 5, multiline: true },
      ],
      ['treats start_line === line as single-line', { start_line: 3, line: 3 }, { start: 3, end: 3, multiline: false }],
      ['returns null when no line can be resolved', {}, null],
      ['returns null when start_line is 0', { start_line: 0 }, null],
      ['returns null when line is null', { line: null }, null],
      [
        'normalizes reversed start/end to ascending order',
        { start_line: 8, line: 3 },
        { start: 3, end: 8, multiline: true },
      ],
    ];

  for (const [name, comment, expected] of lineSpanCases) {
    test(name, () => {
      expect(lineSpan(comment)).toEqual(expected);
    });
  }
});

describe('sameCommentSpan', () => {
  test('two single-line comments are the same only on the same line', () => {
    expect(sameCommentSpan({ start: 3, end: 3, multiline: false }, { start: 3, end: 3, multiline: false }, 0.6)).toBe(
      true,
    );
    expect(sameCommentSpan({ start: 3, end: 3, multiline: false }, { start: 4, end: 4, multiline: false }, 0.6)).toBe(
      false,
    );
  });

  test('single-line is never the same as multi-line', () => {
    expect(sameCommentSpan({ start: 3, end: 3, multiline: false }, { start: 3, end: 5, multiline: true }, 0.6)).toBe(
      false,
    );
    expect(sameCommentSpan({ start: 3, end: 5, multiline: true }, { start: 3, end: 3, multiline: false }, 0.6)).toBe(
      false,
    );
  });

  test('multi-line IoU strictly above the threshold is a duplicate', () => {
    // cur [2..6] (5 lines), other [4..8] (5 lines): overlap [4..6] = 3, union 7, IoU = 3/7 ≈ 0.43
    expect(sameCommentSpan({ start: 2, end: 6, multiline: true }, { start: 4, end: 8, multiline: true }, 0.4)).toBe(
      true,
    );
    // cur [2..6] (5), other [5..6] (2): overlap 2, union 5, IoU = 0.4
    expect(sameCommentSpan({ start: 2, end: 6, multiline: true }, { start: 5, end: 6, multiline: true }, 0.3)).toBe(
      true,
    );
  });

  test('multi-line IoU equal to the threshold is NOT a duplicate (strict >)', () => {
    // cur [1..4] (4), other [3..6] (4): overlap [3..4] = 2, union 6, IoU = 1/3
    expect(sameCommentSpan({ start: 1, end: 4, multiline: true }, { start: 3, end: 6, multiline: true }, 1 / 3)).toBe(
      false,
    );
  });

  test('multi-line IoU below the threshold is NOT a duplicate', () => {
    expect(sameCommentSpan({ start: 1, end: 4, multiline: true }, { start: 3, end: 6, multiline: true }, 0.6)).toBe(
      false,
    );
  });

  test('non-overlapping multi-line spans are never duplicates', () => {
    expect(sameCommentSpan({ start: 1, end: 2, multiline: true }, { start: 10, end: 12, multiline: true }, 0.1)).toBe(
      false,
    );
  });
});

describe('resolveThreshold', () => {
  test('accepts values in (0, 1]', () => {
    expect(resolveThreshold('0.5')).toBe(0.5);
    expect(resolveThreshold(1)).toBe(1);
  });

  test('falls back to the default for malformed values', () => {
    expect(resolveThreshold('0')).toBe(DEFAULT_OVERLAP_THRESHOLD);
    expect(resolveThreshold('-0.1')).toBe(DEFAULT_OVERLAP_THRESHOLD);
    expect(resolveThreshold('1.5')).toBe(DEFAULT_OVERLAP_THRESHOLD);
    expect(resolveThreshold('abc')).toBe(DEFAULT_OVERLAP_THRESHOLD);
    expect(resolveThreshold(undefined)).toBe(DEFAULT_OVERLAP_THRESHOLD);
  });
});

describe('overlapsHistory', () => {
  const histComment = (path: string, start_line: number | null, line: number) => ({
    path,
    start_line,
    line,
    user: { type: 'Bot' },
  });

  test('same-line single comment is a duplicate', () => {
    expect(overlapsHistory({ path: 'a.ts', line: 5 }, [histComment('a.ts', null, 5)], 0.6)).toBe(true);
  });

  test('different path is not a duplicate', () => {
    expect(overlapsHistory({ path: 'a.ts', line: 5 }, [histComment('b.ts', null, 5)], 0.6)).toBe(false);
  });

  test('single-line vs multi-line is never a duplicate', () => {
    expect(overlapsHistory({ path: 'a.ts', line: 5 }, [histComment('a.ts', 4, 6)], 0.6)).toBe(false);
  });

  test('multi-line with IoU at or below threshold is not a duplicate', () => {
    // cur [1..4] (4), other [3..6] (4): IoU = 1/3
    expect(overlapsHistory({ path: 'a.ts', start_line: 1, line: 4 }, [histComment('a.ts', 3, 6)], 1 / 3)).toBe(false);
    expect(overlapsHistory({ path: 'a.ts', start_line: 1, line: 4 }, [histComment('a.ts', 3, 6)], 0.6)).toBe(false);
  });

  test('multi-line with high IoU is a duplicate', () => {
    expect(overlapsHistory({ path: 'a.ts', start_line: 1, line: 6 }, [histComment('a.ts', 2, 6)], 0.6)).toBe(true);
  });

  test('LEFT-side history comments are ignored', () => {
    const left = { ...histComment('a.ts', null, 5), side: 'LEFT' };
    expect(overlapsHistory({ path: 'a.ts', line: 5 }, [left], 0.6)).toBe(false);
  });
});

describe('isBotComment', () => {
  test('Bot user type is a bot', () => {
    expect(isBotComment({ user: { type: 'Bot' } })).toBe(true);
  });

  test('User user type or missing user is not a bot', () => {
    expect(isBotComment({ user: { type: 'User' } })).toBe(false);
    expect(isBotComment({})).toBe(false);
    expect(isBotComment(null)).toBe(false);
    expect(isBotComment(undefined)).toBe(false);
  });
});

describe('normalizeContent', () => {
  test('lowercases and collapses whitespace', () => {
    expect(normalizeContent('  Foo   Bar\nBaz ')).toBe('foo bar baz');
  });

  test('strips markdown decoration', () => {
    expect(normalizeContent('**Foo** `bar` [baz]')).toBe('foo bar baz');
  });

  test('drops the summary marker', () => {
    expect(normalizeContent('<!-- ocr-review-summary -->\nFoo')).toBe('foo');
  });

  test('handles null/undefined/empty', () => {
    expect(normalizeContent(null)).toBe('');
    expect(normalizeContent(undefined)).toBe('');
    expect(normalizeContent('')).toBe('');
  });
});

describe('jaccardSimilarity', () => {
  test('returns 1 for equal non-empty sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  test('returns 1 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  test('returns 0 when one set is empty and the other is not', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0);
  });

  test('computes the intersection-over-union ratio', () => {
    // a: {a,b,c}, b: {b,c,d} -> intersection 2, union 4 -> 0.5
    expect(jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5);
  });
});

describe('resolveContentThreshold', () => {
  test('accepts values in (0, 1]', () => {
    expect(resolveContentThreshold('0.5')).toBe(0.5);
    expect(resolveContentThreshold(1)).toBe(1);
  });

  test('falls back to the default for malformed values', () => {
    expect(resolveContentThreshold('0')).toBe(DEFAULT_CONTENT_SIMILARITY_THRESHOLD);
    expect(resolveContentThreshold('-0.1')).toBe(DEFAULT_CONTENT_SIMILARITY_THRESHOLD);
    expect(resolveContentThreshold('1.5')).toBe(DEFAULT_CONTENT_SIMILARITY_THRESHOLD);
    expect(resolveContentThreshold('abc')).toBe(DEFAULT_CONTENT_SIMILARITY_THRESHOLD);
    expect(resolveContentThreshold(undefined)).toBe(DEFAULT_CONTENT_SIMILARITY_THRESHOLD);
  });
});

describe('isDuplicateContent', () => {
  test('normalized exact match is a duplicate', () => {
    expect(isDuplicateContent('**Foo** bar', 'foo `bar`')).toBe(true);
  });

  test('high Jaccard similarity above the threshold is a duplicate', () => {
    // share 4 of 5 tokens -> Jaccard = 0.8 >= 0.7
    expect(isDuplicateContent('the quick brown fox', 'the quick brown fox jumped', 0.7)).toBe(true);
  });

  test('low similarity is not a duplicate', () => {
    expect(isDuplicateContent('the quick brown fox', 'completely unrelated sentence', 0.8)).toBe(false);
  });

  test('empty or whitespace-only bodies never match', () => {
    expect(isDuplicateContent('', 'foo')).toBe(false);
    expect(isDuplicateContent('  ', 'foo')).toBe(false);
    expect(isDuplicateContent('foo', null)).toBe(false);
    expect(isDuplicateContent(null, null)).toBe(false);
  });
});

describe('isDuplicateComment', () => {
  const hist = (path: string, overrides: Record<string, unknown> = {}) => ({
    path,
    side: 'RIGHT',
    body: 'same wording',
    start_line: null,
    line: 10,
    ...overrides,
  });

  test('line overlap alone is a duplicate even with different content', () => {
    const comment = { path: 'a.ts', body: 'totally different', line: 10 };
    expect(isDuplicateComment(comment, [hist('a.ts')])).toBe(true);
  });

  test('content match on a different line is a duplicate', () => {
    const comment = { path: 'a.ts', body: 'same wording', line: 99 };
    expect(isDuplicateComment(comment, [hist('a.ts', { line: 10 })])).toBe(true);
  });

  test('different path is never a duplicate', () => {
    const comment = { path: 'b.ts', body: 'same wording', line: 99 };
    expect(isDuplicateComment(comment, [hist('a.ts')])).toBe(false);
  });

  test('different content and different lines are not duplicates', () => {
    const comment = { path: 'a.ts', body: 'unrelated text here', line: 99 };
    expect(isDuplicateComment(comment, [hist('a.ts', { line: 10, body: 'very different wording' })])).toBe(false);
  });

  test('content rule can be disabled (line overlap only)', () => {
    const comment = { path: 'a.ts', body: 'same wording', line: 99 };
    expect(isDuplicateComment(comment, [hist('a.ts')], { content: false })).toBe(false);
    // ...while a real line overlap is still caught.
    expect(isDuplicateComment({ ...comment, line: 10 }, [hist('a.ts')], { content: false })).toBe(true);
  });

  test('LEFT-side history comments are ignored', () => {
    const comment = { path: 'a.ts', body: 'same wording', line: 99 };
    expect(isDuplicateComment(comment, [hist('a.ts', { side: 'LEFT' })])).toBe(false);
  });
});

describe('routing', () => {
  test('buildRoutePolicy returns NO_ROUTING when nothing is configured', () => {
    expect(buildRoutePolicy('', '')).toBe(NO_ROUTING);
    expect(buildRoutePolicy(undefined, undefined)).toBe(NO_ROUTING);
  });

  test('buildRoutePolicy fails open on unknown severity or unknown categories', () => {
    expect(buildRoutePolicy('trivial', '')).toBe(NO_ROUTING);
    expect(buildRoutePolicy('', 'unknown,also-unknown')).toBe(NO_ROUTING);
  });

  test('buildRoutePolicy normalizes severity and categories case-insensitively', () => {
    const policy = buildRoutePolicy('LOW', 'Style, documentation');
    expect(policy.routeBySeverity).toBe(true);
    expect(policy.severityRank).toBe(SEVERITY_RANK.low);
    expect(policy.routeByCategory).toBe(true);
    expect([...policy.categories].sort()).toEqual(['documentation', 'style']);
  });

  test('shouldRoute: severity below "low" routes low but not medium/high/critical', () => {
    const policy = buildRoutePolicy('low', '');
    expect(shouldRoute({ severity: 'low' }, policy).routed).toBe(true);
    expect(shouldRoute({ severity: 'medium' }, policy).routed).toBe(false);
    expect(shouldRoute({ severity: 'high' }, policy).routed).toBe(false);
    expect(shouldRoute({ severity: 'critical' }, policy).routed).toBe(false);
  });

  test('shouldRoute: severity below "medium" routes medium and low but not high/critical', () => {
    const policy = buildRoutePolicy('medium', '');
    expect(shouldRoute({ severity: 'medium' }, policy).routed).toBe(true);
    expect(shouldRoute({ severity: 'low' }, policy).routed).toBe(true);
    expect(shouldRoute({ severity: 'high' }, policy).routed).toBe(false);
    expect(shouldRoute({ severity: 'critical' }, policy).routed).toBe(false);
  });

  test('shouldRoute: unknown severity is never routed by severity', () => {
    const policy = buildRoutePolicy('low', '');
    expect(shouldRoute({ severity: '' }, policy).routed).toBe(false);
    expect(shouldRoute({}, policy).routed).toBe(false);
  });

  test('shouldRoute: category match routes regardless of severity', () => {
    const policy = buildRoutePolicy('', 'style');
    expect(shouldRoute({ category: 'style', severity: 'critical' }, policy).routed).toBe(true);
    expect(shouldRoute({ category: 'Style' }, policy).routed).toBe(true);
  });

  test('shouldRoute: unknown category is never routed by category', () => {
    const policy = buildRoutePolicy('', 'style');
    expect(shouldRoute({ category: 'bug' }, policy).routed).toBe(false);
    expect(shouldRoute({ category: '' }, policy).routed).toBe(false);
  });

  test('shouldRoute: NO_ROUTING never routes anything', () => {
    expect(shouldRoute({ severity: 'low', category: 'style' }, NO_ROUTING).routed).toBe(false);
  });

  test('shouldRoute: a routed result carries a reason', () => {
    const policy = buildRoutePolicy('low', '');
    const result = shouldRoute({ severity: 'low', category: 'bug' }, policy);
    expect(result.routed).toBe(true);
    if (result.routed) expect(result.reason).toMatch(/severity low/);
  });

  test('CATEGORIES contains the expected enumeration', () => {
    expect(CATEGORIES).toEqual([
      'bug',
      'security',
      'performance',
      'maintainability',
      'test',
      'style',
      'documentation',
      'other',
    ]);
  });
});
