'use strict';

const { createHash } = require('node:crypto');
const { usageTurn } = require('./usage');
const { PROMPT_REVIEW_INSTRUCTIONS } = require('./prompt-review');
const { resolvePrompt, reviewPacket, parseAssessment, CitationValidationError, REVIEW_RUBRIC, REVIEW_INSTRUCTIONS } = require('./core');
const MAX_PROMPT_CHARACTERS = 150000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// VS Code's public model objects omit the provider's isUserSelectable flag.
const CORE_ONLY_COPILOT_MODELS = new Set(['copilot-dictation-cleanup-nano', 'copilot-dictation-cleanup-luna']);

function unavailableModelReason(model) {
  if ((!model.vendor || model.vendor === 'copilot') && CORE_ONLY_COPILOT_MODELS.has(model.id)) return 'reserved for VS Code core';
  if (model.vendor === 'copilotcli' || model.vendor?.startsWith('agent-host-')) {
    return 'a session-only agent model, not a direct Language Model API provider';
  }
  if (model.vendor === 'aitk-foundry' && /(?:^|\/)__no-project__$/.test(model.id)) return 'a Foundry project-selection placeholder';
  if (model.maxInputTokens !== undefined && (!Number.isFinite(model.maxInputTokens) || model.maxInputTokens <= 1)) {
    return 'not ready: its provider has not published a usable input-token limit';
  }
  return null;
}

function assertCallableModel(model, label = 'Selected') {
  const reason = unavailableModelReason(model);
  if (reason) throw new Error(label + ' model ' + model.id + ' is ' + reason + '. Use Select model to choose a callable chat model.');
}

async function discoverModels(vscode, selector) {
  if (!vscode.lm?.selectChatModels) throw new Error('This VS Code version does not support the Language Model API');
  let models = await vscode.lm.selectChatModels(selector);
  if (!models.some(model => !unavailableModelReason(model))) {
    const copilot = vscode.extensions?.getExtension('GitHub.copilot-chat');
    if (copilot && !copilot.isActive) {
      await copilot.activate();
      models = await vscode.lm.selectChatModels(selector);
    }
  }
  return models;
}

function unavailableModelsError(models, evaluator = false) {
  const observed = models.slice(0, 8).map(model =>
    String(model.vendor || 'unknown').slice(0, 60) + '/' + String(model.id).slice(0, 100) + ': ' + unavailableModelReason(model)).join('; ');
  return new Error('No ' + (evaluator ? 'Copilot' : 'VS Code') + ' models callable through the Language Model API are available to CompareLab in this window. ' +
    'Enable and sign in to a compatible model-provider extension (GitHub Copilot Chat for Copilot), then retry. ' +
    'Models in the native Copilot SDK/agent Chat picker are not necessarily callable by extensions. ' +
    (observed ? 'Unavailable entries: ' + observed + '.' : 'VS Code returned no models.'));
}

async function chooseModel(vscode, evaluator) {
  for (;;) {
    const catalog = await discoverModels(vscode, evaluator ? { vendor: 'copilot' } : {});
    const models = catalog.filter(model => !unavailableModelReason(model));
    if (models.length) {
      const selected = await vscode.window.showQuickPick(models.map(model => ({
        label: model.name, description: model.vendor + ' | ' + model.id,
        detail: 'Version: ' + (model.version || 'Not reported') + ' | Input limit: ' + (model.maxInputTokens ?? 'Not reported'), model
      })), { title: evaluator ? 'CompareLab: choose a Copilot evaluator' : 'CompareLab: choose a VS Code model',
        placeHolder: 'Callable models exposed to this extension (not session-only agents)' });
      return selected?.model;
    }
    const error = unavailableModelsError(catalog, evaluator);
    if (!vscode.window?.showWarningMessage) throw error;
    const actions = ['Retry'];
    if (vscode.commands?.executeCommand) actions.push('Open Copilot extension');
    const action = await vscode.window.showWarningMessage(error.message, ...actions);
    if (action === 'Retry') continue;
    if (action === 'Open Copilot extension') await vscode.commands.executeCommand('extension.open', 'GitHub.copilot-chat');
    return undefined;
  }
}

function evaluationKey(input) {
  return createHash('sha256').update(JSON.stringify({
    ...(input.comparisonKind === 'prompt' ? { comparisonKind: 'prompt' } : {}),
    prompt: input.prompt || '', evidence: input.evidence || '',
    incomingMessage: input.incomingMessage || '',
    baseline: { prompt: resolvePrompt(input.prompt, input.baseline?.prompt), response: input.baseline?.response || '' },
    candidate: { prompt: resolvePrompt(input.prompt, input.candidate?.prompt), response: input.candidate?.response || '' },
    checkOrder: input.review?.checkOrder !== false
  })).digest('hex');
}

function boundedChatPacket(input) {
  const packet = reviewPacket(input);
  if (JSON.stringify(packet).length + REVIEW_INSTRUCTIONS.length > MAX_PROMPT_CHARACTERS) {
    throw new Error('Chat review draft exceeds the 150,000-character limit; use Evaluate with Copilot and a suitable larger-context evaluator to review all evidence.');
  }
  return packet;
}

async function selectEvaluator(vscode) {
  return chooseModel(vscode, true);
}

async function selectRunModel(vscode) {
  return chooseModel(vscode, false);
}

async function resolveRunModels(vscode, variants, { requireTools = false } = {}) {
  const requested = Object.entries(variants).filter(([, variant]) => variant.provider === 'vscode');
  if (!requested.length) return {};
  for (const [side, variant] of requested) {
    assertCallableModel({ id: variant.model, vendor: variant.modelVendor }, 'The ' + side);
  }
  const available = await discoverModels(vscode, {});
  if (!available.length) throw unavailableModelsError(available);
  const selected = {};
  for (const [side, variant] of requested) {
    const model = available.find(model => model.id === variant.model && (!variant.modelVendor || model.vendor === variant.modelVendor));
    if (!model) throw new Error('The ' + side + ' VS Code model is no longer available. Use Select model to choose an available model.');
    assertCallableModel(model, 'The ' + side);
    if (requireTools && (model.capabilities?.supportsToolCalling === false || model.capabilities?.toolCalling === false ||
        model.capabilities?.toolCalling === 0)) {
      throw new Error('The ' + side + ' model does not support tool calling. Use Select model to choose a tool-capable chat model for tool-enabled runs.');
    }
    selected[side] = model;
  }
  return selected;
}

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
    const response = await model.sendRequest(messages, tools?.length ? { tools: tools.map(({ name, description, inputSchema }) =>
      ({ name, description, inputSchema })) } : {}, cancellation.token);
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
    return { provider: 'vscode', model: model.id, reportedModel: model.id, modelVendor: model.vendor, modelVersion: model.version,
      prompt, ...(systemPrompt ? { systemPrompt } : {}), response: text, requestMessages,
      ...(tools ? { toolCalls } : {}),
      estimatedInputTokens, estimatedOutputTokens, inputTokens: null, outputTokens: null,
      usageTurns: [usageTurn({ model: model.id, estimatedInputTokens, estimatedOutputTokens })],
      contextWindowTokens: null, contextWindowSource: 'unverified',
      maxOutputTokens: null, temperature: null, finishReason: null, runId: null, elapsedMs: Date.now() - started };
  } catch (error) {
    if (timedOut) throw new Error('VS Code model request timed out after 180 seconds.');
    if (/only available to VS Code core/i.test(error.message || '')) {
      throw new Error('The selected model is reserved for VS Code core. Use Select model to choose another chat model. ' + error.message);
    }
    throw error;
  } finally { clearTimeout(timer); listener?.dispose(); cancellation.dispose(); }
}

async function evaluateWithCopilot(vscode, input, model, token, progress = () => {}) {
  assertCallableModel(model);
  if (!Number.isSafeInteger(model.maxInputTokens)) {
    throw new Error('The evaluator does not report a usable input-token limit. Select another evaluator; evidence will not be truncated.');
  }
  const orders = input.review?.checkOrder === false ? [false] : [false, true];
  const judgments = [];
  const inputTokenEstimates = [];
  const usageTurns = [];
  let citationRepairs = 0;
  const started = Date.now();
  const checkCancellation = () => {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
  };
  for (const reversed of orders) {
    checkCancellation();
    const packet = reviewPacket(input, reversed);
    const packetText = JSON.stringify(packet);
    let correction = '';
    while (true) {
      checkCancellation();
      const instructions = REVIEW_INSTRUCTIONS + (input.comparisonKind === 'prompt' ? PROMPT_REVIEW_INSTRUCTIONS : '') + correction;
      const messages = [vscode.LanguageModelChatMessage.User(instructions),
        vscode.LanguageModelChatMessage.User(packetText)];
      let inputTokens = 0;
      for (const message of messages) {
        const count = await model.countTokens(message, token);
        if (!Number.isSafeInteger(count) || count <= 0) {
          throw new Error('The evaluator returned an invalid input-token count. Select another evaluator; evidence will not be truncated.');
        }
        inputTokens += count;
      }
      checkCancellation();
      if (inputTokens > model.maxInputTokens) {
        throw new Error('Review needs ' + inputTokens.toLocaleString('en-US') + ' input tokens, but evaluator ' + model.id +
          ' reports an input limit of ' + model.maxInputTokens.toLocaleString('en-US') +
          '. Select a larger-context evaluator. All evidence was preserved; nothing was truncated.');
      }
      progress(correction ? 'Repairing evaluator citations (one extra request)' : reversed
        ? 'Checking reversed response order (2/2)' : 'Reviewing evidence and responses (1/' + orders.length + ')');
      checkCancellation();
      inputTokenEstimates.push(inputTokens);
      const response = await model.sendRequest(messages, {}, token);
      let text = '';
      let bytes = 0;
      for await (const fragment of response.text) {
        checkCancellation();
        bytes += Buffer.byteLength(fragment, 'utf8');
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('Evaluator response exceeded the 2 MiB safety limit');
        text += fragment;
      }
      checkCancellation();
      const outputTokens = await model.countTokens(vscode.LanguageModelChatMessage.Assistant(text), token);
      checkCancellation();
      usageTurns.push(usageTurn({ model: model.id, estimatedInputTokens: inputTokens, estimatedOutputTokens: outputTokens }));
      try {
        judgments.push(parseAssessment(text, packet, reversed));
        break;
      } catch (error) {
        if (!(error instanceof CitationValidationError)) throw error;
        if (citationRepairs) throw new Error('Citation correction failed. ' + error.message + ' Try another evaluator or use Copilot Chat for manual review.');
        citationRepairs++;
        correction = '\nPrevious citation validation failed: ' + error.message +
          ' Return the complete assessment again. Copy short quotes verbatim from the supplied source keys.' +
          ' Do not paraphrase or combine passages. Use insufficient_evidence for criteria that cannot be supported.' +
          (input.comparisonKind === 'prompt' ? ' For EACH promptChanges entry, put the promptA/promptB edit quote AND' +
            ' an A output quote AND a B output quote together in that entry\'s citations array.' +
            ' A readable prompt quote can cross diff spans and include unchanged words, but must overlap added/removed text.' +
            ' Copy exact wording from promptA/promptB. Criteria citations do not count as promptChanges citations.' : '');
      }
    }
  }
  const first = judgments[0];
  const second = judgments[1];
  const orderConsistent = second ? first.verdict === second.verdict : null;
  const unknowns = [...new Set(judgments.flatMap(judgment => judgment.unknowns))];
  const criteria = first.criteria.map(item => {
    const other = second?.criteria.find(criterion => criterion.criterion === item.criterion);
    if (!other || other.verdict === item.verdict) return item;
    unknowns.push('The ' + item.criterion + ' judgment changed with response order.');
    return { ...item, verdict: 'insufficient_evidence', rationale: 'No stable judgment: the evaluator disagreed between response orders.' };
  });
  let verdict = orderConsistent === false ? 'baseline' : first.verdict;
  let summary = orderConsistent === false
    ? 'Provisional recommendation: retain the baseline (low confidence). The evaluator changed its recommendation when response order was reversed; no stable advantage was established. Resolve the criterion disagreements or gather more evidence before switching.' : first.summary;
  if (orderConsistent !== false && !criteria.some(item => item.verdict === verdict)) {
    verdict = 'baseline';
    summary = 'Provisional recommendation: retain the baseline (low confidence). No stable criterion supports switching; this is a default choice, not proof that the baseline is better. Gather evidence to resolve the tied or unsupported criteria before switching.';
  }
  return {
    verdict, summary, criteria, unknowns, orderConsistent, judgments, rubricVersion: 3,
    preferenceEstablished: orderConsistent !== false && judgments.every(judgment => judgment.preferenceEstablished),
    ...(first.promptChanges ? { promptChanges: first.promptChanges } : {}),
    requestCount: inputTokenEstimates.length, citationRepairs, usageTurns,
    inputFingerprint: evaluationKey(input), elapsedMs: Date.now() - started, inputTokenEstimates,
    model: { id: model.id, name: model.name, vendor: model.vendor, version: model.version, maxInputTokens: model.maxInputTokens },
    note: 'Model-generated assessment, not verified ground truth. One response pair does not establish which model is better overall.'
  };
}

async function openReviewChat(vscode, input) {
  const packet = boundedChatPacket(input);
  const commands = await vscode.commands.getCommands(true);
  if (!['workbench.action.chat.newChat', 'workbench.action.chat.open'].every(command => commands.includes(command))) {
    throw new Error('Copilot Chat is unavailable. Enable chat in a supported VS Code version');
  }
  const query = REVIEW_RUBRIC + '\n\nReturn a readable verdict, decisive differences with quotes, regressions, and unknowns. ' +
    'Use only read-only tools if additional investigation is needed. Do not edit files or change systems. ' +
    'Clearly distinguish newly gathered information from the frozen evidence supplied below.\n\n' + JSON.stringify(packet, null, 2);
  await vscode.commands.executeCommand('workbench.action.chat.newChat');
  await vscode.commands.executeCommand('workbench.action.chat.open', { query, mode: 'agent', isPartialQuery: true });
}

module.exports = { selectEvaluator, selectRunModel, resolveRunModels, runWithVsCode, evaluateWithCopilot, openReviewChat, evaluationKey };
