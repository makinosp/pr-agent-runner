import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATEGORIES,
  DEFAULT_BATCH_SIZE,
  DEFAULT_OVERLAP_THRESHOLD,
  NO_ROUTING,
  SEVERITY_RANK,
  buildRoutePolicy,
  chunkArray,
  isBotComment,
  lineSpan,
  overlapsHistory,
  resolveBatchSize,
  resolveThreshold,
  sameCommentSpan,
  shouldRoute,
  sortCommentsDeterministically,
} from '../src/domain/post-comments.ts';

// ---- resolveBatchSize ----

test('resolveBatchSize returns the parsed size for valid positive integers', () => {
  assert.equal(resolveBatchSize('10'), 10);
  assert.equal(resolveBatchSize(1), 1);
});

test('resolveBatchSize falls back to DEFAULT_BATCH_SIZE for invalid values', () => {
  assert.equal(resolveBatchSize('0'), DEFAULT_BATCH_SIZE);
  assert.equal(resolveBatchSize('-3'), DEFAULT_BATCH_SIZE);
  assert.equal(resolveBatchSize('abc'), DEFAULT_BATCH_SIZE);
  assert.equal(resolveBatchSize(undefined), DEFAULT_BATCH_SIZE);
  assert.equal(resolveBatchSize(null), DEFAULT_BATCH_SIZE);
  assert.equal(resolveBatchSize(''), DEFAULT_BATCH_SIZE);
});

// ---- chunkArray ----

test('chunkArray partitions into contiguous slices of at most size', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunkArray yields one chunk of exact size when length is a multiple', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test('chunkArray returns an empty list for an empty input', () => {
  assert.deepEqual(chunkArray([], 5), []);
});

// ---- sortCommentsDeterministically ----

const comment = (path: string, start_line?: number, end_line?: number) => ({ path, start_line, end_line });

test('sortCommentsDeterministically sorts by path then start_line then end_line', () => {
  const input = [comment('b.ts', 5), comment('a.ts', 10, 12), comment('a.ts', 2), comment('a.ts', 10, 11)];
  const sorted = sortCommentsDeterministically(input);
  assert.deepEqual(
    sorted.map((c) => `${c.path}:${c.start_line}:${c.end_line}`),
    ['a.ts:2:undefined', 'a.ts:10:11', 'a.ts:10:12', 'b.ts:5:undefined'],
  );
});

test('sortCommentsDeterministically keeps the original order for identical keys', () => {
  const input = [comment('a.ts', 1, 3), comment('a.ts', 1, 3)];
  const sorted = sortCommentsDeterministically(input);
  assert.equal(sorted[0], input[0]);
  assert.equal(sorted[1], input[1]);
});

test('sortCommentsDeterministically does not mutate the input array', () => {
  const input = [comment('b.ts'), comment('a.ts')];
  sortCommentsDeterministically(input);
  assert.equal(input[0].path, 'b.ts');
  assert.equal(input[1].path, 'a.ts');
});

// ---- lineSpan ----

test('lineSpan resolves a single-line comment from line', () => {
  assert.deepEqual(lineSpan({ line: 3 }), { start: 3, end: 3, multiline: false });
});

test('lineSpan resolves a multi-line comment from start_line and line', () => {
  assert.deepEqual(lineSpan({ start_line: 2, line: 5 }), { start: 2, end: 5, multiline: true });
});

test('lineSpan treats start_line === line as single-line', () => {
  assert.deepEqual(lineSpan({ start_line: 3, line: 3 }), { start: 3, end: 3, multiline: false });
});

test('lineSpan returns null when no line can be resolved', () => {
  assert.equal(lineSpan({}), null);
  assert.equal(lineSpan({ start_line: 0 }), null);
  assert.equal(lineSpan({ line: null }), null);
});

test('lineSpan normalizes reversed start/end to ascending order', () => {
  assert.deepEqual(lineSpan({ start_line: 8, line: 3 }), { start: 3, end: 8, multiline: true });
});

// ---- sameCommentSpan ----

test('sameCommentSpan: two single-line comments are the same only on the same line', () => {
  assert.equal(sameCommentSpan({ start: 3, end: 3, multiline: false }, { start: 3, end: 3, multiline: false }, 0.6), true);
  assert.equal(sameCommentSpan({ start: 3, end: 3, multiline: false }, { start: 4, end: 4, multiline: false }, 0.6), false);
});

test('sameCommentSpan: single-line is never the same as multi-line', () => {
  assert.equal(sameCommentSpan({ start: 3, end: 3, multiline: false }, { start: 3, end: 5, multiline: true }, 0.6), false);
  assert.equal(sameCommentSpan({ start: 3, end: 5, multiline: true }, { start: 3, end: 3, multiline: false }, 0.6), false);
});

test('sameCommentSpan: multi-line IoU strictly above the threshold is a duplicate', () => {
  // cur [2..6] (5 lines), other [4..8] (5 lines): overlap [4..6] = 3, union 7, IoU = 3/7 ≈ 0.43
  assert.equal(sameCommentSpan({ start: 2, end: 6, multiline: true }, { start: 4, end: 8, multiline: true }, 0.4), true);
  // cur [2..6] (5), other [5..6] (2): overlap 2, union 5, IoU = 0.4
  assert.equal(sameCommentSpan({ start: 2, end: 6, multiline: true }, { start: 5, end: 6, multiline: true }, 0.3), true);
});

test('sameCommentSpan: multi-line IoU equal to the threshold is NOT a duplicate (strict >)', () => {
  // cur [1..4] (4), other [3..6] (4): overlap [3..4] = 2, union 6, IoU = 1/3
  assert.equal(sameCommentSpan({ start: 1, end: 4, multiline: true }, { start: 3, end: 6, multiline: true }, 1 / 3), false);
});

test('sameCommentSpan: multi-line IoU below the threshold is NOT a duplicate', () => {
  assert.equal(sameCommentSpan({ start: 1, end: 4, multiline: true }, { start: 3, end: 6, multiline: true }, 0.6), false);
});

test('sameCommentSpan: non-overlapping multi-line spans are never duplicates', () => {
  assert.equal(sameCommentSpan({ start: 1, end: 2, multiline: true }, { start: 10, end: 12, multiline: true }, 0.1), false);
});

// ---- resolveThreshold ----

test('resolveThreshold accepts values in (0, 1]', () => {
  assert.equal(resolveThreshold('0.5'), 0.5);
  assert.equal(resolveThreshold(1), 1);
});

test('resolveThreshold falls back to the default for malformed values', () => {
  assert.equal(resolveThreshold('0'), DEFAULT_OVERLAP_THRESHOLD);
  assert.equal(resolveThreshold('-0.1'), DEFAULT_OVERLAP_THRESHOLD);
  assert.equal(resolveThreshold('1.5'), DEFAULT_OVERLAP_THRESHOLD);
  assert.equal(resolveThreshold('abc'), DEFAULT_OVERLAP_THRESHOLD);
  assert.equal(resolveThreshold(undefined), DEFAULT_OVERLAP_THRESHOLD);
});

// ---- overlapsHistory ----

const histComment = (path: string, start_line: number | null, line: number) => ({ path, start_line, line, user: { type: 'Bot' } });

test('overlapsHistory: same-line single comment is a duplicate', () => {
  assert.equal(overlapsHistory({ path: 'a.ts', line: 5 }, [histComment('a.ts', null, 5)], 0.6), true);
});

test('overlapsHistory: different path is not a duplicate', () => {
  assert.equal(overlapsHistory({ path: 'a.ts', line: 5 }, [histComment('b.ts', null, 5)], 0.6), false);
});

test('overlapsHistory: single-line vs multi-line is never a duplicate', () => {
  assert.equal(overlapsHistory({ path: 'a.ts', line: 5 }, [histComment('a.ts', 4, 6)], 0.6), false);
});

test('overlapsHistory: multi-line with IoU at or below threshold is not a duplicate', () => {
  // cur [1..4] (4), other [3..6] (4): IoU = 1/3
  assert.equal(overlapsHistory({ path: 'a.ts', start_line: 1, line: 4 }, [histComment('a.ts', 3, 6)], 1 / 3), false);
  assert.equal(overlapsHistory({ path: 'a.ts', start_line: 1, line: 4 }, [histComment('a.ts', 3, 6)], 0.6), false);
});

test('overlapsHistory: multi-line with high IoU is a duplicate', () => {
  assert.equal(overlapsHistory({ path: 'a.ts', start_line: 1, line: 6 }, [histComment('a.ts', 2, 6)], 0.6), true);
});

test('overlapsHistory: LEFT-side history comments are ignored', () => {
  const left = { ...histComment('a.ts', null, 5), side: 'LEFT' };
  assert.equal(overlapsHistory({ path: 'a.ts', line: 5 }, [left], 0.6), false);
});

// ---- isBotComment ----

test('isBotComment: Bot user type is a bot', () => {
  assert.equal(isBotComment({ user: { type: 'Bot' } }), true);
});

test('isBotComment: User user type or missing user is not a bot', () => {
  assert.equal(isBotComment({ user: { type: 'User' } }), false);
  assert.equal(isBotComment({}), false);
  assert.equal(isBotComment(null), false);
  assert.equal(isBotComment(undefined), false);
});

// ---- routing ----

test('buildRoutePolicy returns NO_ROUTING when nothing is configured', () => {
  assert.equal(buildRoutePolicy('', ''), NO_ROUTING);
  assert.equal(buildRoutePolicy(undefined, undefined), NO_ROUTING);
});

test('buildRoutePolicy fails open on unknown severity or unknown categories', () => {
  assert.equal(buildRoutePolicy('trivial', ''), NO_ROUTING);
  assert.equal(buildRoutePolicy('', 'unknown,also-unknown'), NO_ROUTING);
});

test('buildRoutePolicy normalizes severity and categories case-insensitively', () => {
  const policy = buildRoutePolicy('LOW', 'Style, documentation');
  assert.equal(policy.routeBySeverity, true);
  assert.equal(policy.severityRank, SEVERITY_RANK.low);
  assert.equal(policy.routeByCategory, true);
  assert.deepEqual([...policy.categories].sort(), ['documentation', 'style']);
});

test('shouldRoute: severity below "low" routes medium and low but not high/critical', () => {
  const policy = buildRoutePolicy('low', '');
  assert.equal(shouldRoute({ severity: 'low' }, policy).routed, true);
  assert.equal(shouldRoute({ severity: 'medium' }, policy).routed, true);
  assert.equal(shouldRoute({ severity: 'high' }, policy).routed, false);
  assert.equal(shouldRoute({ severity: 'critical' }, policy).routed, false);
});

test('shouldRoute: unknown severity is never routed by severity', () => {
  const policy = buildRoutePolicy('low', '');
  assert.equal(shouldRoute({ severity: '' }, policy).routed, false);
  assert.equal(shouldRoute({}, policy).routed, false);
});

test('shouldRoute: category match routes regardless of severity', () => {
  const policy = buildRoutePolicy('', 'style');
  assert.equal(shouldRoute({ category: 'style', severity: 'critical' }, policy).routed, true);
  assert.equal(shouldRoute({ category: 'Style' }, policy).routed, true);
});

test('shouldRoute: unknown category is never routed by category', () => {
  const policy = buildRoutePolicy('', 'style');
  assert.equal(shouldRoute({ category: 'bug' }, policy).routed, false);
  assert.equal(shouldRoute({ category: '' }, policy).routed, false);
});

test('shouldRoute: NO_ROUTING never routes anything', () => {
  assert.equal(shouldRoute({ severity: 'low', category: 'style' }, NO_ROUTING).routed, false);
});

test('shouldRoute: a routed result carries a reason', () => {
  const policy = buildRoutePolicy('low', '');
  const result = shouldRoute({ severity: 'medium', category: 'bug' }, policy);
  assert.equal(result.routed, true);
  if (result.routed) assert.match(result.reason, /severity medium/);
});

test('CATEGORIES contains the expected enumeration', () => {
  assert.deepEqual(CATEGORIES, ['bug', 'security', 'performance', 'maintainability', 'test', 'style', 'documentation', 'other']);
});
