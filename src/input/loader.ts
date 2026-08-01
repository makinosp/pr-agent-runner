import { readFile } from 'node:fs/promises';
import { info } from '@actions/core';
import { findingSchema } from '../schemas/finding.ts';
import { CONTAINER_KEYS, findingsContainerSchema } from '../schemas/container.ts';
import type { Finding } from '../schemas/finding.ts';

const parseItems = (items: readonly unknown[], resultPath: string, source: string): readonly Finding[] => {
  const findings: Finding[] = [];
  items.forEach((item, index) => {
    const result = findingSchema.safeParse(item);
    if (result.success) {
      if (result.data !== null) findings.push(result.data);
      return;
    }
    info(`Skipping invalid finding at ${source}[${index}] in ${resultPath}: ${result.error.message}`);
  });
  return findings;
};

export const loadFindings = async (resultPath: string): Promise<readonly Finding[]> => {
  const rawText = await readFile(resultPath, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`Failed to parse JSON in ${resultPath}`);
  }

  if (Array.isArray(json)) {
    return parseItems(json, resultPath, 'array');
  }

  if (json === null || typeof json !== 'object') {
    throw new Error(`Unexpected JSON shape in ${resultPath}: expected object or array`);
  }

  const parsed = findingsContainerSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Unexpected JSON shape in ${resultPath}: ${parsed.error.message}`);
  }

  for (const key of CONTAINER_KEYS) {
    const items = parsed.data[key];
    if (items !== undefined) {
      return parseItems(items, resultPath, key);
    }
  }

  return [];
};
