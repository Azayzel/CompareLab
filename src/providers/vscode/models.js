'use strict';

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
  for (; ;) {
    const catalog = await discoverModels(vscode, evaluator ? { vendor: 'copilot' } : {});
    const models = catalog.filter(model => !unavailableModelReason(model));
    if (models.length) {
      const selected = await vscode.window.showQuickPick(models.map(model => ({
        label: model.name, description: model.vendor + ' | ' + model.id,
        detail: 'Version: ' + (model.version || 'Not reported') + ' | Input limit: ' + (model.maxInputTokens ?? 'Not reported'), model
      })), {
        title: evaluator ? 'CompareLab: choose a Copilot evaluator' : 'CompareLab: choose a VS Code model',
        placeHolder: 'Callable models exposed to this extension (not session-only agents)'
      });
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

module.exports = { selectEvaluator, selectRunModel, resolveRunModels, assertCallableModel };
