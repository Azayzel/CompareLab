# SHELVED — CompareLab

Deliberately postponed work. None of these features should be described as shipping in v0.2.

## Evaluation

- **Three or more model variants** with a selectable baseline and compact matrix.
- Representative task datasets, paired repeated runs and analysis of variance/uncertainty.
- Task-specific schema assertions, source-grounded fact checks and external test execution.
- Optional semantic/LLM-as-judge evaluation with evidence, calibration and human adjudication.
- Reviewer annotations and QuillBot-style accept/reject of individual suggested edits.
- Cost/latency trends and model-family comparisons with normalized measurement definitions.

## Provider compatibility

- Model discovery (Ollama `/api/tags`, compatible provider lists) and preflight validation.
- OpenAI Responses API, additional native providers (Anthropic/Gemini, etc.) and richer request/response types.
- Streaming output, cancel/retry UX, request history and complete parameter provenance.
- Reliable context-capacity discovery and source attribution; tokenizer-specific estimates explicitly labeled estimates.
- Real-provider integration suites gated on explicit credentials and user permission.

## Workflow and distribution

- VS Code Marketplace/Open VSX publishing and packaged VSIX testing.
- Human-reviewed CI/PR summaries; optional release gates only when deliberately configured.
- Team presets, managed sharing with secret/redaction controls, and historical experiment storage.
- Accessible large-diff modes, structured response comparison and diff performance enhancements.

## Prioritization

**Next priority:** finish live Ollama/compatible-provider and VS Code smoke testing before broadening scope. Any added UI should preserve the minimal baseline/candidate/diff layout.

Record a promotion from this list in [PLAN.md](PLAN.md) and its rationale in [DECISIONS.md](DECISIONS.md).
