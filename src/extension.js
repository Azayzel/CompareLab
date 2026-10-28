'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const path = require('node:path');
const { compare, asMarkdown, responseContent, resolvePrompt, reviewPacket } = require('./core');
const { importRun, MAX_IMPORT_BYTES } = require('./traces');
const { composeAgentTask, createTestPlan, orchestrateTest, summarizeTest } = require('./orchestration');
const { codeMindAlert, agentInstructions } = require('./inputs');
const { runModel, normalizedEndpoint, DEFAULT_ENDPOINTS } = require('./providers');
const { selectEvaluator, selectRunModel, resolveRunModels, runWithVsCode, evaluateWithCopilot, openReviewChat, evaluationKey } = require('./copilot');

const secretId = endpoint => 'comparelab:key:' + crypto.createHash('sha256').update(endpoint).digest('hex');

function panelMarkup(side, heading) {
  return `<section><h2>${heading}</h2>
    <label for="${side}-model">Model</label><div class="model-choice">
    <input id="${side}-model" placeholder="Select a VS Code model" readonly>
    <button id="${side}-selectModel" type="button">Select model</button></div>
    <label>Prompt override <textarea id="${side}-prompt" class="prompt-override" rows="2" placeholder="Uses shared prompt"></textarea></label>
    <label>Response <textarea id="${side}-response" rows="10" placeholder="Paste response or run a model"></textarea></label>
    <details class="runner"><summary>Run model (optional)</summary>
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
    <details><summary>Model &amp; context details</summary>
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
  <div class="buttons"><button id="import">Import JSON</button><button id="export">Export JSON</button><button id="report">Report</button></div></header>
  <section class="prompt"><div class="instruction-heading"><label for="prompt">Agent instructions / shared prompt</label>
  <button id="loadInstructions" type="button">Load agent file</button></div>
  <textarea id="prompt" rows="2" placeholder="Enter the prompt shared by both models"></textarea>
  <label for="incomingMessage" class="evidence-label">Incoming message / trigger</label>
  <textarea id="incomingMessage" rows="3" placeholder="CodeMind mapped alert, normalized event JSON, or plain message"></textarea>
  <label for="evidence" class="evidence-label">Source evidence / tool results</label>
  <textarea id="evidence" rows="3" placeholder="Original logs, metrics, references, or expected results"></textarea></section>
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
  <section id="testResults" hidden aria-live="polite"></section>
  <section id="results" hidden><h2>Quality assessment</h2><div id="evaluation" aria-live="polite"></div>
  <h2>Responses</h2><div class="readable-responses">
  <article><h3>Baseline</h3><pre id="baselineContent" class="response-content"></pre></article>
  <article><h3>Candidate</h3><pre id="candidateContent" class="response-content"></pre></article></div>
  <details class="result-details"><summary>Raw text diff and phrase checks</summary>
  <div id="diff" class="diff" aria-label="Inline difference"></div><div id="summary"></div><div id="checksResults"></div></details>
  <details class="result-details"><summary>Run comparability and efficiency</summary>
  <div id="efficiency"></div><div id="fairness"></div></details>
  <details class="result-details"><summary>Execution traces and context provenance</summary><div id="traces"></div></details></section>
  <footer>VS Code model runs use your configured model access. Evaluation sends the supplied task, evidence, and responses through your Copilot access.
  Invalid citations may trigger one extra correction request.
  Chat opens a draft for review before sending.
  Other model requests go only to the endpoint you explicitly run.
  API keys stay in VS Code SecretStorage; prompts and responses can be sensitive when exported.</footer>
  </main><script nonce="${nonce}" src="${media('app.js')}"></script></body></html>`;
}

function activate(context) {
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
    context.subscriptions.push(panel.onDidDispose(() => {
      disposed = true;
      reviewCancellation?.cancel();
    }));

    function comparison(input) {
      const result = compare(input);
      result.content = { baseline: responseContent(result.baseline.response), candidate: responseContent(result.candidate.response) };
      result.evaluation = evaluation?.inputFingerprint === evaluationKey(input) ? evaluation : null;
      if (!result.evaluation && result.testRun) {
        const pair = result.testRun.pairs.findLast(pair => pair.evaluation?.inputFingerprint === evaluationKey(input));
        result.evaluation = pair?.evaluation ?? null;
      }
      return result;
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
        const generationModels = await resolveRunModels(vscode, { baseline: plan.baseline, candidate: plan.candidate });
        const keys = { baseline: await modelKey(plan.baseline), candidate: await modelKey(plan.candidate) };
        const model = await selectEvaluator(vscode);
        if (!model || disposed || reviewCancellation.token.isCancellationRequested) return;
        const record = await vscode.window.withProgress({ title: 'CompareLab: Orchestrate Test',
          location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
          const listener = token.onCancellationRequested(() => reviewCancellation.cancel());
          if (token.isCancellationRequested) reviewCancellation.cancel();
          try {
            return await orchestrateTest(input, {
              signal: controller.signal, comparePair: compare,
              runVariant: (variant, side, signal) => variant.provider === 'vscode'
                ? runWithVsCode(vscode, variant, generationModels[side], reviewCancellation.token)
                : runModel(variant, { apiKey: keys[side], signal }),
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
        if (!disposed) {
          const pair = record.pairs.findLast(pair => pair.baseline.status === 'succeeded' && pair.candidate.status === 'succeeded') || record.pairs.at(-1);
          const instructions = plan.instructions ?? plan.task;
          const variant = side => ({ ...pair?.[side]?.result, ...plan[side], prompt: instructions, response: pair?.[side]?.result?.response || '' });
          await panel.webview.postMessage({ type: 'testFinished', experiment: { prompt: instructions, incomingMessage: plan.incomingMessage || '', evidence: plan.evidence,
            comparisonMode: 'model-prompt-only', baseline: variant('baseline'), candidate: variant('candidate'),
            review: plan.review, checks: plan.checks, test: { repetitions: plan.repetitions }, testRun: record } });
          await panel.webview.postMessage({ type: 'reviewStatus', message: 'Controlled test ' + record.status + '.' });
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
          reviewPacket(msg.experiment);
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
                return await evaluateWithCopilot(vscode, msg.experiment, model, reviewCancellation.token, message => {
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
          await openReviewChat(vscode, msg.experiment);
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
            await panel.webview.postMessage({ type: 'instructionsLoaded', prompt });
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
