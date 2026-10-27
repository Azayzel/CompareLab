'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runModel, normalizedEndpoint } = require('../src/providers');

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('Ollama uses native chat, passes explicit context and records usage', async () => {
  let request;
  const result = await runModel({
    provider: 'ollama', model: 'qwen3.5:27b', prompt: 'Hi', contextWindowTokens: 32768,
    maxOutputTokens: 500, temperature: 0
  }, { fetchImpl: async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return response({ model: 'qwen3.5:27b', message: { content: 'Hello' }, prompt_eval_count: 18, eval_count: 3, done_reason: 'stop' });
  } });
  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(request.body.options.num_ctx, 32768);
  assert.equal(request.body.options.num_predict, 500);
  assert.equal(request.body.options.temperature, 0);
  assert.equal(request.body.stream, false);
  assert.equal(request.init.headers.Authorization, undefined);
  assert.equal(result.inputTokens, 18);
  assert.equal(result.outputTokens, 3);
  assert.equal(result.contextWindowSource, 'configured');
  assert.equal(result.response, 'Hello');
});

test('OpenAI-compatible request uses chat completions and scoped key', async () => {
  let request;
  const result = await runModel({
    provider: 'openai', model: 'gpt-example', prompt: 'Hi', maxOutputTokens: 100
  }, { apiKey: 'test-secret', fetchImpl: async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return response({
      id: 'chat-123', model: 'gpt-example-2026', choices: [{ message: { content: 'Answer' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 11, completion_tokens: 100 }
    });
  } });
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer test-secret');
  assert.equal(request.body.max_completion_tokens, 100);
  assert.equal(result.finishReason, 'length');
  assert.equal(result.runId, 'chat-123');
  assert.equal(result.contextWindowTokens, null);
  assert.equal(result.reportedModel, 'gpt-example-2026');
  assert.equal(result.outputTokens, 100);
});

test('legacy compatible backend supports max_tokens switch', async () => {
  let body;
  await runModel({ provider: 'openai', endpoint: 'http://localhost:8000/v1', model: 'local', prompt: 'Hi',
    maxOutputTokens: 100, tokenLimitField: 'max_tokens'
  }, { fetchImpl: async (_, init) => {
    body = JSON.parse(init.body);
    return response({ choices: [{ message: { content: [{ type: 'text', text: 'Yes' }] }, finish_reason: 'stop' }] });
  } });
  assert.equal(body.max_tokens, 100);
  assert.equal(body.max_completion_tokens, undefined);
});

test('missing token counts stay unknown', async () => {
  const result = await runModel({ provider: 'ollama', model: 'm', prompt: 'hi' },
    { fetchImpl: async () => response({ message: { content: 'ok' } }) });
  assert.equal(result.inputTokens, null);
  assert.equal(result.contextWindowSource, 'unverified');
});

test('rejects unsafe endpoints, URL credentials and blank prompts', async () => {
  for (const url of ['http://evil.example/v1', 'file:///etc/passwd', 'https://example.com/?api_key=secret',
    'https://bob:secret@example.com/v1', 'ftp://localhost/']) {
    assert.throws(() => normalizedEndpoint('openai', url));
  }
  await assert.rejects(runModel({ provider: 'ollama', model: 'm', prompt: '' }), /prompt/i);
});

test('does not follow redirects with auth', async () => {
  let redirect;
  await runModel({ provider: 'openai', model: 'm', prompt: 'hi' },
    { apiKey: 'secret', fetchImpl: async (_, init) => {
      redirect = init.redirect;
      return response({ choices: [{ message: { content: 'okay' } }] });
    } });
  assert.equal(redirect, 'error');
});

test('fails visibly when completion contains no displayable answer', async () => {
  await assert.rejects(runModel({ provider: 'openai', model: 'm', prompt: 'hi' },
    { fetchImpl: async () => response({ choices: [{ message: { content: null, tool_calls: [{}] } }] }) }), /no visible text/);
});

test('honors non-2xx errors without dumping request body or secrets', async () => {
  await assert.rejects(runModel({ provider: 'openai', model: 'm', prompt: 'hi' },
    { apiKey: 'TOPSECRET', fetchImpl: async () => response({ error: { message: 'No quota' } }, 429) }),
    e => e.message.includes('429') && !e.message.includes('TOPSECRET'));
});
