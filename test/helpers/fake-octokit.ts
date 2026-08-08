/**
 * Shared FakeOctokit for unit tests.
 *
 * Captures all calls so tests can assert on the payloads.
 * Extend the interface as needed for new Octokit methods.
 */
import type { RestEndpointMethodTypes } from '@octokit/rest';

/** Optional seed data returned by `listReviews` / `listReviewComments`. */
export interface FakeOctokitSeed {
  reviews?: Array<Record<string, unknown>>;
  reviewComments?: Array<Record<string, unknown>>;
}

type OctokitFile = RestEndpointMethodTypes['pulls']['listFiles']['response']['data'][number];

type FakePullData = {
  head: { sha: string; ref: string };
  base: { ref: string };
  title?: string;
  body?: string;
};

export type FakeOctokitRest = {
  pulls: {
    get: () => Promise<{ data: FakePullData }>;
    update: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
    createReview: (params: Record<string, unknown>) => Promise<{ data: { html_url?: string } }>;
    create: (params: Record<string, unknown>) => Promise<{ data: { html_url: string } }>;
    listFiles: (params: Record<string, unknown>) => Promise<{ data: OctokitFile[]; headers: { link: string } }>;
    listReviews: (params: Record<string, unknown>) => Promise<{ data: Array<Record<string, unknown>> }>;
    updateReview: (params: Record<string, unknown>) => Promise<{ data: { html_url?: string } }>;
    listReviewComments: (params: Record<string, unknown>) => Promise<{ data: Array<Record<string, unknown>> }>;
  };
  issues: {
    createComment: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  };
  git: {
    createRef: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  };
  repos: {
    /** Subset of `repos.getContent` file response — only `content` and `encoding`. */
    getContent: (params: Record<string, unknown>) => Promise<{ data: { content?: string; encoding?: string } }>;
    createOrUpdateFileContents: (params: Record<string, unknown>) => Promise<{ data: unknown }>;
  };
};

export type FakeOctokit = {
  rest: FakeOctokitRest;
  paginate: (method: unknown, params: Record<string, unknown>) => Promise<OctokitFile[]>;
};

export interface OctokitCaptures {
  reviews: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  prUpdates: Array<Record<string, unknown>>;
  prCreates: Array<Record<string, unknown>>;
  gitRefs: Array<Record<string, unknown>>;
  fileUpdates: Array<{ path: string; content: string }>;
  fileReads: Array<{ path: string }>;
  reviewUpdates: Array<Record<string, unknown>>;
}

export const createCaptures = (): OctokitCaptures => ({
  reviews: [],
  comments: [],
  prUpdates: [],
  prCreates: [],
  gitRefs: [],
  fileUpdates: [],
  fileReads: [],
  reviewUpdates: [],
});

export const makeFakeOctokit = (
  files: Array<{ filename: string; patch?: string | null }>,
  captures: OctokitCaptures,
  seed: FakeOctokitSeed = {},
): FakeOctokit => ({
  rest: {
    pulls: {
      get: async () => ({
        data: {
          head: { sha: 'abc123', ref: 'feature-branch' },
          base: { ref: 'main' },
          title: 'Test PR',
          body: 'Test body',
        },
      }),
      update: async (params) => {
        captures.prUpdates.push(params);
        return { data: {} };
      },
      createReview: async (params) => {
        captures.reviews.push(params);
        return { data: { html_url: 'https://github.com/test/reviews/new' } };
      },
      create: async (params) => {
        captures.prCreates.push(params);
        return { data: { html_url: 'https://github.com/test/pr/1' } };
      },
      listReviews: async () => ({ data: seed.reviews ?? [] }),
      updateReview: async (params) => {
        captures.reviewUpdates.push(params);
        return { data: { html_url: 'https://github.com/test/reviews/updated' } };
      },
      listReviewComments: async () => ({ data: seed.reviewComments ?? [] }),
      listFiles: async () => ({
        data: files.map((f) => ({
          sha: '',
          blob_url: '',
          raw_url: '',
          contents_url: '',
          additions: 1,
          deletions: 1,
          changes: 2,
          status: 'modified' as const,
          patch: f.patch ?? undefined,
          filename: f.filename,
        })),
        headers: { link: '' },
      }),
    },
    issues: {
      createComment: async (params) => {
        captures.comments.push(params);
        return { data: {} };
      },
    },
    git: {
      createRef: async (params) => {
        captures.gitRefs.push(params);
        return { data: {} };
      },
    },
    repos: {
      getContent: async (params) => {
        captures.fileReads.push({ path: params.path as string });
        return {
          data: { content: Buffer.from('line1\nline2\nline3\nline4\nline5').toString('base64'), encoding: 'base64' },
        };
      },
      createOrUpdateFileContents: async (params) => {
        captures.fileUpdates.push({ path: params.path as string, content: params.content as string });
        return { data: {} };
      },
    },
  },
  paginate: async () =>
    files.map((f) => ({
      sha: '',
      blob_url: '',
      raw_url: '',
      contents_url: '',
      additions: 1,
      deletions: 1,
      changes: 2,
      status: 'modified' as const,
      patch: f.patch ?? undefined,
      filename: f.filename,
    })),
});

/**
 * Cast a FakeOctokit to the real Octokit type at call sites.
 * Replaces the pervasive `as never` casts in tests while keeping the fake
 * structurally compatible with the subset of the Octokit API under test.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake only implements a subset of Octokit
export const toOctokit = (fake: FakeOctokit): never => fake as never;
