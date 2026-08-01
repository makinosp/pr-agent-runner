import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import type { Finding } from '../schemas/finding.ts';
import { resolveEndLine } from '../schemas/finding.ts';
import { buildReviewableRightLineMap, splitFindingsForReview } from '../domain/reviewable-lines.ts';
import { buildCommentBody } from './markdown.ts';
import type { RepoRef } from '../schemas/common.ts';

type RawComment = NonNullable<RestEndpointMethodTypes['pulls']['createReview']['parameters']['comments']>[number];
type Comment = Partial<Pick<RawComment, 'position' | 'start_line' | 'start_side'>> & Required<Omit<RawComment, 'position' | 'start_line' | 'start_side'>>;

export const postReview = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  findings: readonly Finding[],
): Promise<void> => {
  if (findings.length === 0) return;

  const countOfCritical = findings.filter(({ severity }) => severity === 'critical').length;
  let body = `OpenCodeReview: **${findings.length}** issues (critical: ${countOfCritical})`;

  const { data } = await octokit.rest.pulls.get({
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

  if (summaryComments.length > 0) {
    body += `\n\n--- \n\n## Review Summary\n\n`;
    body += summaryComments
      .map((finding) => {
        let md = `### 📄 \`${finding.path}\``;
        if (finding.start_line) {
          md += ` (L${finding.start_line}${finding.end_line ? `-L${finding.end_line}` : ''})`;
        }
        const commentBody = buildCommentBody(finding);
        md += `\n\n${commentBody}`;
        return md;
      })
      .join('\n\n---\n\n');
  }

  const comments = inlineComments.map((finding): Comment => {
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
  });

  await octokit.rest.pulls.createReview({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: prNumber,
    commit_id: data.head.sha,
    event: 'COMMENT',
    body,
    comments: comments.length > 0 ? comments : undefined,
  });
};
