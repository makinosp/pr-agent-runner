import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/cli.ts';

test('parseConfig reads required values from env (review mode)', () => {
  const config = parseConfig({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '42',
    RESULT_PATH: 'out.json',
  });
  assert.equal(config.mode, 'review');
  assert.equal(config.token, 'tok');
  assert.equal(config.owner, 'owner');
  assert.equal(config.repo, 'repo');
  assert.equal(config.prNumber, 42);
  assert.equal(config.resultPath, 'out.json');
});

test('parseConfig defaults RESULT_PATH to result.json', () => {
  const config = parseConfig({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '1',
  });
  assert.equal(config.mode, 'review');
  if (config.mode !== 'review') return;
  assert.equal(config.resultPath, 'result.json');
});

test('parseConfig throws when GITHUB_TOKEN is missing', () => {
  assert.throws(() => parseConfig({ GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '1' }), /GITHUB_TOKEN/);
});

test('parseConfig throws when GITHUB_REPOSITORY is missing', () => {
  assert.throws(() => parseConfig({ GITHUB_TOKEN: 'tok', PR_NUMBER: '1' }), /GITHUB_REPOSITORY/);
});

test('parseConfig throws when PR_NUMBER is invalid', () => {
  assert.throws(
    () => parseConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: 'abc' }),
    /PR_NUMBER/,
  );
  assert.throws(
    () => parseConfig({ GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', PR_NUMBER: '0' }),
    /PR_NUMBER/,
  );
});

test('parseConfig switches to review-on-mention mode when COMMENT_ID is present', () => {
  const config = parseConfig({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '42',
    COMMENT_ID: '12345',
    COMMENT_BODY: '@bg-onigiri review',
    COMMENT_USER: 'someone',
    BOT_MENTION: '@bg-onigiri',
    BASE_REF: 'main',
    HEAD_SHA: 'abc123',
  });
  assert.equal(config.mode, 'review-on-mention');
  if (config.mode !== 'review-on-mention') return;
  assert.equal(config.commentId, 12345);
  assert.equal(config.commentBody, '@bg-onigiri review');
  assert.equal(config.botMention, '@bg-onigiri');
});

test('parseConfig throws when COMMENT_ID is invalid', () => {
  assert.throws(
    () =>
      parseConfig({
        GITHUB_TOKEN: 'tok',
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '1',
        COMMENT_ID: 'abc',
      }),
    /COMMENT_ID/,
  );
});

test('parseConfig reads BASE_REF and HEAD_SHA in review mode', () => {
  const config = parseConfig({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '42',
    BASE_REF: 'main',
    HEAD_SHA: 'abc123',
  });
  assert.equal(config.mode, 'review');
  if (config.mode !== 'review') return;
  assert.equal(config.baseRef, 'main');
  assert.equal(config.headSha, 'abc123');
});

test('parseConfig leaves baseRef/headSha undefined when env is absent', () => {
  const config = parseConfig({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '42',
  });
  assert.equal(config.mode, 'review');
  if (config.mode !== 'review') return;
  assert.equal(config.baseRef, undefined);
  assert.equal(config.headSha, undefined);
});

test('parseConfig defaults BOT_MENTION to @opencode-review', () => {
  const config = parseConfig({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '1',
    COMMENT_ID: '1',
  });
  if (config.mode !== 'review-on-mention') throw new Error('expected mention mode');
  assert.equal(config.botMention, '@opencode-review');
});

test('parseConfig defaults the review posting options', () => {
  const config = parseConfig({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '42',
  });
  assert.equal(config.mode, 'review');
  if (config.mode !== 'review') return;
  assert.equal(config.stickySummary, true);
  assert.equal(config.incremental, false);
  assert.equal(config.incrementalOverlapThreshold, '');
  assert.equal(config.batchSize, '');
  assert.equal(config.routeSeverityBelow, '');
  assert.equal(config.routeCategories, '');
});

test('parseConfig reads the review posting options from env', () => {
  const config = parseConfig({
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'owner/repo',
    PR_NUMBER: '42',
    REVIEW_STICKY_SUMMARY: 'false',
    REVIEW_INCREMENTAL: 'true',
    REVIEW_INCREMENTAL_OVERLAP_THRESHOLD: '0.3',
    REVIEW_COMMENT_BATCH_SIZE: '10',
    REVIEW_ROUTE_SEVERITY_BELOW: 'low',
    REVIEW_ROUTE_CATEGORIES: 'style, documentation',
  });
  assert.equal(config.mode, 'review');
  if (config.mode !== 'review') return;
  assert.equal(config.stickySummary, false);
  assert.equal(config.incremental, true);
  assert.equal(config.incrementalOverlapThreshold, '0.3');
  assert.equal(config.batchSize, '10');
  assert.equal(config.routeSeverityBelow, 'low');
  assert.equal(config.routeCategories, 'style, documentation');
});
