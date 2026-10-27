'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const path = require('node:path');
const { compare, asMarkdown } = require('./core');
const { runModel, normalizedEndpoint, DEFAULT_ENDPOINTS } = require('./providers');

const secretId = endpoint => 'comparelab:key:' + crypto.createHash('sha256').update(endpoint).digest('hex');

function panelMarkup(side, heading) {
  return `<section><h2>${heading}</h2>
    <label>Model ID <input id="${side}-model" placeholder="e.g. qwen3.5:27b or gpt-4.1"></label>
    <label>Prompt override <input id="${side}-prompt" placeholder="Uses shared prompt"></label>
    <label>Response <textarea id="${side}-response" rows="10" placeholder="Paste response or run a model"></textarea></label>
    <details class="runner"><summary>Run model (optional)</summary>
      <label>Provider <select id="${side}-provider">
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
  <section class="prompt"><label for="prompt">Shared prompt <span class="subtle">(override per variant to test a prompt change)</span></label>
  <textarea id="prompt" rows="2" placeholder="Enter the prompt shared by both models"></textarea></section>
  <div class="columns">${panelMarkup('a', 'Baseline')}${panelMarkup('b', 'Candidate')}</div>
  <div class="actionbar"><label>Required phrases (comma-separated) <input id="checks" placeholder="e.g. 401, 403"></label>
  <button id="runBoth" type="button">Run both</button><button id="compare" class="primary">Compare outputs</button></div>
  <section id="results" hidden><div class="resultsheading"><h2>Response comparison</h2>
  <span>Inline diff · green added · red removed</span></div>
  <div id="diff" class="diff" aria-label="Inline difference"></div><h2>Evaluation &amp; context</h2>
  <div id="summary"></div><div id="fairness"></div><div id="checksResults"></div></section>
  <footer>Local-first. Model requests are sent only to the endpoint you explicitly run.
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

    async function runSide(input, side) {
      const variant = side === 'a' ? input.baseline : input.candidate;
      if (!variant) throw new Error('Missing variant ' + side);
      const provider = variant.provider;
      if (!['ollama', 'openai'].includes(provider)) throw new Error('Select a model provider before running');
      const endpoint = normalizedEndpoint(provider, variant.endpoint);
      let apiKey;
      if (provider === 'openai') {
        apiKey = await context.secrets.get(secretId(endpoint));
        if (!apiKey && endpoint === DEFAULT_ENDPOINTS.openai) {
          throw new Error('Set an API key for the OpenAI endpoint first');
        }
      }
      const result = await runModel({
        ...variant, provider, prompt: variant.prompt || input.prompt || ''
      }, { apiKey });
      await panel.webview.postMessage({ type: 'runResult', side, result });
    }

    panel.webview.onDidReceiveMessage(async msg => {
      try {
        if (msg.type === 'compare') {
          await panel.webview.postMessage({ type: 'result', result: compare(msg.experiment) });
        } else if (msg.type === 'export') {
          const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, saveLabel: 'Export experiment' });
          if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(msg.experiment, null, 2)));
        } else if (msg.type === 'import') {
          const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] } });
          if (files?.length) {
            const bytes = await vscode.workspace.fs.readFile(files[0]);
            const imported = JSON.parse(Buffer.from(bytes).toString('utf8'));
            await panel.webview.postMessage({ type: 'imported', experiment: imported });
          }
        } else if (msg.type === 'report') {
          const uri = await vscode.window.showSaveDialog({ filters: { Markdown: ['md'] }, saveLabel: 'Save comparison report' });
          if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(asMarkdown(compare(msg.experiment))));
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
          await panel.webview.postMessage({ type: 'busy', value: true });
          const sides = msg.type === 'runBoth' ? ['a','b'] : [msg.side];
          for (const side of sides) {
            if (!['a', 'b'].includes(side)) continue;
            await panel.webview.postMessage({ type: 'runStatus', side, message: 'Running…' });
            try { await runSide(msg.experiment, side); }
            catch (error) {
              await panel.webview.postMessage({ type: 'runStatus', side, message: 'Error: ' + error.message });
            }
          }
          running = false;
          await panel.webview.postMessage({ type: 'busy', value: false });
        }
      } catch (error) {
        running = false;
        await panel.webview.postMessage({ type: 'busy', value: false });
        vscode.window.showErrorMessage('CompareLab: ' + error.message);
      }
    }, undefined, context.subscriptions);
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
