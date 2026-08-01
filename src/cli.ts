import type { RepoRef } from './schemas/common.ts';
import type { Finding } from './schemas/finding.ts';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { info, setFailed } from '@actions/core';
import { Octokit } from '@octokit/rest';
import { answerChat, postChatReply } from './chat/chat.ts';
import { applyFixes, extractFixTargets } from './chat/fix.ts';
import { resolveLlmConfig } from './chat/llm.ts';
import { fetchPrContext, parseMention, type PrContext } from './chat/mention.ts';
import { composePrTitleBody } from './chat/pr-compose.ts';
import { loadFindings } from './input/loader.ts';
import { postReview } from './output/github-review.ts';

const execFileAsync = promisify(execFile);

interface ReviewCliConfig {
  readonly mode: 'review';
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly resultPath: string;
  readonly composePr: boolean;
  readonly baseRef?: string;
  readonly headSha?: string;
}

interface ChatCliConfig {
  readonly mode: 'chat' | 'review-on-mention';
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly commentBody: string;
  readonly commentUser: string;
  readonly botMention: string;
}

type CliConfig = ReviewCliConfig | ChatCliConfig;

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

export const parseConfig = (env: NodeJS.ProcessEnv): CliConfig => {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const { owner, repo } = parseRepo(env);
  const prNumber = parsePrNumber(env);

  if (env.COMMENT_ID !== undefined) {
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
      commentBody,
      commentUser,
      botMention,
    };
  }

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
  };
};

const runReview = async (config: ReviewCliConfig): Promise<void> => {
  const octokit = new Octokit({ auth: config.token });

  try {
    let resultPath = config.resultPath;
    // When a ref range is provided (composite action flow), run OCR here so the
    // action has a single entry point. Otherwise fall back to a pre-generated
    // result file (standalone usage).
    if (config.baseRef && config.headSha) {
      resultPath = await runOcrReview({ baseRef: config.baseRef, headSha: config.headSha });
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

    await postReview(octokit, { owner: config.owner, repo: config.repo }, config.prNumber, findings);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setFailed(`Review failed for PR #${config.prNumber}: ${msg}`);
    process.exit(1);
  }
};

const runOcrReview = async (refs: { readonly baseRef: string; readonly headSha: string }): Promise<string> => {
  const env: Record<string, string | undefined> = {
    OCR_LLM_URL: process.env.OCR_LLM_URL,
    OCR_LLM_TOKEN: process.env.OCR_LLM_TOKEN,
    OCR_LLM_MODEL: process.env.OCR_LLM_MODEL,
    OCR_USE_ANTHROPIC: process.env.OCR_USE_ANTHROPIC,
    OCR_LLM_PROTOCOL: process.env.OCR_LLM_PROTOCOL,
  };
  const { baseRef, headSha } = refs;

  await execFileAsync('ocr', ['llm', 'test'], { env: { ...process.env, ...env } });
  await execFileAsync('ocr', ['config', 'set', 'language', process.env.OCR_LANGUAGE ?? 'English'], {
    env: { ...process.env, ...env },
  });
  await execFileAsync('git', ['fetch', 'origin', baseRef]);
  const { stdout: mergeBase } = await execFileAsync('git', ['merge-base', `origin/${baseRef}`, headSha]);
  const resultPath = 'result.json';
  const { stdout } = await execFileAsync(
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
const runOcrForPr = async (octokit: Octokit, repo: RepoRef, prNumber: number): Promise<OcrPrResult> => {
  const pr = await fetchPrContext(octokit, repo, prNumber);
  const resultPath = await runOcrReview({ baseRef: pr.baseRef, headSha: pr.headSha });
  return { pr, findings: await loadFindings(resultPath) };
};

const runMention = async (config: ChatCliConfig): Promise<void> => {
  const payload = parseMention(config.commentBody, config.botMention);
  if (payload === null) {
    info('No mention found. Skipping.');
    return;
  }

  const octokit = new Octokit({ auth: config.token });
  const repo = { owner: config.owner, repo: config.repo };

  if (payload.mode === 'review') {
    info('Mention requested review re-run');
    const { findings } = await runOcrForPr(octokit, repo, config.prNumber);
    await postReview(octokit, repo, config.prNumber, findings);
    info('Review re-run done');
    return;
  }

  if (payload.mode === 'fix') {
    info('Mention requested auto-fix');
    const { pr, findings } = await runOcrForPr(octokit, repo, config.prNumber);
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
      );
    } else {
      await postChatReply(
        octokit,
        repo,
        config.prNumber,
        'No fixable findings (critical/high with suggestions) were found.',
        config.botMention,
      );
    }
    info('Auto-fix done');
    return;
  }

  info(`Chat question: ${payload.question}`);
  const llmConfig = resolveLlmConfig(process.env);
  const pr = await fetchPrContext(octokit, repo, config.prNumber);
  const answer = await answerChat(octokit, llmConfig, repo, pr, payload.question);
  await postChatReply(octokit, repo, config.prNumber, answer, config.botMention);
  info('Chat reply posted');
};

const run = async (config: CliConfig): Promise<void> => {
  if (config.mode === 'review') {
    await runReview(config);
    return;
  }
  await runMention(config);
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => run(parseConfig(process.env)))
    .catch((error) => {
      setFailed(error instanceof Error ? error.message : String(error));
    });
}
