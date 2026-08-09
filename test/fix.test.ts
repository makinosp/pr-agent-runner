import type { Finding } from '../src/schemas/finding.ts';
import { expect } from 'expect';
import { describe, test } from 'node:test';
import { applyFixes, applyReplacement, buildFixBranchName, extractFixTargets } from '../src/chat/fix.ts';
import { makeFakeOctokit, createCaptures, toOctokit } from './helpers/fake-octokit.ts';

const makeFinding = (overrides: Partial<Finding>): Finding =>
  ({
    path: 'src/a.ts',
    content: 'x',
    category: 'bug',
    severity: 'high',
    side: 'RIGHT',
    ...overrides,
  }) as Finding;

describe('extractFixTargets', () => {
  test('keeps critical/high with suggestion', () => {
    const findings: Finding[] = [
      makeFinding({ severity: 'critical', suggestion: 'fixed', start_line: 1 }),
      makeFinding({ severity: 'high', suggestion: 'fixed', start_line: 2 }),
      makeFinding({ severity: 'medium', suggestion: 'fixed', start_line: 3 }),
      makeFinding({ severity: 'high', start_line: 4 }), // no suggestion
      makeFinding({ severity: 'high', suggestion: 'fixed', side: 'LEFT', start_line: 5 }),
    ];
    const targets = extractFixTargets(findings);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.startLine)).toEqual([1, 2]);
  });

  test('treats missing end_line as single-line', () => {
    const targets = extractFixTargets([makeFinding({ suggestion: 'x', start_line: 3 })]);
    expect(targets[0]?.endLine).toBe(3);
  });
});

describe('applyReplacement', () => {
  test('replaces a single line', () => {
    const lines = ['const a = 1;', 'const b = 2;', 'const c = 3;'];
    const result = applyReplacement(lines, { path: 'x', startLine: 2, endLine: 2, suggestion: 'const b = 20;' });
    expect(result.changed).toBe(true);
    expect(result.content).toBe('const a = 1;\nconst b = 20;\nconst c = 3;');
  });

  test('replaces a multi-line range', () => {
    const lines = ['function f() {', '  return 1;', '  return 2;', '}', 'export {};'];
    const result = applyReplacement(lines, {
      path: 'x',
      startLine: 2,
      endLine: 3,
      suggestion: '  return 42;',
    });
    expect(result.changed).toBe(true);
    expect(result.content).toBe('function f() {\n  return 42;\n}\nexport {};');
  });

  test('returns unchanged when range is out of bounds', () => {
    const lines = ['a', 'b'];
    const result = applyReplacement(lines, { path: 'x', startLine: 5, endLine: 6, suggestion: 'z' });
    expect(result.changed).toBe(false);
    expect(result.content).toBe('a\nb');
  });
});

describe('buildFixBranchName', () => {
  const branchCases: ReadonlyArray<[string, number, string | undefined, string]> = [
    ['uses PR number', 42, undefined, 'fix/opencode-review-42'],
    ['uses custom botMention', 42, 'custom-bot', 'fix/custom-bot-42'],
    ['strips @-prefix from bot mention', 42, '@my-bot', 'fix/my-bot-42'],
    ['sanitizes team-style mentions', 42, '@org/team', 'fix/org-team-42'],
    ['falls back to bot for unusable mentions', 42, '@', 'fix/bot-42'],
  ];

  for (const [name, prNumber, botMention, expected] of branchCases) {
    test(name, () => {
      expect(buildFixBranchName(prNumber, botMention)).toBe(expected);
    });
  }
});

describe('applyFixes', () => {
  test('returns early with changedFiles=0 when targets is empty', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    const result = await applyFixes(toOctokit(octokit), { owner: 'o', repo: 'r' }, 1, [], 'sha1', 'main');
    expect(result.changedFiles).toBe(0);
    expect(result.prUrl).toBeUndefined();
    expect(captures.gitRefs).toHaveLength(0);
  });

  test('creates branch, applies fixes, and creates PR', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    const targets = [{ path: 'src/a.ts', startLine: 1, endLine: 1, suggestion: 'fixed line' }];
    const result = await applyFixes(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, targets, 'head-sha', 'main');
    expect(result.changedFiles).toBe(1);
    expect(result.prUrl).toBeTruthy();
    expect(captures.gitRefs).toHaveLength(1);
    expect(captures.fileUpdates).toHaveLength(1);
    expect(captures.prCreates).toHaveLength(1);
  });

  test('uses custom botMention in fix branch name', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    const targets = [{ path: 'src/a.ts', startLine: 1, endLine: 1, suggestion: 'fixed line' }];
    const result = await applyFixes(
      toOctokit(octokit),
      { owner: 'o', repo: 'r' },
      7,
      targets,
      'head-sha',
      'main',
      '@my-bot',
    );
    expect(result.branch).toBe('fix/my-bot-7');
    expect(captures.gitRefs[0]?.ref).toBe('refs/heads/fix/my-bot-7');
  });

  test('handles createRef failure gracefully (ref already exists)', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    // Override createRef to throw 422 (reference already exists)
    octokit.rest.git.createRef = async () => {
      const err = new Error('Reference already exists') as Error & { status: number };
      err.status = 422;
      throw err;
    };
    const targets = [{ path: 'src/a.ts', startLine: 1, endLine: 1, suggestion: 'fixed' }];
    // Should not throw - 422 is handled gracefully
    const result = await applyFixes(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, targets, 'sha', 'main');
    expect(result.changedFiles).toBe(1);
  });

  test('skips files with no content', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    // Override getContent to return directory (no content)
    octokit.rest.repos.getContent = async () => ({ data: {} });
    const targets = [{ path: 'src/dir', startLine: 1, endLine: 1, suggestion: 'fixed' }];
    const result = await applyFixes(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, targets, 'sha', 'main');
    expect(result.changedFiles).toBe(0);
  });

  test('applies multiple same-file targets from the back so line numbers stay valid', async () => {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    const targets = [
      { path: 'src/a.ts', startLine: 2, endLine: 2, suggestion: 'replacement for line2\nwith extra line' },
      { path: 'src/a.ts', startLine: 4, endLine: 4, suggestion: 'replacement for line4' },
    ];
    const result = await applyFixes(toOctokit(octokit), { owner: 'o', repo: 'r' }, 7, targets, 'sha', 'main');
    expect(result.changedFiles).toBe(1);
    // Applied from the back: line4 is replaced first, then line2 (now 2 lines).
    // Ascending order would have shifted line4 after the line2 replacement.
    const updatedContent = Buffer.from(captures.fileUpdates[0]?.content ?? '', 'base64').toString('utf8');
    expect(updatedContent).toBe(
      ['line1', 'replacement for line2', 'with extra line', 'line3', 'replacement for line4', 'line5'].join('\n'),
    );
  });
});
