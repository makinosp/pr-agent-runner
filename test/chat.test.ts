import type { LlmConfig } from '../src/chat/llm.ts';
import type { PrContext } from '../src/chat/mention.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerChat, postChatReply } from '../src/chat/chat.ts';
import { makeFakeOctokit, createCaptures } from './helpers/fake-octokit.ts';
import { mockFetch } from './helpers/fetch-mock.ts';

const fakeConfig: LlmConfig = {
  url: 'https://api.openai.com/v1/chat/completions',
  token: 'test-token',
  model: 'gpt-4o',
  protocol: 'openai',
  maxTokens: 2048,
};

const fakePr: PrContext = {
  owner: 'test-owner',
  repo: 'test-repo',
  prNumber: 42,
  headSha: 'abc123',
  baseRef: 'main',
  title: 'Test PR',
  body: 'Test description',
};

// --- postChatReply tests ---

test('postChatReply posts a comment with default label', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([], captures);
  await postChatReply(octokit as never, { owner: 'o', repo: 'r' }, 1, 'hello');
  assert.equal(captures.comments.length, 1);
  assert.match(captures.comments[0]?.body as string, /@opencode-review reply:/);
  assert.match(captures.comments[0]?.body as string, /hello/);
});

test('postChatReply uses botMention parameter in label', async () => {
  const captures = createCaptures();
  const octokit = makeFakeOctokit([], captures);
  await postChatReply(octokit as never, { owner: 'o', repo: 'r' }, 1, 'reply', '@custom-bot');
  assert.match(captures.comments[0]?.body as string, /@custom-bot reply:/);
});

// --- answerChat tests ---

test('answerChat sends messages and returns the LLM response', async () => {
  const { calls, restore } = mockFetch([
    {
      status: 200,
      body: { choices: [{ message: { content: 'The code looks good.' } }] },
    },
  ]);
  try {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], captures);
    const answer = await answerChat(
      octokit as never,
      fakeConfig,
      { owner: 'o', repo: 'r' },
      fakePr,
      'Is this correct?',
    );
    assert.equal(answer, 'The code looks good.');
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].init.body as string) as { messages: Array<{ role: string; content: string }> };
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0]?.role, 'system');
    assert.match(body.messages[1]?.content as string, /Is this correct\?/);
  } finally {
    restore();
  }
});

test('answerChat sends Anthropic-format request for anthropic protocol', async () => {
  const anthropicConfig: LlmConfig = { ...fakeConfig, protocol: 'anthropic' };
  const { calls, restore } = mockFetch([
    {
      status: 200,
      body: { content: [{ type: 'text', text: 'Looks fine.' }] },
    },
  ]);
  try {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], captures);
    const answer = await answerChat(octokit as never, anthropicConfig, { owner: 'o', repo: 'r' }, fakePr, 'check auth');
    assert.equal(answer, 'Looks fine.');
    const body = JSON.parse(calls[0].init.body as string) as { system: string; messages: Array<{ role: string }> };
    assert.match(body.system, /code review assistant/);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0]?.role, 'user');
  } finally {
    restore();
  }
});
