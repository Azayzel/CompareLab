# PLAN — CompareLab

## Original request / baseline

Build a visual comparison tool for identical prompts across two or more AI models, and for subtle prompt variations on one model. Combine a Git-style diff with QuillBot-style readable highlights. Identify which outputs work better for a team using evidence rather than superficial text similarity. Reuse the controlled-comparison discipline from the provided Docker image Web Vitals skill.

## Subsequent constraints

- Project name: **CompareLab**.
- Repository: https://github.com/Azayzel/CompareLab.
- Capture model identity and actual/available context-window information so differently constrained runs are not silently judged as equivalent.
- **Keep it lightweight**, and preserve the simple two-panel UI.
- VS Code first; reusable engine and CLI under it, not a dedicated web application.

## V0.1 acceptance criteria

- [x] VS Code command opens a self-contained comparison view.
- [x] Two outputs with baseline/candidate prompt overrides.
- [x] Inline additions/removals and word counts.
- [x] Model, snapshot, context max, source, token usage, output cap, finish reason, sampling metadata.
- [x] Explicit unverified/caution/limited context comparison confidence.
- [x] Deterministic required phrase checks.
- [x] Local JSON input/output and Markdown report.
- [x] Shared dependency-free engine, CLI, automated test source.
- [ ] Validate extension interactively in VS Code and run full CI.

## Later phases

1. Provider adapters (OpenAI-compatible API and local Ollama) with opt-in network calls, redacted secrets, and full usage provenance.
2. Prompt/model datasets, multiple candidates, repeated controlled samples, and paired win/regression analysis.
3. Optional semantic reviews with referenced evidence, human accept/reject change workflows.
4. Optional CI integration (never block release by default) and team sharing.

## Operating principles

Never auto-fetch or guess a model context window. Don't equate a text diff, a model-judge impression, or a context-window maximum with proven answer quality. Keep imported content local unless a future provider integration is explicitly invoked.
