# SHELVED — CompareLab

Deliberately postponed work. Basic evidence-grounded Copilot review, readable triage fields, a Chat draft handoff, and shared-prompt fallback for blank overrides are implemented in the unreleased milestone in [PLAN.md](PLAN.md); the extensions below remain deferred.

## Evaluation

- **Three or more model variants** with a selectable baseline and compact matrix.
- Representative task datasets and analysis of variance/uncertainty beyond the implemented single-task paired repetitions.
- Task-specific schema assertions, source-grounded fact checks and external test execution.
- Judge calibration against reference answers, multiple independent judges and human adjudication.
- Semantic/fuzzy citation matching remains deferred; current matching tolerates only whitespace differences and allows one bounded model correction.
- Reviewer annotations and QuillBot-style accept/reject of individual suggested edits.
- Cost/latency trends and model-family comparisons with normalized measurement definitions.

## Provider compatibility

- External model discovery (Ollama `/api/tags`, compatible provider lists) and preflight validation. VS Code model discovery and availability checks are implemented.
- OpenAI Responses API, additional native providers (Anthropic/Gemini, etc.) and richer request/response types.
- Provider-run streaming output, automatic retry UX, long-term request history and complete parameter provenance. Orchestrated provider calls and Copilot evaluations support cancellation.
- Live end-to-end CodeMind/MCP agent orchestration and exact replay of backend report/runtime instructions, retrieval, mobile scope and tool sessions. Current orchestration uses frozen evidence and plain provider calls.
- Reliable context-capacity discovery and source attribution; tokenizer-specific estimates explicitly labeled estimates.
- Real-provider integration suites gated on explicit credentials and user permission.

## Workflow and distribution

- VS Code Marketplace/Open VSX publishing and packaged VSIX testing.
- Human-reviewed CI/PR summaries; optional release gates only when deliberately configured.
- Team presets, managed sharing with secret/redaction controls, and historical experiment storage.
- Accessible large-diff modes, general structured response comparison and diff performance enhancements beyond the readable triage view.

## Prioritization

**Next priority:** finish live Ollama/compatible-provider, Copilot, and VS Code smoke testing before broadening scope. Keep the two-variant UI and distinguish quality judgments from comparability and efficiency.

Record a promotion from this list in [PLAN.md](PLAN.md) and its rationale in [DECISIONS.md](DECISIONS.md).
