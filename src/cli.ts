import type { ChatCliConfig, CliConfig, CliDeps, RepoRef, ReviewCliConfig, ReviewOptions } from './types.ts';
import type { Finding } from './schemas/finding.ts';
import { execFile } from 'node:child_process';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { info as coreInfo, setFailed, setOutput as coreSetOutput } from '@actions/core';
import { Octokit } from '@octokit/rest';
import { answerChat, postChatReply } from './chat/chat.ts';
import { applyFixes, extractFixTargets } from './chat/fix.ts';
import { resolveLlmConfig } from './chat/llm.ts';
import { fetchPrContext, parseMention, type PrContext } from './chat/mention.ts';
import { composePrTitleBody } from './chat/pr-compose.ts';
import { loadFindings } from './input/loader.ts';
import { postReview } from './output/github-review.ts';

const execFileAsync = promisify(execFile);

const parseRepo = (env: NodeJS.ProcessEnv): RepoRef => {
  const [owner, repo] = env.GITHUB_REPOSITORY?.split('/') ?? [];
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is required');
  return { owner, repo };
};

const parsePrNumber = (env: NodeJS.ProcessEnv): number => {
  const prNumber = Number(env.PR_NUMBER);
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error('PR_NUMBER is invalid');
  return prNumber;
};

/** Parse review posting options from the environment. Optional fields stay
 * raw so `postReview` resolves its own defaults. */
const parseReviewOptions = (env: NodeJS.ProcessEnv): ReviewOptions => ({
  sticky: env.REVIEW_STICKY_SUMMARY !== 'false',
  incremental: env.REVIEW_INCREMENTAL === 'true',
  incrementalOverlapThreshold: env.REVIEW_INCREMENTAL_OVERLAP_THRESHOLD,
  contentBasedDeduplication: env.REVIEW_CONTENT_BASED_DEDUPLICATION !== 'false',
  contentSimilarityThreshold: env.REVIEW_CONTENT_SIMILARITY_THRESHOLD,
  batchSize: env.REVIEW_COMMENT_BATCH_SIZE,
  routeSeverityBelow: env.REVIEW_ROUTE_SEVERITY_BELOW ?? '',
  routeCategories: env.REVIEW_ROUTE_CATEGORIES ?? '',
});

export const parseConfig = (env: NodeJS.ProcessEnv): CliConfig => {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const { owner, repo } = parseRepo(env);
  const prNumber = parsePrNumber(env);

  if (env.COMMENT_ID !== undefined && env.COMMENT_ID !== '') {
    const commentId = Number(env.COMMENT_ID);
    if (!Number.isInteger(commentId) || commentId <= 0) throw new Error('COMMENT_ID is invalid');
    const commentBody = env.COMMENT_BODY ?? '';
    const commentUser = env.COMMENT_USER ?? '';
    const botMention = env.BOT_MENTION || '@opencode-review';
    return {
      mode: 'review-on-mention',
      token,
      owner,
      repo,
      prNumber,
      commentId,
      commentBody,
      commentUser,
      botMention,
    };
  }

  const options = parseReviewOptions(env);
  return {
    mode: 'review',
    token,
    owner,
    repo,
    prNumber,
    resultPath: env.RESULT_PATH ?? 'result.json',
    composePr: env.COMPOSE_PR === 'true',
    baseRef: env.BASE_REF,
    headSha: env.HEAD_SHA,
    stickySummary: options.sticky ?? true,
    incremental: options.incremental ?? false,
    incrementalOverlapThreshold: String(options.incrementalOverlapThreshold ?? ''),
    contentBasedDeduplication: options.contentBasedDeduplication ?? true,
    contentSimilarityThreshold: String(options.contentSimilarityThreshold ?? ''),
    batchSize: String(options.batchSize ?? ''),
    routeSeverityBelow: options.routeSeverityBelow ?? '',
    routeCategories: options.routeCategories ?? '',
  };
};

export const runReview = async (config: ReviewCliConfig, deps: CliDeps = {}): Promise<void> => {
  const { info = coreInfo, setOutput = coreSetOutput } = deps;
  const octokitFactory = deps.octokitFactory ?? ((token: string): Octokit => new Octokit({ auth: token }));
  const octokit = octokitFactory(config.token);

  try {
    let resultPath = config.resultPath;
    // When a ref range is provided (composite action flow), run OCR here so the
    // action has a single entry point. Otherwise fall back to a pre-generated
    // result file (standalone usage).
    if (config.baseRef && config.headSha) {
      resultPath = await runOcrReview({ baseRef: config.baseRef, headSha: config.headSha }, deps);
    }

    if (config.composePr) {
      try {
        const llmConfig = resolveLlmConfig(process.env);
        const pr = await fetchPrContext(octokit, { owner: config.owner, repo: config.repo }, config.prNumber);
        const composed = await composePrTitleBody(octokit, llmConfig, { owner: config.owner, repo: config.repo }, pr);
        if (composed) {
          info(`Composed PR title: ${composed.title}`);
        } else {
          info('PR composition returned no valid result; skipping update');
        }
      } catch (error) {
        info(`PR composition failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const findings = await loadFindings(resultPath);

    // Handle empty array or null/undefined cases
    if (!Array.isArray(findings)) {
      throw new Error(`loadFindings returned invalid type: ${typeof findings}`);
    }

    info(`Loaded ${findings.length} findings`);

    // Skip if no findings
    if (findings.length === 0) {
      info('No findings to review; skipping');
      return;
    }

    const stats = await postReview(octokit, { owner: config.owner, repo: config.repo }, config.prNumber, findings, {
      sticky: config.stickySummary,
      incremental: config.incremental,
      incrementalOverlapThreshold: config.incrementalOverlapThreshold,
      contentBasedDeduplication: config.contentBasedDeduplication,
      contentSimilarityThreshold: config.contentSimilarityThreshold,
      batchSize: config.batchSize,
      routeSeverityBelow: config.routeSeverityBelow,
      routeCategories: config.routeCategories,
    });
    setOutput('comments_total', String(stats.total));
    setOutput('comments_inline', String(stats.inline));
    setOutput('comments_skipped', String(stats.skipped));
    setOutput('comments_routed', String(stats.routed));
    setOutput('comments_failed', String(stats.failed));
    setOutput('summary_comment_url', stats.summaryUrl ?? '');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Review failed for PR #${config.prNumber}: ${msg}`);
  }
};

export const runOcrReview = async (
  refs: { readonly baseRef: string; readonly headSha: string },
  deps: CliDeps = {},
): Promise<string> => {
  const {
    execFile = execFileAsync as NonNullable<CliDeps['execFile']>,
    writeFile = fsWriteFile as NonNullable<CliDeps['writeFile']>,
  } = deps;
  const env: Record<string, string | undefined> = {
    OCR_LLM_URL: process.env.OCR_LLM_URL,
    OCR_LLM_TOKEN: process.env.OCR_LLM_TOKEN,
    OCR_LLM_MODEL: process.env.OCR_LLM_MODEL,
    OCR_USE_ANTHROPIC: process.env.OCR_USE_ANTHROPIC,
    OCR_LLM_PROTOCOL: process.env.OCR_LLM_PROTOCOL,
  };
  const { baseRef, headSha } = refs;

  await execFile('ocr', ['llm', 'test'], { env: { ...process.env, ...env } });
  await execFile('ocr', ['config', 'set', 'language', process.env.OCR_LANGUAGE ?? 'English'], {
    env: { ...process.env, ...env },
  });
  await execFile('git', ['fetch', 'origin', baseRef]);
  const { stdout: mergeBase } = await execFile('git', ['merge-base', `origin/${baseRef}`, headSha]);
  const resultPath = 'result.json';
  const { stdout } = await execFile(
    'ocr',
    ['review', '--from', mergeBase.trim(), '--to', headSha, '--format', 'json', '--audience', 'agent'],
    { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
  );
  await writeFile(resultPath, stdout, 'utf8');
  return resultPath;
};

interface OcrPrResult {
  readonly pr: PrContext;
  readonly findings: readonly Finding[];
}

/**
 * Run OCR against the PR diff and load the resulting findings.
 * Shared by the review re-run and auto-fix mention flows.
 */
const runOcrForPr = async (
  octokit: Octokit,
  repo: RepoRef,
  prNumber: number,
  deps: CliDeps = {},
): Promise<OcrPrResult> => {
  const pr = await fetchPrContext(octokit, repo, prNumber);
  const resultPath = await runOcrReview({ baseRef: pr.baseRef, headSha: pr.headSha }, deps);
  return { pr, findings: await loadFindings(resultPath) };
};

export const runMention = async (config: ChatCliConfig, deps: CliDeps = {}): Promise<void> => {
  const { info = coreInfo } = deps;
  const payload = parseMention(config.commentBody, config.botMention);
  if (payload === null) {
    info('No mention found. Skipping.');
    return;
  }

  const octokitFactory = deps.octokitFactory ?? ((token: string): Octokit => new Octokit({ auth: token }));
  const octokit = octokitFactory(config.token);
  const repo = { owner: config.owner, repo: config.repo };

  if (payload.mode === 'review') {
    info('Mention requested review re-run');
    const { findings } = await runOcrForPr(octokit, repo, config.prNumber, deps);
    await postReview(octokit, repo, config.prNumber, findings, parseReviewOptions(process.env));
    info('Review re-run done');
    return;
  }

  if (payload.mode === 'fix') {
    info('Mention requested auto-fix');
    const { pr, findings } = await runOcrForPr(octokit, repo, config.prNumber, deps);
    const targets = extractFixTargets(findings);
    info(`Extracted ${targets.length} fixable targets (critical/high with suggestion)`);
    const result = await applyFixes(octokit, repo, config.prNumber, targets, pr.headSha, pr.baseRef, config.botMention);
    if (result.changedFiles > 0 && result.prUrl) {
      await postChatReply(
        octokit,
        repo,
        config.prNumber,
        `Created fix PR: ${result.prUrl}\n\nFiles modified: ${result.changedFiles}`,
        config.botMention,
        config.commentId,
      );
    } else {
      await postChatReply(
        octokit,
        repo,
        config.prNumber,
        'No fixable findings (critical/high with suggestions) were found.',
        config.botMention,
        config.commentId,
      );
    }
    info('Auto-fix done');
    return;
  }

  info(`Chat question: ${payload.question}`);
  const llmConfig = resolveLlmConfig(process.env);
  const pr = await fetchPrContext(octokit, repo, config.prNumber);
  const answer = await answerChat(octokit, llmConfig, repo, pr, payload.question);
  await postChatReply(octokit, repo, config.prNumber, answer, config.botMention, config.commentId);
  info('Chat reply posted');
};

const run = async (config: CliConfig, deps: CliDeps = {}): Promise<void> => {
  if (config.mode === 'review') {
    await runReview(config, deps);
    return;
  }
  await runMention(config, deps);
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => run(parseConfig(process.env)))
    .catch((error) => {
      setFailed(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
