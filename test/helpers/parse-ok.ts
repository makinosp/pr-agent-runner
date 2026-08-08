/**
 * Unwrap a successful zod parse, throwing when parsing failed.
 * Replaces `assert.ok(result.success)` which node:assert previously used to
 * narrow the discriminated union on `result.data`.
 */
export const parseOk = <T>(result: { success: true; data: T } | { success: false }): T => {
  if (!result.success) {
    const error = (result as { error?: unknown }).error;
    throw new Error(`expected parse to succeed, got: ${JSON.stringify(error)}`);
  }
  return result.data;
};
