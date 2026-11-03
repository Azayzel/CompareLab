'use strict';
const { modelTimeoutSeconds } = require('./limits');

async function withModelTimeout(vscode, parent, seconds, operation, label = 'VS Code model request') {
  const timeout = modelTimeoutSeconds(seconds);
  const cancellation = new vscode.CancellationTokenSource();
  let listener, timer;
  let stopped = false;
  const interrupted = new Promise((resolve, reject) => {
    const stop = error => {
      if (stopped) return;
      stopped = true;
      reject(error);
      cancellation.cancel();
    };
    listener = parent?.onCancellationRequested?.(() => stop(new vscode.CancellationError()));
    if (parent?.isCancellationRequested) stop(new vscode.CancellationError());
    if (!stopped) timer = setTimeout(() => stop(Object.assign(new Error((typeof label === 'function' ? label() : label) +
      ' timed out after ' + timeout +
      ' seconds. Increase the VS Code timeout in Advanced settings or select another model. No automatic retry was made.'),
    { code: 'COMPARELAB_MODEL_TIMEOUT' })), timeout * 1000);
  });
  try {
    // Race cancellation as well as signalling it: some providers never settle after cancellation.
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      if (stopped) throw new vscode.CancellationError();
      return operation(cancellation.token);
    })]);
  } finally {
    clearTimeout(timer);
    listener?.dispose();
    cancellation.dispose();
  }
}

module.exports = { withModelTimeout };
