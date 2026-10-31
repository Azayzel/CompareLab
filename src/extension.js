'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const path = require('node:path');
const { compare, asMarkdown, responseContent, resolvePrompt, reviewPacket } = require('./comparison/core');
const { importRun, MAX_IMPORT_BYTES } = require('./records/traces');
const { composeAgentTask, comparisonKind, createTestPlan, orchestrateTest, summarizeTest } = require('./comparison/orchestration');
const { codeMindAlert, agentInstructions } = require('./comparison/inputs');
const { runModel, normalizedEndpoint, DEFAULT_ENDPOINTS } = require('./providers/http');
const { createHistory } = require('./records/history');
const { asHtml } = require('./reporting/html');
const { usageReport } = require('./metrics/usage');
const { selectEvaluator, selectRunModel, resolveRunModels } = require('./providers/vscode/models');
const { runWithVsCode } = require('./providers/vscode/generation');
const { evaluateWithCopilot, openReviewChat, evaluationKey } = require('./providers/vscode/review');
const { panelHtml } = require('./webview/panel');
const { selectTools, resolveTools, verifyReadOnlyTools, runToolAgent } = require('./tools/agent');
const { promptDecision, validatePromptChanges } = require('./comparison/prompt-review');
const { optimizerRequest, parseOptimizerDraft } = require('./comparison/prompt-optimizer');
const { collectionRequest, freezeEvidence } = require('./comparison/prompt-evidence');

const secretId = endpoint => 'comparelab:key:' + crypto.createHash('sha256').update(endpoint).digest('hex');

function activate(context) {
  const history = createHistory(path.join(context.globalStorageUri.fsPath, 'comparison-history'));
  context.subscriptions.push(vscode.commands.registerCommand('comparelab.open', () => {
    const panel = vscode.window.createWebviewPanel('comparelab', 'CompareLab', vscode.ViewColumn.One, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    panel.webview.html = panelHtml(vscode, panel, context);
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
