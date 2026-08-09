import type { Category, Severity } from '../schemas/common.ts';

/**
 * Pure helpers for PR review comment posting, ported from the upstream
 * OpenCodeReview `scripts/github-actions/post-review-comments.js` (this repo's
 * `.vendor/open-code-review` snapshot).
 *
 * Only the core functionality is ported — idempotency tags, retries and
 * rate-limit management are intentionally omitted. All functions are pure so
 * they can be unit-tested without Octokit.
 */

/** Marker embedded in the review body that carries the summary. Used to locate
 * the sticky review for in-place updates across runs. */
export const SUMMARY_MARKER = '<!-- ocr-review-summary -->';

/** Default IoU threshold for the incremental multi-line overlap test. */
export const DEFAULT_OVERLAP_THRESHOLD = 0.6;

/** Default maximum number of inline comments packed into a single createReview
 * call (GitHub's soft guidance for comments per review). */
export const DEFAULT_BATCH_SIZE = 50;

/** Severity rank: higher number = less severe. An unknown/empty severity has
 * no rank and is never matched by the routing policy. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Category enumeration for routing (case-insensitive comparison at use site). */
export const CATEGORIES: readonly Category[] = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'test',
  'style',
  'documentation',
  'other',
];

const isSeverity = (value: string): value is Severity =>
  (SEVERITY_RANK as Readonly<Record<string, number | undefined>>)[value] !== undefined;

const isCategory = (value: string): value is Category => (CATEGORIES as readonly string[]).includes(value);

// ---- Batch sizing + deterministic ordering ----

/** Resolve the configured batch size. A batch size is a positive integer
 * (N>=1): 0, negatives, NaN and non-numeric strings all fall back to the
 * default. */
export const resolveBatchSize = (raw: string | number | null | undefined): number => {
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_BATCH_SIZE;
};

/** Minimal shape shared by sortable comment-like objects. */
interface SortableComment {
  readonly path: string;
  readonly start_line?: number | null;
  readonly end_line?: number | null;
  readonly line?: number | null;
}

/** Deterministically order comments before partitioning so identical inputs
 * produce identical batches across reruns. Returns a NEW array (does not
 * mutate the caller's array). Sort key: path → start_line → end_line →
 * original array index (explicit tiebreak guarantees stable ordering even for
 * same-file same-line comments). */
export const sortCommentsDeterministically = <T extends SortableComment>(items: readonly T[]): T[] =>
  items
    .map((item, origIndex) => ({ item, origIndex }))
    .sort((a, b) => {
      const byPath = String(a.item.path).localeCompare(String(b.item.path));
      if (byPath !== 0) return byPath;
      const byStart = (a.item.start_line || 0) - (b.item.start_line || 0);
      if (byStart !== 0) return byStart;
      const aEnd = a.item.end_line ?? a.item.line ?? 0;
      const bEnd = b.item.end_line ?? b.item.line ?? 0;
      if (aEnd !== bEnd) return aEnd - bEnd;
      return a.origIndex - b.origIndex;
    })
    .map(({ item }) => item);

/** Partition an array into contiguous slices of at most `size` items. */
export const chunkArray = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

// ---- Incremental overlap ----

/** Normalize a non-negative line value; null/undefined/empty/<1 become null. */
const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? n : null;
};

interface LineSpan {
  readonly start: number;
  readonly end: number;
  readonly multiline: boolean;
}

/** Resolve a comment into a line span tagged as single- or multi-line.
 * Handles both our own review-comment shape ({start_line, line}) and GitHub's
 * historical shape ({start_line, line}; start_line null for single-line). A
 * comment is multi-line only when start_line and line are both present and
 * differ; start_line === line (or a missing start_line) is treated as a
 * single-line comment on that line. */
export const lineSpan = (c: {
  readonly start_line?: number | string | null;
  readonly line?: number | string | null;
  readonly end_line?: number | string | null;
}): LineSpan | null => {
  const start = num(c.start_line);
  const end = num(c.line ?? c.end_line);
  if (start === null && end === null) return null;
  if (start !== null && end !== null && start !== end) {
    return { start: Math.min(start, end), end: Math.max(start, end), multiline: true };
  }
  const single = end ?? start;
  if (single === null) return null;
  return { start: single, end: single, multiline: false };
};

/** Same-comment predicate implementing the incremental rules. The IoU
 * comparison is strict (>), so a span that exactly meets the threshold is NOT
 * treated as a duplicate. */
export const sameCommentSpan = (cur: LineSpan, other: LineSpan, threshold: number): boolean => {
  if (cur.multiline !== other.multiline) return false;
  if (!cur.multiline) return cur.start === other.start;
  const overlap = Math.min(cur.end, other.end) - Math.max(cur.start, other.start) + 1;
  if (overlap <= 0) return false;
  const union = cur.end - cur.start + 1 + (other.end - other.start + 1) - overlap;
  if (union <= 0) return false;
  return overlap / union > threshold;
};

/** Clamp/validate the caller-provided threshold to a sane (0, 1] number,
 * falling back to the default when it is missing, NaN, or out of range. */
export const resolveThreshold = (threshold: string | number | null | undefined): number => {
  const n = Number(threshold);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_OVERLAP_THRESHOLD;
};

/** Decide whether a bot previously posted `comment`. Simplified from upstream
 * (login comparison + getAuthenticated): a GitHub App token always posts as a
 * Bot user, so the user type alone is sufficient. */
export const isBotComment = (
  comment: { readonly user?: { readonly type?: string | null } | null } | null | undefined,
): boolean => comment?.user?.type === 'Bot';

/**
 * Incremental overlap test. The current comment is a duplicate of an existing
 * bot comment (and thus skipped) when they target the same path and RIGHT side
 * AND one of these holds:
 *   1. both are single-line comments on the same line;
 *   2. both are multi-line comments whose line-range IoU (intersection over
 *      union) exceeds `threshold`.
 * A single-line comment is NEVER considered the same as a multi-line one.
 */
export const overlapsHistory = (
  comment: {
    readonly path: string;
    readonly start_line?: number | string | null;
    readonly line?: number | string | null;
    readonly end_line?: number | string | null;
    readonly side?: string | null;
  },
  history: ReadonlyArray<{
    readonly path: string;
    readonly start_line?: number | string | null;
    readonly line?: number | string | null;
    readonly end_line?: number | string | null;
    readonly side?: string | null;
  }>,
  threshold: string | number | null | undefined = DEFAULT_OVERLAP_THRESHOLD,
): boolean => {
  const t = resolveThreshold(threshold);
  const cur = lineSpan(comment);
  if (!cur) return false;
  for (const h of history) {
    if (h.path !== comment.path) continue;
    if (h.side && h.side !== 'RIGHT') continue;
    const other = lineSpan(h);
    if (!other) continue;
    if (sameCommentSpan(cur, other, t)) return true;
  }
  return false;
};

// ---- Content-based deduplication ----

/** Default Jaccard threshold for content-based duplicate detection. */
export const DEFAULT_CONTENT_SIMILARITY_THRESHOLD = 0.8;

/** Normalize comment text so near-identical wording compares equal: drop the
 * summary marker, strip common Markdown decoration, collapse whitespace, and
 * lowercase. Used to compare posted bodies that differ only in formatting. */
export const normalizeContent = (text: string | null | undefined): string =>
  String(text ?? '')
    .replace(SUMMARY_MARKER, '')
    .replace(/[*_`#>[\]().]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Tokenize normalized text into a word set (empty tokens are dropped). */
const tokenize = (text: string): ReadonlySet<string> => new Set(text.split(' ').filter((t) => t.length > 0));

/** Jaccard coefficient between two token sets; 1 when both sets are empty. */
export const jaccardSimilarity = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
};

/** Clamp/validate the caller-provided content threshold to a sane (0, 1]
 * number, falling back to the default when missing, NaN, or out of range. */
export const resolveContentThreshold = (threshold: string | number | null | undefined): number => {
  const n = Number(threshold);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_CONTENT_SIMILARITY_THRESHOLD;
};

/** Content-level duplicate test: two bodies are duplicates when their
 * normalized forms match exactly, or their token Jaccard similarity is
 * at-or-above `threshold`. Empty/whitespace-only bodies never match. */
export const isDuplicateContent = (
  current: string | null | undefined,
  existing: string | null | undefined,
  threshold: string | number | null | undefined = DEFAULT_CONTENT_SIMILARITY_THRESHOLD,
): boolean => {
  const t = resolveContentThreshold(threshold);
  const cur = normalizeContent(current);
  const other = normalizeContent(existing);
  if (cur.length === 0 || other.length === 0) return false;
  if (cur === other) return true;
  return jaccardSimilarity(tokenize(cur), tokenize(other)) >= t;
};

/** Options controlling the combined (line + content) duplicate test. */
export interface DedupeOptions {
  /** IoU threshold for the multi-line overlap rule (default: 0.6). */
  readonly lineThreshold?: string | number | null;
  /** Enable the content-similarity rule (default: true). */
  readonly content?: boolean;
  /** Jaccard threshold for the content rule (default: 0.8). */
  readonly contentThreshold?: string | number | null;
}

/**
 * Decide whether a candidate comment duplicates any entry in `history`. A
 * comment is a duplicate when it targets the same path as a history comment
 * AND either:
 *   1. line-based overlap — same single line, or multi-line IoU above
 *      `lineThreshold` (the pre-existing incremental rule); or
 *   2. content-based similarity — normalized exact match or Jaccard
 *      at-or-above `contentThreshold` against the history body, when content
 *      dedup is enabled.
 * The rules are OR-ed: different lines with the same wording are caught by the
 * content rule; the same line with different wording is caught by the line
 * rule. Only RIGHT-side history comments are considered.
 */
export const isDuplicateComment = (
  comment: {
    readonly path: string;
    readonly body?: string | null;
    readonly start_line?: number | string | null;
    readonly line?: number | string | null;
    readonly end_line?: number | string | null;
    readonly side?: string | null;
  },
  history: ReadonlyArray<{
    readonly path: string;
    readonly body?: string | null;
    readonly start_line?: number | string | null;
    readonly line?: number | string | null;
    readonly end_line?: number | string | null;
    readonly side?: string | null;
  }>,
  options: DedupeOptions = {},
): boolean => {
  const lineThreshold = resolveThreshold(options.lineThreshold);
  const contentEnabled = options.content !== false;
  const contentThreshold = resolveContentThreshold(options.contentThreshold);
  for (const h of history) {
    if (h.path !== comment.path) continue;
    if (h.side && h.side !== 'RIGHT') continue;
    if (overlapsHistory(comment, [h], lineThreshold)) return true;
    if (contentEnabled && isDuplicateContent(comment.body, h.body, contentThreshold)) return true;
  }
  return false;
};

// ---- Routing (severity/category → summary) ----

/** Sentinel policy object: "do not route anything". Returned by buildRoutePolicy
 * on any parse problem so the posting loop falls open to normal behavior. */
export const NO_ROUTING: RoutePolicy = Object.freeze({
  routeBySeverity: false,
  severityRank: -1,
  routeByCategory: false,
  categories: new Set<string>(),
});

interface RoutePolicy {
  readonly routeBySeverity: boolean;
  /** Rank of the threshold severity; -1 when severity routing is disabled. */
  readonly severityRank: number;
  readonly routeByCategory: boolean;
  /** Lowercase category members; empty when category routing is disabled. */
  readonly categories: ReadonlySet<string>;
}

type RouteResult = { readonly routed: true; readonly reason: string } | { readonly routed: false };

/** Parse the routing policy from the raw inputs. Unknown/empty values disable
 * that routing dimension (fail-open: an unknown threshold never routes).
 * Category tokens are case-insensitive; unknown tokens are dropped. */
export const buildRoutePolicy = (
  severityBelow: string | null | undefined,
  categories: string | null | undefined,
): RoutePolicy => {
  let routeBySeverity = false;
  let severityRank = -1;
  if (severityBelow !== null && severityBelow !== undefined) {
    const norm = String(severityBelow).trim().toLowerCase();
    if (isSeverity(norm)) {
      routeBySeverity = true;
      severityRank = SEVERITY_RANK[norm];
    }
  }

  let routeByCategory = false;
  const categorySet = new Set<string>();
  if (categories !== null && categories !== undefined) {
    for (const token of String(categories)
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0)) {
      if (isCategory(token)) categorySet.add(token);
    }
    if (categorySet.size > 0) routeByCategory = true;
  }

  if (!routeBySeverity && !routeByCategory) return NO_ROUTING;
  return { routeBySeverity, severityRank, routeByCategory, categories: categorySet };
};

/**
 * Decide whether a finding routes to the summary per the policy. A finding
 * matches when its severity is at-or-below the threshold (when severity
 * routing is on) OR its category is in the category list (when category
 * routing is on).
 *
 * Severity rank increases as severity decreases (critical=0 … low=3), so the
 * configured threshold itself and less severe findings are routed to the
 * summary. For example, `routeSeverityBelow='medium'` routes medium and low.
 * Unknown/malformed metadata NEVER matches: an empty/unknown category or
 * severity falls through to the normal inline path (visible, never dropped).
 */
export const shouldRoute = (
  finding: { readonly severity?: string; readonly category?: string },
  policy: RoutePolicy,
): RouteResult => {
  if (!policy.routeBySeverity && !policy.routeByCategory) return { routed: false };
  const catRaw = String(finding.category ?? '')
    .trim()
    .toLowerCase();
  const sevRaw = String(finding.severity ?? '')
    .trim()
    .toLowerCase();
  const catKnown = catRaw !== '' && isCategory(catRaw);
  const sevKnown = sevRaw !== '' && isSeverity(sevRaw);

  if (policy.routeBySeverity && sevKnown && SEVERITY_RANK[sevRaw] >= policy.severityRank) {
    return { routed: true, reason: `Routed to summary (severity ${sevRaw}${catKnown ? ` · category ${catRaw}` : ''})` };
  }
  if (policy.routeByCategory && catKnown && policy.categories.has(catRaw)) {
    return { routed: true, reason: `Routed to summary (category ${catRaw}${sevKnown ? ` · severity ${sevRaw}` : ''})` };
  }
  return { routed: false };
};
