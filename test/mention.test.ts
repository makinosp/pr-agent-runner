import { expect } from 'expect';
import { describe, test } from 'node:test';
import { fetchPrDiffContext, parseMention } from '../src/chat/mention.ts';
import { makeFakeOctokit, createCaptures, toOctokit } from './helpers/fake-octokit.ts';

describe('parseMention', () => {
  const mentionCases: ReadonlyArray<[string, string, 'review' | 'fix' | 'chat' | null, string]> = [
    ['returns null when mention is absent', 'hello world', null, ''],
    ['detects review command', '@bg-onigiri review', 'review', ''],
    ['detects fix command', '@bg-onigiri fix', 'fix', ''],
    [
      'treats review with extra text as review command',
      '@bg-onigiri review please focus on auth',
      'review',
      'please focus on auth',
    ],
    ['treats fix with extra text as fix command', '@bg-onigiri fix the auth bug', 'fix', 'the auth bug'],
    ['treats non-review text as chat', '@bg-onigiri この関数の意図を教えて', 'chat', 'この関数の意図を教えて'],
    ['strips mention from middle of body', 'thanks @bg-onigiri why use map here?', 'chat', 'thanks  why use map here?'],
  ];

  for (const [name, body, mode, question] of mentionCases) {
    test(name, () => {
      const payload = parseMention(body, '@bg-onigiri');
      if (mode === null) {
        expect(payload).toBeNull();
      } else {
        expect(payload?.mode).toBe(mode);
        expect(payload?.question).toBe(question);
      }
    });
  }

  test('is case-insensitive for review token', () => {
    const payload = parseMention('@bg-onigiri REVIEW', '@bg-onigiri');
    expect(payload?.mode).toBe('review');
  });
});

describe('fetchPrDiffContext', () => {
  test('builds diff context from files', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], captures);
    const result = await fetchPrDiffContext(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1);
    expect(result).toMatch(/changed files/);
    expect(result).toMatch(/src\/a\.ts/);
    expect(result).toMatch(/UNTRUSTED_PATCH_START/);
    expect(result).toMatch(/UNTRUSTED_PATCH_END/);
  });

  test('truncates patches exceeding maxPatchBytes', async () => {
    const longPatch = '@@ -1 +1 @@\n' + 'x'.repeat(30000);
    const captures = createCaptures();
    const octokit = makeFakeOctokit([{ filename: 'big.ts', patch: longPatch }], captures);
    const result = await fetchPrDiffContext(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1, 30, 1000);
    expect(result).toMatch(/truncated/);
  });

  test('limits number of files', async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      filename: `file${i}.ts`,
      patch: '@@ -1 +1 @@\nchange',
    }));
    const captures = createCaptures();
    const octokit = makeFakeOctokit(files, captures);
    const result = await fetchPrDiffContext(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1, 2);
    expect(result).toMatch(/showing up to 2/);
    expect(result).toMatch(/file0\.ts/);
    expect(result).toMatch(/file1\.ts/);
    expect(result).not.toMatch(/file2\.ts/);
  });

  test('handles binary files with no patch', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([{ filename: 'image.png', patch: null }], captures);
    const result = await fetchPrDiffContext(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1);
    expect(result).toMatch(/no patch \/ binary/);
  });

  test('does not break markdown fences when patch contains backticks', async () => {
    const patchWithBackticks = '@@ -1 +1 @@\n-```\n+console.log("hello");';
    const captures = createCaptures();
    const octokit = makeFakeOctokit([{ filename: 'src/markdown.md', patch: patchWithBackticks }], captures);
    const result = await fetchPrDiffContext(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1);
    // Must not contain ``` as a standalone fence — the patch content should be wrapped in untrusted delimiters only
    expect(result).toMatch(/UNTRUSTED_PATCH_START/);
    expect(result).toMatch(/UNTRUSTED_PATCH_END/);
    expect(result).toMatch(/```/);
    // Ensure no stray closing markdown fence sequence appears alone on a line
    const lines = result.split('\n');
    const hasStandaloneFence = lines.some((l) => l.trim() === '```');
    expect(hasStandaloneFence).toBe(false);
  });
});
