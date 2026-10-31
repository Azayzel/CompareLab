# DECISIONS — CompareLab

Architectural choices, assumptions, and the cost of those choices.

See [module ownership](CONTRIBUTING.md#code-boundaries) for the source layout and the [user guide](docs/guide.md) for operating details.

| Choice | Why | Consequence |
| --- | --- | --- |
| **VS Code-first** | Compare outputs where engineers already work | No hosted browser product in the initial scope |
| **Separate model and prompt workflows** | Make the comparison intent explicit | Each tab retains its own draft; comparisons still have two variants |
| **One primary action per workflow** | Avoid competing generation and evaluation buttons | Run comparison and Review prompt change generate and review; advanced settings and standalone actions remain secondary |
| **Plain JS/CSS; no runtime npm packages** | Small footprint, no framework build step | UI stays deliberately modest |
| **Shared `src/comparison/core.js`** | CLI, extension and future automation can share the same comparison semantics | Request execution and UI behavior stay outside the engine |
| **Responsibility-based CommonJS modules** | Make comparison, provider, tool, record, metric, and rendering code easy to locate | Explicit imports; no barrel modules, framework, or build-time abstraction |
| **Injected VS Code API** | Test model adapters and panel rendering without an editor host | Only `src/extension.js` imports `vscode`; module dependencies remain acyclic |
| **Native Ollama `/api/chat`** | Local-model use with provider usage/finish metadata | Model IDs must already be known/installed |
| **OpenAI-compatible Chat Completions** | Broad compatibility via simple HTTP | Responses API and some provider-specific features unsupported |
| **Optional `max_completion_tokens` / `max_tokens`** | Accommodates different compatible servers | User must know the selected endpoint's dialect |
| **Explicit model-facing messages** | Preserve task and incoming-event context across providers | HTTP providers support system/user roles; VS Code receives instructions as user context, not a privileged system message |
| **Shared prompt when override is blank** | Invisible whitespace must not mask a populated task | Review, runs, reports, and cache identity share resolution; meaningful prompt text is preserved exactly |
| **Sequential generation** | Reduces local GPU contention | Generate both (no tools) skips tools and review; timing is not a concurrent throughput benchmark |
| **Controlled paired orchestration** | Snapshot configuration, alternate generation order, and reuse one evaluator across 1-5 pairs | Live investigations can gather different evidence; repetitions of one task are not a representative benchmark |
| **Native VS Code tool discovery** | Reuse configured MCP and extension tools without a vendor allowlist or separate client | Chat selections are not inherited; provider setup and authentication remain in VS Code |
| **Fresh read-only verification and per-call approval** | Keep tool availability separate from permission to invoke it | Unmarked tools are excluded; saved selections grant no approval; declarations are not sandboxing |
| **Frozen evidence for prompt edits by default** | Separate instruction effects from differences in discovered evidence | Collect once or reuse supplied evidence, then run both prompts without live tools; results remain untrusted data |
| **No artificial investigation budget** | Let agents gather the evidence needed for the task | Provider limits, per-request timeouts, record-size limits, and cancellation still apply; call counts and costs can vary |
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
| **Assessment bound to source inputs** | Prevent stale results from being attributed to changed evidence/responses | Edits invalidate attached results; history retains saved reviews and orchestrated JSON retains per-pair assessments |
| **Local history and portable exports** | Reopen comparisons without rerunning models; share JSON, Markdown, or self-contained HTML | History is unencrypted; prompts, responses, and tool evidence require review before sharing |
| **Build/test-gated releases on main** | Publish a tested VSIX after each merge without version-bump commits | Release tags allocate patch versions; failed publishing leaves a resumable draft; AI comparison verdicts remain advisory |
| **Marketplace trusted publishing** | Avoid long-lived publishing credentials | Requires an OIDC trust policy bound to the repository, release workflow, and main-only GitHub environment |
| **Sidebar launcher and shared artwork** | Make CompareLab discoverable without squeezing reports into a sidebar | Activity Bar uses the SVG; Marketplace uses a PNG export; both launch paths use the existing editor command |

## Current comparability rules

The engine compares both recorded prompts, configured context-window numbers, maximum output tokens, and temperature values; it also checks whether token counts/model identity are available and whether a run reported truncation or apparent context overrun.

A `comparable` status means **only** that these narrow checks identified no known issue and required metadata was supplied. It does not establish independent verification of that data, the same system instructions/tool availability, exact model snapshots, or matching effective context.

Run metadata such as provider IDs may be absent; a user-entered context-window value is not automatically verified. Ollama's entered `num_ctx` is labeled `configured`.

## Security boundaries and limitations

API keys are entered in VS Code and stored in SecretStorage, not in experiment JSON. The editor UI uses a content-security policy and `textContent` for response text. Model calls require explicit generation, comparison, review, or draft-generation actions. Chat handoff creates an unsent draft. Compatible endpoints are not verified/trusted merely because the URL passes validation.

Live investigations and evidence collection use only tools freshly marked read-only for that test, with confirmation for every invocation. Writes, commands, code execution, and shared-state changes are prohibited. This is a user declaration and approval boundary, not proof of provider behavior or isolation. Use trusted tools and read-only server permissions; cancellation cannot undo side effects. Imports and history never restore permission to run tools.

The review prompt marks all supplied content as untrusted data. This is not a complete prompt-injection defense. In-panel evaluation exposes no tools; the separate Agent-mode draft requests read-only investigation but does not enforce tool permissions. Model identities can remain inside supplied prose despite anonymized labels.

**Validation:** automated tests cover module boundaries, mocked provider and tool calls, cancellation, record compatibility, and UI behavior. Architecture checks reject unresolved imports, dependency cycles, and direct VS Code bindings outside the entry point. These checks do not certify live provider or editor integration.

**Open issues:** live provider/Copilot/editor smoke tests, representative multi-task experiments, judge calibration, and additional provider interfaces.
