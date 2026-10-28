'use strict';

const { createHash } = require('node:crypto');
const { resolvePrompt, reviewPacket, parseAssessment, CitationValidationError, REVIEW_RUBRIC, REVIEW_INSTRUCTIONS } = require('./core');
const MAX_REVIEW_CHARACTERS = 150000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function evaluationKey(input) {
  return createHash('sha256').update(JSON.stringify({
    prompt: input.prompt || '', evidence: input.evidence || '',
    incomingMessage: input.incomingMessage || '',
    baseline: { prompt: resolvePrompt(input.prompt, input.baseline?.prompt), response: input.baseline?.response || '' },
    candidate: { prompt: resolvePrompt(input.prompt, input.candidate?.prompt), response: input.candidate?.response || '' },
    checkOrder: input.review?.checkOrder !== false
  })).digest('hex');
}

function boundedPacket(input, reversed = false) {
  const packet = reviewPacket(input, reversed);
  if (JSON.stringify(packet).length + REVIEW_INSTRUCTIONS.length > MAX_REVIEW_CHARACTERS) {
    throw new Error('Review exceeds the 150,000-character limit; provide a smaller evidence snapshot');
  }
  return packet;
}

async function selectEvaluator(vscode) {
  if (!vscode.lm?.selectChatModels) throw new Error('This VS Code version does not support the Language Model API');
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) throw new Error('No Copilot models are available to CompareLab. Check your sign-in and organization model-access policy');
  const selected = await vscode.window.showQuickPick(models.map(model => ({
    label: model.name, description: model.id, detail: 'Version: ' + model.version, model
  })), { title: 'CompareLab: choose a Copilot evaluator', placeHolder: 'Available models depend on your Copilot access' });
  return selected?.model;
}

async function availableRunModels(vscode) {
  if (!vscode.lm?.selectChatModels) throw new Error('This VS Code version does not support the Language Model API');
  const models = await vscode.lm.selectChatModels({});
  if (!models.length) throw new Error('No VS Code models are available to CompareLab. Check sign-in, model providers, and organization access.');
  return models;
}

async function selectRunModel(vscode) {
  const models = await availableRunModels(vscode);
  const selected = await vscode.window.showQuickPick(models.map(model => ({ label: model.name,
    description: model.vendor + ' | ' + model.id, detail: 'Version: ' + model.version + ' | Input limit: ' + model.maxInputTokens, model })),
  { title: 'CompareLab: choose a VS Code model', placeHolder: 'Models currently available to this extension' });
  return selected?.model;
}

async function resolveRunModels(vscode, variants) {
  const requested = Object.entries(variants).filter(([, variant]) => variant.provider === 'vscode');
  if (!requested.length) return {};
  const available = await availableRunModels(vscode);
  const selected = {};
  for (const [side, variant] of requested) {
    const model = available.find(model => model.id === variant.model && (!variant.modelVendor || model.vendor === variant.modelVendor));
    if (!model) throw new Error('The ' + side + ' VS Code model is no longer available. Use Select model to choose an available model.');
    selected[side] = model;
  }
  return selected;
}

async function runWithVsCode(vscode, input, model, token) {
  const prompt = String(input.prompt || '');
  const systemPrompt = String(input.systemPrompt || '');
  if (!prompt.trim()) throw new Error('Enter a prompt before running');
  if (prompt.length + systemPrompt.length > MAX_REVIEW_CHARACTERS) throw new Error('Prompt exceeds the 150,000-character limit');
  const cancellation = new vscode.CancellationTokenSource();
  const listener = token?.onCancellationRequested?.(() => cancellation.cancel());
  if (token?.isCancellationRequested) cancellation.cancel();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cancellation.cancel(); }, 180000);
  const started = Date.now();
  const check = () => { if (cancellation.token.isCancellationRequested) throw new vscode.CancellationError(); };
  try {
    check();
    const requestMessages = [...(systemPrompt ? [{ role: 'user', content: systemPrompt }] : []), { role: 'user', content: prompt }];
    const messages = requestMessages.map(message => vscode.LanguageModelChatMessage.User(message.content));
    let estimatedInputTokens = 0;
    for (const message of messages) estimatedInputTokens += await model.countTokens(message, cancellation.token);
    check();
    if (estimatedInputTokens >= model.maxInputTokens) throw new Error('The input exceeds the selected VS Code model\'s input limit.');
    const response = await model.sendRequest(messages, {}, cancellation.token);
    let text = '';
    let bytes = 0;
    for await (const fragment of response.text) {
      check();
      bytes += Buffer.byteLength(fragment, 'utf8');
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Model response exceeded the 2 MiB safety limit');
      text += fragment;
    }
    check();
    if (!text.trim()) throw new Error('VS Code model returned no visible response.');
    return { provider: 'vscode', model: model.id, reportedModel: model.id, modelVendor: model.vendor, modelVersion: model.version,
      prompt, ...(systemPrompt ? { systemPrompt } : {}), response: text, requestMessages,
      estimatedInputTokens, inputTokens: null, outputTokens: null, contextWindowTokens: null, contextWindowSource: 'unverified',
      maxOutputTokens: null, temperature: null, finishReason: null, runId: null, elapsedMs: Date.now() - started };
  } catch (error) {
    if (timedOut) throw new Error('VS Code model request timed out after 180 seconds.');
    throw error;
  } finally { clearTimeout(timer); listener?.dispose(); cancellation.dispose(); }
}

async function evaluateWithCopilot(vscode, input, model, token, progress = () => {}) {
  const orders = input.review?.checkOrder === false ? [false] : [false, true];
  const judgments = [];
  const inputTokenEstimates = [];
  let citationRepairs = 0;
  const started = Date.now();
  const checkCancellation = () => {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
  };
  for (const reversed of orders) {
    checkCancellation();
    const packet = boundedPacket(input, reversed);
    const packetText = JSON.stringify(packet);
    let correction = '';
    while (true) {
      checkCancellation();
      const instructions = REVIEW_INSTRUCTIONS + correction;
      if (packetText.length + instructions.length > MAX_REVIEW_CHARACTERS) throw new Error('Review exceeds the 150,000-character limit; provide a smaller evidence snapshot');
      const messages = [vscode.LanguageModelChatMessage.User(instructions),
        vscode.LanguageModelChatMessage.User(packetText)];
      let inputTokens = 0;
      for (const message of messages) inputTokens += await model.countTokens(message, token);
      checkCancellation();
      if (inputTokens >= model.maxInputTokens) throw new Error('The evidence and responses exceed this evaluator model\'s input limit');
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
      try {
        judgments.push(parseAssessment(text, packet, reversed));
        break;
      } catch (error) {
        if (!(error instanceof CitationValidationError)) throw error;
        if (citationRepairs) throw new Error('Citation correction failed. ' + error.message + ' Try another evaluator or use Copilot Chat for manual review.');
        citationRepairs++;
        correction = '\nPrevious citation validation failed: ' + error.message +
          ' Return the complete assessment again. Copy short quotes verbatim from the supplied source keys.' +
          ' Do not paraphrase or combine passages. Use insufficient_evidence for criteria that cannot be supported.';
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
    requestCount: inputTokenEstimates.length, citationRepairs,
    inputFingerprint: evaluationKey(input), elapsedMs: Date.now() - started, inputTokenEstimates,
    model: { id: model.id, name: model.name, vendor: model.vendor, version: model.version, maxInputTokens: model.maxInputTokens },
    note: 'Model-generated assessment, not verified ground truth. One response pair does not establish which model is better overall.'
  };
}

async function openReviewChat(vscode, input) {
  const packet = boundedPacket(input);
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
