import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run `fn` with a fresh temporary directory, removing it afterwards. */
export const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'pr-agent-runner-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Run `fn` with `dir` as the process working directory, restoring it afterwards. */
export const withCwd = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
};
