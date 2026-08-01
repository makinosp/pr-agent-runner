import type { ChatMessage, LlmConfig } from '../src/chat/llm.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chat, resolveLlmConfig, retryWithBackoff } from '../src/chat/llm.ts';
import { mockFetch } from './helpers/fetch-mock.ts';

test('resolveLlmConfig throws when OCR_LLM_URL is missing', () => {
  assert.throws(() => resolveLlmConfig({ OCR_LLM_TOKEN: 't', OCR_LLM_MODEL: 'm' }), /OCR_LLM_URL/);
});

test('resolveLlmConfig throws when OCR_LLM_TOKEN is missing', () => {
  assert.throws(() => resolveLlmConfig({ OCR_LLM_URL: 'https://x', OCR_LLM_MODEL: 'm' }), /OCR_LLM_TOKEN/);
});

test('resolveLlmConfig throws when OCR_LLM_MODEL is missing', () => {
  assert.throws(() => resolveLlmConfig({ OCR_LLM_URL: 'https://x', OCR_LLM_TOKEN: 't' }), /OCR_LLM_MODEL/);
});

test('resolveLlmConfig respects OCR_LLM_PROTOCOL=anthropic', () => {
  const cfg = resolveLlmConfig({
    OCR_LLM_URL: 'https://api.anthropic.com/v1/messages',
    OCR_LLM_TOKEN: 't',
    OCR_LLM_MODEL: 'claude-sonnet-4-6',
    OCR_LLM_PROTOCOL: 'anthropic',
  });
  assert.equal(cfg.protocol, 'anthropic');
});

test('resolveLlmConfig respects OCR_USE_ANTHROPIC=true', () => {
  const cfg = resolveLlmConfig({
    OCR_LLM_URL: 'https://api.anthropic.com/v1/messages',
    OCR_LLM_TOKEN: 't',
    OCR_LLM_MODEL: 'claude-sonnet-4-6',
    OCR_USE_ANTHROPIC: 'true',
  });
  assert.equal(cfg.protocol, 'anthropic');
});

test('resolveLlmConfig infers anthropic from /v1/messages URL', () => {
  const cfg = resolveLlmConfig({
    OCR_LLM_URL: 'https://api.anthropic.com/v1/messages',
    OCR_LLM_TOKEN: 't',
    OCR_LLM_MODEL: 'claude-sonnet-4-6',
  });
  assert.equal(cfg.protocol, 'anthropic');
});

test('resolveLlmConfig defaults to openai', () => {
  const cfg = resolveLlmConfig({
    OCR_LLM_URL: 'https://api.openai.com/v1/chat/completions',
    OCR_LLM_TOKEN: 't',
    OCR_LLM_MODEL: 'gpt-4o',
  });
  assert.equal(cfg.protocol, 'openai');
});

// --- chat() tests ---

const openaiConfig: LlmConfig = {
  url: 'https://api.openai.com/v1/chat/completions',
  token: 't',
  model: 'gpt-4o',
  protocol: 'openai',
  maxTokens: 2048,
};
const anthropicConfig: LlmConfig = {
  url: 'https://api.anthropic.com/v1/messages',
  token: 't',
  model: 'claude-sonnet-4-6',
  protocol: 'anthropic',
  maxTokens: 2048,
};
const messages: ChatMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Hello' },
];

test('chat returns text from OpenAI response', async () => {
  const { restore } = mockFetch([{ status: 200, body: { choices: [{ message: { content: 'Hi there!' } }] } }]);
  try {
    const result = await chat(openaiConfig, messages);
    assert.equal(result, 'Hi there!');
  } finally {
    restore();
  }
});

test('chat returns text from Anthropic response', async () => {
  const { restore } = mockFetch([{ status: 200, body: { content: [{ type: 'text', text: 'Hello!' }] } }]);
  try {
    const result = await chat(anthropicConfig, messages);
    assert.equal(result, 'Hello!');
  } finally {
    restore();
  }
});

test('chat throws on OpenAI non-ok response', async () => {
  const { restore } = mockFetch([{ status: 401, ok: false, body: { error: 'unauthorized' } }]);
  try {
    await assert.rejects(() => chat(openaiConfig, messages), /LLM API failed for gpt-4o at[\s\S]*Status: 401/);
  } finally {
    restore();
  }
});

test('chat throws on Anthropic non-ok response', async () => {
  const { restore } = mockFetch([{ status: 500, ok: false, body: { error: 'server error' } }]);
  try {
    await assert.rejects(() => chat(anthropicConfig, messages), /LLM API failed for claude-sonnet-4-6 at[\s\S]*Status: 500/);
  } finally {
    restore();
  }
});

test('chat throws when OpenAI returns empty choices', async () => {
  const { restore } = mockFetch([{ status: 200, body: { choices: [] } }]);
  try {
    await assert.rejects(() => chat(openaiConfig, messages), /no content/);
  } finally {
    restore();
  }
});

test('chat throws when Anthropic returns no text content', async () => {
  const { restore } = mockFetch([{ status: 200, body: { content: [] } }]);
  try {
    await assert.rejects(() => chat(anthropicConfig, messages), /no text content/);
  } finally {
    restore();
  }
});

test('chat includes the response body in the error message', async () => {
  const { restore } = mockFetch([{ status: 401, ok: false, body: { error: 'unauthorized' } }]);
  try {
    await assert.rejects(() => chat(openaiConfig, messages), /Response body:[\s\S]*unauthorized/);
  } finally {
    restore();
  }
});

test('chat retries on 429 and succeeds on the next attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, restore } = mockFetch([
    { status: 429, ok: false, body: { error: 'rate limit' } },
    { status: 200, body: { choices: [{ message: { content: 'ok after retry' } }] } },
  ]);
  try {
    const promise = chat(openaiConfig, messages);
    // Let the first fetch settle and the backoff timer be scheduled, then advance it.
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    const result = await promise;
    assert.equal(result, 'ok after retry');
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test('retryWithBackoff does not retry non-retryable errors', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          attempts += 1;
          throw new Error('boom');
        },
        3,
        (e) => (e as { status?: number }).status === 429,
      ),
    /boom/,
  );
  assert.equal(attempts, 1);
});

test('retryWithBackoff gives up after exhausting retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const promise = retryWithBackoff(
    async () => {
      attempts += 1;
      throw Object.assign(new Error('rate limited'), { status: 429 });
    },
    3,
    (e) => (e as { status?: number }).status === 429,
  ).catch((error: unknown) => error as Error);
  // Backoff delays are 1s, 2s, 4s, 8s; advance each timer once scheduled.
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(2000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(8000);
  await new Promise((resolve) => setImmediate(resolve));
  const err = await promise;
  assert.equal(attempts, 4);
  assert.match(err.message, /rate limited/);
});
