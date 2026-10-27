'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { compare, asMarkdown } = require('./core');

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('comparelab.open', () => {
    const panel = vscode.window.createWebviewPanel('comparelab', 'CompareLab', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    });
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'app.js')));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', 'style.css')));
    panel.webview.html = `<!doctype html><html lang="en"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>CompareLab</title></head><body>
    <main>
      <header><div><h1>⇄ CompareLab</h1><p>Visual, context-aware model comparisons.</p></div><div class="buttons"><button id="import">Import JSON</button><button id="export">Export JSON</button><button id="report">Report</button></div></header>
      <section class="prompt"><label for="prompt">Shared prompt <span class="subtle">(edit candidate prompt to test prompt variants)</span></label><textarea id="prompt" rows="2" placeholder="Enter the baseline prompt"></textarea></section>
      <div class="columns">
        <section><h2>Baseline</h2><label>Model <input id="a-model" placeholder="e.g. GPT-6"></label><label>Prompt override <input id="a-prompt" placeholder="Uses shared prompt"></label><label>Response <textarea id="a-response" rows="10" placeholder="Paste baseline output"></textarea></label><details><summary>Model & context details</summary>
          <label>Provider-reported model <input id="a-reportedModel" placeholder="Exact identifier, if available"></label>
          <label>Snapshot/version <input id="a-modelVersion" placeholder="Snapshot, if available"></label>
          <label>Context-window tokens <input id="a-contextWindowTokens" type="number" min="0" placeholder="Unknown"></label>
          <label>Context source <select id="a-contextWindowSource"><option value="unverified">Unverified</option><option value="provider">Provider-reported</option><option value="documentation">Provider documentation</option><option value="configured">Configured / user-entered</option></select></label>
          <label>Actual input tokens <input id="a-inputTokens" type="number" min="0" placeholder="Unknown"></label>
          <label>Actual output tokens <input id="a-outputTokens" type="number" min="0" placeholder="Unknown"></label>
          <label>Maximum output tokens <input id="a-maxOutputTokens" type="number" min="0" placeholder="Unknown"></label>
          <label>Finish reason <select id="a-finishReason"><option value="">Unknown</option><option value="stop">stop</option><option value="length">length / truncated</option><option value="tool_calls">tool_calls</option><option value="other">other</option></select></label>
          <label>Temperature <input id="a-temperature" type="number" step="0.1" min="0" placeholder="Unknown"></label>
        </details></section>
        <section><h2>Candidate</h2><label>Model <input id="b-model" placeholder="e.g. Claude"></label><label>Prompt override <input id="b-prompt" placeholder="Uses shared prompt"></label><label>Response <textarea id="b-response" rows="10" placeholder="Paste candidate output"></textarea></label><details><summary>Model & context details</summary>
          <label>Provider-reported model <input id="b-reportedModel" placeholder="Exact identifier, if available"></label>
          <label>Snapshot/version <input id="b-modelVersion" placeholder="Snapshot, if available"></label>
          <label>Context-window tokens <input id="b-contextWindowTokens" type="number" min="0" placeholder="Unknown"></label>
          <label>Context source <select id="b-contextWindowSource"><option value="unverified">Unverified</option><option value="provider">Provider-reported</option><option value="documentation">Provider documentation</option><option value="configured">Configured / user-entered</option></select></label>
          <label>Actual input tokens <input id="b-inputTokens" type="number" min="0" placeholder="Unknown"></label>
          <label>Actual output tokens <input id="b-outputTokens" type="number" min="0" placeholder="Unknown"></label>
          <label>Maximum output tokens <input id="b-maxOutputTokens" type="number" min="0" placeholder="Unknown"></label>
          <label>Finish reason <select id="b-finishReason"><option value="">Unknown</option><option value="stop">stop</option><option value="length">length / truncated</option><option value="tool_calls">tool_calls</option><option value="other">other</option></select></label>
          <label>Temperature <input id="b-temperature" type="number" step="0.1" min="0" placeholder="Unknown"></label>
        </details></section>
      </div>
      <div class="actionbar"><label>Required phrases (comma-separated) <input id="checks" placeholder="e.g. 401, 403"></label><button id="compare" class="primary">Compare outputs</button></div>
      <section id="results" hidden><div class="resultsheading"><h2>Response comparison</h2><span>Inline diff · green added · red removed</span></div>
      <div id="diff" class="diff" aria-label="Inline difference"></div><h2>Evaluation & context</h2><div id="summary"></div><div id="fairness"></div><div id="checksResults"></div></section>
      <footer>Local-first. No response content is sent to CompareLab servers. This version compares supplied outputs; it does not execute external models.</footer>
    </main>
    <script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
    let latest = null;
    panel.webview.onDidReceiveMessage(async msg => {
      try {
        if (msg.type === 'compare') {
          latest = compare(msg.experiment);
          panel.webview.postMessage({ type: 'result', result: latest });
        } else if (msg.type === 'export') {
          const data = JSON.stringify(msg.experiment, null, 2);
          const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, saveLabel: 'Export experiment' });
          if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(data));
        } else if (msg.type === 'import') {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] } });
          if (picked?.length) {
            const bytes = await vscode.workspace.fs.readFile(picked[0]);
            const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
            panel.webview.postMessage({ type: 'imported', experiment: value });
          }
        } else if (msg.type === 'report') {
          if (!latest) latest = compare(msg.experiment);
          const uri = await vscode.window.showSaveDialog({ filters: { Markdown: ['md'] }, saveLabel: 'Save comparison report' });
          if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(asMarkdown(latest)));
        }
      } catch (err) {
        vscode.window.showErrorMessage('CompareLab: ' + err.message);
      }
    }, undefined, context.subscriptions);
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
