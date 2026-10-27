# CompareLab

**A lightweight VS Code extension for comparing AI model outputs and prompt variants.**

CompareLab gives you an inline Git-style diff, a short deterministic evaluation, and an honest accounting of whether two responses can be fairly compared. It runs locally; it does **not** call model providers or transmit your response text.

## Quick start

1. Clone [Azayzel/CompareLab](https://github.com/Azayzel/CompareLab).
2. Open the repository in VS Code (Node.js 20+ recommended).
3. Press **F5** to launch the Extension Development Host.
4. Open the command palette and choose **CompareLab: Compare Model Outputs**.
5. Paste baseline/candidate responses, enter model and context metadata where available, and click **Compare outputs**.

No `npm install`, backend, API token, database, or build step is required to run the extension.

## CLI

```sh
node bin/comparelab.js examples/experiment.json --format md
node bin/comparelab.js examples/experiment.json --format json > comparison.json
node --test
```

Reports can be saved from the extension as Markdown, or experiments imported/exported as JSON. Both the extension and CLI call `src/core.js`.

## Comparison fairness

For **each** run, record as much of the following as available:

- Requested model, provider-resolved model ID/snapshot, and version.
- Effective context-window maximum **and the source of that number** (provider-reported, documentation, configured, or unverified).
- Provider-reported *actual* input/output tokens, configured output token maximum, and finish reason.
- Exact prompt and response, plus sampling temperature where known.

Context-window size is **not** the same as context actually used. Provider chat/system instructions, retrieved documents, tool results, hidden reasoning tokens, and tokenization differences can affect comparisons. CompareLab labels missing data **unverified**, warns about different budgets, and flags known truncation as **limited**. It will not claim two runs are fair merely because model names or nominal context-window sizes appear to match. Model updates and snapshot aliases are not silently treated as frozen versions.

If comparing different prompts, interpret changes as a **prompt experiment**, not proof that one model is better. The required-phrase checks are literal string checks, **not** semantic correctness or an AI quality score.

## Scope

**Implemented in v0.1:** VS Code Webview, two-variant word-level inline diff, context metadata capture, local JSON import/export, Markdown report, deterministic required-phrase checks, standalone CLI, Node built-in tests.

**Not implemented yet:** Automatic model invocation, token-usage discovery, context-window verification from providers, semantic grading, LLM-as-judge, multi-run statistics, or more than two side-by-side variants. See [SHELVED.md](SHELVED.md).

Large text comparisons fall back to coarse replacement spans to avoid large quadratic diff allocations.

## Development

- `src/core.js`: Pure comparison/fairness logic; no VS Code or runtime dependencies.
- `src/extension.js`: VS Code Webview host and file dialogs.
- `media/`: Single-page UI; plain JavaScript and CSS.
- `bin/comparelab.js`: Portable CLI.
- `test/`: Node built-in tests.

See [PLAN.md](PLAN.md) and [DECISIONS.md](DECISIONS.md). Contributions welcome.
