# PLAN — CompareLab

## Original request (baseline)

Build a visual way to compare outputs from two or more AI models given the same prompt, and to evaluate subtle changes to prompts on the same model. Combine **Git diff** with QuillBot-like readable edit highlighting so a team can see what changed and judge what works best.

Take inspiration from the user's Docker-image Web Vitals skill: capture an explicit baseline and candidate, control variables, record real measurements with provenance, surface confounders and incomplete runs, and publish reproducible results. Don't assume different wording implies a better answer.

## Product constraints

- **VS Code first**, with a reusable core and optional CLI; avoid a separate web application for the initial product.
- Preserve the **simple two-panel UI**; no dashboards, database, authentication service, or third-party runtime packages.
- Make every model request **opt-in**. Keep API keys out of export files and Webview state.
- Treat model context-window claims as **provenance-bearing metadata**, not a guessed constant.
- Never declare a universal winner from a single text diff.

## Shipped: v0.1

- [x] VS Code Webview: baseline, candidate, simple inline word-level diff.
- [x] Separate shared prompt and per-variant overrides.
- [x] Manual pasted responses, JSON import/export, Markdown report.
- [x] Literal required-phrase checks and context/usage comparison warnings.
- [x] Dependency-free `src/core.js` and standalone comparison CLI.
- [x] Initial Node built-in tests and CI.

## Shipped: v0.2

- [x] Opt-in **native Ollama** `/api/chat` runner.
- [x] Opt-in **OpenAI-compatible** `/chat/completions` runner with two output-budget field options.
- [x] Per-side **Run** and sequential **Run both**.
- [x] Exact run prompt, response, returned model identifier, usage counters, and finish reason where supported.
- [x] Optional Ollama `num_ctx`, `num_predict`, and temperature; provider defaults remain unknown when omitted.
- [x] Endpoint-scoped bearer keys via VS Code SecretStorage; no keys in exports.
- [x] HTTPS remote / HTTP loopback only, no redirects, bounded responses, request timeout.
- [x] Mocked tests for successful responses, compatibility fields, missing usage, validation and error paths.
- [x] CI Node tests and syntax checks for extension/Webview files.
- [x] Updated README, security, contribution and reusable comparison procedure.

## Validation status

- [x] GitHub Actions **unit/syntax checks** have passed for v0.2 code.
- [ ] Live Ollama integration smoke test against an installed local model.
- [ ] Live OpenAI/compatible endpoint smoke test (requires user-authorized key/endpoint).
- [ ] Manual interaction/accessibility test in VS Code Extension Development Host.
- [ ] VSIX packaging and installation smoke test.

Do not represent mock-backed tests as live provider verification.

## Next milestones

1. Finish the live/interactive validation above and fix any compatibility defects.
2. Support repeatable task suites and multiple paired samples before offering a team-level decision.
3. Introduce optional provider/model discovery, robust recording of run settings and evidence-based checks.
4. Evaluate adding a third+ variant and semantic/human scoring without compromising UI simplicity.

Future ideas and intentionally deferred scope remain in [SHELVED.md](SHELVED.md). See [DECISIONS.md](DECISIONS.md) for rationale.
