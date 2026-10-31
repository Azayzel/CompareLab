---
name: comparelab
description: Compare AI model responses or prompt variants using controlled baselines, evidence-grounded Copilot assessment, visual text diffs, token/context provenance, deterministic checks, and auditable reports. Use when choosing among model outputs or testing prompt edits.
argument-hint: Supply baseline and candidate tasks/responses, shared source evidence, model identifiers, available run metadata, and acceptance criteria.
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
4. **Run locally or import.** In the VS Code extension, choose **CompareLab: Compare Model Outputs** and paste both responses, or explicitly run **Ollama** / **OpenAI-compatible API** from each panel. Supply the shared task; leave overrides blank when both used it. Empty or whitespace-only overrides use the shared prompt, while meaningful overrides are preserved exactly. Set keys only through VS Code SecretStorage. The standalone CLI accepts existing JSON outputs; it does not invoke models.
5. **Review against evidence.** Supply the frozen source evidence/tool results, then explicitly choose **Review existing responses** and an available evaluator. It reviews grounding, reasoning, completeness, actionability/safety, uncertainty, and clarity, without tools. Reversed-order checking uses the same model for two reviews by default; invalid citations allow one extra correction request total. Whitespace-only differences preserve the original source quote; unsupported quotations still fail validation. Missing evidence or unstable judgments can force abstention; do not force a winner.
6. **Inspect judgments and differences.** Verify the cited passages actually support each rationale; exact-source checks cannot establish semantic correctness. Inspect readable responses and the raw diff for regressions. Required-phrase checks are *smoke tests only*. Use independent reference answers, executable tests, schema checks, and human rubric reviews externally. **Open review in Chat** opens an unsent draft for further investigation; distinguish newly gathered evidence and do not treat the Chat answer as an automatically captured assessment.
7. **Assess comparability.** Flag missing token metadata, different context limits, changed temperatures/output caps, possible truncation or context overrun. Model context maximum is not actual input usage; provider tokenizers, hidden reasoning, system prompts, tools and retrieval can vary. Do not imply equivalence from a status label alone.
8. **Repeat before choosing.** Use **Select model** for both VS Code models and choose **Model / prompt only** with fixed evidence. Set repetitions under **Advanced settings**, then click **Run comparison**. It runs 1-5 sequential pairs with alternating generation order and records one selected evaluator's per-pair judgments. VS Code generation receives instructions as user context and reports token estimates, not actual usage; external providers remain optional. End-to-end mode instead permits independent tool investigations and does not hold discovered evidence constant. Inspect failures, confounders, source quotes and available measurements; default recommendations are not wins. Repeat across representative tasks externally. One task's repetitions cannot rank models or establish statistical significance.
9. **Report and retain caveats.** Export JSON inputs and a Markdown report including identity, exact tasks, evidence, evaluator/version, citations, order verdicts, measurements, and unknowns. Orchestrated records preserve their assessments; standalone assessments remain in memory. Matching exports/imports make no model calls. Avoid publishing secrets, private evidence, and prompts.

## CLI quick start

```sh
node bin/comparelab.js examples/experiment.json --format md
node bin/comparelab.js examples/experiment.json --format json > comparison.json
node --test
```

The comparison JSON may contain full task, evidence, and response text. Use approved/private storage. The UI supports two variants, non-streaming Ollama/compatible-provider runs, and optional Copilot review. Copilot access, consent, policy, and quota apply; direct evaluation is not Agent-mode tool orchestration. The CLI remains offline. No calibrated model leaderboard, provider-limit discovery, or statistical conclusion is supplied.
