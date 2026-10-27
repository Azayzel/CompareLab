# DECISIONS — CompareLab

Architectural choices, assumptions, and the cost of those choices.

| Choice | Why | Consequence |
| --- | --- | --- |
| **VS Code-first** | Compare outputs where engineers already work | No hosted browser product in the initial scope |
| **Two-panel Webview** | Preserves the minimal UI the user preferred | More than two simultaneous variants deferred |
| **Plain JS/CSS; no runtime npm packages** | Small footprint, no framework build step | UI stays deliberately modest |
| **Pure `src/core.js`** | CLI, extension and future automation can share the same semantics | UI/provider concerns kept separate |
| **Native Ollama `/api/chat`** | Local-model use with provider usage/finish metadata | Model IDs must already be known/installed |
| **OpenAI-compatible Chat Completions** | Broad compatibility via simple HTTP | Responses API and some provider-specific features unsupported |
| **Optional `max_completion_tokens` / `max_tokens`** | Accommodates different compatible servers | User must know the selected endpoint's dialect |
| **One user prompt per request** | Deterministic, easy-to-explain starting point | No injected system prompts, tools, retrieval or multimedia |
| **Sequential Run both** | Reduces local GPU contention | Not a concurrent throughput/latency benchmark |
| **Explicit context-window provenance** | Configured maximum does not prove effective input capacity | Unknown capacities and actual usage are surfaced, not guessed |
| **Record provider usage when available** | More faithful than estimated token counts | Tokenizers and hidden reasoning differ across models |
| **SecretStorage keyed by endpoint** | API keys kept outside Webview and exports | Keys are managed separately for distinct URLs |
| **HTTPS for remote, HTTP for loopback** | Avoid inadvertent plaintext transport to remote endpoints | Plain HTTP compatible servers on a LAN are not supported |
| **Reject redirect; bound body/time** | Limit accidental credential forwarding and excessive work | Some proxy architectures and long generations may fail |
| **Deterministic literal phrase checks** | Easy to reproduce and audit | Not semantic accuracy, JSON-schema validation or fact checking |
| **No overall model-quality score** | Avoid unjustified claims from isolated outputs | Teams must choose their rubric and representative samples |
| **JSON and Markdown exports** | Portable, Git-friendly artifacts | Sensitive prompts/responses require review before sharing |
| **Advisory CI, not a release gate** | Passive measurement consistent with original comparison skill | No automated promotion/blocking decisions |

## Current comparability rules

The engine compares both recorded prompts, configured context-window numbers, maximum output tokens, and temperature values; it also checks whether token counts/model identity are available and whether a run reported truncation or apparent context overrun.

A `comparable` status means **only** that these narrow checks identified no known issue and required metadata was supplied. It does not establish independent verification of that data, the same system instructions/tool availability, exact model snapshots, or matching effective context.

Run metadata such as provider IDs may be absent; a user-entered context-window value is not automatically verified. Ollama's entered `num_ctx` is labeled `configured`.

## Security boundaries and limitations

API keys are entered in VS Code and stored in SecretStorage, not in experiment JSON. The editor UI uses a content-security policy and `textContent` for response text. Network execution happens only when a user selects Run. Compatible endpoints are not verified/trusted merely because the URL passes validation.

**Open issues:** live provider and editor smoke tests, proper controlled multi-run experiments, richer quality evidence and additional provider interfaces. For details, see [PLAN.md](PLAN.md), [SECURITY.md](SECURITY.md), and [SHELVED.md](SHELVED.md).
