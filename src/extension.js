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
const { selectTools, resolveTools, verifyReadOnlyTools, runToolAgent, AGENT_PROMPT } = require('./tool-agent');
const { promptDecision, validatePromptChanges } = require('./prompt-review');
const { optimizerRequest, parseOptimizerDraft } = require('./prompt-optimizer');
const { collectionRequest, freezeEvidence } = require('./prompt-evidence');

const secretId = endpoint => 'comparelab:key:' + crypto.createHash('sha256').update(endpoint).digest('hex');

function panelMarkup(side, heading) {
  return `<section id="${side}-editor"><h2 id="${side}-heading">${heading}</h2>
    <div id="${side}-modelSlot"><div id="${side}-modelSettings"><label id="${side}-modelLabel" for="${side}-model">Model</label><div class="model-choice">
    <input id="${side}-model" placeholder="Select a VS Code model" readonly>
    <button id="${side}-selectModel" type="button">Select model</button></div></div></div>
    <details id="${side}-promptSection" class="prompt-override-details"><summary>Advanced: saved prompt override</summary>
    <div class="instruction-heading"><label id="${side}-promptLabel" for="${side}-prompt">Prompt override</label>
    <button id="${side}-loadInstructions" type="button">Load agent file</button></div>
    <textarea id="${side}-prompt" class="prompt-override" rows="6" placeholder="Uses shared prompt"></textarea></details>
    <div id="${side}-technicalSlot"><details class="raw-editor"><summary>Paste / edit raw response</summary>
    <label>Response <textarea id="${side}-response" rows="6" placeholder="Paste response or run a model"></textarea></label></details>
    <details id="${side}-runner" class="runner"><summary>Provider settings and single-model run</summary>
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
        <button id="${side}-run" type="button">Generate ${heading.toLowerCase()} (no tools)</button></div>
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
    </details></div></section>`;
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
  <details id="shareActions"><summary id="shareActionsLabel">Save / export</summary>
  <div id="currentActions" class="buttons"><button id="historySave">Save to history</button><button id="import">Import JSON</button><button id="export">Export JSON</button><button id="report">Markdown report</button><button id="htmlReport">Export HTML</button></div></details></header>
  <nav class="view-tabs" role="tablist" aria-label="CompareLab views">
  <button id="compareTab" role="tab" aria-controls="compareView" aria-selected="true">Model comparison</button>
  <button id="promptTab" role="tab" aria-controls="compareView" aria-selected="false" tabindex="-1">Prompt comparison</button>
  <button id="historyTab" role="tab" aria-controls="historyView" aria-selected="false" tabindex="-1">History</button></nav>
  <section id="compareView" role="tabpanel" aria-labelledby="compareTab">
  <p id="historySaveStatus" class="runstatus" role="status"></p>
  <p id="comparisonDescription" class="notice">Compare models using the same instructions and incoming message.</p>
  <section class="prompt"><div id="promptModelSlot" hidden></div><div id="sharedInstructions"><div class="instruction-heading"><label for="prompt">Agent instructions / shared prompt</label>
  <button id="loadInstructions" type="button">Load agent file</button></div>
  <textarea id="prompt" rows="2" placeholder="Enter the prompt shared by both models"></textarea></div>
  <section id="toolSetup" class="tool-setup" aria-labelledby="toolSetupHeading">
  <div class="tool-setup-heading"><div>
  <h2 id="toolSetupHeading">Investigation tools</h2>
  <p id="toolSelectionSummary" role="status">No tools selected</p>
  </div><button id="selectTools" type="button" aria-describedby="toolSelectionSummary">Select tools</button></div>
  <p class="notice">Tools require fresh read-only verification for each test and approval for every call.
  Verification is not a sandbox. No writes, commands, code execution, or shared-state changes.</p>
  <details id="agentGuidance"><summary>Tool setup and safety</summary>
  <p class="notice">Configure servers using MCP: List Servers in this VS Code window. Chat selections are not inherited.
  Only text results are supported. Both sides receive the same verified tools. Use read-only server permissions.
  Generation-only actions do not use tools. The following instructions are added to live investigations:</p>
  <pre class="response-content">${AGENT_PROMPT.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre></details>
  </section>
  <label id="incomingMessageLabel" for="incomingMessage" class="evidence-label">Incoming message / trigger</label>
  <textarea id="incomingMessage" rows="3" placeholder="CodeMind mapped alert, normalized event JSON, or plain message"></textarea>
  <details id="evidenceOptions"><summary id="evidenceOptionsLabel">Source evidence (optional for live investigations)</summary>
  <label for="evidence" class="evidence-label">Source evidence / tool results</label>
  <textarea id="evidence" rows="3" placeholder="Optional for End-to-end agent; required for Model / prompt only"></textarea>
  </details>
  <p id="investigationDescription" class="notice">Each model investigates independently with the selected tools. Evidence may differ.</p></section>
  <div class="columns">${panelMarkup('a', 'Baseline')}${panelMarkup('b', 'Candidate')}</div>
  <section id="promptTools" hidden>
  <details id="promptOptimizer" class="result-details"><summary>Help me improve this prompt</summary>
  <label>Improvement goal <select id="optimizerGoal"><option>Clearer instructions</option><option>More concise output</option>
  <option>Better evidence grounding</option><option>More actionable recommendations</option><option>Consistent output structure</option></select></label>
  <label>Keep unchanged <textarea id="optimizerPreserve" rows="2" placeholder="Required fields, behavior, constraints, or wording"></textarea></label>
  <label>What would a better output do? <textarea id="optimizerSuccess" rows="2" placeholder="Optional success criteria"></textarea></label>
  <button id="generatePrompt" type="button">Generate edited draft</button>
  <p class="notice">Choose a rewriting model when prompted. This only drafts instructions; it does not invoke tools or test either prompt.</p>
  <p id="optimizerStatus" class="runstatus" role="status"></p>
  <div id="optimizerPreview" hidden><p id="optimizerSummary"></p>
  <label>Review and edit draft <textarea id="optimizerDraft" rows="8"></textarea></label>
  <button id="applyPromptDraft" type="button">Apply draft to edited prompt</button>
  <p class="notice">Applying keeps the original unchanged and clears previous test results. Testing is a separate action. Rewriting usage is separate from investigation and evaluator totals.</p></div></details>
  <h2>What changed in the prompt?</h2><p class="notice">Read changed passages side by side. Highlights mark edited words; unchanged sections are hidden. Edits alone do not establish quality.</p>
  <div id="promptDiff" aria-label="Prompt changes"></div>
  <button id="promptTest" type="button" class="primary">Review prompt change</button>
  <div id="promptProgressSlot"></div>
  <p class="notice">One action runs both prompts and reviews their outputs automatically. If evidence is blank, collect one shared snapshot using selected tools first. You do not need to run or evaluate either prompt separately.</p>
  </section>
  <section id="modelRunControls" class="comparison-controls" aria-label="Run comparison">
  <div id="modelModeSlot"><label id="comparisonModeSetting">Comparison mode
  <select id="comparisonMode"><option value="end-to-end">End-to-end agent</option>
  <option value="model-prompt-only">Model / prompt only (frozen evidence required)</option></select></label></div>
  <button id="orchestrate" type="button" class="primary">Run comparison</button>
  <p id="comparisonRunSummary" class="notice"></p>
  </section>
  <details id="promptAdvanced" class="secondary-controls"><summary>Advanced settings</summary>
  <div id="promptModeSlot"></div>
  <div class="actionbar">
  <label>Paired runs <input id="testRepetitions" type="number" min="1" max="5" value="3"></label>
  <label>Required phrases (comma-separated) <input id="checks" placeholder="e.g. 401, 403"></label>
  </div>
  <label class="checkbox"><input id="checkOrder" type="checkbox" checked>Check reversed order (2 reviews)</label>
  <p id="testBudget" class="notice"></p>
  </details>
  <details id="otherActions" class="secondary-controls"><summary>Other actions</summary>
  <div id="modelOtherActions" class="secondary-actions">
  <div><button id="runBoth" type="button">Generate both (no tools)</button><p class="notice">Generate responses only; skip tools and quality review.</p></div>
  <div><button id="compare" type="button">Compare text only</button><p class="notice">Diff existing responses without calling a model.</p></div>
  <div><button id="evaluate" type="button">Review existing responses</button><p class="notice">Evaluate the current responses with Copilot; do not regenerate them.</p></div>
  <div><button id="chat" type="button">Open review in Chat</button><p class="notice">Open a draft to inspect and send yourself.</p></div>
  </div>
  <div id="promptOtherActions" class="secondary-actions" hidden>
  <button id="promptReviewOutputs" type="button">Review pasted outputs only</button>
  <button id="promptFreshEvidence" type="button">Collect fresh evidence and test prompts</button>
  </div>
  </details>
  <div id="reviewProgressSlot"><section id="reviewProgress" class="review-progress" hidden aria-labelledby="reviewProgressTitle" aria-busy="false">
  <div class="review-progress-heading"><span class="progress-spinner" aria-hidden="true"></span>
  <h3 id="reviewProgressTitle" role="status">Preparing prompt review</h3><span id="reviewElapsed" aria-live="off"></span></div>
  <ol id="reviewSteps" class="review-steps" aria-label="Review stages"></ol>
  <p id="reviewProgressDetail" class="progress-detail" role="status"></p>
  <p class="notice">This can take several minutes. Progress updates as model and tool requests finish; no completion time is estimated.</p>
  <div id="progressCancelSlot"></div></section></div>
  <div id="cancelReviewSlot"><button id="cancelReview" type="button" hidden>Cancel</button></div>
  <p id="reviewStatus" class="runstatus" role="status"></p>
  <section id="promptResults" hidden aria-live="polite" tabindex="-1"></section>
  <details id="promptAudit"><summary>Full outputs, reviews and technical details</summary>
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
  <details class="result-details"><summary>Execution traces and context provenance</summary><div id="traces"></div></details></section></details>
  </section>
  <section id="historyView" role="tabpanel" aria-labelledby="historyTab" hidden>
  <div class="history-heading"><div><h2>Comparison history</h2><p id="historyUsage" class="notice"></p></div>
  <div class="buttons"><button id="historyRefresh">Refresh</button><button id="historyClear">Clear history</button></div></div>
  <p class="notice">Shared across workspaces in this VS Code profile. Stored outside your repository, not synced by CompareLab.
  History contains prompts, responses, and retained evidence. Oldest entries are removed beyond 50 entries or 100 MiB; export important comparisons.</p>
  <p class="notice">Opening an entry loads an editable copy in Compare without rerunning models. Editing it never overwrites the saved entry.</p>
  <p id="historyStatus" class="runstatus" role="status"></p><div id="historyList"></div></section>
  <footer><details><summary>Data and model usage</summary>
  <p>VS Code model runs use your configured model access. Evaluation sends the supplied task, evidence, and responses through your Copilot access.
  Invalid citations may trigger one extra correction request.
  Chat opens a draft for review before sending.
  Other model requests go only to the endpoint you explicitly run.
  API keys stay in VS Code SecretStorage; prompts and responses can be sensitive when exported.</p></details></footer>
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
      if (result.comparisonKind === 'prompt') {
        if (result.evaluation?.promptChanges) validatePromptChanges(result.evaluation.promptChanges, {
          baselinePrompt: result.promptComparison.original, candidatePrompt: result.promptComparison.edited,
          baselineTask: result.baseline.prompt, candidateTask: result.candidate.prompt,
          baseline: responseContent(result.baseline.response), candidate: responseContent(result.candidate.response)
        }, result.promptComparison.spans);
        result.promptDecision = promptDecision(result);
      }
      return result;
    }

    async function saveHistory(input, revision) {
      const result = comparison(input);
      if (!result.testRun && !result.baseline.response.trim() && !result.candidate.response.trim()) {
        if (result.comparisonKind !== 'prompt') throw new Error('Add at least one model response before saving a comparison to history.');
        if (!result.promptComparison.original.trim() && !result.promptComparison.edited.trim()) {
          throw new Error('Enter an original or edited prompt before saving a prompt draft.');
        }
      }
      const draft = result.comparisonKind === 'prompt' && !result.testRun && !result.baseline.response.trim() && !result.candidate.response.trim();
      const saved = await history.save({ ...input, testRun: result.testRun }, result.evaluation);
      if (!disposed) await panel.webview.postMessage({ type: 'historySaved', entry: saved.entry, revision,
        message: (draft ? 'Prompt draft saved to History. No review has been run.' : 'Saved to history.') +
          (saved.removed ? ' Removed ' + saved.removed + ' oldest entries to stay within the history limits.' : '') });
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
      if (input.comparisonKind === 'prompt' && resolvePrompt(input.prompt, input.baseline?.prompt) === resolvePrompt(input.prompt, input.candidate?.prompt)) {
        throw new Error('Edit the candidate prompt before testing. Identical prompts cannot establish a prompt improvement.');
      }
      const collect = input.comparisonKind === 'prompt' && input.comparisonMode !== 'end-to-end' && !String(input.evidence || '').trim();
      let plan = createTestPlan(input, { allowPendingEvidence: collect });
      const collectionInput = collect ? { ...plan.baseline, prompt: collectionRequest(input).prompt } : null;
      running = true;
      evaluation = null;
      reviewCancellation = new vscode.CancellationTokenSource();
      const controller = new AbortController();
      const cancellation = reviewCancellation.token.onCancellationRequested(() => controller.abort());
      await panel.webview.postMessage({ type: 'busy', value: true, kind: 'test' });
      try {
        if (input.comparisonKind === 'prompt') await panel.webview.postMessage({ type: 'reviewStatus',
          message: 'Preparing prompt review: choosing the shared model and reviewer. Both outputs will be reviewed automatically.' });
        const generationModels = await resolveRunModels(vscode, { baseline: plan.baseline, candidate: plan.candidate },
          { requireTools: collect || plan.comparisonMode === 'end-to-end' });
        const keys = { baseline: await modelKey(plan.baseline), candidate: await modelKey(plan.candidate) };
        const model = await selectEvaluator(vscode);
        if (!model || disposed || reviewCancellation.token.isCancellationRequested) {
          if (!disposed) await panel.webview.postMessage({ type: 'reviewStatus', message: 'Review cancelled before either prompt was run.' });
          return;
        }
        let tools;
        if (collect || plan.comparisonMode === 'end-to-end') {
          let names = input.toolSelection;
          if (!names?.length) names = await selectTools(vscode, names);
          if (names === undefined) {
            if (!disposed) await panel.webview.postMessage({ type: 'reviewStatus', message: 'Tool selection cancelled. No generation was started.' });
            return;
          }
          tools = await verifyReadOnlyTools(vscode, resolveTools(vscode, names));
          if (!tools || disposed || reviewCancellation.token.isCancellationRequested) {
            if (!disposed) await panel.webview.postMessage({ type: 'reviewStatus', message: 'Read-only verification cancelled. No generation was started.' });
            return;
          }
          names = tools.map(tool => tool.name);
          if (input.evidenceCollection && JSON.stringify(input.toolSelection) !== JSON.stringify(names)) {
            input = { ...input, evidence: '', evidenceCollection: undefined };
          }
          input = { ...input, toolSelection: names, ...(plan.comparisonMode === 'end-to-end' ? { toolCatalog: tools } : {}) };
          plan = createTestPlan(input, { allowPendingEvidence: collect });
          if (!disposed) await panel.webview.postMessage({ type: 'toolsSelected', names });
        }
        if ((collect || plan.comparisonMode === 'end-to-end') && (!tools || disposed || reviewCancellation.token.isCancellationRequested)) {
          if (!disposed) await panel.webview.postMessage({ type: 'reviewStatus', message: 'Review cancelled before either prompt was run.' });
          return;
        }
        const record = await vscode.window.withProgress({ title: 'CompareLab: Orchestrate Test',
          location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
          const listener = token.onCancellationRequested(() => reviewCancellation.cancel());
          if (token.isCancellationRequested) reviewCancellation.cancel();
          try {
            if (collect) {
              await panel.webview.postMessage({ type: 'reviewStatus', phase: 'evidence', message: 'Collecting one shared tool snapshot. Neither prompt is being tested yet.' });
              const collected = await runToolAgent(vscode, { ...collectionInput, runLabel: 'Shared evidence collection' }, tools, (conversation, tools, token) => {
                if (collectionInput.provider === 'vscode') return runWithVsCode(vscode, collectionInput, generationModels.baseline, token, { conversation, tools });
                return runModel(collectionInput, { apiKey: keys.baseline, signal: controller.signal, conversation, tools });
              }, reviewCancellation.token, message => {
                progress.report({ message: 'Shared evidence: ' + message });
                panel.webview.postMessage({ type: 'reviewStatus', phase: 'evidence', message: 'Shared evidence: ' + message });
              });
              input = { ...input, ...freezeEvidence(collected), comparisonMode: 'model-prompt-only' };
              await panel.webview.postMessage({ type: 'sharedEvidence', evidence: input.evidence, evidenceCollection: input.evidenceCollection });
              plan = createTestPlan(input);
            }
            return await orchestrateTest(input, {
              signal: controller.signal, comparePair: compare,
              runVariant: (variant, side, signal) => {
                if (plan.comparisonMode !== 'end-to-end') return variant.provider === 'vscode'
                  ? runWithVsCode(vscode, variant, generationModels[side], reviewCancellation.token,
                    { tokenAwareInput: plan.comparisonKind === 'prompt' })
                  : runModel(variant, { apiKey: keys[side], signal });
                const runLabel = plan.comparisonKind === 'prompt'
                  ? side === 'baseline' ? 'Original prompt' : 'Edited prompt'
                  : side === 'baseline' ? 'Baseline' : 'Candidate';
                return runToolAgent(vscode, { ...variant, runLabel }, tools, (conversation, tools, token) => {
                  if (variant.provider === 'vscode') return runWithVsCode(vscode, variant, generationModels[side], token, { conversation, tools });
                  const child = new AbortController();
                  const listener = token.onCancellationRequested(() => child.abort());
                  if (token.isCancellationRequested) child.abort();
                  return runModel(variant, { apiKey: keys[side], signal: child.signal, conversation, tools }).finally(() => listener.dispose());
                }, reviewCancellation.token, message => {
                  progress.report({ message: side + ': ' + message });
                  panel.webview.postMessage({ type: 'reviewStatus', message: side + ': ' + message });
                }).catch(error => {
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
            review: plan.review, checks: plan.checks, test: { repetitions: plan.repetitions }, testRun: record,
            ...(input.toolSelection ? { toolSelection: input.toolSelection } : {}) };
          if (plan.evidenceCollection) completed.evidenceCollection = plan.evidenceCollection;
          if (input.optimizer) completed.optimizer = input.optimizer;
          if (plan.comparisonKind) completed.comparisonKind = plan.comparisonKind;
          if (!disposed) await panel.webview.postMessage({ type: 'testFinished', experiment: completed });
          try { await saveHistory(completed); }
          catch (error) {
            const message = 'The test finished, but its history save failed: ' + error.message + ' Export JSON to keep a copy.';
            if (!disposed) await panel.webview.postMessage({ type: 'historyError', message });
            vscode.window.showErrorMessage('CompareLab: ' + message);
          }
          const limited = record.pairs.some(pair => ['baseline', 'candidate'].some(side => pair[side].result?.investigationBudget?.limited));
          const reviewed = record.pairs.filter(pair => pair.evaluationStatus === 'succeeded').length;
          if (!disposed) await panel.webview.postMessage({ type: 'reviewStatus', message: plan.comparisonKind === 'prompt'
            ? reviewed === plan.repetitions ? 'Review complete. See the prompt recommendation below.'
              : 'Review ' + (record.status === 'cancelled' ? 'cancelled' : 'incomplete') + ': ' + reviewed + ' of ' +
                plan.repetitions + ' output pairs reviewed. See the errors below; no improvement has been established.'
            : 'Controlled test ' + record.status + (limited ? ' with budget-limited investigations. Inspect the run warnings.' : '.') });
        }
      } catch (error) {
        if (collect && !input.evidence && (reviewCancellation.token.isCancellationRequested || error instanceof vscode.CancellationError)) {
          if (!disposed) await panel.webview.postMessage({ type: 'reviewStatus', message: 'Shared evidence collection cancelled. Neither prompt was tested.' });
          return;
        }
        throw error;
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
        if (running && ['generatePrompt', 'selectModel', 'selectTools', 'loadInstructions', 'orchestrate', 'evaluate', 'chat', 'run', 'runBoth', 'import', 'setKey'].includes(msg.type)) return;
        if (msg.type === 'compare') {
          await panel.webview.postMessage({ type: 'result', result: comparison(msg.experiment), revision: msg.revision });
        } else if (msg.type === 'generatePrompt') {
          if (msg.experiment.comparisonKind !== 'prompt') throw new Error('Open Prompt comparison to generate an edited draft.');
          const request = optimizerRequest(msg.experiment, msg.guidance);
          running = true;
          reviewCancellation = new vscode.CancellationTokenSource();
          await panel.webview.postMessage({ type: 'busy', value: true, kind: 'optimizer' });
          try {
            const model = await selectRunModel(vscode);
            if (!model || disposed || reviewCancellation.token.isCancellationRequested) {
              if (!disposed) await panel.webview.postMessage({ type: 'optimizerStatus', message: 'Draft generation cancelled.' });
              return;
            }
            const result = await runWithVsCode(vscode, request, model, reviewCancellation.token);
            if (!disposed) await panel.webview.postMessage({ type: 'optimizerDraft', draft: parseOptimizerDraft(result), revision: msg.revision });
          } catch (error) {
            if (!disposed) {
              const cancelled = error instanceof vscode.CancellationError || reviewCancellation.token.isCancellationRequested;
              await panel.webview.postMessage({ type: 'optimizerStatus', message: cancelled ? 'Draft generation cancelled.' : 'Draft generation failed: ' + error.message });
              if (!cancelled) vscode.window.showErrorMessage('CompareLab: ' + error.message);
            }
          } finally {
            reviewCancellation.dispose();
            reviewCancellation = undefined;
            running = false;
            if (!disposed) await panel.webview.postMessage({ type: 'busy', value: false });
          }
        } else if (msg.type === 'orchestrate') {
          await runTest(msg.experiment);
        } else if (msg.type === 'selectTools') {
          running = true;
          await panel.webview.postMessage({ type: 'busy', value: true, kind: 'selection' });
          try {
            const names = await selectTools(vscode, msg.experiment.toolSelection);
            if (names !== undefined && !disposed) await panel.webview.postMessage({ type: 'toolsSelected', names });
          } finally {
            running = false;
            if (!disposed) await panel.webview.postMessage({ type: 'busy', value: false });
          }
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
        if (msg.type === 'generatePrompt') await panel.webview.postMessage({ type: 'optimizerStatus', message: error.message });
        vscode.window.showErrorMessage('CompareLab: ' + error.message);
      }
    }, undefined, context.subscriptions);
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
