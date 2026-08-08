import type { Finding } from '../../src/schemas/finding.ts';

/** Patch with right-side lines 1..5 all reviewable. */
export const PATCH = ['@@ -1,3 +1,5 @@', ' line1', '+line2', '+line3', '+line4', '+line5'].join('\n');

export const inlineFinding = (
  line: number,
  severity: Finding['severity'] = 'high',
  category: Finding['category'] = 'bug',
): Finding => ({
  path: 'a.ts',
  start_line: line,
  category,
  severity,
  content: `inline ${line}`,
  side: 'RIGHT',
});

export const summaryFinding: Finding = {
  path: 'src/example.ts',
  category: 'documentation',
  severity: 'low',
  content: 'summary only',
  side: 'LEFT',
};

export const multiLineFinding = (startLine: number, endLine: number): Finding => ({
  path: 'a.ts',
  start_line: startLine,
  end_line: endLine,
  category: 'bug',
  severity: 'high',
  content: 'range',
  side: 'RIGHT',
});
