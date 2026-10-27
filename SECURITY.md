# Security

CompareLab is a local-first VS Code extension. Manual comparisons and the CLI work without model-network calls. **Only clicking Run or Run both sends a prompt to the selected model endpoint.** Remote provider services may log prompts, charge for usage, or apply their own retention policies.

## Credentials

- OpenAI-compatible bearer keys are captured through a masked VS Code input and stored in **SecretStorage**, scoped to the normalized endpoint.
- Keys are not included in Webview experiment state, JSON exports, Markdown reports, or code.
- To clear a key, click **Set API key** for that endpoint and submit a blank value.
- Do not put tokens in endpoint URLs, prompts, examples, public issues, or screenshots.

## Data handling

- The extension keeps the working experiment in VS Code Webview state; exported JSON/Markdown may contain full prompts, model responses and configuration.
- No CompareLab-owned hosted backend, user account or telemetry service is included.
- The UI uses `textContent` for dynamic response text and a Webview Content Security Policy.
- Do not run proprietary workloads against an unfamiliar compatible endpoint without approval.

## Connections

- Remote requests require HTTPS; localhost/loopback HTTP is allowed.
- Credentials in URLs, URL query strings/fragments, and HTTP redirects are rejected.
- Requests have a **180-second timeout** and response bodies are limited to **2 MiB**.
- These constraints are not a complete defense against malicious local services, DNS rebinding, compromised TLS, or untrusted providers. Only configure endpoints you trust.
- Automated tests use mocks; no live security audit or production-provider certification has been completed.

## Vulnerability reporting

Avoid posting security details or sensitive data to public issues. Use the repository's **Report a vulnerability** private advisory feature when available, or an established private maintainer contact channel. Include reproduction steps and sanitized evidence.
