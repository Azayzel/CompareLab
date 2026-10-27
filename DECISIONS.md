# DECISIONS — CompareLab

| Decision | Reason | Tradeoff |
| --- | --- | --- |
| VS Code extension is primary UX | Lives where developers already work | Standalone web UI deferred |
| Pure JS/CSS Webview | Simple UI, zero runtime packages, no frontend build | Fewer third-party UI widgets |
| Core logic independent of VS Code | Reuse from CLI and future CI/agents | Separate view and engine contracts |
| No backend or database | Minimal footprint, no accounts or server ops | No centralized history |
| Manual response input for v0.1 | No secret handling or provider-specific APIs | Doesn't execute models yet |
| Explicit context provenance | Prevent fabricated model-window metadata | Users must supply unknown metadata |
| Actual token counts separate from context maximum | Maximum capacity is not usage | Depends on upstream run metadata |
| Unknown metadata yields unverified, truncation yields limited | Avoid false certainty | Confidence status is conservative |
| Literal deterministic checks, no universal quality score | Transparent and reproducible | Semantic correctness requires later evaluation |
| Bounded LCS with coarse fallback | Prevent high memory cost on long outputs | Large outputs get less granular diff |
| JSON and Markdown reports | Portable and easily versioned | No hosted reporting portal |

## Security

No credentials required, no third-party scripts, Webview CSP, dynamic result text rendered via `textContent`. Imported JSON is parsed locally. Exports may contain sensitive prompts/responses; users control where they save them. Future model adapters must require opt-in and protect secrets.
