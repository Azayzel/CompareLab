# CompareLab

**A lightweight VS Code extension for comparing AI model outputs and prompt variants.**

Compare the same prompt on two models, or test a subtle prompt change on one model. CompareLab combines a Git-style inline diff with readable text highlights, simple acceptance checks, and context/usage warnings. **Paste responses or explicitly run models through Ollama and OpenAI-compatible Chat Completions APIs.**

No hosted backend, database, frontend framework, or runtime npm dependencies. Just **baseline → candidate → diff**.

## Quick start

Requires **VS Code 1.90+** and **Node.js 20+** for development.

1. Clone this repository and open it in VS Code.
2. Press **F5** to start the Extension Development Host.
3. In its Command Palette, choose **CompareLab: Compare Model Outputs**.
4. Enter a **Shared prompt**. Paste two responses to compare them immediately, or enter model IDs.
5. To generate responses, expand **Run model (optional)** for each side, select a provider, and click **Run baseline**, **Run candidate**, or **Run both**.
6. Click **Compare outputs** for the inline diff, required-phrase checks, and comparability warnings. Use **Export JSON** or **Report** to save your experiment.

To vary a prompt, enter a **Prompt override** for either side. After a model run, the override is populated with the exact prompt that was sent. **Clear or change the override before rerunning** if you've edited the shared prompt.

The extension is run from source; it is not yet published to the VS Code Marketplace.

## Run with Ollama

Install and start [Ollama](https://ollama.com/), then use a locally installed model:

```sh
ollama pull qwen3.5:27b
ollama list
```

Choose **Ollama**, enter the installed model ID, and click Run. The default endpoint is `http://127.0.0.1:11434`; CompareLab calls the native `POST /api/chat` route without streaming. No API key is required in this version.

- **Context-window tokens** sends Ollama's `num_ctx`. This is labeled **configured**, not independently verified.
- **Maximum output tokens** sends `num_predict`.
- **Temperature** is only sent when entered.
- Usage is populated from `prompt_eval_count` and `eval_count` when supplied.

Leaving limits empty uses server/model defaults, which CompareLab records as **unknown**, rather than guessing effective context capacity.

## Run with OpenAI / compatible APIs

Choose **OpenAI-compatible API**, enter the model identifier, and optionally override the endpoint (default: `https://api.openai.com/v1`). The integration uses `POST /chat/completions`, **not** the Responses API.

Click **Set API key** to enter a key for that endpoint when needed. Keys are stored in VS Code **SecretStorage**, scoped to the normalized endpoint. They are not stored in Webview experiment state or included in JSON/Markdown exports. The default OpenAI endpoint requires a key; other compatible endpoints may not.

The output-token setting uses `max_completion_tokens` by default. If a compatible server expects the older field, choose `max_tokens`. Some models may reject temperature, token-limit parameters, or Chat Completions entirely; the extension displays an error rather than silently retrying with different settings.

Remote endpoints must use **HTTPS**; HTTP is permitted only for local loopback addresses. Embedded URL credentials, query strings, fragments, and redirects are rejected. **Requests are sent only after clicking Run.**

### Run both

Configure providers and model IDs on both sides, then click **Run both**. Runs execute **sequentially**, not concurrently, to reduce resource contention on a shared local GPU. Each successful run updates its response, reported model ID, token usage and finish reason when available. If one side fails, the other is still attempted.

Elapsed duration appears in each runner's status, but is **not currently persisted** in experiment JSON or Markdown reports.

## Understanding the results

The inline diff highlights **green additions** to the candidate and **red strikethrough deletions** from the baseline. Text change alone cannot establish that either response is more accurate, safe, or useful.

**Required phrases** are comma-separated, case-insensitive literal substring checks. These checks are deterministic but **not** semantic scoring or fact verification.

CompareLab flags changed prompts, different recorded context-window sizes, output caps, and temperatures; missing provider metadata; and known completion truncation. Its comparison-confidence labels (`comparable`, `unverified`, `caution`, `limited`) summarize **only those checks**. Even `comparable` is **not a fairness guarantee**: system instructions, hidden reasoning, tools, retrieval, snapshot versions, and different tokenizers can confound results.

For team-wide judgments, use a representative task set, fixed acceptance criteria, repeated runs, and human review. See [SKILL.md](SKILL.md).

## CLI and experiment files

The dependency-free CLI compares **supplied** responses and does **not** call model providers:

```sh
node bin/comparelab.js examples/experiment.json --format md
node bin/comparelab.js examples/experiment.json --format json > comparison.json
node --test
```

Basic input shape:

```json
{
  "prompt": "Explain HTTP 401 and 403.",
  "baseline": { "model": "model-a", "response": "Authentication failed." },
  "candidate": {
    "model": "model-b",
    "response": "401 means unauthenticated; 403 means access is forbidden."
  },
  "checks": { "requiredPhrases": ["401", "403"] }
}
```

Optional fields include `reportedModel`, `modelVersion`, `contextWindowTokens`, `contextWindowSource`, `inputTokens`, `outputTokens`, `maxOutputTokens`, `finishReason`, and `temperature`. Missing values remain unknown. See [examples/experiment.json](examples/experiment.json) for a sample.

**Exports can contain sensitive prompts and responses.** Check them before committing or sharing. API keys are never included.

## What ships in v0.2

- Two-variant word-level inline diff (large inputs use a coarse replacement fallback).
- Per-side manual entry or opt-in non-streaming Ollama/OpenAI-compatible model runs.
- Deterministic required-phrase checks and descriptive comparability warnings.
- JSON import/export, Markdown reports, standalone CLI and Node built-in tests.
- API keys in VS Code SecretStorage; no account, backend, or hosted telemetry.

**Not included:** third or additional panels, streaming, model discovery, OpenAI Responses API, semantic grading, proven effective context limits, statistical evaluations, or a quality leaderboard. Provider integrations are mock-tested; live-server and interactive VS Code smoke tests remain outstanding.

## Source and documentation

| Path | Purpose |
| --- | --- |
| `src/core.js` | Pure text diff, checks, context warnings, Markdown reports |
| `src/providers.js` | Native Ollama and OpenAI-compatible HTTP adapters |
| `src/extension.js`, `media/` | VS Code Webview, file handling and minimal UI |
| `bin/comparelab.js` | CLI over prepared responses |
| `test/` | Built-in Node tests and mocked provider calls |

- [PLAN.md](PLAN.md) — original baseline, delivered milestones, remaining validation.
- [DECISIONS.md](DECISIONS.md) — architecture and tradeoffs.
- [SHELVED.md](SHELVED.md) — explicitly deferred features.
- [SKILL.md](SKILL.md) — repeatable comparison procedure.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development and contribution guidelines.
- [SECURITY.md](SECURITY.md) — data, credentials, and connection boundaries.
- [.github/REPOSITORY_METADATA.md](.github/REPOSITORY_METADATA.md) — suggested GitHub About text/topics.

Licensed under [MIT](LICENSE). Current version: **0.2.0**.
