'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const path = require('node:path');
const { compare, asMarkdown, responseContent, resolvePrompt, reviewPacket } = require('./core');
const { importRun, MAX_IMPORT_BYTES } = require('./traces');
const { composeAgentTask, comparisonKind, createTestPlan, orchestrateTest, summarizeTest } = require('./orchestration');
const { codeMindAlert, agentInstructions } = require('./inputs');
const { runModel, normalizedEndpoint, DEFAULT_ENDPOINTS } = require('./providers');
const { createHistory } = require('./history');
const { asHtml } = require('./html');
const { usageReport } = require('./usage');
const { selectEvaluator, selectRunModel, resolveRunModels, runWithVsCode, evaluateWithCopilot, openReviewChat, evaluationKey } = require('./copilot');
const { selectDatadogTools, runDatadogAgent, DATADOG_AGENT_PROMPT } = require('./datadog');

const secretId = endpoint => 'comparelab:key:' + crypto.createHash('sha256').update(endpoint).digest('hex');

function panelMarkup(side, heading) {
  return `<section><h2 id="${side}-heading">${heading}</h2>
    <div id="${side}-modelSettings"><label id="${side}-modelLabel" for="${side}-model">Model</label><div class="model-choice">
    <input id="${side}-model" placeholder="Select a VS Code model" readonly>
    <button id="${side}-selectModel" type="button">Select model</button></div></div>
    <details id="${side}-promptSection" class="prompt-override-details"><summary>Advanced: saved prompt override</summary>
    <div class="instruction-heading"><label id="${side}-promptLabel" for="${side}-prompt">Prompt override</label>
    <button id="${side}-loadInstructions" type="button">Load agent file</button></div>
    <textarea id="${side}-prompt" class="prompt-override" rows="6" placeholder="Uses shared prompt"></textarea></details>
    <details class="raw-editor"><summary>Paste / edit raw response</summary>
    <label>Response <textarea id="${side}-response" rows="6" placeholder="Paste response or run a model"></textarea></label></details>
    <details id="${side}-runner" class="runner"><summary>Run model (optional)</summary>
      <label>Provider <select id="${side}-provider">
        <option value="vscode">VS Code models</option>
        <option value="manual">Manual / paste output</option>
        <option value="ollama">Ollama (native)</option>
        <option value="openai">OpenAI-compatible API</option>
      </select></label>
      <label>Endpoint <input id="${side}-endpoint" placeholder="Default endpoint (blank)"></label>
      <label>Output token parameter <select id="${side}-tokenLimitField">
        <option value="max_completion_tokens">max_completion_tokens (OpenAI)</option>
        <option value="max_tokens">max_tokens (legacy compatible API)</option>
      </select></label>
      <div class="runner-actions"><button id="${side}-key" type="button">Set API key</button>
        <button id="${side}-run" type="button" class="primary">Run ${heading.toLowerCase()}</button></div>
      <p id="${side}-status" class="runstatus" role="status"></p>
    </details>
    <details id="${side}-modelDetails"><summary>Model &amp; context details</summary>
      <label>Provider-reported model <input id="${side}-reportedModel" placeholder="From provider, if available"></label>
      <label>Snapshot/version <input id="${side}-modelVersion" placeholder="If available"></label>
      <label>Context-window tokens <input id="${side}-contextWindowTokens" type="number" min="1" placeholder="Unknown"></label>
      <label>Context source <select id="${side}-contextWindowSource">
        <option value="unverified">Unverified</option><option value="provider">Provider-reported</option>
        <option value="documentation">Provider documentation</option><option value="configured">Configured</option></select></label>
      <label>Input tokens (actual) <input id="${side}-inputTokens" type="number" min="0" placeholder="Unknown"></label>
      <label>Output tokens (actual) <input id="${side}-outputTokens" type="number" min="0" placeholder="Unknown"></label>
      <label>Maximum output tokens <input id="${side}-maxOutputTokens" type="number" min="1" placeholder="Optional"></label>
      <label>Finish reason <select id="${side}-finishReason">
        <option value="">Unknown</option><option value="stop">stop</option><option value="length">length / truncated</option>
        <option value="tool_calls">tool_calls</option><option value="other">other</option></select></label>
      <label>Temperature <input id="${side}-temperature" type="number" step="0.1" min="0" max="2" placeholder="Provider default"></label>
    </details></section>`;
}

function panelHtml(panel, context) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const media = (...parts) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', ...parts));
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${media('style.css')}"><link rel="stylesheet" href="${media('runners.css')}">
  <title>CompareLab</title></head><body><main>
  <header><div><h1>⇄ CompareLab</h1><p>Visual, context-aware model comparisons.</p></div>
  <div id="currentActions" class="buttons"><button id="historySave">Save to history</button><button id="import">Import JSON</button><button id="export">Export JSON</button><button id="report">Markdown report</button><button id="htmlReport">Export HTML</button></div></header>
  <nav class="view-tabs" role="tablist" aria-label="CompareLab views">
  <button id="compareTab" role="tab" aria-controls="compareView" aria-selected="true">Model comparison</button>
  <button id="promptTab" role="tab" aria-controls="compareView" aria-selected="false" tabindex="-1">Prompt comparison</button>
  <button id="historyTab" role="tab" aria-controls="historyView" aria-selected="false" tabindex="-1">History</button></nav>
  <section id="compareView" role="tabpanel" aria-labelledby="compareTab">
  <p id="historySaveStatus" class="runstatus" role="status"></p>
  <p id="comparisonDescription" class="notice">Compare models using the same instructions and incoming message.</p>
  <section class="prompt"><div id="sharedInstructions"><div class="instruction-heading"><label for="prompt">Agent instructions / shared prompt</label>
  <button id="loadInstructions" type="button">Load agent file</button></div>
  <textarea id="prompt" rows="2" placeholder="Enter the prompt shared by both models"></textarea></div>
  <details id="datadogBudgetGuidance"><summary>Investigation instructions (automatically added to End-to-end runs)</summary>
  <pre class="response-content">${DATADOG_AGENT_PROMPT.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre></details>
  <label for="incomingMessage" class="evidence-label">Incoming message / trigger</label>
  <textarea id="incomingMessage" rows="3" placeholder="CodeMind mapped alert, normalized event JSON, or plain message"></textarea>
  <label for="evidence" class="evidence-label">Source evidence / tool results</label>
  <textarea id="evidence" rows="3" placeholder="Optional for End-to-end agent; required for Model / prompt only"></textarea>
  <p id="investigationDescription" class="notice">End-to-end Orchestrate Test lets each model investigate independently with approved Datadog MCP tools. No pasted evidence is required.</p></section>
  <div class="columns">${panelMarkup('a', 'Baseline')}${panelMarkup('b', 'Candidate')}</div>
  <div class="actionbar"><label>Required phrases (comma-separated) <input id="checks" placeholder="e.g. 401, 403"></label>
  <label>Comparison mode <select id="comparisonMode"><option value="end-to-end">End-to-end agent</option>
  <option value="model-prompt-only">Model / prompt only (frozen evidence required)</option></select></label>
  <button id="runBoth" type="button">Run both</button><button id="compare">Compare text</button></div>
  <section class="test-controls" aria-label="Controlled test">
  <label>Paired runs <input id="testRepetitions" type="number" min="1" max="5" value="3"></label>
  <button id="orchestrate" type="button" class="primary">Orchestrate Test</button>
  <p id="testBudget" class="notice"></p></section>
  <div class="review-actions"><label class="checkbox"><input id="checkOrder" type="checkbox" checked>Check reversed order (2 reviews)</label>
  <button id="chat" type="button">Analyze in Copilot Chat</button>
  <button id="evaluate" type="button" class="primary">Evaluate with Copilot</button>
  <button id="cancelReview" type="button" hidden>Cancel</button></div>
  <p id="reviewStatus" class="runstatus" role="status"></p>
  <section id="testResults" hidden aria-live="polite" tabindex="-1"></section>
  <section id="results" hidden tabindex="-1"><h2 class="section-title">Quality review</h2><div id="evaluation" aria-live="polite"></div>
  <div class="response-section-heading"><h2 id="responseHeading" class="section-title">Model reports</h2>
  <p id="responseDescription" class="notice">Read the formatted reports, or expand Raw response for the original text.</p></div>
  <div class="readable-responses">
  <article id="baselineResponseCard" class="response-card"><div class="model-card-heading"><h3 id="baselineResponseModel"></h3><span id="baselineResponseStatus"></span></div>
  <p id="baselineResponseRole" class="model-role">Baseline</p><div id="baselineContent" class="response-view"></div></article>
  <article id="candidateResponseCard" class="response-card"><div class="model-card-heading"><h3 id="candidateResponseModel"></h3><span id="candidateResponseStatus"></span></div>
  <p id="candidateResponseRole" class="model-role">Candidate</p><div id="candidateContent" class="response-view"></div></article></div>
  <h2 class="section-title diagnostics-heading">Diagnostics</h2>
  <details class="result-details"><summary>Text differences and phrase checks</summary>
  <div id="diff" class="diff" aria-label="Inline difference"></div><div id="summary"></div><div id="checksResults"></div></details>
  <details class="result-details"><summary>Run comparability and efficiency</summary>
  <div id="efficiency"></div><div id="fairness"></div></details>
  <details class="result-details"><summary>Execution traces and context provenance</summary><div id="traces"></div></details></section>
  </section>
  <section id="historyView" role="tabpanel" aria-labelledby="historyTab" hidden>
  <div class="history-heading"><div><h2>Comparison history</h2><p id="historyUsage" class="notice"></p></div>
  <div class="buttons"><button id="historyRefresh">Refresh</button><button id="historyClear">Clear history</button></div></div>
  <p class="notice">Shared across workspaces in this VS Code profile. Stored outside your repository, not synced by CompareLab.
  History contains prompts, responses, and retained evidence. Oldest entries are removed beyond 50 entries or 100 MiB; export important comparisons.</p>
  <p class="notice">Opening an entry loads an editable copy in Compare without rerunning models. Editing it never overwrites the saved entry.</p>
  <p id="historyStatus" class="runstatus" role="status"></p><div id="historyList"></div></section>
  <footer>VS Code model runs use your configured model access. Evaluation sends the supplied task, evidence, and responses through your Copilot access.
  Invalid citations may trigger one extra correction request.
  Chat opens a draft for review before sending.
  Other model requests go only to the endpoint you explicitly run.
  API keys stay in VS Code SecretStorage; prompts and responses can be sensitive when exported.</footer>
  </main><script nonce="${nonce}" src="${media('markdown.js')}"></script>
  <script nonce="${nonce}" src="${media('app.js')}"></script></body></html>`;
}

function activate(context) {
  const history = createHistory(path.join(context.globalStorageUri.fsPath, 'comparison-history'));
  context.subscriptions.push(vscode.commands.registerCommand('comparelab.open', () => {
    const panel = vscode.window.createWebviewPanel('comparelab', 'CompareLab', vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    panel.webview.html = panelHtml(panel, context);
    let running = false;
    let evaluation = null;
    let reviewCancellation;
    let disposed = false;
    let historyWorking = false;
    context.subscriptions.push(panel.onDidDispose(() => {
      disposed = true;
      reviewCancellation?.cancel();
    }));

    function comparison(input) {
      const result = compare(input);
      result.content = { baseline: responseContent(result.baseline.response), candidate: responseContent(result.candidate.response) };
      const key = evaluationKey({ ...input, evidence: result.evidence });
      result.evaluation = evaluation?.inputFingerprint === key ? evaluation : null;
      if (!result.evaluation && result.testRun) {
        const pair = result.testRun.pairs.findLast(pair => pair.evaluation?.inputFingerprint === key);
        result.evaluation = pair?.evaluation ?? null;
      }
      if (result.evaluation) result.evaluation = { ...result.evaluation, usage: usageReport(result.evaluation.usageTurns || []) };
      return result;
    }

    async function saveHistory(input, revision) {
      const result = comparison(input);
      if (!result.testRun && !result.baseline.response.trim() && !result.candidate.response.trim()) {
        throw new Error('Add at least one model response before saving a comparison to history.');
      }
      const saved = await history.save({ ...input, testRun: result.testRun }, result.evaluation);
      if (!disposed) await panel.webview.postMessage({ type: 'historySaved', entry: saved.entry, revision,
        message: 'Saved to history.' + (saved.removed ? ' Removed ' + saved.removed + ' oldest entries to stay within the history limits.' : '') });
    }

    async function handleHistory(msg) {
      const mutating = msg.type !== 'historyList';
      if (mutating && (running || historyWorking)) {
        await panel.webview.postMessage({ type: 'historyError', message: 'Wait for the current operation to finish before changing history.' });
        return;
      }
      if (mutating) {
        historyWorking = true;
        await panel.webview.postMessage({ type: 'historyBusy', value: true });
      }
      try {
        if (msg.type === 'historySave') await saveHistory(msg.experiment, msg.revision);
        else if (msg.type === 'historyOpen') {
          const snapshot = await history.get(msg.id);
          compare(snapshot.experiment);
          const choice = await vscode.window.showWarningMessage(
            'Open this saved comparison? This replaces the current form. Save or export any changes you want to keep first.',
            { modal: true }, 'Open comparison');
          if (choice !== 'Open comparison' || disposed) return;
          if (running) throw new Error('A run started while opening history. Open the comparison again after it finishes.');
          evaluation = snapshot.evaluation;
          await panel.webview.postMessage({ type: 'historyOpened', experiment: snapshot.experiment, savedAt: snapshot.savedAt });
          return;
        } else if (msg.type === 'historyDelete' || msg.type === 'historyClear') {
          const all = msg.type === 'historyClear';
          const label = all ? 'Clear history' : 'Delete comparison';
          const choice = await vscode.window.showWarningMessage(all
            ? 'Delete all saved comparisons in this profile? Exported files and the current form will not be changed.'
            : 'Delete this saved comparison? Exported files and the current form will not be changed.', { modal: true }, label);
          if (choice !== label || disposed) return;
          if (all) await history.clear();
          else await history.delete(msg.id);
          await panel.webview.postMessage({ type: 'historyStatus', message: all ? 'History cleared.' : 'Saved comparison deleted.' });
        } else if (msg.type !== 'historyList') throw new Error('Unknown history action.');
        if (!disposed) await panel.webview.postMessage({ type: 'historyList', ...await history.list() });
      } catch (error) {
        if (!disposed) await panel.webview.postMessage({ type: 'historyError', message: error.message });
        vscode.window.showErrorMessage('CompareLab history: ' + error.message);
      } finally {
        if (mutating) {
          historyWorking = false;
          if (!disposed) await panel.webview.postMessage({ type: 'historyBusy', value: false });
        }
      }
    }

    async function modelKey(variant) {
      if (variant.provider === 'vscode') return undefined;
      const endpoint = normalizedEndpoint(variant.provider, variant.endpoint);
      let apiKey;
      if (variant.provider === 'openai') {
        apiKey = await context.secrets.get(secretId(endpoint));
        if (!apiKey && endpoint === DEFAULT_ENDPOINTS.openai) {
          throw new Error('Set an API key for the OpenAI endpoint first');
        }
      }
      return apiKey;
    }

    async function runSide(input, side) {
      comparisonKind(input);
      const variant = side === 'a' ? input.baseline : input.candidate;
      if (!variant) throw new Error('Missing variant ' + side);
      const provider = variant.provider || 'vscode';
      if (!['vscode', 'ollama', 'openai'].includes(provider)) throw new Error('Select a model provider before running');
      const selected = await resolveRunModels(vscode, { [side]: { ...variant, provider } });
      const apiKey = await modelKey({ ...variant, provider });
      const promptTemplate = resolvePrompt(input.prompt, variant.prompt);
      const alert = codeMindAlert(input.incomingMessage);
      const request = {
        ...variant, provider, prompt: alert?.userPrompt || composeAgentTask(promptTemplate, input.incomingMessage),
        ...(alert ? { systemPrompt: agentInstructions(promptTemplate) } : {})
      };
      const result = provider === 'vscode' ? await runWithVsCode(vscode, request, selected[side], reviewCancellation?.token)
        : await runModel(request, { apiKey });
      await panel.webview.postMessage({ type: 'runResult', side, result: { ...result, promptTemplate } });
    }

    async function runTest(input) {
      const plan = createTestPlan(input);
      running = true;
      evaluation = null;
      reviewCancellation = new vscode.CancellationTokenSource();
      const controller = new AbortController();
      const cancellation = reviewCancellation.token.onCancellationRequested(() => controller.abort());
      await panel.webview.postMessage({ type: 'busy', value: true, kind: 'test' });
      try {
        const generationModels = await resolveRunModels(vscode, { baseline: plan.baseline, candidate: plan.candidate },
          { requireTools: plan.comparisonMode === 'end-to-end' });
        const keys = { baseline: await modelKey(plan.baseline), candidate: await modelKey(plan.candidate) };
        const model = await selectEvaluator(vscode);
        if (!model || disposed || reviewCancellation.token.isCancellationRequested) return;
        const toolSelection = plan.comparisonMode === 'end-to-end' ? await selectDatadogTools(vscode) : undefined;
        const tools = toolSelection?.tools;
        if (plan.comparisonMode === 'end-to-end' && (!tools || disposed || reviewCancellation.token.isCancellationRequested)) return;
        const record = await vscode.window.withProgress({ title: 'CompareLab: Orchestrate Test',
          location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
          const listener = token.onCancellationRequested(() => reviewCancellation.cancel());
          if (token.isCancellationRequested) reviewCancellation.cancel();
          try {
            return await orchestrateTest(input, {
              signal: controller.signal, comparePair: compare,
              runVariant: (variant, side, signal) => {
                if (!tools) return variant.provider === 'vscode'
                  ? runWithVsCode(vscode, variant, generationModels[side], reviewCancellation.token)
                  : runModel(variant, { apiKey: keys[side], signal });
                return runDatadogAgent(vscode, variant, tools, (conversation, tools, token) => {
                  if (variant.provider === 'vscode') return runWithVsCode(vscode, variant, generationModels[side], token, { conversation, tools });
                  const child = new AbortController();
                  const listener = token.onCancellationRequested(() => child.abort());
                  if (token.isCancellationRequested) child.abort();
                  return runModel(variant, { apiKey: keys[side], signal: child.signal, conversation, tools }).finally(() => listener.dispose());
                }, reviewCancellation.token, message => {
                  progress.report({ message: side + ': ' + message });
                  panel.webview.postMessage({ type: 'reviewStatus', message: side + ': ' + message });
                }, toolSelection.approvedReadOnlyTools).catch(error => {
                  if (error instanceof vscode.CancellationError) reviewCancellation.cancel();
                  throw error;
                });
              },
              evaluatePair: async (pairInput, number) => {
                const child = new vscode.CancellationTokenSource();
                const parent = reviewCancellation.token.onCancellationRequested(() => child.cancel());
                if (reviewCancellation.token.isCancellationRequested) child.cancel();
                let timedOut = false;
                const timer = setTimeout(() => { timedOut = true; child.cancel(); }, 180000);
                try {
                  return await evaluateWithCopilot(vscode, pairInput, model, child.token, message => {
                    progress.report({ message: 'Pair ' + number + ': ' + message });
                    panel.webview.postMessage({ type: 'reviewStatus', message: 'Pair ' + number + ': ' + message });
                  });
                } catch (error) {
                  if (timedOut) throw new Error('Pair evaluation timed out after 180 seconds.');
                  throw error;
                } finally { clearTimeout(timer); parent.dispose(); child.dispose(); }
              },
              onUpdate: async record => {
                if (disposed) return;
                const pair = record.pairs.at(-1);
                const message = pair ? 'Pair ' + pair.number + '/' + plan.repetitions + ': baseline ' + pair.baseline.status +
                  ', candidate ' + pair.candidate.status + ', review ' + pair.evaluationStatus : 'Starting controlled test...';
                progress.report({ message });
                await panel.webview.postMessage({ type: 'testUpdate', record, summary: summarizeTest(record), message });
              }
            });
          } finally { listener.dispose(); }
        });
        if (record) {
          const pair = record.pairs.findLast(pair => pair.baseline.status === 'succeeded' && pair.candidate.status === 'succeeded') || record.pairs.at(-1);
          const instructions = plan.instructions ?? plan.task;
          const variant = side => ({ ...pair?.[side]?.result, ...plan[side], prompt: plan.prompts?.[side] ?? instructions,
            response: pair?.[side]?.result?.response || '' });
          const completed = { prompt: instructions, incomingMessage: plan.incomingMessage || '', evidence: plan.evidence,
            comparisonMode: plan.comparisonMode || 'model-prompt-only', baseline: variant('baseline'), candidate: variant('candidate'),
            review: plan.review, checks: plan.checks, test: { repetitions: plan.repetitions }, testRun: record };
          if (plan.comparisonKind) completed.comparisonKind = plan.comparisonKind;
          if (!disposed) await panel.webview.postMessage({ type: 'testFinished', experiment: completed });
          try { await saveHistory(completed); }
          catch (error) {
            const message = 'The test finished, but its history save failed: ' + error.message + ' Export JSON to keep a copy.';
            if (!disposed) await panel.webview.postMessage({ type: 'historyError', message });
            vscode.window.showErrorMessage('CompareLab: ' + message);
          }
          const limited = record.pairs.some(pair => ['baseline', 'candidate'].some(side => pair[side].result?.investigationBudget?.limited));
          if (!disposed) await panel.webview.postMessage({ type: 'reviewStatus', message: 'Controlled test ' + record.status +
            (limited ? ' with budget-limited investigations. Inspect the run warnings.' : '.') });
        }
      } finally {
        cancellation.dispose();
        reviewCancellation.dispose();
        reviewCancellation = undefined;
        running = false;
        if (!disposed) await panel.webview.postMessage({ type: 'busy', value: false });
      }
    }

    panel.webview.onDidReceiveMessage(async msg => {
      if (typeof msg.type === 'string' && msg.type.startsWith('history')) { await handleHistory(msg); return; }
      try {
        if (msg.type === 'cancelReview') { reviewCancellation?.cancel(); return; }
        if (running && ['selectModel', 'loadInstructions', 'orchestrate', 'evaluate', 'chat', 'run', 'runBoth', 'import', 'setKey'].includes(msg.type)) return;
        if (msg.type === 'compare') {
          await panel.webview.postMessage({ type: 'result', result: comparison(msg.experiment), revision: msg.revision });
        } else if (msg.type === 'orchestrate') {
          await runTest(msg.experiment);
        } else if (msg.type === 'selectModel') {
          if (!['a', 'b'].includes(msg.side)) return;
          running = true;
          await panel.webview.postMessage({ type: 'busy', value: true, kind: 'selection' });
          try {
            const model = await selectRunModel(vscode);
            if (model && !disposed) await panel.webview.postMessage({ type: 'modelSelected', side: msg.side,
              model: { id: model.id, name: model.name, vendor: model.vendor, version: model.version } });
          } finally {
            running = false;
            if (!disposed) await panel.webview.postMessage({ type: 'busy', value: false });
          }
        } else if (msg.type === 'evaluate') {
          const reviewInput = msg.experiment.testRun ? { ...msg.experiment, evidence: compare(msg.experiment).evidence } : msg.experiment;
          reviewPacket(reviewInput);
          running = true;
          evaluation = null;
          await panel.webview.postMessage({ type: 'busy', value: true, kind: 'evaluation' });
          await panel.webview.postMessage({ type: 'reviewStatus', message: 'Choosing a Copilot evaluator...' });
          let timer;
          let timedOut = false;
          try {
            reviewCancellation = new vscode.CancellationTokenSource();
            const model = await selectEvaluator(vscode);
            if (!model || disposed || reviewCancellation.token.isCancellationRequested) {
              await panel.webview.postMessage({ type: 'reviewStatus', message: 'Evaluation cancelled.' });
              return;
            }
            timer = setTimeout(() => { timedOut = true; reviewCancellation?.cancel(); }, 180000);
            evaluation = await vscode.window.withProgress({
              location: vscode.ProgressLocation.Notification, cancellable: true, title: 'CompareLab: ' + model.name
            }, async (progress, token) => {
              const listener = token.onCancellationRequested(() => reviewCancellation.cancel());
              if (token.isCancellationRequested) reviewCancellation.cancel();
              try {
                return await evaluateWithCopilot(vscode, reviewInput, model, reviewCancellation.token, message => {
                  progress.report({ message });
                  panel.webview.postMessage({ type: 'reviewStatus', message });
                });
              } finally { listener.dispose(); }
            });
            if (!disposed) {
              await panel.webview.postMessage({ type: 'result', result: comparison(msg.experiment), revision: msg.revision });
              await panel.webview.postMessage({ type: 'reviewStatus', message: 'Assessment complete.' });
            }
          } catch (error) {
            if (!disposed) {
              const cancelled = reviewCancellation?.token.isCancellationRequested || error instanceof vscode.CancellationError;
              await panel.webview.postMessage({ type: 'reviewStatus', message: timedOut
                ? 'Evaluation timed out after 180 seconds.' : cancelled ? 'Evaluation cancelled.' : 'Evaluation failed: ' + error.message });
              if (!cancelled) vscode.window.showErrorMessage('CompareLab: ' + error.message);
            }
          } finally {
            clearTimeout(timer);
            reviewCancellation?.dispose();
            reviewCancellation = undefined;
            running = false;
            if (!disposed) await panel.webview.postMessage({ type: 'busy', value: false });
          }
        } else if (msg.type === 'chat') {
          const reviewInput = msg.experiment.testRun ? { ...msg.experiment, evidence: compare(msg.experiment).evidence } : msg.experiment;
          await openReviewChat(vscode, reviewInput);
          await panel.webview.postMessage({ type: 'reviewStatus', message: 'New Copilot Chat draft opened. No message was submitted.' });
        } else if (msg.type === 'export') {
          const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, saveLabel: 'Export experiment' });
          if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(msg.experiment, null, 2)));
        } else if (msg.type === 'loadInstructions') {
          const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Load agent instructions',
            filters: { 'Agent instructions': ['md', 'txt'] } });
          if (files?.length) {
            const bytes = await vscode.workspace.fs.readFile(files[0]);
            if (bytes.byteLength > 600000) throw new Error('Agent instructions exceed the 150,000-character limit.');
            const prompt = Buffer.from(bytes).toString('utf8');
            if (prompt.length > 150000) throw new Error('Agent instructions exceed the 150,000-character limit.');
            await panel.webview.postMessage({ type: 'instructionsLoaded', prompt, ...(['a', 'b'].includes(msg.side) ? { side: msg.side } : {}) });
          }
        } else if (msg.type === 'import') {
          const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] } });
          if (files?.length) {
            const bytes = await vscode.workspace.fs.readFile(files[0]);
            if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error('Import exceeds the 64 MiB limit');
            const imported = JSON.parse(Buffer.from(bytes).toString('utf8'));
            let side = 'baseline';
            if (imported.kind === 'codemind-agent-run') {
              const choice = await vscode.window.showQuickPick(['Baseline', 'Candidate'], { title: 'Import CodeMind run into' });
              if (!choice) return;
              side = choice === 'Baseline' ? 'baseline' : 'candidate';
            }
            const experiment = importRun(imported, msg.experiment, side);
            compare(experiment);
            evaluation = null;
            await panel.webview.postMessage({ type: 'imported', experiment });
          }
        } else if (msg.type === 'report') {
          const uri = await vscode.window.showSaveDialog({ filters: { Markdown: ['md'] }, saveLabel: 'Save comparison report' });
          if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(asMarkdown(comparison(msg.experiment))));
        } else if (msg.type === 'htmlReport') {
          const uri = await vscode.window.showSaveDialog({ filters: { HTML: ['html'] }, saveLabel: 'Export styled HTML report' });
          if (uri) {
            const assets = await Promise.all(['style.css', 'runners.css', 'markdown.js'].map(file =>
              vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'media', file))));
            const html = asHtml(comparison(msg.experiment), { css: assets.slice(0, 2).map(bytes => Buffer.from(bytes).toString('utf8')).join('\n'),
              markdownScript: Buffer.from(assets[2]).toString('utf8') });
            await vscode.workspace.fs.writeFile(uri, Buffer.from(html));
          }
        } else if (msg.type === 'setKey') {
          if (!['a', 'b'].includes(msg.side)) return;
          const variant = msg.side === 'a' ? msg.experiment.baseline : msg.experiment.candidate;
          if (variant.provider !== 'openai') throw new Error('API keys are only configured for OpenAI-compatible endpoints');
          const endpoint = normalizedEndpoint('openai', variant.endpoint);
          const value = await vscode.window.showInputBox({
            title: 'CompareLab API key', prompt: 'Key for ' + endpoint + ' (blank to clear). Stored in VS Code SecretStorage.',
            password: true, ignoreFocusOut: true
          });
          if (value !== undefined) {
            if (value) await context.secrets.store(secretId(endpoint), value);
            else await context.secrets.delete(secretId(endpoint));
            vscode.window.showInformationMessage(value ? 'CompareLab: API key saved for ' + endpoint : 'CompareLab: API key cleared');
          }
        } else if (msg.type === 'run' || msg.type === 'runBoth') {
          if (running) return;
          running = true;
          reviewCancellation = new vscode.CancellationTokenSource();
          await panel.webview.postMessage({ type: 'busy', value: true, kind: 'run' });
          const sides = msg.type === 'runBoth' ? ['a','b'] : [msg.side];
          for (const side of sides) {
            if (reviewCancellation.token.isCancellationRequested) break;
            if (!['a', 'b'].includes(side)) continue;
            await panel.webview.postMessage({ type: 'runStatus', side, message: 'Running…' });
            try { await runSide(msg.experiment, side); }
            catch (error) {
              await panel.webview.postMessage({ type: 'runStatus', side, message: 'Error: ' + error.message });
            }
          }
          reviewCancellation.dispose();
          reviewCancellation = undefined;
          running = false;
          await panel.webview.postMessage({ type: 'busy', value: false });
        }
      } catch (error) {
        running = false;
        await panel.webview.postMessage({ type: 'busy', value: false });
        if (['orchestrate', 'evaluate', 'chat'].includes(msg.type)) await panel.webview.postMessage({ type: 'reviewStatus', message: error.message });
        vscode.window.showErrorMessage('CompareLab: ' + error.message);
      }
    }, undefined, context.subscriptions);
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
