import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadFindings } from '../src/input/loader.ts';

const writeTemp = async (dir: string, name: string, content: unknown): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
};

test('loadFindings parses an array of findings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const path = await writeTemp(dir, 'result.json', [
      { path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
    ]);
    const findings = await loadFindings(path);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.path, 'a.ts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadFindings parses a container object with each known key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    for (const key of ['comments', 'findings', 'issues', 'results'] as const) {
      const path = await writeTemp(dir, `${key}.json`, {
        [key]: [{ path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 }],
      });
      const findings = await loadFindings(path);
      assert.equal(findings.length, 1, `key ${key} should yield one finding`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadFindings skips invalid items within an array', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const path = await writeTemp(dir, 'result.json', [
      { path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
      { path: '', content: 'missing content', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
      'not an object',
    ]);
    const findings = await loadFindings(path);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.path, 'a.ts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadFindings returns empty array for an empty container object', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const path = await writeTemp(dir, 'result.json', { unrelated: true });
    const findings = await loadFindings(path);
    assert.equal(findings.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadFindings skips invalid items within a container', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const path = await writeTemp(dir, 'result.json', {
      findings: [
        { path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
        { path: '', content: 'missing content', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
      ],
    });
    const findings = await loadFindings(path);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.path, 'a.ts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadFindings fills missing severity with medium', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const path = await writeTemp(dir, 'result.json', {
      findings: [{ path: 'a.ts', content: 'x', category: 'bug', side: 'RIGHT', start_line: 1 }],
    });
    const findings = await loadFindings(path);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, 'medium');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadFindings drops RIGHT-side findings without start_line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const path = await writeTemp(dir, 'result.json', {
      findings: [
        { path: 'a.ts', content: 'orphan right', category: 'bug', severity: 'high', side: 'RIGHT' },
        { path: 'b.ts', content: 'left finding', category: 'bug', severity: 'low', side: 'LEFT' },
      ],
    });
    const findings = await loadFindings(path);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.path, 'b.ts');
    assert.equal(findings[0]?.side, 'LEFT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadFindings throws when a known container key is not an array', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const path = await writeTemp(dir, 'result.json', { findings: 'oops' });
    await assert.rejects(loadFindings(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadFindings throws on malformed JSON text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const path = await writeTemp(dir, 'result.json', '{ not valid json');
    await assert.rejects(loadFindings(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadFindings coerces numeric string line numbers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loader-'));
  try {
    const path = await writeTemp(dir, 'result.json', [
      { path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: '3' },
    ]);
    const findings = await loadFindings(path);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.start_line, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
