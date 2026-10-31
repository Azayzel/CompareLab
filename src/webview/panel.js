'use strict';

const crypto = require('node:crypto');
const { AGENT_PROMPT } = require('../tools/agent');

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

function panelHtml(vscode, panel, context) {
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

module.exports = { panelHtml };
