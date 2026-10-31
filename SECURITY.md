# Security

CompareLab is a local-first VS Code extension. Manual comparisons and the CLI work without model-network calls. Generation-only actions send prompts to the selected provider without tools. Under **Other actions**, **Review existing responses** sends supplied tasks, evidence, and responses through VS Code's Language Model API after model selection and any required consent. **Open review in Chat** opens an unsent draft; review it before sending. Provider and Copilot policies, usage charges, and retention rules apply.

## Credentials

**Run comparison** starts paired generations and Copilot reviews using the selected comparison mode. The panel previews paired-run and review counts; **Advanced settings** contains the detailed request summary. Citation corrections may add one review request per pair. Frozen-evidence runs share the supplied evidence. End-to-end runs let each model investigate independently using the same selected tools; their evidence and request counts can differ.

Live runs and shared-evidence collection require fresh verification of read-only tools and confirmation for every invocation. Writes, commands, code execution, and shared-state changes are prohibited. Verification is a user declaration, not a sandbox or proof of provider behavior; use trusted providers and read-only server permissions. See [tool selection and safety](docs/guide.md#selecting-vs-code-tools).

VS Code models are discovered through the editor's Language Model API and use the user's existing provider access, consent and policy. CompareLab does not read those credentials. Generation and review require explicit user actions. VS Code models receive instructions as user context, not privileged system messages; provider controls and actual usage are not inferred from token estimates.

- OpenAI-compatible bearer keys are captured through a masked VS Code input and stored in **SecretStorage**, scoped to the normalized endpoint.
- Keys are not included in Webview experiment state, JSON exports, Markdown reports, or code.
- To clear a key, click **Set API key** for that endpoint and submit a blank value.
- Do not put tokens in endpoint URLs, prompts, examples, public issues, or screenshots.

## Data handling

- The extension keeps the working experiment in VS Code Webview state. JSON, Markdown, and HTML exports can contain full prompts, source evidence, model responses, and configuration. Markdown/HTML reports can include evaluator judgments and citations; standalone assessments are not included in ordinary experiment JSON.
- Orchestrated tests also retain original agent text, raw/normalized triggers, exact model-facing requests, all retained pair outputs and judgments, timestamps and metrics in JSON and Markdown. Records are capped at 8 MiB and are not cryptographically authenticated. Review before sharing; input normalization and template insertion do not redact sensitive content.
- Local history retains saved experiments and reviews as unencrypted JSON outside the repository. It is shared across workspaces in the same VS Code profile, not synced by CompareLab. Restoring a record does not run models or grant tool permissions.
- **Load agent file** reads only the selected local text file (up to 150,000 characters). It does not execute the file, follow skill links, or grant tools named in frontmatter.
- No CompareLab-owned hosted backend, user account or telemetry service is included.
- The UI uses `textContent` for dynamic response text and a Webview Content Security Policy.
- Do not run proprietary workloads against an unfamiliar compatible endpoint without approval.
- Copilot review has no tools or chat-history access. Model labels are anonymized, but identities and secrets embedded inside source text are not redacted. Sanitize evidence before evaluation, draft handoff, or export.
- Review prompts mark source content as untrusted data; citation validation recovers exact source substrings with whitespace-only tolerance, not factual correctness. Altered claims, punctuation, numbers, and Markdown are rejected. Prompt injection and misleading model judgments remain possible.
- The Agent-mode chat draft requests read-only investigation, but this text is not a security boundary. Tool access and approvals remain controlled by VS Code/Copilot and the user.

## Connections

- Remote requests require HTTPS; localhost/loopback HTTP is allowed.
- Credentials in URLs, URL query strings/fragments, and HTTP redirects are rejected.
- HTTP provider requests and VS Code generation requests have a **180-second timeout** and a **2 MiB** response limit. These per-request limits are not an overall investigation budget or a limit on retained tool-result text.
- Direct Copilot reviews count complete request messages against the selected model's reported input-token limit, without a fixed character cap or silent evidence truncation. They retain a 180-second evaluation timeout and a 2 MiB streamed-response limit. Reversed-order checking runs two reviews by default, with at most one extra citation correction request across both orders. Request counts include corrections; token counts are estimates, not billed usage.
- The separate **Open review in Chat** draft retains its 150,000-character limit because CompareLab cannot inspect the eventual Chat model. Review the draft before submitting it.
- These constraints are not a complete defense against malicious local services, DNS rebinding, compromised TLS, or untrusted providers. Only configure endpoints you trust.
- Automated tests use mocks; no live security audit or production-provider certification has been completed.

## Vulnerability reporting

Avoid posting security details or sensitive data to public issues. Use the repository's **Report a vulnerability** private advisory feature when available, or an established private maintainer contact channel. Include reproduction steps and sanitized evidence.
