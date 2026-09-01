# Releasing the Latchway JavaScript SDKs

The repository contains one fail-closed npm release workflow for
`@latchway/client`, `@latchway/openai`, `@latchway/vercel-ai`, and
`@latchway/langchain`. All four packages use one stable version and are released
as one evidence-bound set. Preparing that version does not create a tag, an npm
version, or a GitHub release. Only the verified core-promotion
`repository_dispatch` may start the release workflow; that workflow owns
creation or verification of the evidence-bound annotated SDK tag.

## Registry and repository setup

Before the first automated release, configure these external controls:

1. Protect release tags and the `npm` GitHub environment. Require an independent
   reviewer for the environment.
   Store a fine-grained `LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN` in that protected
   environment with read-only repository Administration permission. The workflow
   uses it only to require GitHub's exact immutable-release setting response
   (`enabled: true` and a Boolean `enforced_by_owner`) before any draft or asset
   mutation.
2. In each of the four npm package settings, configure the GitHub Actions
   trusted publisher for organization `Latchway`, repository `latchway-js`,
   workflow file `release.yml`, environment `npm`, and the `npm publish` action.
3. Disallow package-token publication after trusted publishing is working.
   Never add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or an npm auth token to this
   repository or workflow.
4. Confirm the public package repository URL is exactly
   `https://github.com/Latchway/latchway-js`.
5. If the core repository remains private, configure
   `LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN` as a fine-grained Contents: read
   credential scoped to `Latchway/latchway`. It authenticates only the pinned
   promotion asset download and attestation verification. Public core
   repositories need no secret and fall back to the job token.

npm currently requires a package to exist before its trusted publisher can be
configured. If any package has no npm package record, its initial namespace
bootstrap remains an external registry operation. Do not bypass that limitation
by adding a long-lived token to `release.yml`; complete the reviewed npm
bootstrap procedure for every missing package, then enable all four trusted
publishers and the automated release path.

## Candidate preparation

Set the root and all three adapter `package.json` files to the same exact stable
`X.Y.Z` version in a reviewed commit. Do not use prerelease or build suffixes. Update
the checksummed core contract bundle only through the core release process;
`contract.lock` must byte-for-byte match the reviewed lock expected by
`pnpm verify:contracts`.

Run the same gate as CI on Node 24.19.0 and pnpm 10.15.0:

```bash
pnpm install --frozen-lockfile
pnpm release:check
```

The gate runs workflow-policy validation, exact contract verification, release
policy tests, lint, strict type checking, unit tests, a clean build, examples,
export checks, two clean reproducible builds across all four `dist` trees, two
byte-identical package operations per package, archive allowlists and credential
scans, and a clean Node ESM and TypeScript consumer installed from all four exact
tarballs. Adapter workspace peers are verified to pack as the matching public
`@latchway/client` semver range.

Review `.artifacts/package-evidence.json`,
`.artifacts/release-candidate-evidence.json`, and `.artifacts/SHA256SUMS`.
Generated artifacts are ignored by Git and must not be committed.

## Promotion dispatch and publish

Do not create or push the SDK tag manually. After the reviewed source commit is
part of the accepted cross-repository candidate, the core promotion workflow
sends `latchway_release_promoted` with the exact SDK commit, intended tag, core
tag, immutable image digest, and attested promotion-report coordinates. The SDK
workflow verifies that envelope and report before it creates, or byte-for-byte
verifies, the annotated tag through the GitHub API. A conflicting tag,
mismatched version, or non-stable JavaScript coordinate fails before dependency
installation or publication. The release workflow then:

1. Repeats the full candidate gate in a clean GitHub-hosted runner.
2. Transfers only the four verified tarballs, checksum, and machine-readable evidence
   to a separately permissioned `npm` environment job. In parallel, a
   source-free `permissions: {}` job downloads the exact npm 11.6.2 registry
   tarball with lifecycle scripts disabled. It requires a one-file artifact
   closure, 2,663,834 bytes, 2,133 regular archive entries, 11,785,613 unpacked
   bytes, SHA-256
   `585f95094ee5cb2788ee11d90f2a518a7c9ef6e083fa141d0b63ca3383675a20`,
   and npm integrity
   `sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485DOvRT2l5Gerbl3VlZNT57MxJVA==`
   before handing that tarball to the protected job as inert data.
3. Re-verifies the package artifact and local tag, requires the installed GitHub CLI to
   support JSON release and asset attestation verification, and resolves the
   remote annotated tag object to the exact promoted commit immediately before
   draft creation. Before extraction or execution, the OIDC job independently
   rechecks the exact npm CLI handoff name-only closure, byte size, SHA-256,
   SHA-512, integrity, entry paths and types, and unpacked size. It invokes the
   verified CLI directly for `publish --provenance --access public`; it never
   runs `npm install`, `npm exec`, or `npx`. It has `id-token: write` and no
   long-lived npm credential. Before the first mutation it preflights all four
   coordinates and rejects any conflicting existing metadata or bytes.
   Publication is then fixed in dependency order: client, OpenAI, Vercel AI,
   then LangChain. A rerun adopts an existing coordinate only
   after its metadata, integrity, shasum, and downloaded tarball bytes match the
   reviewed archive; a missing coordinate can be created only while the GitHub
   release is still a draft.
4. For every package, downloads the exact registry tarball, checks byte identity,
   exports and peer dependencies, validates npm signature and trusted-publisher
   metadata, verifies the SLSA provenance subject and source workflow/commit,
   installs a fresh public-registry consumer with exact package, client, and
   external-peer versions, imports its public exports, and runs
   `npm audit signatures`. Per-package bounded, credential-scanned registry
   responses, views, Sigstore bundles, and signature audits are retained and
   bound by the aggregate `npm-registry-evidence-manifest.json`.
5. Creates or resumes a draft only after the protected administration read proves
   immutable releases are enabled. A second fresh no-checkout job rechecks that
   policy with the administration credential but has no OIDC permission; the
   final OIDC job receives no administration credential and validates the exact
   local asset closure before asking GitHub to attest it. It then reconciles the
   draft after all registry checks pass. Existing
   assets are downloaded and compared byte for byte, only missing assets may be
   attached, and no asset is ever overwritten. A final release must already
   contain every fixed asset plus at least one valid adoption record for each
   package; otherwise the workflow stops. After
   finalization, the remote annotated tag is resolved again. After publication,
   bounded retries of `gh release verify` and `gh release verify-asset` are parsed
   strictly; the signed release subject must identify the promoted commit and the
   signed asset subjects must be the exact name/SHA-256 closure.

The fixed GitHub release closure is the four `latchway-<package>-X.Y.Z.tgz`
archives (`client`, `openai`, `vercel-ai`, and `langchain`),
`docs-bundle-X.Y.Z.tar.gz`, `SHA256SUMS`, `build-reproducibility.json`,
`contract-evidence.json`, `dependency-vulnerability-scan.json`,
`package-evidence.json`, `post-publish-evidence.json`,
`publish-input-evidence.json`, `release-candidate-evidence.json`,
`tag-evidence.json`, and `npm-registry-evidence-manifest.json`. For each package
ID, it also contains `npm-<id>-registry-version.json`,
`npm-<id>-registry-view.json`, `npm-<id>-attestations.json`, and
`npm-<id>-audit-signatures.json`. Adoption history uses
`npm-release-adoption-<id>-<run>-<attempt>.json`; a complete release contains at
least one valid record for each of the four IDs. The current handoff therefore
contains exactly 35 files, while a later immutable retry may observe additional
valid adoption-history records and must preserve them byte for byte.

If npm accepts one or more packages but a later step is interrupted, rerunning
the same tag is recoverable only when every existing immutable npm version has
the exact verified integrity and bytes. The post-publish provenance checks still have to bind it to
the same canonical tag, commit, and workflow; a merely matching version string
is never treated as success. An attested, attempt-specific adoption record binds
the immutable npm provenance-producing run and attempt, exact registry evidence
manifest, and the current successful adoption run and attempt. The provenance
producer is therefore allowed to be the earlier interrupted attempt without
misrepresenting the successful rerun. The GitHub release is equally resumable: an
interrupted draft can be completed only when its metadata and every existing
asset match the exact rerun inputs, while an identical final release is a
read-only success.

## Consumer verification

After release, a consumer can verify all downloaded archive checksums and npm
attestations:

```bash
shasum -a 256 -c SHA256SUMS
npm audit signatures
```

The GitHub workflow run, all four npm package versions, and GitHub release must
all report the same version and source commit. Each package's SHA-256 checksum,
SHA-512 integrity, provenance, registry-signature result, adoption record, and
annotated tag binding must agree before the release is considered complete.
