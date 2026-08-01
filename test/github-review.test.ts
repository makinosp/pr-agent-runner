import type { Finding } from '../src/schemas/finding.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { postReview } from '../src/output/github-review.ts';

type FakeOctokit = {
  rest: {
    pulls: {
      get: () => Promise<{ data: { head: { sha: string } } }>;
      createReview: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
    };
  };
  paginate: () => Promise<Array<{ filename: string; patch?: string | null }>>;
};

const makeFakeOctokit = (
  files: Array<{ filename: string; patch?: string | null }>,
  captured: Array<Record<string, unknown>>,
): FakeOctokit => ({
  rest: {
    pulls: {
      get: async (): Promise<{ data: { head: { sha: string } } }> => ({ data: { head: { sha: 'abc123' } } }),
      createReview: async (params: Record<string, unknown>): Promise<{ data: unknown }> => {
        captured.push(params);
        return { data: {} };
      },
    },
  },
  paginate: async (): Promise<Array<{ filename: string; patch?: string | null }>> => files,
});

const inlineFinding: Finding = {
  path: 'src/example.ts',
  start_line: 3,
  category: 'bug',
  severity: 'high',
  content: 'inline',
  side: 'RIGHT',
};

test('postReview returns early when there are no findings', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([], captured);
  await postReview(octokit as never, { owner: 'o', repo: 'r' }, 1, []);
  assert.equal(captured.length, 0);
});

test('postReview posts inline comments for reviewable lines', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit(
    [{ filename: 'src/example.ts', patch: ['@@ -2,2 +2,3 @@', ' c1', '+c2', ' c3'].join('\n') }],
    captured,
  );
  await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [inlineFinding]);

  assert.equal(captured.length, 1);
  const review = captured[0] as { commit_id: string; event: string; comments?: Array<Record<string, unknown>> };
  assert.equal(review.commit_id, 'abc123');
  assert.equal(review.event, 'COMMENT');
  assert.equal(review.comments?.length, 1);
  assert.equal(review.comments?.[0]?.path, 'src/example.ts');
  assert.equal(review.comments?.[0]?.line, 3);
});

test('postReview moves non-reviewable findings into the summary body', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit([], captured);
  const summaryFinding: Finding = {
    path: 'src/example.ts',
    category: 'documentation',
    severity: 'low',
    content: 'summary only',
    side: 'LEFT',
  };
  await postReview(octokit as never, { owner: 'o', repo: 'r' }, 7, [summaryFinding]);

  assert.equal(captured.length, 1);
  const review = captured[0] as { body: string; comments?: unknown[] };
  assert.match(review.body, /Review Summary/);
  assert.match(review.body, /summary only/);
  assert.equal(review.comments, undefined);
});

test('postReview adds start_line for multi-line inline comments', async () => {
  const captured: Array<Record<string, unknown>> = [];
  const octokit = makeFakeOctokit(
    [{ filename: 'src/example.ts', patch: ['@@ -2,3 +2,3 @@', ' c1', ' c2', ' c3'].join('\n') }],
    captured,
  );
  const multiLine: Finding = {
    path: 'src/example.ts',
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
