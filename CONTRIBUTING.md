<!-- SPDX-License-Identifier: Apache-2.0 -->
# Contributing to sdo-sdk-js

Thanks for helping build the official Scrape.do JavaScript/TypeScript SDK (`@scrape-do/sdo-client`). This document covers how to set up your environment, the test-first workflow we follow, and the rules every change must satisfy before it can be merged.

## Project at a glance

- **Package:** `@scrape-do/sdo-client` on npm
- **Runtime:** Node.js 22.23.4, 24.22.1 or 26.12.1 or newer (ESM + CJS), for users and development alike. Earlier releases have an out-of-bounds write in the bundled Brotli decoder (CVE-2026-111497), reachable through the SDK's `br` decompression of a target's response. Node.js 20 reached end of life in April 2026 and is not supported
- **Language:** TypeScript, type-checked with `tsc`, bundled with `tsup`
- **Tests:** [Vitest](https://vitest.dev/)
- **License:** Apache-2.0
- **Auth:** token-only: the `token` option or the `SDO_TOKEN` environment variable
- **No telemetry. No UI.** This is an SDK; it never phones home and ships no dashboard.

The request parameters, defaults and observable behaviour are shared by all sdo SDKs and pinned by the conformance corpus (`conformance.json`), which Scrape.do maintains against https://scrape.do/documentation. Propose a change in an issue first; a change to a parameter lands in every SDK together. See [The conformance corpus](#the-conformance-corpus).

## Governance

`sdo` uses **Solo + AI** governance: the founder is the sole approver and final reviewer of every change. That means:

- All discussion happens in the open on GitHub issues and pull requests.
- A maintainer (currently the founder) reviews and merges. AI assistance is used throughout, but a human gives the final approval.
- We use **DCO sign-off, not a CLA**. By signing off you certify the [Developer Certificate of Origin](https://developercertificate.org/). See [Sign-off (DCO)](#sign-off-dco).

Be patient with review latency, and keep PRs small and self-contained so they are quick to reason about.

## Development setup

You need Node.js 22.23.4, 24.22.1 or 26.12.1 or newer, and npm.

```bash
git clone https://github.com/scrape-do/sdo-sdk-js
cd sdo-sdk-js
npm install
```

Verify your checkout is healthy before you change anything:

```bash
npm test               # vitest — full unit + conformance suite
npm run typecheck      # tsc --noEmit
npm run build          # tsup — ESM + CJS + .d.ts in dist/
npm run check:dist     # the built package: nothing vendored, ESM/CJS/types all load
npm run lint           # biome ci — formatting, lint rules and import order
```

All five must pass on a clean clone. If they don't, open an issue before doing anything else.

### Useful commands

| Command | What it does |
| --- | --- |
| `npm test` | Run the full Vitest suite once |
| `npm test -- --watch` | Re-run tests on file changes while you work |
| `npm test -- path/to/file.test.ts` | Run a single test file |
| `npx tsc --noEmit` | Type-check the whole project, emit nothing |
| `npm run build` | Bundle to `dist/` with tsup |
| `npm run test:cov` | Tests with the coverage floor (99% lines, branches, functions, statements) |
| `npm run check:dist` | Check the built package (run after `npm run build`) |
| `npm run api:surface` | Regenerate `api-surface.txt`, the public API golden CI diffs against |
| `npm run lint` | Check formatting, lint rules and import order with Biome (`biome ci .`) |
| `npm run format` | Apply Biome's formatting, import order and safe lint fixes |

## Test-driven development

This SDK is **TDD-first**. The expected loop for any behavioral change is:

1. **Write a failing test** that describes the behavior you want. Run `npm test` and watch it fail for the right reason.
2. **Write the minimum code** to make it pass.
3. **Refactor** with the test green.
4. **Type-check** with `npx tsc --noEmit`.

Pull requests that add or change behavior without a corresponding test will be asked to add one. Tests live in `test/` as `*.test.ts` and run under Vitest. Prefer small, focused tests that assert one thing.

Network calls never leave the machine. Use an injected `fetchImpl` (see `test/helpers.ts`) for logic above the HTTP layer, and a throwaway server on `127.0.0.1` (`test/server.ts`) for anything the default `node:http` transport does: framing, retries, decompression, timeouts. `test/setup.ts` refuses any socket that does not connect to the loopback interface and clears every `SDO_*` variable, so the suite behaves the same whatever your shell holds. A test that needs a live `SDO_TOKEN` or a real host is not a unit test and won't be accepted.

`README.md` samples run in `test/readme.test.ts`; keep them runnable. The CJK decoding tables in `src/cjk-index.ts` are generated from the WHATWG index files by `tools/gen-cjk-index.mjs` (its header says how to fetch the files and regenerate); never edit the generated module by hand.

## The conformance corpus

The Go, JavaScript and Python SDKs are kept in lockstep by a cross-language **conformance corpus** that all of them are tested against. In this repo that corpus is checked in as:

```
test/conformance.json
```

`conformance.json` is maintained by Scrape.do and shared by the Go, JavaScript and Python SDKs; its sha256 sidecar is checked by the tests. **Do not edit it in a contribution; describe the change in an issue.** The conformance tests read this file and assert that the SDK's request building, parameter encoding, and response parsing match the expectations for every fixture.

Consequences for contributors:

- **Bug fix / internal refactor that keeps the surface identical:** fine — add your test, fix the code, done. The conformance suite should still pass untouched.
- **A change that alters public surface** (a new parameter, a renamed field, a different default, a new error shape): open an issue describing the change first. Scrape.do updates `conformance.json` against https://scrape.do/documentation, and a change to a parameter lands in every SDK together; the JS implementation is then updated to satisfy the corpus. Do not race ahead in JS alone — divergence across SDKs is the one thing this process exists to prevent.

If a conformance test fails after you pull `main`, the corpus moved under you: update the implementation to match the corpus, not the corpus to match your code.

## Coding standards

- **TypeScript, strict.** No `any` escapes for convenience; model the real types. The build must pass `npx tsc --noEmit` with zero errors.
- **Token-only auth.** The only credential is the token: the `token` option or the `SDO_TOKEN` environment variable. Never add alternative auth schemes, config files that store secrets, or interactive prompts.
- **No telemetry, ever.** Don't add analytics, crash reporting, "anonymous usage stats," update checks, or any outbound call that isn't a scrape request the user explicitly made.
- **No UI.** This package is a library. No CLI entry point, no web server, no dashboard. (The `sdo` CLI lives in [sdo-cli](https://github.com/scrape-do/sdo-cli); the MCP server is [sdo-mcp](https://github.com/scrape-do/sdo-mcp), and the same server also ships inside the CLI as `sdo mcp serve`.)
- **Keep dependencies lean.** New runtime dependencies need a justification in the PR. We favor Node's built-in modules (`node:http`, `node:https`, `node:zlib`, `URL`, `AbortController`) over packages: the default transport is `node:http` / `node:https`, and `fetch` is used only when a caller passes `fetchImpl`.
- **Biome formats and lints.** `npm run lint` checks formatting, Biome's recommended lint rules and import order; `npm run format` applies them. The configuration is `biome.json` (2-space indent, 100 columns; Markdown and YAML are not formatted). `noNonNullAssertion` is off because `tsconfig.json` sets `noUncheckedIndexedAccess`: a `!` after an index the code has just checked is the idiom. Don't loosen a rule to get a PR through: fix the code, or justify a `biome-ignore` comment on the line. Don't sneak in drive-by refactors; keep the diff scoped to the change.

## Commit messages — Conventional Commits

We use [Conventional Commits](https://www.conventionalcommits.org/). The format is:

```
<type>(<optional scope>): <description>
```

Common types:

- `feat:` — a user-facing capability (propose it in an issue first)
- `fix:` — a bug fix
- `test:` — adding or correcting tests
- `refactor:` — internal change with no surface impact
- `docs:` — documentation only
- `build:` / `chore:` — tooling, deps, build config
- `ci:` — CI configuration

Examples:

```
fix(transport): retry on 429 with Retry-After honored
test(conformance): cover render=true fixtures
docs: clarify SDO_TOKEN setup in README
```

A breaking change is marked with `!` after the type (`feat!:`) and a `BREAKING CHANGE:` footer. Breaking changes to the public surface are proposed in an issue first and described in MIGRATING.md.

## Sign-off (DCO)

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/). We use **DCO, not a CLA** — there is no separate agreement to sign. Sign-off is a single trailer line added automatically by `-s`:

```bash
git commit -s -m "fix(transport): honor Retry-After on 429"
```

This appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use your real name and a reachable email. CI checks every commit's subject and sign-off, and the pull request title, which becomes the squash commit's subject (`commits` job); a pull request fails until they are fixed. To sign off a commit you already made:

```bash
git commit --amend -s --no-edit
```

For a multi-commit branch, rebase with `git rebase --signoff <base>`.

## Pull request checklist

Before you open a PR, confirm:

- [ ] A test was added or updated and it fails without your change (TDD).
- [ ] `npm test` passes — including the conformance suite.
- [ ] `npx tsc --noEmit` passes with no errors.
- [ ] `npm run build` succeeds.
- [ ] `npm run lint` passes.
- [ ] `test/conformance.json` was **not** edited.
- [ ] If the public surface changed, `api-surface.txt` was regenerated (`npm run api:surface`) and the change is noted in CHANGELOG.md.
- [ ] No telemetry, no UI, no new auth scheme was introduced.
- [ ] Commits follow Conventional Commits and are DCO signed off (`-s`).
- [ ] The diff is scoped to the stated change.

Open the PR against `main` with a clear description of what changed and why. Link the issue that motivated it. The maintainer will review; expect questions and keep the conversation in the PR.

## CI workflows

| Workflow | Runs on | What it does |
|----------|---------|--------------|
| `ci.yml` | every push to `main` and every pull request | Biome formatting and lint check (`lint` job); type check, the test suite with 99% coverage floors on Node 22, 24 and 26 (Linux), plus macOS and Windows on Node 26, including the cross-language conformance suite and its integrity check; the build and `check:dist` (no bundled dependencies, ESM/CJS and TypeScript consumers load it); the public-API snapshot (`api-surface.txt`) must be up to date; CodeQL code scanning. |
| `commits.yml` | every pull request: opened, updated, reopened, or its title or description edited | the `commits` job checks every commit's subject and sign-off and the pull request title, which becomes the squash commit's subject. A workflow of its own, so editing a pull request re-runs only this check. |
| `security.yml` | push to `main`, pull requests, and weekly | secret scanning over the full git history (gitleaks), OSV-Scanner over the lockfile, `npm audit`, and an SBOM uploaded as a build artifact. OpenSSF Scorecard runs on pushes to `main` and weekly, with results in code scanning. |
| `publish.yml` | a version tag, or a manual run | A tag `vX.Y.Z-rc.N` publishes to npm under the `next` dist-tag; `vX.Y.Z` publishes under `latest`. The tag must be on `main` and match both `package.json` and `src/version.ts`. The build job re-runs `npm run typecheck`, `npm run test:cov` (with the coverage floor), `npm run build` and `npm run check:dist` on Node 24; the publish job uses npm trusted publishing with provenance (no stored token) after approval in the `prerelease` or `release` environment, and skips a version that is already on npm. A manual run (Actions → publish → Run workflow) publishes nothing: its `publisher-check` job only confirms that npm accepts this workflow's OIDC token for the package, after approval in the `release` environment. |
| Dependabot | weekly | update pull requests for npm dependencies and the GitHub Actions, taken only after a 7-day cooldown; each one runs the checks above. |

Every job runs on GitHub-hosted runners except CodeQL and Scorecard, which run on the organisation's self-hosted runners: their uploads are GitHub API calls that the organisation's IP allow list only accepts from there. CodeQL runs there for same-repository events only, so a pull request from a fork is analysed once merged; Scorecard never runs on a pull request. Every action is pinned to a full commit SHA and every job declares least-privilege `permissions:`. Publishing never happens outside the `scrape-do` organisation, never from a commit that is not on `main`, and never without a maintainer's approval.

## Releasing

Releases are published from GitHub Actions (`.github/workflows/publish.yml`) when
a `v*` tag is pushed: an unprivileged job builds and tests the package, and a
second job, behind the approval of the `prerelease` or `release` environment,
publishes it with npm trusted publishing (OIDC, no stored token) and
provenance. Trusted publishing needs npm 11.5.1 or newer, so the publish job
runs on Node.js 24.

The version lives in two files that must agree: `package.json` (`version`) and
`src/version.ts` (`VERSION`, used in the User-Agent); a test checks them against
each other. The build job refuses a tag that is not `v` plus that version, and a
tagged commit that is not on `main`.

Development is trunk-based (pull requests into `main`), and the tag picks the
channel: `vX.Y.Z-rc.N` publishes under the npm dist-tag `next` after approval in
the `prerelease` environment; `vX.Y.Z` publishes under `latest` after approval in
the `release` environment. Create both environments (required reviewers, `v*`
tag rule) before the first tag.

One-time setup before the first release:

1. In the repository settings, create both environments, `prerelease` and
   `release`, each with required reviewers and a deployment rule limited to
   `v*` tags. They are the approval gates: the publish job waits in one of them
   until a maintainer approves.
2. npm only lets you configure a trusted publisher for a package that already
   exists, so create the package by hand with a throwaway placeholder,
   `0.0.0-bootstrap.0`, under the `bootstrap` dist-tag (never `latest`). Then
   0.1.0 itself is published by the workflow, with provenance. From a clean
   checkout of `main`, with a short-lived granular token that can publish to
   the `@scrape-do` scope:

   ```bash
   npm version 0.0.0-bootstrap.0 --no-git-tag-version
   npm publish --tag bootstrap   # dist/ is not built: the placeholder holds no code
   git checkout -- package.json package-lock.json
   ```

3. On npmjs.com, configure the trusted publisher for `@scrape-do/sdo-client`:
   repository `scrape-do/sdo-sdk-js`, workflow `publish.yml`, and leave the
   environment field **empty**. npm allows one trusted publisher per package
   and, when an environment is set, accepts only that one, but the workflow
   publishes release candidates from `prerelease` and final versions from
   `release`. The GitHub environments from step 1 still gate every publish.
   Revoke the token used in step 2.
4. Push the version tag (`v0.1.0-rc.1` or `v0.1.0`). The workflow builds, tests
   and, after approval, publishes it; every later version is published the
   same way. The registry may point `latest` at a new package's first version;
   if `npm view @scrape-do/sdo-client dist-tags` shows that, it moves when the
   workflow publishes the first final version.
5. Once 0.1.0 is on npm, retire the placeholder:
   `npm dist-tag rm @scrape-do/sdo-client bootstrap` and
   `npm deprecate @scrape-do/sdo-client@0.0.0-bootstrap.0 "Placeholder that created the package; install @scrape-do/sdo-client@latest."`
6. Retire the predecessor. `@scrape-do/client` (repository
   `scrape-do/node-client`) is superseded by this package. Once 0.1.0 is on
   `latest`: `npm deprecate @scrape-do/client@"*" "Superseded by
   @scrape-do/sdo-client: https://github.com/scrape-do/sdo-sdk-js"`, put the same
   pointer at the top of node-client's README, and archive that repository.
   Existing installs keep working; `npm install` prints the notice.

npm only accepts provenance from a public source repository; this repository
is public, so the workflow publishes with provenance.

## Reporting bugs and proposing changes

- **Bug reports:** open an issue with a minimal reproduction — the exact SDK call, the expected result, and the actual result. Redact your `SDO_TOKEN`.
- **Surface proposals:** propose new or changed surface as an issue first. The request parameters, defaults and observable behaviour are shared by all sdo SDKs; if the change belongs there, Scrape.do updates `conformance.json` against https://scrape.do/documentation, and the change lands in every SDK together.
- **Security issues:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the project's [Apache-2.0](./LICENSE) license, and you certify the DCO with your sign-off.
