import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';

/** Repository reference (owner + name). */
export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Test seams for the CLI entry points. All fields default to the real
 * implementations so production behaviour is unchanged.
 */
export interface CliDeps {
  /** Override Octokit construction (defaults to real Octokit). */
  octokitFactory?: (token: string) => Octokit;
  /** Override execFile (defaults to promisified node:child_process.execFile). */
  execFile?: (
    file: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Override writeFile (defaults to node:fs/promises.writeFile). */
  writeFile?: (path: string, data: string, encoding: 'utf8') => Promise<void>;
  /** Override @actions/core.info (defaults to the real one). */
  info?: (message: string) => void;
  /** Override @actions/core.setOutput (defaults to the real one). */
  setOutput?: (name: string, value: string) => void;
  /** Override @actions/core.setFailed (defaults to the real one). */
  setFailed?: (message: string) => void;
}

export interface ReviewCliConfig {
  readonly mode: 'review';
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly resultPath: string;
  readonly composePr: boolean;
  readonly baseRef?: string;
  readonly headSha?: string;
  readonly stickySummary: boolean;
  readonly incremental: boolean;
  readonly incrementalOverlapThreshold: string;
  readonly contentBasedDeduplication: boolean;
  readonly contentSimilarityThreshold: string;
  readonly batchSize: string;
  readonly routeSeverityBelow: string;
  readonly routeCategories: string;
}

export interface ChatCliConfig {
  readonly mode: 'chat' | 'review-on-mention';
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly commentId: number;
  readonly commentBody: string;
  readonly commentUser: string;
  readonly botMention: string;
}

export type CliConfig = ReviewCliConfig | ChatCliConfig;

// ---------------------------------------------------------------------------
// GitHub review I/F types
// ---------------------------------------------------------------------------
//
// These are the DTOs and public contracts used by the output layer
// (src/output/github-review.ts). They live here so the CLI, the action input
// loader, and the output layer can all reference the same definitions
// without circular imports.

/** One element of the `comments` array accepted by `pulls.createReview`. */
export type RawComment = NonNullable<
  RestEndpointMethodTypes['pulls']['createReview']['parameters']['comments']
>[number];

/** Normalised comment DTO: a `Comment` always carries `path`/`line`/`side`/`body`,
 * while multi-line ranges add `start_line`/`start_side` and drop `position`. */
export type Comment = Partial<Pick<RawComment, 'position' | 'start_line' | 'start_side'>> &
  Required<Omit<RawComment, 'position' | 'start_line' | 'start_side'>>;

/** Shape of a single review comment returned by `pulls.listReviewComments`. */
export type ReviewComment = RestEndpointMethodTypes['pulls']['listReviewComments']['response']['data'][number];

/** Shape of a single review returned by `pulls.listReviews`. */
export type Review = RestEndpointMethodTypes['pulls']['listReviews']['response']['data'][number];

/** Options controlling how findings are posted. Every field is optional;
 * defaults mirror the action inputs (sticky summary, no incremental filtering,
 * 50 comments per batch, no routing). */
export interface ReviewOptions {
  /** Update the summary review body in place across runs (default: true). */
  readonly sticky?: boolean;
  /** Skip inline comments overlapping previously-posted bot comments (default: false). */
  readonly incremental?: boolean;
  /** IoU threshold for multi-line overlap in incremental mode (default: 0.6). */
  readonly incrementalOverlapThreshold?: string | number;
  /** Also skip inline comments whose content matches a previously-posted bot
   * comment on the same path, even when the lines differ (default: true). */
  readonly contentBasedDeduplication?: boolean;
  /** Jaccard threshold in [0, 1] for content-based dedup (default: 0.8). */
  readonly contentSimilarityThreshold?: string | number;
  /** Max inline comments per createReview call (default: 50). */
  readonly batchSize?: string | number;
  /** Route findings at-or-below this severity to the summary (default: none). */
  readonly routeSeverityBelow?: string;
  /** Comma-separated categories routed to the summary (default: none). */
  readonly routeCategories?: string;
}

/** Result counters returned by `postReview`. `summaryUrl` is the HTML URL of
 * the review whose body carries the summary marker (the freshly-created one
 * for a first run, or the updated sticky review on subsequent runs). */
export interface ReviewStats {
  readonly total: number;
  readonly inline: number;
  readonly skipped: number;
  readonly routed: number;
  readonly failed: number;
  readonly summaryUrl?: string;
}
