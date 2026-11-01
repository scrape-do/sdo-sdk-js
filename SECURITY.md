# Security Policy

This document describes how to report a vulnerability in **`@scrape-do/sdk`** (the `sdo-sdk-js` repository) and what you can expect from us in return. It is part of the `sdo` open-source project — Scrape.do's official SDK, CLI, and MCP tooling.

`sdo-sdk-js` is licensed under **Apache-2.0** and governed under a Solo+AI model: a single founder is the sole approver, contributions are accepted via DCO sign-off (not a CLA), and the project ships **no telemetry** and **no UI** (CLI, SDKs, and MCP only).

## Reporting a Vulnerability

**Do not open a public GitHub issue, pull request, or discussion for a suspected vulnerability.** Public reports expose users before a fix is available.

Use **either** private channel below — both reach the same maintainer:

1. **GitHub Private Vulnerability Reporting (preferred)**
   Go to the repository's **Security** tab → **Report a vulnerability**. This opens a private advisory (GHSA) draft visible only to you and the maintainers, and keeps the disclosure timeline, fix, and credit in one place.

2. **Email** — **security@scrape.do**
   Encrypt if you can; if you cannot, send a plain report and we will move it into a private GitHub advisory.

Please include as much of the following as you can:

- Affected version(s) of `@scrape-do/sdk` and your Node.js runtime version.
- A clear description of the issue and its security impact.
- A minimal, self-contained reproduction (code snippet or steps). **Redact your `SDO_TOKEN`** and any other credentials from logs, stack traces, and snippets.
- Any known mitigations or workarounds.

You may report anonymously. If you'd like credit in the published advisory, tell us the name/handle to use.

## The Sensitive Asset: Your API Token

The single most sensitive value handled by this SDK is your **Scrape.do API token**, supplied via the **`SDO_TOKEN`** environment variable (token-only auth — there is no other credential type).

How the SDK treats it, and what to keep in mind when filing a report:

- The token is **only** transmitted to the configured Scrape.do API base over HTTPS; the client refuses a plain-http base URL unless its host is loopback or the caller opts in explicitly. Redirects are never followed, so it is sent nowhere else.
- The token is **never logged**, never printed to stdout/stderr, and never written to disk by the SDK. Error objects, debug output, and thrown exceptions must not embed it.
- There is **no telemetry** — the SDK does not phone home or emit usage data to any third party.

Findings that cause the token (or any portion of it) to be logged, serialized into errors, leaked to a non-Scrape.do host, embedded in derived identifiers, or otherwise exposed are treated as **high severity**. Please report these privately and do not attach un-redacted reproductions to public locations.

## Supported Versions

Security fixes are released for the **latest minor** of the current major. Older minors do not receive backported patches; upgrade to the latest minor to stay supported.

| Version | Supported |
| ------- | --------- |
| latest 0.x minor | ✅ |
| older 0.x minors | ❌ |

We follow Semantic Versioning. Security releases are cut as patch versions on the latest supported minor (e.g. `0.2.0` → `0.2.1`).

## Triage SLA

We aim to meet the following timelines from first receipt of a valid report:

| Stage | Target |
| ----- | ------ |
| Acknowledge receipt | within **48 hours** |
| Initial triage & severity assessment | within **5 business days** |
| Status update cadence while open | at least every **7 days** |
| Fix or mitigation for critical/high severity | target within **30 days** of triage |

Severity is assessed using CVSS v3.1. Timelines may extend for complex issues or those requiring coordination with upstream dependencies; we will keep you updated if so.

## Disclosure Process (GHSA → CVE)

We practice coordinated disclosure:

1. We confirm the report privately and work on a fix in a private branch or advisory workspace.
2. We prepare a **GitHub Security Advisory (GHSA)** for the repository.
3. Through the GHSA, we **request a CVE ID** from GitHub (a CNA), so the issue is tracked publicly under a stable identifier.
4. We publish a patched release on the latest supported minor (npm: **`@scrape-do/sdk`**) and update the `SECURITY.md` supported-versions table.
5. We publish the advisory — including the CVE, affected/fixed versions, impact, and reporter credit — once a fix is available or by mutual agreement on a disclosure date.

We ask reporters to keep details private until the advisory is published. We will not pursue legal action against good-faith researchers who follow this policy, avoid privacy violations and service disruption, and give us a reasonable window to remediate before public disclosure.

## Scope

In scope: vulnerabilities in the `@scrape-do/sdk` package source as published from this repository.

Out of scope: issues in the Scrape.do platform/API itself (report those to **security@scrape.do** as well, noting it's a platform issue), vulnerabilities solely in third-party dependencies without a demonstrated impact through this SDK, and findings that require a compromised local environment or a leaked `SDO_TOKEN` obtained outside the SDK.

---

Thank you for helping keep `sdo` and its users safe.
