# DECISIONS — CompareLab

| Decision | Rationale / tradeoff |
| --- | --- |
| VS Code-first extension | Where developers work; no dedicated web app needed |
| Simple two-panel native Webview | Preserves minimal UI, no React build chain |
| Pure shared comparison engine | Reuse in CLI and future automation |
| Native Ollama adapter | Retrieves provider token counts and finish reasons with minimal surface |
| OpenAI-compatible Chat Completions | Widely adopted protocol; Responses API is deferred |
| Sequential Run both | Avoid local GPU contention; trades speed for more stable comparative experiments |
| No automatic context-window guess | Explicit configuration is not proof of actual effective limit |
| Provider-reported counts preserved | Counts can use different tokenizers and include hidden reasoning |
| API keys in endpoint-scoped VS Code SecretStorage | Never store tokens in settings, webviews, source, or experiment exports |
| HTTPS remote and no redirects | Avoid plaintext remote credential leaks and redirect forwarding |
| HTTP loopback allowed | Enables local Ollama and compatible local servers |
| Optional token limit dialect | `max_completion_tokens` for OpenAI or `max_tokens` for compatible APIs |
| Bounded response and timeout | Protect extension host from runaway requests |
| Model running always explicit | No surprising external prompt transmission |
| Deterministic checks, no universal score | Reproducibility over subjective model preference |

## Caveats

Custom OpenAI-compatible endpoints can have different semantics, restrictions, and billing. Only test endpoints you trust. Provider/model aliases are not necessarily pinned snapshots, and context capacity can differ from actual usable input. Live-provider compatibility remains unverified until smoke-tested.
