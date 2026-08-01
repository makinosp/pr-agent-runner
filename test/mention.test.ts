import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPrDiffContext, parseMention } from '../src/chat/mention.ts';
import { makeFakeOctokit, createCaptures } from './helpers/fake-octokit.ts';

test('parseMention returns null when mention is absent', () => {
  assert.equal(parseMention('hello world', '@bg-onigiri'), null);
});

test('parseMention detects review command', () => {
  const payload = parseMention('@bg-onigiri review', '@bg-onigiri');
  assert.equal(payload?.mode, 'review');
  assert.equal(payload?.question, '');
});

test('parseMention detects fix command', () => {
  const payload = parseMention('@bg-onigiri fix', '@bg-onigiri');
  assert.equal(payload?.mode, 'fix');
  assert.equal(payload?.question, '');
});

test('parseMention treats review with extra text as review command', () => {
  const payload = parseMention('@bg-onigiri review please focus on auth', '@bg-onigiri');
  assert.equal(payload?.mode, 'review');
  assert.equal(payload?.question, 'please focus on auth');
});

test('parseMention treats fix with extra text as fix command', () => {
  const payload = parseMention('@bg-onigiri fix the auth bug', '@bg-onigiri');
  assert.equal(payload?.mode, 'fix');
  assert.equal(payload?.question, 'the auth bug');
});

test('parseMention treats non-review text as chat', () => {
  const payload = parseMention('@bg-onigiri この関数の意図を教えて', '@bg-onigiri');
  assert.equal(payload?.mode, 'chat');
  assert.equal(payload?.question, 'この関数の意図を教えて');
});

test('parseMention strips mention from middle of body', () => {
  const payload = parseMention('thanks @bg-onigiri why use map here?', '@bg-onigiri');
  assert.equal(payload?.mode, 'chat');
  assert.equal(payload?.question, 'thanks  why use map here?');
});

test('parseMention is case-insensitive for review token', () => {
  const payload = parseMention('@bg-onigiri REVIEW', '@bg-onigiri');
  assert.equal(payload?.mode, 'review');
});

// --- fetchPrDiffContext tests ---

test('fetchPrDiffContext builds diff context from files', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], captures);
  const result = await fetchPrDiffContext(octokit as never, { owner: 'o', repo: 'r' }, 1);
  assert.match(result, /changed files/);
  assert.match(result, /src\/a\.ts/);
  assert.match(result, /UNTRUSTED_PATCH_START/);
  assert.match(result, /UNTRUSTED_PATCH_END/);
});

test('fetchPrDiffContext truncates patches exceeding maxPatchBytes', async () => {
  const longPatch = '@@ -1 +1 @@\n' + 'x'.repeat(30000);
  const captures = createCaptures();
  const octokit = makeFakeOctokit([{ filename: 'big.ts', patch: longPatch }], captures);
  const result = await fetchPrDiffContext(octokit as never, { owner: 'o', repo: 'r' }, 1, 30, 1000);
  assert.match(result, /truncated/);
});

test('fetchPrDiffContext limits number of files', async () => {
  const files = Array.from({ length: 5 }, (_, i) => ({
    filename: `file${i}.ts`,
    patch: '@@ -1 +1 @@\nchange',
  }));
  const captures = createCaptures();
  const octokit = makeFakeOctokit(files, captures);
  const result = await fetchPrDiffContext(octokit as never, { owner: 'o', repo: 'r' }, 1, 2);
  assert.match(result, /showing up to 2/);
  assert.match(result, /file0\.ts/);
  assert.match(result, /file1\.ts/);
  assert.doesNotMatch(result, /file2\.ts/);
});

test('fetchPrDiffContext handles binary files with no patch', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([{ filename: 'image.png', patch: null }], captures);
  const result = await fetchPrDiffContext(octokit as never, { owner: 'o', repo: 'r' }, 1);
  assert.match(result, /no patch \/ binary/);
});

test('fetchPrDiffContext does not break markdown fences when patch contains backticks', async () => {
  const patchWithBackticks = '@@ -1 +1 @@\n-```\n+console.log("hello");';
  const captures = createCaptures();
  const octokit = makeFakeOctokit([{ filename: 'src/markdown.md', patch: patchWithBackticks }], captures);
  const result = await fetchPrDiffContext(octokit as never, { owner: 'o', repo: 'r' }, 1);
  // Must not contain ``` as a standalone fence — the patch content should be wrapped in untrusted delimiters only
  assert.match(result, /UNTRUSTED_PATCH_START/);
  assert.match(result, /UNTRUSTED_PATCH_END/);
  assert.match(result, /```/);
  // Ensure no stray closing markdown fence sequence appears alone on a line
  const lines = result.split('\n');
  const hasStandaloneFence = lines.some((l) => l.trim() === '```');
  assert.equal(hasStandaloneFence, false);
});
