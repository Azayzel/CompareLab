---
name: comparelab
description: Compare two model outputs or prompt variants with reproducible text diffs, provider-run metadata, controlled context budgets, deterministic checks, and traceable reports. Optional local Ollama and OpenAI-compatible execution in VS Code.
argument-hint: Give baseline/candidate prompt, model IDs, outputs or provider endpoints, context provenance, token usage and criteria.
---

# CompareLab — controlled model and prompt comparison

## Use cases

- Compare two models with the *same* prompt and task fixtures.
- Compare prompt edits on the *same* model/snapshot.
- Review output changes without mistaking changed wording for improved quality.

## Procedure

1. Define the independent variable (model, prompt, settings, or retrieval) and keep all other constraints stable.
2. Record model ID and resolved snapshot when available; preserve exact prompt, output, runtime parameters, tool/retrieval state, usage counters, finish reason, output token cap and context limit provenance.
3. Use local VS Code CompareLab to paste outputs or explicitly invoke Ollama/OpenAI-compatible models. Only invoke trusted endpoints and never export keys.
4. Run the same deterministic checks for each result (e.g., schema validation, required facts/phrases, unit tests or expected fields). The built-in phrase checker is only a shallow deterministic starting point.
5. Review inline added/removed text alongside context fairness warnings. Unknown effective context, differing token caps, or truncation can make attribution weak.
6. Export JSON or Markdown and state limitations, confounders and next isolating experiment. Do not claim a universal model winner from a single run.
7. Repeat on representative tasks and multiple seeds/runs before team policy decisions.

## CLI for prepared results

```sh
node bin/comparelab.js examples/experiment.json --format md
node --test
```

The CLI compares supplied responses. Live provider execution is available only in the VS Code extension for v0.2. Ollama uses native /api/chat; the OpenAI-compatible adapter uses /chat/completions, not Responses API.

## Reporting cautions

Configured `num_ctx` is not a verified effective prompt length. Even on the same nominal context size, provider tokenization, hidden instructions, reasoning tokens, retrieval, tool use and response caps can differ. The JSON may contain proprietary prompts/responses: keep reports in ignored or approved locations and never store secrets.
