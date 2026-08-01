import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import type { Finding } from '../schemas/finding.ts';
import { resolveEndLine } from '../schemas/finding.ts';
import { buildReviewableRightLineMap, splitFindingsForReview } from '../domain/reviewable-lines.ts';
import {
  SUMMARY_MARKER,
  buildRoutePolicy,
  chunkArray,
  isBotComment,
  overlapsHistory,
  resolveBatchSize,
  resolveThreshold,
  shouldRoute,
  sortCommentsDeterministically,
} from '../domain/post-comments.ts';
import { buildCommentBody } from './markdown.ts';
import type { RepoRef } from '../schemas/common.ts';

type RawComment = NonNullable<RestEndpointMethodTypes['pulls']['createReview']['parameters']['comments']>[number];
type Comment = Partial<Pick<RawComment, 'position' | 'start_line' | 'start_side'>> & Required<Omit<RawComment, 'position' | 'start_line' | 'start_side'>>;
type ReviewComment = RestEndpointMethodTypes['pulls']['listReviewComments']['response']['data'][number];
type Review = RestEndpointMethodTypes['pulls']['listReviews']['response']['data'][number];

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
  /** Max inline comments per createReview call (default: 50). */
  readonly batchSize?: string | number;
  /** Route findings at-or-below this severity to the summary (default: none). */
  readonly routeSeverityBelow?: string;
  /** Comma-separated categories routed to the summary (default: none). */
  readonly routeCategories?: string;
}

export interface ReviewStats {
  readonly total: number;
  readonly inline: number;
  readonly skipped: number;
  readonly routed: number;
  readonly failed: number;
  readonly summaryUrl?: string;
}

const EMPTY_STATS: ReviewStats = { total: 0, inline: 0, skipped: 0, routed: 0, failed: 0 };

type InlineFinding = Finding & { start_line: number };

const toComment = (finding: InlineFinding): Comment => {
  const endLine = resolveEndLine(finding);
  const isMultiLine = typeof finding.end_line === 'number' && finding.end_line > finding.start_line;
  const comment = {
    path: finding.path,
    line: endLine,
    side: 'RIGHT' as const,
    body: buildCommentBody(finding),
  };
  if (isMultiLine) {
    return { ...comment, start_line: finding.start_line, start_side: 'RIGHT' as const };
  }
  return comment;
};

const renderSummaryEntry = (finding: Finding, reason?: string): string => {
  let md = `### 📄 \`${finding.path}\``;
  if (finding.start_line) {
    md += ` (L${finding.start_line}${finding.end_line ? `-L${finding.end_line}` : ''})`;
  }
  md += `\n\n${buildCommentBody(finding)}`;
  if (reason) md += `\n\n*${reason}*`;
  return md;
};

const buildSummaryBody = (
  findingsCount: number,
  entries: ReadonlyArray<{ readonly finding: Finding; readonly reason?: string }>,
): string => {
  let body = `${SUMMARY_MARKER}\nOpenCodeReview: **${findingsCount}** issues (critical: ${entries.filter(({ finding }) => finding.severity === 'critical').length})`;
  if (entries.length > 0) {
    body += `\n\n--- \n\n## Review Summary\n\n`;
    body += entries.map(({ finding, reason }) => renderSummaryEntry(finding, reason)).join('\n\n---\n\n');
  }
  return body;
};

/**
 * List review comments newest-first, capped at MAX_PAGES pages so a
 * pathological PR cannot stall the job. On failure, degrade to an empty
 * history (incremental filtering becomes a no-op).
 */
const listExistingReviewComments = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
): Promise<ReviewComment[]> => {
  const all: ReviewComment[] = [];
  const MAX_PAGES = 10;
  let page = 1;
  try {
    while (page <= MAX_PAGES) {
      const res = await octokit.rest.pulls.listReviewComments({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        sort: 'created',
        direction: 'desc',
        per_page: 100,
        page,
      });
      const items = res.data ?? [];
      all.push(...items);
      if (items.length < 100) break;
      page += 1;
    }
  } catch (error) {
    console.info(
      `[incremental] listing review comments failed (${error instanceof Error ? error.message : String(error)}); degrading to no history.`,
    );
    return [];
  }
  if (page > MAX_PAGES) {
    console.info(`[incremental] listing review comments reached max page limit (${MAX_PAGES}); results may be incomplete.`);
  }
  return all;
};

/** Find the newest review whose body carries the summary marker. */
const findSummaryReview = async (octokit: Octokit, repo: RepoRef, prNumber: number): Promise<Review | undefined> => {
  const all: Review[] = [];
  const MAX_PAGES = 10;
  let page = 1;
  try {
    while (page <= MAX_PAGES) {
      const res = await octokit.rest.pulls.listReviews({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });
      const items = res.data ?? [];
      all.push(...items);
      if (items.length < 100) break;
      page += 1;
    }
  } catch (error) {
    console.info(
      `[sticky] listing reviews failed (${error instanceof Error ? error.message : String(error)}); posting a fresh review.`,
    );
    return undefined;
  }
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const body = all[i].body;
    if (typeof body === 'string' && body.includes(SUMMARY_MARKER)) return all[i];
  }
  return undefined;
};

/**
 * Post review comments for a PR. Inline comments are batched into one or more
 * `createReview` calls; the summary lives in the review body. When `sticky`,
 * the review carrying the summary marker is updated in place across runs
 * (inline comments always go to fresh reviews, since GitHub does not allow
 * adding comments to an existing review).
 */
export const postReview = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  findings: readonly Finding[],
  options: ReviewOptions = {},
): Promise<ReviewStats> => {
  if (findings.length === 0) return EMPTY_STATS;

  const sticky = options.sticky !== false;
  const incremental = options.incremental === true;
  const threshold = resolveThreshold(options.incrementalOverlapThreshold);
  const batchSize = resolveBatchSize(options.batchSize);
  const policy = buildRoutePolicy(options.routeSeverityBelow, options.routeCategories);

  const { data: pr } = await octokit.rest.pulls.get({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
  });

  const reviewFiles = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const reviewableRightLines = buildReviewableRightLineMap(reviewFiles);
  const { inlineComments, summaryComments } = splitFindingsForReview(findings, reviewableRightLines);

  // Routing is a placement decision: findings that COULD be posted inline but
  // match the policy move to the summary (counted in stats.routed). Findings
  // without a valid line already go to the summary via splitFindingsForReview,
  // so they are never re-routed.
  let routed = 0;
  const routedEntries: Array<{ readonly finding: Finding; readonly reason: string }> = [];
  const remainingInline: InlineFinding[] = [];
  for (const finding of inlineComments) {
    const route = shouldRoute(finding, policy);
    if (route.routed) {
      routed += 1;
      routedEntries.push({ finding, reason: route.reason });
    } else {
      remainingInline.push(finding);
    }
  }

  let summaryBody = buildSummaryBody(findings.length, [
    ...summaryComments.map((finding) => ({ finding })),
    ...routedEntries,
  ]);

  const comments = remainingInline.map(toComment);

  // Incremental filtering: drop inline comments whose (path, line range)
  // overlaps an existing bot review comment. History is never deleted.
  let skipped = 0;
  let toSend = comments;
  if (incremental && comments.length > 0) {
    const existing = await listExistingReviewComments(octokit, repo, prNumber);
    const history = existing.filter(isBotComment);
    toSend = comments.filter((comment) => !overlapsHistory(comment, history, threshold));
    skipped = comments.length - toSend.length;
  }

  const sorted = sortCommentsDeterministically(toSend);
  const batches = chunkArray(sorted, batchSize);

  if (toSend.length === 0 && skipped > 0) {
    summaryBody += '\n\n---\n\nℹ️ All inline comments overlapped with existing reviews; nothing new was posted.';
  }

  // The sticky summary review (body carries SUMMARY_MARKER) is updated in
  // place when one already exists. In that case fresh inline-comment reviews
  // carry no body, so the summary never duplicates across reviews.
  const existingSummary = sticky ? await findSummaryReview(octokit, repo, prNumber) : undefined;

  let inline = 0;
  let failed = 0;
  let summaryUrl: string | undefined;
  const postBatch = async (index: number, body: string | undefined): Promise<void> => {
    try {
      const { data: review } = await octokit.rest.pulls.createReview({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        commit_id: pr.head.sha,
        event: 'COMMENT',
        body,
        comments: batches[index],
      });
      inline += batches[index].length;
      if (index === 0 && typeof review.html_url === 'string') summaryUrl = review.html_url;
    } catch (error) {
      console.info(
        `[post] failed to post review batch of ${batches[index].length} comment(s): ${error instanceof Error ? error.message : String(error)}`,
      );
      failed += batches[index].length;
    }
  };

  if (batches.length > 0) {
    // First batch carries the summary body (and the marker) unless a sticky
    // summary review already exists — in that case the body is updated in
    // place below and the new review carries comments only.
    const firstBody = existingSummary === undefined ? summaryBody : undefined;
    for (let i = 0; i < batches.length; i += 1) {
      await postBatch(i, i === 0 ? firstBody : undefined);
    }
    // Sticky: refresh the existing summary review body so the latest counts
    // and routed/summary findings are reflected there, not in a fresh review.
    if (existingSummary !== undefined) {
      const { data: updated } = await octokit.rest.pulls.updateReview({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: prNumber,
        review_id: existingSummary.id,
        body: summaryBody,
      });
      if (typeof updated.html_url === 'string') summaryUrl = updated.html_url;
    }
  } else if (existingSummary !== undefined) {
    // Summary-only run with an existing sticky summary: update in place.
    const { data: updated } = await octokit.rest.pulls.updateReview({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      review_id: existingSummary.id,
      body: summaryBody,
    });
    if (typeof updated.html_url === 'string') summaryUrl = updated.html_url;
  } else {
    // Summary-only run, no sticky review yet: create one.
    const { data: review } = await octokit.rest.pulls.createReview({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: prNumber,
      commit_id: pr.head.sha,
      event: 'COMMENT',
      body: summaryBody,
    });
    if (typeof review.html_url === 'string') summaryUrl = review.html_url;
  }

  return { total: findings.length, inline, skipped, routed, failed, ...(summaryUrl !== undefined ? { summaryUrl } : {}) };
};
