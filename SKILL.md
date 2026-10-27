---
name: comparelab
description: Compare AI model responses or prompt variants using controlled baselines, visual text diffs, token/context provenance, deterministic checks, and auditable reports. Use when choosing among model outputs or testing prompt edits.
argument-hint: Supply a baseline and candidate prompt/response pair (or selected VS Code model providers), model identifiers, available run metadata, and acceptance criteria.
---

# CompareLab — Model and prompt output comparison

Compare responses with the controlled-experiment discipline of a performance regression test. **A text diff is not a correctness measurement or a model leaderboard.**

## When to use

- Compare two models against the same task/prompt to choose a candidate for further evaluation.
- Test a small prompt edit against a stable model.
- Inspect response changes following a model or sampling-parameter upgrade.
- Rerun a prior comparison with better controls, new representative tasks or more samples.

## Procedure

1. **Frame the hypothesis.** Identify the independent variable: model, prompt, model settings, or retrieval configuration. Name the acceptance criteria before looking at the answers.
2. **Capture the baseline.** Preserve the exact prompt, model ID, resolved provider model/snapshot (if reported), settings, context-window maximum **with its source**, actual input/output tokens, maximum output tokens, finish reason, and response. Document unrecorded system instructions, tools, retrieval, or hidden inputs as unknown.
3. **Capture the candidate with the same fields.** For model-only comparisons keep prompt, fixtures, retrieval/tool access, and evaluation criteria constant to the extent possible. For prompt-only comparisons keep model/snapshot/configuration constant. Flag changes to multiple factors as confounders.
4. **Run locally or import.** In the VS Code extension, choose **CompareLab: Compare Model Outputs** and paste both responses, or explicitly run **Ollama** / **OpenAI-compatible API** from each panel. Set keys only through VS Code SecretStorage. The standalone CLI accepts existing JSON outputs; it does not invoke models.
5. **Diff outputs.** Inspect inline deletions/additions. Record substantive differences with examples, not just longer/shorter wording. Keep prompt deltas separate from model deltas.
6. **Apply the same checks.** Built-in case-insensitive required-phrase checks are reproducible *smoke tests only*. For real team choices, add independently verified reference answers, executable code tests, schema checks, and human rubric reviews externally.
7. **Assess comparability.** Flag missing token metadata, different context limits, changed temperatures/output caps, possible truncation or context overrun. Model context maximum is not actual input usage; provider tokenizers, hidden reasoning, system prompts, tools and retrieval can vary. Do not imply equivalence from a status label alone.
8. **Repeat before choosing.** Use representative prompts and paired repeated runs to check robustness. A single sample cannot rank models, show statistical significance, or prove a prompt improvement.
9. **Report and retain caveats.** Export JSON plus a concise Markdown report including baseline/candidate identity, exact prompts, findings, deterministic checks, unknowns, and next experiments. Avoid publishing secrets and private prompts.

## CLI quick start

```sh
node bin/comparelab.js examples/experiment.json --format md
node bin/comparelab.js examples/experiment.json --format json > comparison.json
node --test
```

The comparison JSON may contain full prompt and response text. Use approved/private storage. v0.2 supports two variants, non-streaming native Ollama chat and OpenAI-compatible Chat Completions through the VS Code UI; it does not fetch provider limits, measure live Core Web Vitals, or implement a semantic judge.
