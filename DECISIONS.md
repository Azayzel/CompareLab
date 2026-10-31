# DECISIONS — CompareLab

Architectural choices, assumptions, and the cost of those choices.

| Choice | Why | Consequence |
| --- | --- | --- |
| **VS Code-first** | Compare outputs where engineers already work | No hosted browser product in the initial scope |
| **Two-panel Webview** | Preserves the minimal UI the user preferred | More than two simultaneous variants deferred |
| **Plain JS/CSS; no runtime npm packages** | Small footprint, no framework build step | UI stays deliberately modest |
| **Shared `src/comparison/core.js`** | CLI, extension and future automation can share the same comparison semantics | Request execution and UI behavior stay outside the engine |
| **Responsibility-based CommonJS modules** | Make comparison, provider, tool, record, metric, and rendering code easy to locate | Explicit imports; no barrel modules, framework, or build-time abstraction |
| **Injected VS Code API** | Test model adapters and panel rendering without an editor host | Only `src/extension.js` imports `vscode`; module dependencies remain acyclic |
| **Native Ollama `/api/chat`** | Local-model use with provider usage/finish metadata | Model IDs must already be known/installed |
| **OpenAI-compatible Chat Completions** | Broad compatibility via simple HTTP | Responses API and some provider-specific features unsupported |
| **Optional `max_completion_tokens` / `max_tokens`** | Accommodates different compatible servers | User must know the selected endpoint's dialect |
| **Explicit model-facing messages** | Generic prompts use one user message; CodeMind events retain system/user roles | No live tools, retrieval or multimedia are added by the runner |
| **Shared prompt when override is blank** | Invisible whitespace must not mask a populated task | Review, runs, reports, and cache identity share resolution; meaningful prompt text is preserved exactly |
| **Sequential Run both** | Reduces local GPU contention | Not a concurrent throughput/latency benchmark |
| **Controlled paired orchestration** | Freeze inputs, alternate generation order, and reuse one evaluator across 1-5 pairs | Measures one task; does not establish statistical significance or universal model superiority |
| **CodeMind web-event normalization** | Mirror `MappedAlertMapper` and the web `AgentDefinitionRunner` message roles | Does not reproduce backend safety/report additions, Kafka filtering, trusted hashes, mobile scope, or live tools |
| **Bounded retained test records** | Export original instructions, trigger, frozen evidence, all retained results and measurements | 8 MiB cap; failures/cancellation remain explicit; imported artifacts are not authenticated attestations |
| **Explicit context-window provenance** | Configured maximum does not prove effective input capacity | Unknown capacities and actual usage are surfaced, not guessed |
| **Record provider usage when available** | More faithful than estimated token counts | Tokenizers and hidden reasoning differ across models |
| **SecretStorage keyed by endpoint** | API keys kept outside Webview and exports | Keys are managed separately for distinct URLs |
| **HTTPS for remote, HTTP for loopback** | Avoid inadvertent plaintext transport to remote endpoints | Plain HTTP compatible servers on a LAN are not supported |
| **Reject redirect; bound body/time** | Limit accidental credential forwarding and excessive work | Some proxy architectures and long generations may fail |
| **Deterministic literal phrase checks** | Easy to reproduce and audit | Not semantic accuracy, JSON-schema validation or fact checking |
| **No overall model-quality score** | Avoid unjustified claims from isolated outputs | Teams must choose their rubric and representative samples |
| **Optional Copilot Language Model API judge** | Uses the user's available Copilot models without another key | Consent, policy and quota apply; no automatic Agent tools or chat history |
| **VS Code model discovery and generation by default** | Reuse installed model providers and existing access for baseline/candidate | Input tokens are estimates; actual usage/settings and a privileged system role are not exposed by this integration |
| **Fixed evidence and six-criterion rubric** | Prioritizes supported claims and safe actions over prose style | No live investigation or independent truth verification during in-panel evaluation |
| **Anonymized labels and reversed-order check** | Reduces identity and position bias | Default doubles requests; agreement does not establish reliability |
| **Source citation validation and abstention** | Accept whitespace-only differences while retaining the source passage; reject altered claims | Valid quotations can still be misinterpreted; human calibration remains necessary |
| **One citation correction request per evaluation** | Recover from model quotation errors without unbounded retries | Extra usage is recorded; persistent failures stop the evaluation, with no relaxed semantic matching |
| **Separate fresh Chat draft** | Allows interactive investigation with available tools | Workbench-command compatibility needs testing; no automatic submission or answer capture |
| **Assessment bound to source inputs** | Prevent stale results from being attributed to changed evidence/responses | Assessment lives in memory; JSON import does not restore it, Markdown preserves findings |
| **JSON and Markdown exports** | Portable, Git-friendly artifacts | Sensitive prompts/responses require review before sharing |
| **Advisory CI, not a release gate** | Passive measurement consistent with original comparison skill | No automated promotion/blocking decisions |

## Current comparability rules

The engine compares both recorded prompts, configured context-window numbers, maximum output tokens, and temperature values; it also checks whether token counts/model identity are available and whether a run reported truncation or apparent context overrun.

A `comparable` status means **only** that these narrow checks identified no known issue and required metadata was supplied. It does not establish independent verification of that data, the same system instructions/tool availability, exact model snapshots, or matching effective context.

Run metadata such as provider IDs may be absent; a user-entered context-window value is not automatically verified. Ollama's entered `num_ctx` is labeled `configured`.

## Security boundaries and limitations

API keys are entered in VS Code and stored in SecretStorage, not in experiment JSON. The editor UI uses a content-security policy and `textContent` for response text. Provider requests require Run or Orchestrate Test; Copilot requests require explicit evaluation or orchestration. Chat handoff creates an unsent draft. Compatible endpoints are not verified/trusted merely because the URL passes validation.

The review prompt marks all supplied content as untrusted data. This is not a complete prompt-injection defense. In-panel evaluation exposes no tools; the separate Agent-mode draft requests read-only investigation but does not enforce tool permissions. Model identities can remain inside supplied prose despite anonymized labels.

**Open issues:** live provider/Copilot/editor smoke tests, controlled multi-run experiments, judge calibration and additional provider interfaces. 
