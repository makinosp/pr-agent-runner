import type { LlmConfig } from '../src/chat/llm.ts';
import type { PrContext } from '../src/chat/mention.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { composePrTitleBody, parseComposed } from '../src/chat/pr-compose.ts';
import { makeFakeOctokit, createCaptures } from './helpers/fake-octokit.ts';
import { mockFetch } from './helpers/fetch-mock.ts';

test('parseComposed parses a plain JSON object', () => {
  const result = parseComposed('{"title":"Add login","body":"## Summary\\nfoo"}');
  assert.equal(result?.title, 'Add login');
  assert.match(result?.body ?? '', /Summary/);
});

test('parseComposed strips code fences', () => {
  const result = parseComposed('```json\n{"title":"x","body":"y"}\n```');
  assert.equal(result?.title, 'x');
  assert.equal(result?.body, 'y');
});

test('parseComposed returns null when JSON is invalid', () => {
  assert.equal(parseComposed('not json at all'), null);
});

test('parseComposed returns null when fields are missing', () => {
  assert.equal(parseComposed('{"title":"only title"}'), null);
  assert.equal(parseComposed('{"body":"only body"}'), null);
});

test('parseComposed returns null when types are wrong', () => {
  assert.equal(parseComposed('{"title":123,"body":true}'), null);
});

// --- composePrTitleBody tests ---

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
  title: 'Old Title',
  body: 'Old description',
};

test('composePrTitleBody composes and updates PR', async () => {
  const { restore } = mockFetch([
    {
      status: 200,
      body: { choices: [{ message: { content: '{"title":"New Title","body":"New body"}' } }] },
    },
  ]);
  try {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], captures);
    const result = await composePrTitleBody(octokit as never, fakeConfig, { owner: 'o', repo: 'r' }, fakePr);
    assert.equal(result?.title, 'New Title');
    assert.equal(result?.body, 'New body');
    assert.equal(captures.prUpdates.length, 1);
    assert.equal(captures.prUpdates[0]?.title, 'New Title');
  } finally {
    restore();
  }
});

test('composePrTitleBody returns null when LLM returns invalid JSON', async () => {
  const { restore } = mockFetch([
    {
      status: 200,
      body: { choices: [{ message: { content: 'not valid json' } }] },
    },
  ]);
  try {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    const result = await composePrTitleBody(octokit as never, fakeConfig, { owner: 'o', repo: 'r' }, fakePr);
    assert.equal(result, null);
    assert.equal(captures.prUpdates.length, 0);
  } finally {
    restore();
  }
});

test('composePrTitleBody strips code fences from LLM response', async () => {
  const { restore } = mockFetch([
    {
      status: 200,
      body: { choices: [{ message: { content: '```json\n{"title":"Fenced","body":"Content"}\n```' } }] },
    },
  ]);
  try {
    const captures = createCaptures();
    const octokit = makeFakeOctokit([], captures);
    const result = await composePrTitleBody(octokit as never, fakeConfig, { owner: 'o', repo: 'r' }, fakePr);
    assert.equal(result?.title, 'Fenced');
    assert.equal(result?.body, 'Content');
  } finally {
    restore();
  }
});
