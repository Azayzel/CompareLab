'use strict';

const { createHash } = require('node:crypto');
const { usageTurn } = require('../../metrics/usage');
const { PROMPT_REVIEW_INSTRUCTIONS } = require('../../comparison/prompt-review');
const { resolvePrompt, reviewPacket, parseAssessment, CitationValidationError, REVIEW_RUBRIC, REVIEW_INSTRUCTIONS } = require('../../comparison/core');
const { assertCallableModel } = require('./models');
const { MAX_PROMPT_CHARACTERS, MAX_RESPONSE_BYTES } = require('./limits');

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

async function evaluateWithCopilot(vscode, input, model, token, progress = () => { }) {
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

module.exports = { evaluateWithCopilot, openReviewChat, evaluationKey };
