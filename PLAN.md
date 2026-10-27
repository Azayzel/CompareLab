# PLAN — CompareLab

## Original request / baseline

Make it easy to visualize the outputs of two or more AI models given the same prompt, or subtle prompt changes to a single model. Combine Git-style diffs and QuillBot-style readable changes. Help teams evaluate which responses work better using controlled, reproducible comparisons rather than superficial text changes. The Docker image Web Vitals comparison skill is the methodological starting point.

## Constraints and decisions

- Keep the original simple two-panel UI; no dashboard.
- VS Code extension first, shared comparison engine and CLI alongside it.
- Local-first with no third-party runtime packages, database, or permanent service.
- Capture provider-reported usage and model identity; don't invent a model's context window.

## V0.1 completed

- [x] VS Code side-by-side entry and inline word diff
- [x] Context/usage metadata and comparison-confidence warnings
- [x] Deterministic required phrase checks
- [x] JSON import/export and Markdown report
- [x] Reusable pure JavaScript engine and CLI

## V0.2 — opt-in provider execution

- [x] Native Ollama /api/chat with explicit num_ctx, num_predict, temperature
- [x] OpenAI-compatible /chat/completions with selectable output-token field
- [x] Endpoint-scoped API keys in VS Code SecretStorage
- [x] HTTP localhost or HTTPS remote, no redirects, bounded responses, request timeout
- [x] Per-variant Run and sequential Run both
- [x] Normalize requested/resolved model, usage, finish reason and actual prompt
- [x] Mocked request/error/security tests
- [ ] Verify with live Ollama and live OpenAI-compatible servers
- [ ] Verify UX in an actual VS Code Extension Development Host

## Next

- Build a small opt-in real-provider smoke-test matrix.
- Optional model discovery, provider presets, repeated trials, multi-variant experiment matrix.
- Add semantic/task-specific evaluations with evidence and human review before automated scoring.
- Keep CI checks advisory unless a user explicitly requests gating.
