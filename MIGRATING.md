<!-- SPDX-License-Identifier: Apache-2.0 -->
# Migrating `@scrape-do/sdk`

This guide describes how to upgrade between versions of the `@scrape-do/sdk`
package (the `sdo` JavaScript/TypeScript SDK). It documents the compatibility
guarantees you can rely on and the steps required when a release introduces a
breaking change.

## Backward-compatibility policy

`@scrape-do/sdk` follows [Semantic Versioning 2.0.0](https://semver.org/).

- **PATCH** (`0.1.0` → `0.1.1`) — bug fixes and internal changes only. No
  observable change to the public API. Safe to take automatically.
- **MINOR** (`0.1.0` → `0.2.0`) — additive, backward-compatible changes: new
  methods, new optional parameters, new fields on response objects. Existing
  code keeps working unchanged.
- **MAJOR** (`0.x` → `1.0`, `1.x` → `2.0`) — may remove or change existing
  behavior. Every breaking change is listed in this file with a before/after
  example and, where practical, a deprecation period first (see
  [Deprecations](#deprecations)).

Before 1.0, a minor version may contain breaking changes; each is marked
**Breaking** in [CHANGELOG.md](CHANGELOG.md) and described in this file. Patch
versions never break.

Pin a version range you trust in `package.json` and review this guide before
crossing a major boundary (before 1.0, a minor one; `^0.1.0` already stops
below `0.2.0`):

```jsonc
{
  "dependencies": {
    "@scrape-do/sdk": "^0.1.0"
  }
}
```

### What counts as the public API

The public API is the surface exported from the package entry point and its
published type declarations:

- Exported classes, functions, and their signatures (e.g. the client
  constructor, request methods, and their option objects).
- The shape of returned objects and thrown error types.
- Documented configuration: the `SDO_TOKEN` environment variable and any
  constructor options that mirror it.

The request parameters, defaults and observable behaviour are shared by all
sdo SDKs and pinned by the conformance corpus (`conformance.json`), which
Scrape.do maintains against https://scrape.do/documentation. The exported
names and signatures are recorded in `api-surface.txt`. A change to a parameter
lands in every SDK together, which keeps behaviour consistent across languages.

### What is **not** covered by these guarantees

The following may change in any release without a major bump:

- Anything exported under an `internal`/`_` path or explicitly marked
  `@internal` in the type declarations.
- Exact wording of error messages (error **types** are stable; the
  human-readable `message` string is not).
- Undocumented behavior you discovered by inspection rather than from the docs.
- Pre-release tags (`-alpha`, `-beta`, `-rc`).

### Authentication and configuration stability

Authentication is token-only: the `token` option or the `SDO_TOKEN` environment
variable. Removing or renaming either, or adding any other required auth
mechanism, is a breaking change and will be called out here. There is **no
telemetry** and **no UI**; the SDK will never start collecting usage data or
require an interactive component as part of an upgrade.

### Deprecations

When something is slated for removal we:

1. Mark it `@deprecated` in the type declarations (so editors and `tsc` surface
   a warning) with a pointer to the replacement.
2. Keep it working for at least two minor releases and at least 90 days before
   it is removed.
3. Remove it only in a major release (before 1.0, a minor release) after that
   window, with an entry in this file.

A deprecation warning is your signal to migrate before the next major — it is
never an emergency on its own.

### How breaking changes are decided

Governance is solo maintainer plus AI assistance: the founder is the sole
approver of every release. Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/) with a
`Signed-off-by` line on each commit (DCO sign-off, not a CLA). Breaking changes
are made deliberately, documented here, and shipped only under a major version
(before 1.0, a minor version).

## Migrations

None yet. The first published release of `@scrape-do/sdk` will have no earlier
version to migrate from. Future entries will appear here, newest first, each
with the version boundary, what changed, why, and the exact before/after edit to
apply.
