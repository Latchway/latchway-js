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

1. Install an active ruleset for `refs/tags/v*` that allows tag creation only
   through the GitHub Actions integration used by `release.yml` and denies tag
   updates, deletion, and non-fast-forward changes. Operators and administrators
   must not create, move, or delete release tags manually.
2. Create three protected GitHub environments, restrict deployments to `main`
   only, require an independent reviewer for each one, set
   `prevent_self_review: true`, and
   disallow administrator bypass wherever the repository plan exposes that
   control. Each environment must define its own environment-scoped variable
   named `LATCHWAY_RELEASE_CONTROL_POLICY_ID` with the exact value below:
   - `release-administration`:
     `latchway-release-controls-v1:latchway-js:release-administration`
   - `npm`: `latchway-release-controls-v1:latchway-js:npm`
   - `github-release`:
     `latchway-release-controls-v1:latchway-js:github-release`

   Do not define that variable at repository or organization scope. GitHub
   variable precedence can otherwise make an accidentally missing environment
   variable fall back to a broader value. The release-control reconciler must
   verify the variable through each environment's variables endpoint before a
   release is dispatched. Every protected job checks its unique literal value
   as its first step, before any step uses an action, resolves a credential or
   token, requests an OIDC token, or performs a mutation.

   The environment authority inventories are exact:
   - `release-administration` contains only a fine-grained
     `LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN` with read-only repository
     Administration permission. Two fresh no-checkout jobs use it only to require
     GitHub's exact immutable-release response, `enabled: true` and
     `enforced_by_owner: true`, before the draft and again before final release.
     The pre-publication and final policy handoffs are bound to the exact
     workflow run and attempt and expire after exactly 600 seconds.
   - `npm` contains no registry token. It protects only trusted npm publication
     and the resulting registry-evidence job; it has no environment secrets.
   - `github-release` contains no custom credential. It protects draft mutation
     and the final GitHub-token/OIDC release publication jobs; it has no
     environment secrets.

   Do not duplicate an environment secret into another environment. In
   particular, the administration token must never enter the `npm` or
   `github-release` jobs, and GitHub release authority must never enter an npm
   job. The same privileged secret name must not exist at repository or
   organization scope: GitHub would otherwise fall back to that broader value if
   the intended environment secret were removed. The release-control reconciler
   checks secret names and visibility only; it never reads or writes secret
   values.
3. In each of the four npm package settings, configure the GitHub Actions
   trusted publisher for organization `Latchway`, repository `latchway-js`,
   workflow file `release.yml`, environment `npm`, and the `npm publish` action.
4. Disallow package-token publication after trusted publishing is working.
   Never add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or an npm auth token to this
   repository or workflow.
5. Make `Latchway/latchway-js` public before publication and confirm the public
   package repository URL is exactly
   `https://github.com/Latchway/latchway-js`. Required npm provenance is not
   generated from a private source repository, so private visibility is not a
   supported stable-publication state.
6. Keep `Latchway/latchway` public. The promotion-authentication job uses only
   the current repository's built-in job token to download and verify the public
   core release evidence; no sibling-repository credential is supported.
7. Make `release.yml` the exclusive writer for generated SDK tags and GitHub
   release drafts; do not upload, replace, or remove draft assets manually. The
   per-commit workflow concurrency group prevents overlapping dispatches for the
   same promoted commit. The protected `github-release` environment limits who
   may mutate the draft, while `npm` separately limits registry publication. The
   pre-publish draft gate can validate only release
   metadata and allowed asset-name shape because registry evidence does not exist
   until publication verification completes. The final no-checkout reconciler
   subsequently downloads, bounds, parses, byte-binds, and attests every retained
   adoption record before it uploads anything, repeats that validation after all
   uploads immediately before finalization, and verifies the immutable result
   again. GitHub does not expose an atomic compare-and-finalize operation for
   draft asset bytes, so the exclusive-writer control remains necessary for the
   final interval between the last validation and finalization. A foreign or
   corrupt draft therefore fails closed, but the exclusive-writer control is what
   prevents such a draft from causing an otherwise valid immutable npm publication
   before that later cryptographic check.

npm currently requires a package to exist before its trusted publisher can be
configured. The following reviewed bootstrap is the only procedure for creating
the five initially absent records. It is intentionally separate from both
repositories' `release.yml`; it must never become part of an automated stable
release.

### One-time npm namespace bootstrap

The fixed bootstrap set is `@latchway/client`, `@latchway/openai`,
`@latchway/vercel-ai`, `@latchway/langchain`, and
`@latchway/react-native`. Every archive has version
`0.0.0-bootstrap.0`, Apache-2.0 licensing, and the exact owning repository
metadata. It contains only `package.json`, `README.md`, and `LICENSE`: no source,
entry point, dependency, lifecycle or install script, secret, or runtime
implementation.

Start from the exact reviewed commit in a clean tracked checkout. Review the
commit before assigning it; do not substitute a moving branch or tag. Bootstrap
archive generation and publication both require exactly npm 11.17.0 because npm
pack format is part of the release input:

```bash
reviewed_commit="$(git rev-parse --verify HEAD)"
git show --stat "$reviewed_commit"
git status --porcelain=v1 --untracked-files=no
npm --version # must print exactly 11.17.0
pnpm run namespace:bootstrap --dry-run --reviewed-commit "$reviewed_commit"
cat .artifacts/npm-namespace-bootstrap/inspection.json
for archive in .artifacts/npm-namespace-bootstrap/*.tgz; do tar -tzf "$archive"; done
```

The status command must print nothing. The helper rejects a different HEAD,
staged or unstaged tracked changes, an untracked helper or license, a nonexact
npm version, or a missing `--reviewed-commit`. The inspection binds the exact
source commit, SHA-256 of `scripts/npm-namespace-bootstrap.mjs`, SHA-256 of
`LICENSE`, and npm version. Publication recomputes and compares all four bindings
immediately before the first registry mutation.

The default `.artifacts/npm-namespace-bootstrap` output is ignored by Git. A
custom output is accepted only below that ignored directory or an
operating-system temporary directory. The dry run fixes each archive's size,
SHA-256, three-file closure, repository identity, and prospective command. Read
all five manifests and hashes before authorizing registry mutation. Do not copy
these inert archives into a stable release or use them as application
dependencies.

The authorized operator must keep the exact reviewed npm 11.17.0 toolchain and
use an interactive terminal with a short-lived web-login session and
organization access. The script rejects token environment variables. It has no
implicit publish mode, and the exact confirmation phrase is deliberately
cumbersome:

```bash
npm --version # must still print exactly 11.17.0
pnpm run namespace:bootstrap --publish \
  --reviewed-commit "$reviewed_commit" \
  --confirm publish-five-latchway-bootstrap-packages
```

Do not run that command as part of ordinary release preparation. It always
passes `--access=public`, `--tag=bootstrap`, the public npm registry, and
`--ignore-scripts`; it never publishes under `latest`. Before any publish, it
checks every package record. An absent name is created, while an existing name
is adopted only if its sole version, sole `bootstrap` dist-tag, manifest,
repository identity, integrity, shasum, and downloaded tarball bytes exactly
match the reviewed local archive. This makes a partial prior run resumable: only
missing names are published, and even a lost publish response is accepted only
after the exact immutable bytes appear. Any foreign version, tag, manifest, or
archive fails before another name is changed.

After the last create, the script fetches and revalidates the complete
five-package registry closure and writes
`.artifacts/npm-namespace-bootstrap/completed.json`. Absence of that record means
the bootstrap is not complete. Keep `bootstrap` on `0.0.0-bootstrap.0`; do not
add or move `latest`. The completion record repeats the exact source commit,
helper and license hashes, and npm version from the inspection. Inspect the
public result independently, and keep the short-lived interactive session only
through trusted-publisher setup and verification:

```bash
npm view @latchway/client dist-tags versions repository --json
npm view @latchway/openai dist-tags versions repository --json
npm view @latchway/vercel-ai dist-tags versions repository --json
npm view @latchway/langchain dist-tags versions repository --json
npm view @latchway/react-native dist-tags versions repository --json
```

Once all five records exist, use npm 11.15.0 or newer (the reviewed 11.17.0
bootstrap toolchain already qualifies) to configure GitHub Actions trusted
publishing. `--file release.yml` is the workflow filename, not a path.
The four JavaScript packages trust `Latchway/latchway-js`; the React Native
package trusts `Latchway/latchway-react-native-sdk`. Every publisher is limited
to environment `npm` and the publish action:

```bash
npm trust github @latchway/client --repository Latchway/latchway-js --file release.yml --environment npm --allow-publish --yes
npm trust github @latchway/openai --repository Latchway/latchway-js --file release.yml --environment npm --allow-publish --yes
npm trust github @latchway/vercel-ai --repository Latchway/latchway-js --file release.yml --environment npm --allow-publish --yes
npm trust github @latchway/langchain --repository Latchway/latchway-js --file release.yml --environment npm --allow-publish --yes
npm trust github @latchway/react-native --repository Latchway/latchway-react-native-sdk --file release.yml --environment npm --allow-publish --yes
```

This setup requires each package record to exist and the configuring npm account
to have two-factor authentication enabled. npm permits only one trusted-publisher
configuration per package, so a pre-existing configuration must be reviewed and
removed deliberately rather than overwritten by assumption. A granular access
token that bypasses two-factor authentication cannot configure trusted
publishing; use the authenticated npm 11.15.0-or-newer CLI session.

Verify every exact configuration, then end the short-lived interactive session:

```bash
npm trust list @latchway/client --json
npm trust list @latchway/openai --json
npm trust list @latchway/vercel-ai --json
npm trust list @latchway/langchain --json
npm trust list @latchway/react-native --json
npm logout --registry=https://registry.npmjs.org/
```

Retain all three protected GitHub environments, their `main` deployment
restriction, and their required reviewers. Require two-factor authentication for
package settings and disallow token publication after the trusted publishers
work. Neither `NPM_TOKEN` nor `NODE_AUTH_TOKEN` belongs in a repository,
workflow, artifact, or release environment.

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
3. After both the reviewed candidate and fixed npm CLI are ready, runs a fresh,
   no-checkout, no-OIDC `release-administration` job that verifies immutable
   releases with the narrow administration token. It emits a strict JSON policy
   lease and SHA-256 bound to this repository, phase, workflow run, and attempt,
   with a 600-second lifetime. A separately
   protected `github-release` job receives no administration credential, requires
   the installed GitHub CLI to support JSON release and asset attestation
   verification, validates the lease's exact one-file closure and hash, resolves
   the remote annotated tag object to the exact promoted commit, and rechecks the
   lease immediately before creating a draft. The npm job validates the same
   lease before setup, rechecks it immediately before the npm provenance
   attestation, and rechecks it again immediately before each registry mutation,
   then re-verifies the
   package artifact and local tag. Before extraction or execution, that OIDC job
   independently rechecks the exact npm CLI handoff name-only closure, byte size,
   SHA-256, SHA-512, integrity, entry paths and types, and unpacked size. It
   invokes the verified CLI directly for `publish --provenance --access public`;
   it never runs `npm install`, `npm exec`, or `npx`. It has `id-token: write` and
   no long-lived npm credential. Before the first mutation it preflights all four
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
   immutable releases are enabled. A second fresh no-checkout
   `release-administration` job rechecks that policy with the administration
   credential but has no OIDC permission; the final `github-release` OIDC job
   receives no administration credential, validates the exact local asset
   closure, and performs a complete fresh lease validation immediately before
   asking GitHub to attest it. It then reconciles the
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
misrepresenting the successful rerun. The fixed post-publish record describes
the immutable registry state and therefore always records `publication_mode` as
`published`; only the package-suffixed adoption record describes whether the
current attempt published or adopted those bytes. This keeps every fixed asset
byte-stable across a valid retry. If the npm job succeeded in an earlier workflow
attempt and only a downstream evidence job is rerun, the workflow consumes the
npm producer's exported run and attempt, converts its earlier `published` result
to `adopted_existing` for the current adoption record, and keeps the original npm
provenance coordinates unchanged. A record says `published` if and only if its
provenance and adoption run/attempt coordinates are identical; every consumer
enforces that equivalence. The GitHub release is equally resumable: an
interrupted draft can be completed only when its metadata and every existing
asset match the exact rerun inputs, while an identical final release is a
read-only success.

The short immutable-policy lease intentionally cannot be reused by a later
workflow attempt. If `github-release` must be retried after its policy producer
already succeeded, use **Re-run all jobs** (or send a fresh verified promotion
dispatch) rather than **Re-run failed jobs** or a single-job rerun. A full rerun
generates new attempt-bound policy evidence and safely adopts any npm bytes from
the earlier attempt; a partial rerun fails before release mutation when it sees
the prior attempt's policy handoff.

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
