import type { RestEndpointMethodTypes } from '@octokit/rest';
import type { Finding } from '../schemas/finding.ts';
import { resolveEndLine } from '../schemas/finding.ts';

type OctokitFile = RestEndpointMethodTypes['pulls']['listFiles']['response']['data'][number];
type ReviewFilePatch = Pick<OctokitFile, 'filename' | 'patch'>;
type SplitFindingsResult = { inlineComments: InlineFinding[]; summaryComments: Finding[] };
export type InlineFinding = Finding & { start_line: number; side: 'RIGHT' };
type HunkAccumulator = { rightLine: number; inHunk: boolean; lines: Set<number> };

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const parsePatchLines = (patch: string): Set<number> =>
  patch.split('\n').reduce<HunkAccumulator>(
    (acc, line) => {
      const hunk = HUNK_HEADER.exec(line);
      if (hunk) {
        acc.rightLine = Number(hunk[1]);
        acc.inHunk = true;
        return acc;
      }
      if (!acc.inHunk || line.startsWith('\\')) return acc;
      if (line.startsWith('+') || line.startsWith(' ')) {
        acc.lines.add(acc.rightLine);
        acc.rightLine += 1;
      }
      return acc;
    },
    { rightLine: 0, inHunk: false, lines: new Set<number>() },
  ).lines;

export const buildReviewableRightLineMap = (files: readonly ReviewFilePatch[]): Map<string, Set<number>> => {
  return new Map(
    files.flatMap(({ filename, patch }) => {
      if (typeof patch !== 'string' || patch.length === 0) return [];
      const lines = parsePatchLines(patch);
      return lines.size > 0 ? [[filename, lines] as const] : [];
    }),
  );
};

const hasReviewableRightRange = (
  reviewableRightLines: ReadonlyMap<string, ReadonlySet<number>>,
  finding: Finding & { start_line: number },
): boolean => {
  const lines = reviewableRightLines.get(finding.path);
  if (!lines) return false;
  const endLine = resolveEndLine(finding);
  for (let line = finding.start_line; line <= endLine; line += 1) {
    if (!lines.has(line)) return false;
  }
  return true;
};

/**
 * Determine if a finding is an inline comment-postable RIGHT-side finding with a numeric start_line.
 */
export const isInlineRightFinding = (finding: Finding): finding is InlineFinding =>
  finding.side === 'RIGHT' && typeof finding.start_line === 'number' && finding.start_line >= 1;

const canPostInlineComment = (
  reviewableRightLines: ReadonlyMap<string, ReadonlySet<number>>,
  finding: Finding,
): finding is InlineFinding => {
  if (!isInlineRightFinding(finding)) return false;
  return hasReviewableRightRange(reviewableRightLines, finding);
};

export const splitFindingsForReview = (
  findings: readonly Finding[],
  reviewableRightLines: ReadonlyMap<string, ReadonlySet<number>>,
): SplitFindingsResult =>
  findings.reduce<SplitFindingsResult>(
    (acc, finding) => {
      if (canPostInlineComment(reviewableRightLines, finding)) {
        acc.inlineComments.push(finding);
      } else {
        acc.summaryComments.push(finding);
      }
      return acc;
    },
    { inlineComments: [], summaryComments: [] },
  );
