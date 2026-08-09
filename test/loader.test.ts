import { expect } from 'expect';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { loadFindings } from '../src/input/loader.ts';
import { withTempDir } from './helpers/temp.ts';

const writeTemp = async (dir: string, name: string, content: unknown): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
};

describe('loadFindings', () => {
  test('parses an array of findings', async () => {
    await withTempDir(async (dir) => {
      const path = await writeTemp(dir, 'result.json', [
        { path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
      ]);
      const findings = await loadFindings(path);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe('a.ts');
    });
  });

  test('parses a container object with each known key', async () => {
    await withTempDir(async (dir) => {
      for (const key of ['comments', 'findings', 'issues', 'results'] as const) {
        const path = await writeTemp(dir, `${key}.json`, {
          [key]: [{ path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 }],
        });
        const findings = await loadFindings(path);
        expect(findings).toHaveLength(1);
      }
    });
  });

  test('skips invalid items within an array', async () => {
    await withTempDir(async (dir) => {
      const path = await writeTemp(dir, 'result.json', [
        { path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
        { path: '', content: 'missing content', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
        'not an object',
      ]);
      const findings = await loadFindings(path);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe('a.ts');
    });
  });

  test('returns empty array for an empty container object', async () => {
    await withTempDir(async (dir) => {
      const path = await writeTemp(dir, 'result.json', { unrelated: true });
      const findings = await loadFindings(path);
      expect(findings).toHaveLength(0);
    });
  });

  test('skips invalid items within a container', async () => {
    await withTempDir(async (dir) => {
      const path = await writeTemp(dir, 'result.json', {
        findings: [
          { path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
          { path: '', content: 'missing content', category: 'bug', severity: 'high', side: 'RIGHT', start_line: 1 },
        ],
      });
      const findings = await loadFindings(path);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe('a.ts');
    });
  });

  test('fills missing severity with medium', async () => {
    await withTempDir(async (dir) => {
      const path = await writeTemp(dir, 'result.json', {
        findings: [{ path: 'a.ts', content: 'x', category: 'bug', side: 'RIGHT', start_line: 1 }],
      });
      const findings = await loadFindings(path);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.severity).toBe('medium');
    });
  });

  test('drops RIGHT-side findings without start_line', async () => {
    await withTempDir(async (dir) => {
      const path = await writeTemp(dir, 'result.json', {
        findings: [
          { path: 'a.ts', content: 'orphan right', category: 'bug', severity: 'high', side: 'RIGHT' },
          { path: 'b.ts', content: 'left finding', category: 'bug', severity: 'low', side: 'LEFT' },
        ],
      });
      const findings = await loadFindings(path);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.path).toBe('b.ts');
      expect(findings[0]?.side).toBe('LEFT');
    });
  });

  test('throws when a known container key is not an array', async () => {
    await withTempDir(async (dir) => {
      const path = await writeTemp(dir, 'result.json', { findings: 'oops' });
      await expect(loadFindings(path)).rejects.toThrow();
    });
  });

  test('throws on malformed JSON text', async () => {
    await withTempDir(async (dir) => {
      const path = await writeTemp(dir, 'result.json', '{ not valid json');
      await expect(loadFindings(path)).rejects.toThrow();
    });
  });

  test('coerces numeric string line numbers', async () => {
    await withTempDir(async (dir) => {
      const path = await writeTemp(dir, 'result.json', [
        { path: 'a.ts', content: 'x', category: 'bug', severity: 'high', side: 'RIGHT', start_line: '3' },
      ]);
      const findings = await loadFindings(path);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.start_line).toBe(3);
    });
  });
});
