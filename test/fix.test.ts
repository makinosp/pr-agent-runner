import assert from 'node:assert/strict';
import test from 'node:test';
import { applyFixes, applyReplacement, buildFixBranchName, extractFixTargets } from '../src/chat/fix.ts';
import type { Finding } from '../src/schemas/finding.ts';
import { makeFakeOctokit, createCaptures } from './helpers/fake-octokit.ts';

const makeFinding = (overrides: Partial<Finding>): Finding =>
  ({
    path: 'src/a.ts',
    content: 'x',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
    ...overrides,
  }) as Finding;

test('extractFixTargets keeps critical/high with suggestion', () => {
  const findings: Finding[] = [
    makeFinding({ severity: 'critical', suggestion: 'fixed', start_line: 1 }),
    makeFinding({ severity: 'high', suggestion: 'fixed', start_line: 2 }),
    makeFinding({ severity: 'medium', suggestion: 'fixed', start_line: 3 }),
    makeFinding({ severity: 'high', start_line: 4 }), // no suggestion
    makeFinding({ severity: 'high', suggestion: 'fixed', side: 'LEFT', start_line: 5 }),
  ];
  const targets = extractFixTargets(findings);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((t) => t.startLine), [1, 2]);
});

test('extractFixTargets treats missing end_line as single-line', () => {
  const targets = extractFixTargets([makeFinding({ suggestion: 'x', start_line: 3 })]);
  assert.equal(targets[0]?.endLine, 3);
});

test('applyReplacement replaces a single line', () => {
  const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
  const result = applyReplacement(lines, { path: 'x', startLine: 2, endLine: 2, suggestion: 'const b = 20;' });
  assert.equal(result.changed, true);
  assert.equal(result.content, 'const a = 1;\nconst b = 20;\nconst c = 3;');
});

test('applyReplacement replaces a multi-line range', () => {
  const lines = ['function f() {', '  return 1;', '  return 2;', '}', 'export {};'];
  const result = applyReplacement(lines, {
    path: 'x',
    startLine: 2,
    endLine: 3,
    suggestion: '  return 42;',
  });
  assert.equal(result.changed, true);
  assert.equal(result.content, 'function f() {\n  return 42;\n}\nexport {};');
});

test('applyReplacement returns unchanged when range is out of bounds', () => {
  const lines = ['a', 'b'];
  const result = applyReplacement(lines, { path: 'x', startLine: 5, endLine: 6, suggestion: 'z' });
  assert.equal(result.changed, false);
  assert.equal(result.content, 'a\nb');
});

test('buildFixBranchName uses PR number', () => {
  assert.equal(buildFixBranchName(42), 'fix/opencode-review-42');
});

test('buildFixBranchName uses custom botMention', () => {
  assert.equal(buildFixBranchName(42, 'custom-bot'), 'fix/custom-bot-42');
});

test('buildFixBranchName strips @-prefix from bot mention', () => {
  assert.equal(buildFixBranchName(42, '@my-bot'), 'fix/my-bot-42');
});

test('buildFixBranchName sanitizes team-style mentions', () => {
  assert.equal(buildFixBranchName(42, '@org/team'), 'fix/org-team-42');
});

test('buildFixBranchName falls back to bot for unusable mentions', () => {
  assert.equal(buildFixBranchName(42, '@'), 'fix/bot-42');
});

// --- applyFixes tests ---

test('applyFixes returns early with changedFiles=0 when targets is empty', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([], captures);
  const result = await applyFixes(octokit as never, { owner: 'o', repo: 'r' }, 1, [], 'sha1', 'main');
  assert.equal(result.changedFiles, 0);
  assert.equal(result.prUrl, undefined);
  assert.equal(captures.gitRefs.length, 0);
});

test('applyFixes creates branch, applies fixes, and creates PR', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([], captures);
  const targets = [
    { path: 'src/a.ts', startLine: 1, endLine: 1, suggestion: 'fixed line' },
  ];
  const result = await applyFixes(octokit as never, { owner: 'o', repo: 'r' }, 7, targets, 'head-sha', 'main');
  assert.equal(result.changedFiles, 1);
  assert.ok(result.prUrl);
  assert.equal(captures.gitRefs.length, 1);
  assert.equal(captures.fileUpdates.length, 1);
  assert.equal(captures.prCreates.length, 1);
});

test('applyFixes uses custom botMention in fix branch name', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([], captures);
  const targets = [
    { path: 'src/a.ts', startLine: 1, endLine: 1, suggestion: 'fixed line' },
  ];
  const result = await applyFixes(
    octokit as never,
    { owner: 'o', repo: 'r' },
    7,
    targets,
    'head-sha',
    'main',
    '@my-bot',
  );
  assert.equal(result.branch, 'fix/my-bot-7');
  assert.equal(captures.gitRefs[0]?.ref, 'refs/heads/fix/my-bot-7');
});

test('applyFixes handles createRef failure gracefully (ref already exists)', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([], captures);
  // Override createRef to throw 422 (reference already exists)
  octokit.rest.git.createRef = async () => {
    const err = new Error('Reference already exists') as Error & { status: number };
    err.status = 422;
    throw err;
  };
  const targets = [
    { path: 'src/a.ts', startLine: 1, endLine: 1, suggestion: 'fixed' },
  ];
  // Should not throw - 422 is handled gracefully
  const result = await applyFixes(octokit as never, { owner: 'o', repo: 'r' }, 7, targets, 'sha', 'main');
  assert.equal(result.changedFiles, 1);
});

test('applyFixes skips files with no content', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([], captures);
  // Override getContent to return directory (no content)
  octokit.rest.repos.getContent = async () => ({ data: {} });
  const targets = [
    { path: 'src/dir', startLine: 1, endLine: 1, suggestion: 'fixed' },
  ];
  const result = await applyFixes(octokit as never, { owner: 'o', repo: 'r' }, 7, targets, 'sha', 'main');
  assert.equal(result.changedFiles, 0);
});

test('applyFixes applies multiple same-file targets from the back so line numbers stay valid', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([], captures);
  const targets = [
    { path: 'src/a.ts', startLine: 2, endLine: 2, suggestion: 'replacement for line2\nwith extra line' },
    { path: 'src/a.ts', startLine: 4, endLine: 4, suggestion: 'replacement for line4' },
  ];
  const result = await applyFixes(octokit as never, { owner: 'o', repo: 'r' }, 7, targets, 'sha', 'main');
  assert.equal(result.changedFiles, 1);
  // Applied from the back: line4 is replaced first, then line2 (now 2 lines).
  // Ascending order would have shifted line4 after the line2 replacement.
  const updatedContent = Buffer.from(captures.fileUpdates[0]?.content ?? '', 'base64').toString('utf8');
  assert.equal(
    updatedContent,
    ['line1', 'replacement for line2', 'with extra line', 'line3', 'replacement for line4', 'line5'].join('\n'),
  );
});
