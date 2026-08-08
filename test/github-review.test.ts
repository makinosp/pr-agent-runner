import type { Finding } from '../src/schemas/finding.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { postReview } from '../src/output/github-review.ts';

type FakeOctokit = {
  rest: {
    pulls: {
      get: () => Promise<{ data: { head: { sha: string } } }>;
      createReview: (params: Record<string, unknown>) => Promise<{ data: { html_url: string } }>;
      listReviews: () => Promise<{ data: Array<Record<string, unknown>> }>;
      updateReview: (params: Record<string, unknown>) => Promise<{ data: { html_url: string } }>;
      listReviewComments: () => Promise<{ data: Array<Record<string, unknown>> }>;
    };
  };
  paginate: () => Promise<Array<{ filename: string; patch?: string | null }>>;
};

const makeFakeOctokit = (
  files: Array<{ filename: string; patch?: string | null }>,
  captured: Array<Record<string, unknown>>,
  seed: { reviews?: Array<Record<string, unknown>>; reviewComments?: Array<Record<string, unknown>> } = {},
): FakeOctokit => ({
  rest: {
    pulls: {
      get: async (): Promise<{ data: { head: { sha: string } } }> => ({ data: { head: { sha: 'abc123' } } }),
      createReview: async (params: Record<string, unknown>): Promise<{ data: { html_url: string } }> => {
        captured.push(params);
        return { data: { html_url: 'https://github.com/o/r/pull/7/reviews/new' } };
      },
      listReviews: async (): Promise<{ data: Array<Record<string, unknown>> }> => ({ data: seed.reviews ?? [] }),
      updateReview: async (params: Record<string, unknown>): Promise<{ data: { html_url: string } }> => {
        captured.push(params);
        return { data: { html_url: 'https://github.com/o/r/pull/7/reviews/updated' } };
      },
      listReviewComments: async (): Promise<{ data: Array<Record<string, unknown>> }> => ({
        data: seed.reviewComments ?? [],
      }),
    },
  },
  paginate: async (): Promise<Array<{ filename: string; patch?: string | null }>> => files,
});

/** Patch with right-side lines 1..5 all reviewable. */
const PATCH = ['@@ -1,3 +1,5 @@', ' line1', '+line2', '+line3', '+line4', '+line5'].join('\n');

const inlineFinding = (line: number, severity: Finding['severity'] = 'high', category: Finding['category'] = 'bug'): Finding => ({
  path: 'a.ts',
  start_line: line,
  category,
  severity,
  content: `inline ${line}`,
  side: 'RIGHT',
});

const summaryFinding: Finding = {
  path: 'src/example.ts',
  category: 'documentation',
  severity: 'low',
  content: 'summary only',
  side: 'LEFT',
};

test('postReview returns early with empty stats when there are no findings', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([], captured);
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 1, []);
  assert.equal(captured.length, 0);
  assert.deepEqual(stats, { total: 0, inline: 0, skipped: 0, routed: 0, failed: 0 });
});

test('postReview posts inline comments for reviewable lines', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured);
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)]);

  assert.equal(captured.length, 1);
  const review = captured[0] as { commit_id: string; event: string; comments?: Array<Record<string, unknown>> };
  assert.equal(review.commit_id, 'abc123');
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.comments?.length, 1);
  assert.equal(review.comments?.[0]?.path, 'a.ts');
  assert.equal(review.comments?.[0]?.line, 3);
  assert.deepEqual(stats, { total: 1, inline: 1, skipped: 0, routed: 0, failed: 0, summaryUrl: 'https://github.com/o/r/pull/7/reviews/new' });
});

test('postReview moves non-reviewable findings into the summary body', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([], captured);
  await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [summaryFinding]);

  assert.equal(captured.length, 1);
  const review = captured[0] as { body: string; comments?: unknown[] };
  assert.match(review.body, /Review Summary/);
  assert.match(review.body, /summary only/);
  assert.equal(review.comments, undefined);
});

test('postReview adds start_line for multi-line inline comments', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured);
  const multiLine: Finding = {
    path: 'a.ts',
    start_line: 2,
    end_line: 4,
    category: 'bug',
    severity: 'high',
    content: 'range',
    side: 'RIGHT',
  };
  await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [multiLine]);

  const review = captured[0] as { comments?: Array<Record<string, unknown>> };
  assert.equal(review.comments?.[0]?.start_line, 2);
  assert.equal(review.comments?.[0]?.line, 4);
  assert.equal(review.comments?.[0]?.start_side, 'RIGHT');
});

// ---- batch splitting ----

test('postReview splits inline comments into batches of batchSize', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured);
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [
    inlineFinding(2),
    inlineFinding(3),
    inlineFinding(5),
  ], { batchSize: '1' });

  assert.equal(captured.length, 3);
  for (const review of captured) {
    assert.equal((review as { comments: unknown[] }).comments.length, 1);
  }
  // Summary body (with marker) travels on the first batch only.
  assert.match((captured[0] as { body: string }).body, /ocr-review-summary/);
  assert.equal((captured[1] as { body?: string }).body, undefined);
  assert.equal((captured[2] as { body?: string }).body, undefined);
  assert.equal(stats.total, 3);
  assert.equal(stats.inline, 3);
});

// ---- sticky summary ----

test('postReview creates a fresh review carrying the summary on first run', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured);
  await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)]);

  assert.equal(captured.length, 1);
  assert.match((captured[0] as { body: string }).body, /ocr-review-summary/);
  assert.equal((captured[0] as { comments?: unknown[] }).comments?.length, 1);
});

test('postReview updates the existing summary review in place when sticky', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured, {
    reviews: [{ id: 42, body: '<!-- ocr-review-summary -->\nold summary', html_url: 'https://github.com/o/r/pull/7/reviews/42' }],
  });
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)]);

  assert.equal(captured.length, 2);
  const created = captured.find((c) => Array.isArray(c.comments)) as { body?: string };
  const updated = captured.find((c) => c.review_id === 42) as { review_id: number; body: string };
  assert.ok(created, 'expected a createReview for inline comments');
  // Inline comments go to a fresh review; the summary body is updated in place.
  assert.equal(created.body, undefined);
  assert.ok(updated, 'expected an updateReview for the sticky summary');
  assert.equal(updated.review_id, 42);
  assert.match(updated.body, /ocr-review-summary/);
  assert.equal(stats.summaryUrl, 'https://github.com/o/r/pull/7/reviews/updated');
});

test('postReview with sticky false always posts a fresh review with the summary', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured, {
    reviews: [{ id: 42, body: '<!-- ocr-review-summary -->\nold summary' }],
  });
  await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)], { sticky: false });

  assert.equal(captured.length, 1);
  assert.match((captured[0] as { body: string }).body, /ocr-review-summary/);
  assert.equal((captured[0] as { comments?: unknown[] }).comments?.length, 1);
});

test('postReview summary-only run updates the existing sticky review without creating a new one', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([], captured, {
    reviews: [{ id: 42, body: '<!-- ocr-review-summary -->\nold summary' }],
  });
  await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [summaryFinding]);

  assert.equal(captured.length, 1);
  const updated = captured[0] as { review_id?: number; body: string };
  assert.equal(updated.review_id, 42);
  assert.match(updated.body, /summary only/);
});

// ---- incremental ----

test('postReview skips an inline comment overlapping an existing bot comment on the same line', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured, {
    reviewComments: [{ path: 'a.ts', start_line: null, line: 3, side: 'RIGHT', user: { type: 'Bot', login: 'app[bot]' } }],
  });
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)], { incremental: true });

  assert.equal(stats.skipped, 1);
  assert.equal(stats.inline, 0);
  // Nothing inline left → summary-only review (no comments).
  assert.equal(captured.length, 1);
  assert.equal((captured[0] as { comments?: unknown[] }).comments, undefined);
  assert.match((captured[0] as { body: string }).body, /overlapped with existing reviews/);
});

test('postReview does not skip a single-line comment when history is multi-line', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured, {
    reviewComments: [{ path: 'a.ts', start_line: 2, line: 4, side: 'RIGHT', user: { type: 'Bot' } }],
  });
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)], { incremental: true });

  assert.equal(stats.skipped, 0);
  assert.equal(stats.inline, 1);
});

test('postReview does not skip a multi-line comment when IoU is at or below the threshold', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured, {
    reviewComments: [{ path: 'a.ts', start_line: 3, line: 5, side: 'RIGHT', user: { type: 'Bot' } }],
  });
  const multiLine: Finding = { path: 'a.ts', start_line: 1, end_line: 4, category: 'bug', severity: 'high', content: 'range', side: 'RIGHT' };
  // cur [1..4] (4 lines), other [3..5] (3): overlap 2, union 5, IoU = 0.4 <= 0.6
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [multiLine], { incremental: true });

  assert.equal(stats.skipped, 0);
  assert.equal(stats.inline, 1);
});

test('postReview skips a multi-line comment when IoU exceeds the threshold', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured, {
    reviewComments: [{ path: 'a.ts', start_line: 2, line: 5, side: 'RIGHT', user: { type: 'Bot' } }],
  });
  const multiLine: Finding = { path: 'a.ts', start_line: 1, end_line: 5, category: 'bug', severity: 'high', content: 'range', side: 'RIGHT' };
  // cur [1..5] (5), other [2..5] (4): overlap 4, union 5, IoU = 0.8 > 0.6
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [multiLine], { incremental: true });

  assert.equal(stats.skipped, 1);
  assert.equal(stats.inline, 0);
});

test('postReview ignores history comments from non-bot users', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured, {
    reviewComments: [{ path: 'a.ts', start_line: null, line: 3, side: 'RIGHT', user: { type: 'User', login: 'human' } }],
  });
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)], { incremental: true });

  assert.equal(stats.skipped, 0);
  assert.equal(stats.inline, 1);
});

// ---- routing ----

test('postReview routes only low findings to the summary with routeSeverityBelow=low', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured);
  const stats = await postReview(
    octokit as never,
    { owner: 'o', repo: 'r' },
    7,
    [inlineFinding(2, 'high'), inlineFinding(3, 'medium'), inlineFinding(5, 'low')],
    { routeSeverityBelow: 'low' },
  );

  assert.equal(stats.routed, 1);
  assert.equal(stats.inline, 2);
  assert.equal(captured.length, 1);
  const review = captured[0] as { comments: Array<Record<string, unknown>>; body: string };
  assert.deepEqual(review.comments.map((comment) => comment.line), [2, 3]);
  assert.match(review.body, /low/);
  assert.match(review.body, /Routed to summary/);
});

test('postReview routes only medium and low findings with routeSeverityBelow=medium', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured);
  const stats = await postReview(
    octokit as never,
    { owner: 'o', repo: 'r' },
    7,
    [inlineFinding(1, 'critical'), inlineFinding(2, 'high'), inlineFinding(3, 'medium'), inlineFinding(5, 'low')],
    { routeSeverityBelow: 'medium' },
  );

  assert.equal(stats.routed, 2);
  assert.equal(stats.inline, 2);
  assert.equal(captured.length, 1);
  const review = captured[0] as { comments: Array<Record<string, unknown>>; body: string };
  assert.deepEqual(
    review.comments.map((comment) => comment.line),
    [1, 2],
  );
  assert.match(review.body, /medium/);
  assert.match(review.body, /low/);
});

test('postReview routes findings matching a configured category to the summary', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured);
  const stats = await postReview(
    octokit as never,
    { owner: 'o', repo: 'r' },
    7,
    [inlineFinding(2, 'high', 'bug'), inlineFinding(3, 'high', 'style')],
    { routeCategories: 'style' },
  );

  assert.equal(stats.routed, 1);
  assert.equal(stats.inline, 1);
  const review = captured[0] as { comments: Array<Record<string, unknown>> };
  assert.equal(review.comments[0].line, 2);
});

test('postReview leaves unknown metadata alone (nothing routed)', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured);
  const stats = await postReview(
    octokit as never,
    { owner: 'o', repo: 'r' },
    7,
    [inlineFinding(2, 'medium'), inlineFinding(3, 'low')],
    { routeSeverityBelow: 'garbage' },
  );

  assert.equal(stats.routed, 0);
  assert.equal(stats.inline, 2);
  assert.equal(captured.length, 1);
  assert.equal((captured[0] as { comments: unknown[] }).comments.length, 2);
});

test('postReview reports failed batches in stats', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([{ filename: 'a.ts', patch: PATCH }], captured);
  // Force the createReview call to reject.
  (octokit.rest.pulls.createReview as () => Promise<never>) = async () => {
    throw new Error('boom');
  };
  const stats = await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [inlineFinding(3)]);

  assert.equal(stats.failed, 1);
  assert.equal(stats.inline, 0);
});
