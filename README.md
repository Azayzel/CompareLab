# CompareLab

**Compare AI model responses and prompt variants directly in VS Code.** Local-first, lightweight, no runtime packages or hosted backend.

CompareLab pairs the simplicity of a Git diff with readable inline edits, deterministic checks, and context-budget metadata. You can **paste results** or **run Ollama and OpenAI-compatible chat-completion models** from the same two-panel view.

## Get started

1. Clone [Azayzel/CompareLab](https://github.com/Azayzel/CompareLab) and open the folder in VS Code.
2. Press **F5** to open the Extension Development Host.
3. Open the command palette: **CompareLab: Compare Model Outputs**.
4. Type a shared prompt, then enter two model IDs (or paste responses).
5. Optional: expand **Run model**, choose **Ollama** or **OpenAI-compatible API**, configure endpoint and run the model.
6. Click **Compare outputs** to review additions, removals, required phrase checks, and comparison-confidence warnings.

### Ollama

Install and start [Ollama](https://ollama.com/), then pull an installed model (e.g. `ollama pull qwen3.5:27b`). In CompareLab, choose **Ollama**, type that exact local model ID, and click **Run baseline** or **Run candidate**. Default endpoint: `http://127.0.0.1:11434`. It calls the native `/api/chat` endpoint with streaming disabled. No API key is needed.

You can set the **Context-window tokens** field to explicitly request Ollama's `num_ctx`; this is recorded as *configured*, not misrepresented as a provider-verified window. **Maximum output tokens** controls `num_predict`. If either field is blank, provider defaults apply and the capacity/budget remains unknown. Ollama's reported `prompt_eval_count` and `eval_count` are recorded where available.

### OpenAI or an OpenAI-compatible server

Choose **OpenAI-compatible API**, enter the model ID, and optionally change the endpoint. Default: `https://api.openai.com/v1`. CompareLab uses `POST /chat/completions` (not the Responses API) with plain text messages.

For authenticated endpoints, click **Set API key** inside that variant's Run model section. The extension stores the key in **VS Code SecretStorage, scoped to the normalized endpoint**; it is not copied into experiments, exported reports, or the Webview. Keys for `api.openai.com` are required before running. Custom servers may use keys or allow unauthenticated calls.

If the compatible server supports the older `max_tokens` field rather than `max_completion_tokens`, change **Output token parameter**. Not every model accepts temperature, token-budget controls, or Chat Completions. A server compatibility error will be displayed instead of silently changing your request.

Only **HTTPS remote** endpoints are permitted; HTTP is supported only for localhost. Redirects are rejected to prevent forwarding authorization to another host. Prompts are sent **only after clicking Run**. Consider your organization's data-handling policy before sending source code or other sensitive prompts to remote services.

### Run both

Set providers and model IDs for both variants, then click **Run both**. Requests run **sequentially**, not simultaneously, to avoid GPU contention for a local Ollama model. After each run, the response, resolved model ID (when supplied), actual usage counters, and finish reason populate the comparison. You can compare different model providers or tweak either prompt with a per-variant override.

## CLI

A standalone, dependency-free comparator for supplied JSON responses:

```sh
node bin/comparelab.js examples/experiment.json --format md
node bin/comparelab.js examples/experiment.json --format json > comparison.json
node --test
```

The CLI **does not call model providers** in this release. It shares `src/core.js` with the extension. Use **Import JSON**, **Export JSON**, and **Report** (Markdown) in the extension.

## Comparison integrity

Record requested/resolved model and version, prompt, actual token counts, maximum output tokens, finish reason, temperature, and context-window source where possible. The displayed context size is *not* equivalent to actual context used. Unreported system instructions, tools, retrieval, tokenizer differences, and hidden reasoning overhead can confound comparisons.

CompareLab flags missing context metadata as **unverified**, unequal configurations as **caution**, and known truncation as **limited**. Literal required-phrase checks are reproducible but do **not** establish semantic correctness. No universal AI quality or model winner is inferred from a text diff.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/core.js` | Pure text diff, deterministic checks, context warnings, report |
| `src/providers.js` | Native Ollama + OpenAI-compatible HTTP runners |
| `src/extension.js` | VS Code Webview, file dialogs, endpoint-scoped SecretStorage |
| `media/` | Plain HTML/CSS/JavaScript UI |
| `bin/comparelab.js` | Standalone manual-input CLI |
| `test/` | Node built-in unit and mock provider tests |

No external JavaScript dependencies, remote hosted backend, account, or database are required. The extension is not yet published in the Marketplace.

## Scope and roadmap

**v0.2:** Visual two-variant comparison, local manual imports/exports, Ollama and OpenAI-compatible model requests, token metadata, fair-comparison warnings, deterministic checks, CLI, tests.

**Deferred:** >2 simultaneous variants, model lists, streaming tokens, Responses API, retries/multiple statistical samples, semantic grading, real provider integration test matrix, and opt-in CI reporting. See [PLAN.md](PLAN.md), [DECISIONS.md](DECISIONS.md), [SHELVED.md](SHELVED.md).

## GitHub repository metadata

Suggested **About**:

> Compare AI model outputs and prompt variants in VS Code with Git-style diffs, evaluation checks, and local Ollama/OpenAI-compatible runners.

Suggested **Topics**:

`llm-evaluation` · `prompt-engineering` · `prompt-comparison` · `model-comparison` · `vscode-extension` · `ollama` · `openai` · `git-diff` · `ai-developer-tools` · `local-first`

GitHub's About and Topics are repository settings and must be saved via GitHub's settings UI or an authorized API with repository-metadata write access; editing this README does not alter those settings.
