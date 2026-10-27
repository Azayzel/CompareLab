---
name: comparelab
description: Compare two AI model responses or two prompt variants using reproducible text diffs, context-budget checks, deterministic assertions, and traceable reports. Use when asked whether a new model or prompt is better, or whether a change affects answer quality.
argument-hint: Provide two prompt/response pairs, requested and resolved model IDs, context-window provenance, actual usage counts, output caps, finish reasons, and required checks.
---

# CompareLab — Controlled AI output comparison

Use the smallest repeatable comparison that addresses the request. Never infer correctness from prose similarity or pronounce a universal model winner from one response.

## Procedure

1. **Define the question.** Is the independent variable the model, prompt, sampling settings, retrieval context, or a mixture? Flag multiple variables as confounders.
2. **Capture the baseline.** Record exact prompt, system instructions if shareable, selected model, provider-reported model/version when available, context-window maximum and its source, actual token usage, output-token cap, finish reason, sampling settings, tool/retrieval configuration, and any relevant environment information. Mark missing fields unknown.
3. **Capture the candidate identically.** Don't guess a model's context window from a product family or name. Different context capacities are not automatically unfair; actual prompt fit, truncation, and effective budget matter. If a provider aliases or updates model IDs, mark that snapshot unverified unless confirmed.
4. **Control confounders.** For model-only comparisons keep the exact prompt, test inputs, expected tool and retrieval access, and evaluation rubric fixed. For prompt-only comparisons keep the model/config fixed. Use multiple representative tasks and repeated paired runs for team-level conclusions.
5. **Diff the content.** Show concise additions, removals, and modified wording. Attribute the exact prompt changes separately. A text delta is not a quality delta.
6. **Run deterministic checks.** Prefer schema validation, exact expected fields, tests, citations to reference evidence, and task-specific acceptance criteria. Apply the same evaluation to both outputs. Optional model-judge results must be labeled subjective and reviewed for bias.
7. **Evaluate comparability.** Explicitly flag unknown context windows, provider-reported token usage gaps, differing output budgets, truncated completions, and evidence of context overflow. Mark comparisons as limited, caution, unverified, or comparable; do not present an absolute fairness guarantee.
8. **Report.** State each variant's model/context metadata and its provenance, differences and checks, uncertainties, and next experiment to isolate causes. Export JSON and a readable Markdown summary. Do not include secrets or proprietary input in public artifacts.

## Local harness

```sh
node bin/comparelab.js examples/experiment.json --format md
node bin/comparelab.js examples/experiment.json --format json > comparison.json
node --test
```

Use the VS Code command **CompareLab: Compare Model Outputs** for the visual inline diff.

## Boundaries

V0.1 processes supplied outputs only. It does not call providers, independently verify context capacities, calculate provider-billed tokens, or score semantic truth. These require external evidence and future opt-in adapters. Do not use these initial checks as CI release gates without an explicit request.
