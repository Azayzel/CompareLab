'use strict';

const { usageTurn } = require('../../metrics/usage');
const { assertCallableModel } = require('./models');
const { MAX_PROMPT_CHARACTERS, MAX_RESPONSE_BYTES } = require('./limits');

async function runWithVsCode(vscode, input, model, token, { conversation, tools, tokenAwareInput = false } = {}) {
  assertCallableModel(model);
  const prompt = String(input.prompt || '');
  const systemPrompt = String(input.systemPrompt || '');
  if (!prompt.trim()) throw new Error('Enter a prompt before running');
  if (!tokenAwareInput && prompt.length + systemPrompt.length > MAX_PROMPT_CHARACTERS) throw new Error('Prompt exceeds the 150,000-character limit');
  if (tokenAwareInput && (!Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens <= 0)) {
    throw new Error('The selected model does not report a usable input-token limit. Select another shared model; evidence was not truncated.');
  }
  const cancellation = new vscode.CancellationTokenSource();
  const listener = token?.onCancellationRequested?.(() => cancellation.cancel());
  if (token?.isCancellationRequested) cancellation.cancel();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cancellation.cancel(); }, 180000);
  const started = Date.now();
  const check = () => { if (cancellation.token.isCancellationRequested) throw new vscode.CancellationError(); };
  try {
    check();
    const requestMessages = conversation ? conversation.map(message => message.role === 'system' ? { ...message, role: 'user' } : message)
      : [...(systemPrompt ? [{ role: 'user', content: systemPrompt }] : []), { role: 'user', content: prompt }];
    const messages = requestMessages.map(message => {
      if (message.role === 'assistant') return vscode.LanguageModelChatMessage.Assistant([
        ...(message.content ? [new vscode.LanguageModelTextPart(message.content)] : []),
        ...(message.toolCalls || []).map(call => new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input))
      ]);
      if (message.role === 'tool') return vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelToolResultPart(message.toolCallId, [new vscode.LanguageModelTextPart(message.content)])
      ]);
      return vscode.LanguageModelChatMessage.User(message.content);
    });
    let estimatedInputTokens = 0;
    for (const message of messages) {
      const count = await model.countTokens(message, cancellation.token);
      if (tokenAwareInput && (!Number.isSafeInteger(count) || count <= 0)) {
        throw new Error('The selected model returned an invalid input-token count. Select another shared model; evidence was not truncated.');
      }
      estimatedInputTokens += count;
    }
    if (tools?.length) estimatedInputTokens += await model.countTokens(JSON.stringify(tools), cancellation.token);
    check();
    if (tokenAwareInput ? estimatedInputTokens > model.maxInputTokens : estimatedInputTokens >= model.maxInputTokens) {
      throw new Error('The input needs ' + estimatedInputTokens.toLocaleString('en-US') + ' tokens, but model ' + model.id +
        ' reports an input limit of ' + model.maxInputTokens.toLocaleString('en-US') +
        '. Select a larger-context shared model. All evidence was preserved; nothing was truncated.');
    }
    const response = await model.sendRequest(messages, tools?.length ? {
      tools: tools.map(({ name, description, inputSchema }) =>
        ({ name, description, inputSchema }))
    } : {}, cancellation.token);
    let text = '';
    let bytes = 0;
    const toolCalls = [];
    const ignoredPartTypes = new Set();
    for await (const fragment of tools ? response.stream : response.text) {
      check();
      if (tools && fragment instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({ callId: fragment.callId, name: fragment.name, input: fragment.input });
        bytes += Buffer.byteLength(JSON.stringify(toolCalls.at(-1)), 'utf8');
      } else if (!tools || fragment instanceof vscode.LanguageModelTextPart) {
        const value = tools ? fragment.value : fragment;
        if (typeof value !== 'string') throw new Error('VS Code model returned invalid response text.');
        bytes += Buffer.byteLength(value, 'utf8');
        text += value;
      } else {
        // The stable stream contract permits future parts. Never treat them as answer text or evidence.
        const partType = fragment?.constructor?.name || typeof fragment;
        const thinking = vscode.LanguageModelThinkingPart && fragment instanceof vscode.LanguageModelThinkingPart;
        if (!thinking && !ignoredPartTypes.has(partType)) {
          ignoredPartTypes.add(partType);
          console.debug('CompareLab: skipped optional provider response part (' + partType + '); continuing with text and tool calls.');
        }
        bytes += Buffer.byteLength(JSON.stringify(fragment) || '', 'utf8');
      }
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Model response exceeded the 2 MiB safety limit');
    }
    check();
    if (!text.trim() && !toolCalls.length) throw new Error('VS Code model returned no visible response.');
    const estimatedOutputTokens = await model.countTokens(tools ? vscode.LanguageModelChatMessage.Assistant([
      ...(text ? [new vscode.LanguageModelTextPart(text)] : []),
      ...toolCalls.map(call => new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input))
    ]) : text, cancellation.token);
    check();
    return {
      provider: 'vscode', model: model.id, reportedModel: model.id, modelVendor: model.vendor, modelVersion: model.version,
      prompt, ...(systemPrompt ? { systemPrompt } : {}), response: text, requestMessages,
      ...(tools ? { toolCalls } : {}),
      estimatedInputTokens, estimatedOutputTokens, inputTokens: null, outputTokens: null,
      usageTurns: [usageTurn({ model: model.id, estimatedInputTokens, estimatedOutputTokens })],
      contextWindowTokens: null, contextWindowSource: 'unverified',
      maxOutputTokens: null, temperature: null, finishReason: null, runId: null, elapsedMs: Date.now() - started
    };
  } catch (error) {
    if (timedOut) throw new Error('VS Code model request timed out after 180 seconds.');
    if (/only available to VS Code core/i.test(error.message || '')) {
      throw new Error('The selected model is reserved for VS Code core. Use Select model to choose another chat model. ' + error.message);
    }
    throw error;
  } finally { clearTimeout(timer); listener?.dispose(); cancellation.dispose(); }
}

module.exports = { runWithVsCode };
