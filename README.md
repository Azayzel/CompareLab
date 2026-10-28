# CompareLab

**A lightweight VS Code extension for comparing AI model outputs and prompt variants.**

Compare the same prompt on two models, or test a subtle prompt change on one model. CompareLab combines evidence-grounded assessment, readable response views, a Git-style inline diff, and context/usage warnings. **Choose models available in VS Code, paste responses, or optionally run Ollama/OpenAI-compatible endpoints.**

No hosted backend, database, frontend framework, or runtime npm dependencies. Manual comparison remains offline; Copilot evaluation is optional.

## Quick start

Requires **VS Code 1.90+** and **Node.js 20+** for development.

1. Clone this repository and open it in VS Code.
2. Open **Run and Debug**, select **Run CompareLab Extension**, and press **F5** to open a separate **Extension Development Host** window (on macOS, you may need **Fn+F5**).
3. In that **new window**, open the Command Palette (**Cmd+Shift+P** on macOS; **Ctrl+Shift+P** on Windows/Linux) and choose **CompareLab: Compare Model Outputs**. This opens the comparison interface in an editor tab.
4. Enter **Agent instructions / shared prompt** or choose **Load agent file**. Put the original alert or message in **Incoming message / trigger**. Paste two responses to compare them immediately, or enter model IDs.
5. Click **Select model** for Baseline and Candidate to choose from the models available in VS Code. Then use **Run baseline**, **Run candidate**, **Run both**, or **Orchestrate Test**. Existing endpoint providers remain under **Run model (optional)**.
6. Click **Compare text** for readable responses, the inline diff, required-phrase checks, and comparability warnings.
7. Supply **Source evidence / tool results**, then click **Evaluate with Copilot** for a cited assessment, or **Analyze in Copilot Chat** for a new draft you can review and send. Use **Export JSON** to save inputs or **Report** to retain the assessment.

**No CompareLab command or panel?** Opening this repository does not install the extension in your regular VS Code window. Use the separate Extension Development Host window from step 2. CompareLab has no dedicated sidebar or bottom-panel view; its editor tab appears only after running the command.

To vary a prompt, enter a **Prompt override** for either side. After a model run, the override is populated with the exact prompt that was sent. **Clear or change the override before rerunning** if you've edited the shared prompt.

Empty or whitespace-only overrides use the **Shared prompt**; meaningful overrides keep their exact text. If a task is genuinely missing, the error names Baseline, Candidate, or both and asks for a Shared prompt or the corresponding override. Empty source evidence does not cause a missing-task error.

The extension is run from source; it is not yet published to the VS Code Marketplace.

## Orchestrate Test

**VS Code models is the default provider.** The picker discovers models through VS Code's Language Model API, not a hard-coded list. Availability depends on your installed providers, sign-in, consent and organization policy; it can differ from the Chat picker. No endpoint URL or separate CompareLab API key is needed. Select the model again if it becomes unavailable.

1. Load or paste the agent instructions and supply the incoming trigger. Keep differing per-side prompt overrides empty for a controlled model test.
2. Supply **Source evidence / tool results**. This is the same frozen reference material both models will receive, not either model's previous answer.
3. Use **Select model** on each side. Optionally choose Ollama or an OpenAI-compatible endpoint instead; match sampling settings and output budgets for those providers where possible.
4. Set **Paired runs** (1 to 5, default 3), leave **Check reversed order** on, and click **Orchestrate Test**. Choose one available Copilot evaluator.
5. Inspect the task-specific preference, measured latency/token usage, per-pair citations and checks, and **Frozen test input**. Export JSON or a Markdown **Report** to retain the complete record.

Runs are sequential, alternating baseline-first and candidate-first to reduce resource contention and ordering effects. Three pairs make six generation requests and six review requests by default, plus at most three citation corrections. There is no automatic generation retry. Cancellation stops remaining calls and retains a partial record; failed or incomplete pairs never reuse pasted responses. Each model call and each paired review has a 180-second limit. Test records are bounded to 8 MiB; hitting the limit stops further work and labels the unretained result.

VS Code generation records the selected model/vendor/version, request messages, wall-clock duration and estimated input tokens. Actual input/output usage, output caps, temperature and effective context size are not exposed as controlled settings here; they remain unknown rather than guessed. The Language Model API receives the instructions as user context (not a privileged system role) and does not inherit Agent-mode tools or chat history. Exact request roles are retained in the test record. These limits can affect comparisons even when visible inputs match.

Supported preferences require consistent evaluator order checks, grounded substantive criteria, and no contradictory safety/grounding judgment or severe run warning. Default baseline retention is not counted as a win. A strict majority can produce a **task-specific preference** only when every pair completed and recorded configuration warnings do not confound the result. Other outcomes remain inconclusive. Median latency uses pairs where both generations succeeded; missing usage remains unknown, with known subtotals retained. These are repeated samples of **one task**, not statistical significance, a representative benchmark, verified correctness, or a model leaderboard.

Test JSON includes the instructions, trigger, exact requests, frozen evidence, settings, timestamps, responses, measurements, and assessments. Importing a matching test record or exporting a report makes no model calls. Editing its inputs or responses invalidates the attached record. Imported records are user-controlled artifacts, not authenticated execution attestations.

### CodeMind incoming messages

CompareLab recognizes the web-agent input shapes used by CodeMind's `MappedAlertMessage`, `MappedAlertMapper.ToInput`, `DatadogAlertInput`, and `AgentDefinitionRunner`:

- A mapped envelope containing `alertEvent`, `rawEventRef`, and `sendAlert`. Standardized ID/state/severity/time fields take precedence. Monitor query, scope, service, tags, and related fields come from `additionalDetails`.
- A normalized alert object containing `eventId`, `monitorId`, `title`, `body`, `alertStatus`, and the other `DatadogAlertInput` fields. PascalCase keys are also accepted.

For these inputs, YAML frontmatter is removed from the model-facing agent instructions. With direct Ollama/OpenAI-compatible endpoints, instructions become the **system** message and the normalized event becomes a **user** message beginning `Analyze this Datadog alert event:`. VS Code models receive both as user-context messages through its Language Model API. Orchestrate Test adds its no-live-tools policy and frozen evidence. The raw trigger and original agent text remain in the record. Generated response objects containing `Analysis` are rejected as incoming alerts.

This matches the web event contract and message roles, **not the complete production runtime**: it does not reproduce Kafka delivery filters, registry/thread state, trusted-file hashes, backend-added safety instructions, shared report skills, retrieval, live MCP tools, or the mobile investigation-scope builder. Include any required runtime/report instructions in the supplied instructions and retain the actual evidence snapshot. No production system is queried or changed by input normalization.

For other messages, `{{alert}}` or `{{message}}` in the instructions is replaced literally; without those placeholders, the message is appended as a separate section. Other placeholders are left untouched. [examples/orchestrated-codemind.json](examples/orchestrated-codemind.json) is an importable synthetic setup; use **Select model** for each placeholder model and replace the synthetic evidence before a real comparison.

## Evaluate with Copilot

Provide the original task, both responses, and a frozen evidence snapshot: logs, metrics, tool results, reference material, or expected outcomes. Click **Evaluate with Copilot**, then select an available model. Use a current VS Code release with Copilot access; availability depends on sign-in, organization policy, consent, and quota. No separate provider API key is needed for this workflow.

- The overall result is **Recommend Baseline** or **Recommend Candidate**: a practical recommendation, not proof of superiority. The summary requests confidence, decisive differences, tradeoffs, and evidence that could change the choice. Limited evidence produces a provisional, low-confidence recommendation; ties retain the baseline. Individual criteria can still be **Tie** or **Insufficient evidence**.
- The evaluator receives anonymized A/B response labels, their tasks, and supplied evidence, without provider metadata or tools. Identities mentioned inside response text are not automatically redacted.
- **Check reversed order** is enabled by default and runs **two sequential reviews** with the same selected model. Disagreement produces a provisional recommendation to retain the baseline, not a claim that it is better; both judgments and disputed criteria remain visible. Turning it off runs one review and explicitly records that order was not checked. Invalid citations can trigger **one extra correction request total**, so evaluation uses up to three requests (two without order checking). All requests consume Copilot usage and appear in the run details/report.
- Citations must match supplied text, allowing only whitespace differences and retaining the original source passage. Wording, numbers, punctuation, and Markdown must match. This validates quotation provenance, not whether the passage supports the judgment. Missing evidence prevents verification of factual correctness, but does not block a provisional recommendation based on the tasks and responses; no model assessment is verified ground truth.
- Cancel from the panel or progress notification. Reviews enforce a 150,000-character packet limit, the selected model's input-token limit, a 180-second evaluation timeout, and a 2 MiB response limit per request.

If citation correction fails, the error identifies the criterion and source. Try another evaluator or use Chat for manual review; unsupported quotations are never silently accepted. A citation error concerns the evaluator's generated quotation, not necessarily your pasted JSON.

**Analyze in Copilot Chat** opens a fresh Agent-mode draft with the same rubric and source packet. It does not submit, read chat history, or import the resulting answer into the panel. Review the draft before sending. Available Chat tools can investigate further, but any newly gathered facts are separate from the frozen in-panel evaluation. The prompt requests read-only investigation; it is not a tool-permission boundary. Chat handoff depends on VS Code workbench commands and still needs live compatibility verification.

## Assessment and export

Quality assessment comes before readable responses. Triage JSON containing `Analysis` or `Recommendation` is rendered without known envelope metadata such as `EventId`, `AgentDefinition`, and `CompletedAt`; raw responses remain available in the diff and exports. Comparability and recorded latency/token usage are separate from quality.

Changing inputs hides the displayed assessment; changed tasks, triggers, evidence, responses, or order settings cannot reuse it. **Report** reuses a matching assessment without another model request and includes source evidence, evaluator identity/version, citations, order verdicts, and run measurements. **Export JSON** saves experiment inputs and review settings. Standalone assessments are not saved in JSON, but orchestrated-test records include their per-pair assessments. Reports without a matching assessment say **Not evaluated**.

## CodeMind execution-trace imports

Export an authenticated CodeMind run attempt from
`GET /agents/runs/{runId}/attempts/{attempt}/export`, then choose **Import JSON** and
select **Baseline** or **Candidate**. Version 1 `codemind-agent-run` exports import
without running any model or fetching evidence; importing the second attempt preserves
the other variant. Ordinary two-variant experiment JSON remains supported.

Expand **Execution traces and context provenance** to inspect ordered model and tool
events, requested versus session-boundary execution attempts, failures/rejections,
deployment versus reported model, context hashes, and any retained snapshots.
Attempt token totals are available only when all recorded model requests have complete
provider usage and event capture is complete; known partial subtotals are labeled.
Cache and reasoning token counts are subsets, never added to input/output totals.
The ordinary variant token fields describe the last returned model request, not the sum.

CodeMind snapshots are opt-in. Metadata-only runs cannot reconstruct their prompts,
tools or evidence; supply the original task explicitly for evaluation. Redacted,
truncated, unfinished, failed and partial captures display warnings. Hashes identify
original content, not a reconstruction, proof of its truth, or evidence of deployed code.
Imports are untrusted provenance, not authenticated attestations. Never put secrets or
unapproved private data in exports. File imports are bounded to 64 MiB (16 MiB per trace), with up to 512
events and 1,000,000 retained snapshot characters per attempt.

Traces survive comparison normalization, panel persistence, JSON export/import, CLI
comparison output, and Markdown reports. Reports include retained snapshots and must be
stored privately. Editing a variant clears attached execution metadata; running a new
model replaces it. Raw context snapshots are not automatically submitted to Copilot:
evaluation still sends only the visible tasks, evidence, and responses.

Choose **End-to-end agent** when tool selection is part of the evaluation. Choose
**Model / prompt only** only with independently frozen or replayed evidence; recorded
context, tool-definition and tool-result differences are confounders. Trace imports do
not implement replay or prove that live external evidence was controlled.

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

Remote endpoints must use **HTTPS**; HTTP is permitted only for local loopback addresses. Embedded URL credentials, query strings, fragments, and redirects are rejected. **Requests to these endpoints are sent only after clicking Run or Orchestrate Test.** Copilot evaluation uses VS Code's separate Language Model API.

### Run both

Configure providers and model IDs on both sides, then click **Run both**. Runs execute **sequentially**, not concurrently, to reduce resource contention on a shared local GPU. Each successful run updates its response, reported model ID, token usage and finish reason when available. If one side fails, the other is still attempted.

Elapsed duration is recorded in experiment JSON and Markdown reports when available. These sequential wall-clock measurements are not a controlled performance benchmark; missing measurements stay unknown.

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

Optional top-level `evidence` contains the source snapshot and `review.checkOrder` controls reversed-order evaluation in the extension. Variant `elapsedMs` records observed duration. The CLI remains offline and does not generate or restore Copilot assessments.

**Exports can contain sensitive prompts, evidence, and responses.** Check them before committing or sharing. API keys are never included.

## Current capabilities

- Optional cited Copilot evaluation and fresh Copilot Chat draft handoff (unreleased additions).
- VS Code model discovery/generation and controlled repeated **Orchestrate Test**, incoming trigger/agent-file inputs, CodeMind web-alert normalization, and exportable per-pair evidence.
- Verdict-first reports, readable triage responses, order-bias checking, and missing-evidence abstention.
- Two-variant word-level inline diff (large inputs use a coarse replacement fallback).
- Per-side manual entry or opt-in non-streaming Ollama/OpenAI-compatible model runs.
- Deterministic required-phrase checks and descriptive comparability warnings.
- JSON import/export, Markdown reports, standalone CLI and Node built-in tests.
- API keys in VS Code SecretStorage; no account, backend, or hosted telemetry.

**Not included:** additional variants, runner streaming/model discovery, OpenAI Responses API, calibrated scoring, proven effective context limits, statistical evaluations, or a quality leaderboard. Unit/host tests and a synthetic desktop/narrow browser fixture cover the new workflow; live providers, Copilot consent/quotas, and Extension Development Host smoke tests remain outstanding.

## Source and documentation

| Path | Purpose |
| --- | --- |
| `src/core.js` | Review rubric and validation, readable responses, text diff, checks, Markdown reports |
| `src/copilot.js` | Copilot model selection, two-order assessment, cancellation, chat draft handoff |
| `src/providers.js` | Native Ollama and OpenAI-compatible HTTP adapters |
| `src/orchestration.js` | Frozen-input plans, bounded paired runs, measurements and test records |
| `src/inputs.js` | CodeMind incoming-alert normalization and model-facing agent instructions |
| `src/extension.js`, `media/` | VS Code Webview, file handling and minimal UI |
| `bin/comparelab.js` | CLI over prepared responses |
| `test/` | Built-in Node tests, mocked provider/Copilot calls and VS Code host behavior |

- [PLAN.md](PLAN.md) — original baseline, delivered milestones, remaining validation.
- [DECISIONS.md](DECISIONS.md) — architecture and tradeoffs.
- [SHELVED.md](SHELVED.md) — explicitly deferred features.
- [SKILL.md](SKILL.md) — repeatable comparison procedure.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development and contribution guidelines.
- [SECURITY.md](SECURITY.md) — data, credentials, and connection boundaries.
- [.github/REPOSITORY_METADATA.md](.github/REPOSITORY_METADATA.md) — suggested GitHub About text/topics.

Licensed under [MIT](LICENSE). Current version: **0.2.0**.
