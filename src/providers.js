'use strict';

/**
 * Opt-in, dependency-free chat runners. Never stores or logs API keys.
 * Responses are normalized to the comparison engine's variant shape.
 */
const DEFAULT_ENDPOINTS = Object.freeze({
  ollama: 'http://127.0.0.1:11434',
  openai: 'https://api.openai.com/v1'
});
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180000;

function normalizedEndpoint(provider, supplied) {
  if (!Object.hasOwn(DEFAULT_ENDPOINTS, provider)) throw new Error('Choose Ollama or OpenAI-compatible');
  const raw = String(supplied || DEFAULT_ENDPOINTS[provider]).trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid model endpoint URL'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Endpoint URL must not contain credentials, query parameters, or fragments');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS for remote endpoints (HTTP is allowed only on localhost)');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function intOpt(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(label + ' must be a positive integer');
  return n;
}

function tempOpt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('Temperature must be between 0 and 2');
  return n;
}

async function readBounded(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Model server returned no response body');
  let bytes = 0;
  const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Model response exceeded the 2 MiB safety limit');
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts.map(x => Buffer.from(x))).toString('utf8');
}

function serverError(value, status) {
  let message = '';
  try {
    const parsed = JSON.parse(value);
    message = parsed?.error?.message || parsed?.error || '';
  } catch {}
  const safe = typeof message === 'string' ? message.slice(0, 240) : '';
  return new Error('Model request failed (HTTP ' + status + ')' + (safe ? ': ' + safe : ''));
}

function getContent(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text).join('\n');
  }
  return '';
}

/**
 * @param {object} input provider, model, prompt, endpoint, num_ctx/context metadata, max tokens
 * @param {object} deps injectable fetch and API key for testing
 */
async function runModel(input, { apiKey, fetchImpl = globalThis.fetch } = {}) {
  const provider = String(input.provider || '');
  const endpoint = normalizedEndpoint(provider, input.endpoint);
  const model = String(input.model || '').trim();
  const prompt = String(input.prompt || '');
  if (!model) throw new Error('Enter a model ID before running');
  if (!prompt.trim()) throw new Error('Enter a prompt before running');
  if (prompt.length > 150000) throw new Error('Prompt exceeds the 150,000-character limit');
  const context = intOpt(input.contextWindowTokens, 'Context window');
  const maxOutput = intOpt(input.maxOutputTokens, 'Output cap');
  const temperature = tempOpt(input.temperature);
  const headers = { 'Content-Type': 'application/json' };
  let target, body;
  if (provider === 'ollama') {
    target = endpoint + '/api/chat';
    const options = {};
    if (context !== null) options.num_ctx = context;
    if (maxOutput !== null) options.num_predict = maxOutput;
    if (temperature !== null) options.temperature = temperature;
    body = { model, messages: [{ role: 'user', content: prompt }], stream: false };
    if (Object.keys(options).length) body.options = options;
  } else {
    target = endpoint + '/chat/completions';
    body = { model, messages: [{ role: 'user', content: prompt }], stream: false };
    if (maxOutput !== null) {
      const field = input.tokenLimitField === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens';
      body[field] = maxOutput;
    }
    if (temperature !== null) body.temperature = temperature;
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  }
  const start = Date.now();
  let res;
  try {
    res = await fetchImpl(target, {
      method: 'POST', headers, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('Model request timed out after 180 seconds');
    throw new Error('Could not contact model endpoint: ' + (error.message || 'connection failed'));
  }
  const text = await readBounded(res);
  if (!res.ok) throw serverError(text, res.status);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Model endpoint returned invalid JSON'); }
  const response = provider === 'ollama' ? getContent(data.message) : getContent(data?.choices?.[0]?.message);
  if (!response && provider === 'openai' && data?.choices?.[0]?.message?.refusal) {
    throw new Error('Model refused the request without returning response text');
  }
  if (typeof response !== 'string' || !response.trim()) {
    throw new Error('Model returned no visible text (possibly a tool-only or reasoning-only completion)');
  }
  const counts = provider === 'ollama'
    ? { input: data.prompt_eval_count, output: data.eval_count }
    : { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens };
  const inputTokens = Number.isSafeInteger(counts.input) && counts.input >= 0 ? counts.input : null;
  const outputTokens = Number.isSafeInteger(counts.output) && counts.output >= 0 ? counts.output : null;
  return {
    provider, model, reportedModel: typeof data.model === 'string' ? data.model : null,
    prompt, response,
    contextWindowTokens: context,
    contextWindowSource: provider === 'ollama' && context ? 'configured' : (input.contextWindowSource || 'unverified'),
    inputTokens, outputTokens, maxOutputTokens: maxOutput,
    finishReason: provider === 'ollama' ? (data.done_reason || null) : (data.choices?.[0]?.finish_reason || null),
    temperature, runId: typeof data.id === 'string' ? data.id : null,
    elapsedMs: Date.now() - start
  };
}

module.exports = { runModel, normalizedEndpoint, DEFAULT_ENDPOINTS };
