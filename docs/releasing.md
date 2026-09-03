# Releasing the Latchway JavaScript SDKs

The repository contains one fail-closed npm release workflow for
`@latchway/client`, `@latchway/openai`, `@latchway/vercel-ai`, and
`@latchway/langchain`. All four packages use one stable version and are released
as one evidence-bound set. Preparing that version does not create a tag, an npm
version, or a GitHub release. Only the verified core-promotion
`repository_dispatch` may start the release workflow; that workflow owns
creation or verification of the evidence-bound annotated SDK tag.

## Single-maintainer v1 publication profile

The additive `single-maintainer-release.yml` workflow is the explicit launch
path when an independent human reviewer and the deferred platform/provider
evidence are not yet available. It is limited to version `1.0.0`, an exact
40-character commit selected from `main`, the checked-in released core lock,
and the confirmation phrase
`publish-v1.0.0-with-deferred-assurance`. It records
`single_maintainer_v1`, `release_qualified: false`, the deferred evidence, and
the forbidden stronger claims before doing any work.

Before creating any JavaScript tag, the workflow downloads the exact public
`Latchway/latchway` `v1.0.0` release and requires the
`single_maintainer_v1` core record. It checks the release's closed 15-asset
set and checksums with the verifier stored at the selected JavaScript commit.
The released candidate may be newer than the `contract.lock` core checkpoint,
but GitHub's comparison must report it as `ahead` or `identical` with that
checkpoint as the merge base. The workflow verifies the annotated core tag and
public release metadata, authenticates the public core record and `SHA256SUMS`
to core's `single-maintainer-release.yml`, and authenticates the candidate,
Docker Compose, and Google Cloud Run evidence to their exact core workflows,
`main` ref, and released candidate commit. The resulting
`core-release-gate.json` records both revisions and is retained with the
JavaScript release inputs.

The complete dependency scan, test, browser, build, reproducibility, archive
allowlist, consumer, and documentation gates then pass before the workflow
creates the JavaScript annotated tag. The tag and draft carry a deterministic
transaction ID derived from the repository, workflow, exact source commit,
`v1.0.0`, and the GitHub run ID. A failed job may be resumed only by using
GitHub's **Re-run failed jobs** operation on that same run. After any tag,
draft, or registry mutation, never use **Re-run all jobs** and never start a
fresh dispatch: the successful owner-binding jobs must remain successful while
only the failed job and its dependents resume. A rerun-all or fresh dispatch
fails the early v1 owner guard rather than adopting or altering the earlier
transaction.

The exact GitHub draft is staged before the first npm mutation. Every fixed
asset is uploaded only when absent; an existing asset is adopted only after its
digest or downloaded bytes match. npm publication uses the deterministic
reviewed archives and trusted publishing. A tokenless follow-up installs each
published package into a clean consumer and verifies registry bytes, npm
signatures, the Sigstore publish attestation, and SLSA provenance bound to
`Latchway/latchway-js`, the exact source commit, `refs/heads/main`,
`workflow_dispatch`, and `.github/workflows/single-maintainer-release.yml`.
Only after that gate does the workflow add the registry evidence to the draft,
re-download or digest-check the complete 32-asset closure, attest it, and
finalize the release. Existing `1.0.0` versions are therefore not considered
adopted merely because their tarball bytes match. This path does not claim
independent review, owner-enforced immutable releases, full evidence gating, or
release-qualified status.

The four transaction artifacts (intent, core gate, deterministic release
inputs, and registry evidence) are retained for 90 days. Reruns never use
`--clobber`, move a tag, replace an asset, or weaken a mismatched transaction.

Create a `single-maintainer-v1` GitHub environment restricted to `main`. Define
the environment-scoped variable `LATCHWAY_RELEASE_CONTROL_POLICY_ID` there with
the exact value
`latchway-release-controls-v1:latchway-js:single-maintainer-v1`; do not define
it at repository or organization scope. Every environment-bearing job checks
that sentinel as its first step, before an action, credential, OIDC request, or
mutation. The environment contains no npm token and does not require an
independent reviewer. For this launch profile, configure each JavaScript
package's one npm trusted publisher as organization `Latchway`, repository
`latchway-js`, workflow file
`single-maintainer-release.yml`, environment `single-maintainer-v1`, and the
publish action. npm permits only one trusted publisher per package: while this
tuple is active, strict `release.yml` cannot publish. Moving to `strict_full`
later requires deliberate reconfiguration of all four packages back to
workflow file `release.yml` and environment `npm`; never assume both publishers
are active.

```bash
gh workflow run single-maintainer-release.yml --ref main \
  -f release_profile=single_maintainer_v1 \
  -f release_commit="$(git rev-parse HEAD)" \
  -f release_version=1.0.0 \
  -f confirmation=publish-v1.0.0-with-deferred-assurance
```

Dispatch only after the public core `v1.0.0` single-maintainer release exists
with its exact Docker Compose and Cloud Run evidence. If a dispatch reaches
any mutation and later fails, use **Re-run failed jobs** on that owner run; do
not use rerun-all and do not start a new dispatch for recovery.

## Strict full registry and repository setup

These controls belong to the later `strict_full` migration, not the
`single_maintainer_v1` launch above. Apply them only when an independent
reviewer is available and all four npm packages are deliberately moved from
the `single-maintainer-release.yml` trusted-publisher tuple back to
`release.yml` with environment `npm`. npm supports only one trusted publisher
per package, so configuring this section during the launch profile would
disable its publication workflow.

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
   - `github-release` contains no custom credential. It protects promotion's
     annotated-tag mutation, draft mutation, and the final GitHub-token/OIDC
     release publication job; it has no environment secrets.

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
   may create the annotated tag or mutate the draft/final release, while `npm`
   separately limits registry publication. The
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
passes `--access=public`, `--tag=bootstrap`, `--registry` and the explicit
`--@latchway:registry` override for `https://registry.npmjs.org/`, and
`--ignore-scripts`; its publish request never selects `latest`. The two literal
registry pins prevent a hostile scoped environment or user npm configuration
from redirecting a scoped package operation. Before any publish, it checks every
package record. An absent name is created, while an existing name is adopted
only if its sole version, required `bootstrap` dist-tag (with at most the exact
singleton `latest` alias described below), manifest, repository
identity, integrity, shasum, and downloaded tarball bytes exactly match the
reviewed local archive. This makes a partial prior run resumable: only missing
names are published, and even a lost publish response is accepted only after the
exact immutable bytes appear.

npm may nevertheless materialize a `latest` alias when the very first version
of a new package is created, even though the fixed publish command requested
`bootstrap`. In the observed first publication, an authenticated attempt to
remove that alias returned HTTP 400 without an explanatory response body.
The helper therefore accepts only the exact observed singleton exception: the
record must have exactly version `0.0.0-bootstrap.0`, exactly the `bootstrap` and
`latest` tags both pointing to that version, and the manifest, repository,
digests, and downloaded archive must already be byte-identical to the reviewed
local package. It never adds, moves, or removes a tag. A foreign version, a
missing `bootstrap` tag, any other tag, or a different tag target, manifest,
digest, or archive fails closed. The exception does not prove who created the
alias and is not evidence that an SDK or stable release is available. Until a
real release replaces the alias, an unversioned install may resolve to this
inert placeholder: do not recommend installing these namespaces yet.

Registry checks happen again immediately before every missing-name publication,
so a long scan of an earlier package cannot leave the next name's preflight
stale. The helper rechecks the reviewed checkout, toolchain, and archive before
uploading. A validation failure before upload is fatal, not an ambiguous
publication response.

npm's public packument omits the `files` allowlist even though that field is
present inside the published `package.json`. The helper accepts only that one
metadata omission and only for the fixed `["LICENSE", "README.md"]` bootstrap
allowlist. It still downloads the registry archive and requires every byte to
match the reviewed local archive before it adopts an existing package, so an omitted
packument field cannot hide a changed package or extra file.

The interactive npm subprocess runs asynchronously, reports bounded progress,
and has a 20-minute deadline (with five seconds for termination before a forced
stop). After a publication attempt, metadata or tarball HTTP 404 is treated as
pending visibility, not a reason to republish. The same rule applies when an
existing record's tarball is temporarily unavailable. Each visibility check
waits at most 20 minutes, polling every ten seconds and reporting progress at
most every 30 seconds. This accommodates npm's documented
[publish-time scanning delay](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/),
typically five minutes and sometimes 15 minutes or longer; it is not a service
guarantee. Invalid metadata, mismatched bytes, and other HTTP failures fail
immediately rather than being retried as scanning delays.

If the visibility deadline expires, the helper emits an explicit `pending`
progress event, exits with status 2, and does not create a completion receipt or
publish following packages. Publication may already have succeeded. Rerun the
same reviewed helper and output directory to reconcile the registry; do not
manually republish or unpublish a namespace. The helper never records an
uncertain outcome as successful, even when npm's subprocess exited cleanly.

After the last create, the script fetches and revalidates the complete
five-package registry closure and writes
`.artifacts/npm-namespace-bootstrap/completed.json`. Absence of that record means
the bootstrap is not complete. Keep `bootstrap` on `0.0.0-bootstrap.0`; do not
add or move `latest`. `completed.json` is written only after all five records
have been fetched again with only the required `bootstrap` and optional exact
singleton `latest` alias. Receipt schema 2 records each package's canonical
`observed_dist_tags` and `registry_latest_alias` boolean, plus
`stable_release: false` and the explicit alias policy. The inspection and
completion record repeat the exact source commit, helper and license hashes,
and npm version. A changed helper requires a newly reviewed clean commit and a
new output directory; never rewrite an old inspection or attribute new tooling
to an earlier commit. The namespace tarballs are unchanged by this metadata
compatibility update. Inspect the public result independently, and keep
the short-lived interactive session only through trusted-publisher setup and
verification:

```bash
npm_registry='https://registry.npmjs.org/'
npm_scope_registry='--@latchway:registry=https://registry.npmjs.org/'
npm view @latchway/client dist-tags versions repository --json --registry="$npm_registry" "$npm_scope_registry"
npm view @latchway/openai dist-tags versions repository --json --registry="$npm_registry" "$npm_scope_registry"
npm view @latchway/vercel-ai dist-tags versions repository --json --registry="$npm_registry" "$npm_scope_registry"
npm view @latchway/langchain dist-tags versions repository --json --registry="$npm_registry" "$npm_scope_registry"
npm view @latchway/react-native dist-tags versions repository --json --registry="$npm_registry" "$npm_scope_registry"
```

Once all five records exist, use npm 11.15.0 or newer (the reviewed 11.17.0
bootstrap toolchain already qualifies) to configure the selected
`single_maintainer_v1` GitHub Actions trusted publishers. `--file
single-maintainer-release.yml` is the workflow filename, not a path.
The four JavaScript packages trust `Latchway/latchway-js`; the React Native
package trusts `Latchway/latchway-react-native-sdk`. Every publisher is limited
to environment `single-maintainer-v1` and the publish action:

```bash
npm trust github @latchway/client --repository Latchway/latchway-js --file single-maintainer-release.yml --environment single-maintainer-v1 --allow-publish --yes --registry="$npm_registry"
npm trust github @latchway/openai --repository Latchway/latchway-js --file single-maintainer-release.yml --environment single-maintainer-v1 --allow-publish --yes --registry="$npm_registry"
npm trust github @latchway/vercel-ai --repository Latchway/latchway-js --file single-maintainer-release.yml --environment single-maintainer-v1 --allow-publish --yes --registry="$npm_registry"
npm trust github @latchway/langchain --repository Latchway/latchway-js --file single-maintainer-release.yml --environment single-maintainer-v1 --allow-publish --yes --registry="$npm_registry"
npm trust github @latchway/react-native --repository Latchway/latchway-react-native-sdk --file single-maintainer-release.yml --environment single-maintainer-v1 --allow-publish --yes --registry="$npm_registry"
```

This setup requires each package record to exist and the configuring npm account
to have two-factor authentication enabled. npm permits only one trusted-publisher
configuration per package, so a pre-existing configuration must be reviewed and
removed deliberately rather than overwritten by assumption. A granular access
token that bypasses two-factor authentication cannot configure trusted
publishing; use the authenticated npm 11.15.0-or-newer CLI session.

These five commands intentionally select the lower-assurance workflow. They
make the strict `release.yml` / `npm` tuple inactive. Before a later
`strict_full` release, explicitly replace each package's publisher with that
strict tuple and verify all five settings again.

Verify every exact configuration, then end the short-lived interactive session:

```bash
npm trust list @latchway/client --json --registry="$npm_registry"
npm trust list @latchway/openai --json --registry="$npm_registry"
npm trust list @latchway/vercel-ai --json --registry="$npm_registry"
npm trust list @latchway/langchain --json --registry="$npm_registry"
npm trust list @latchway/react-native --json --registry="$npm_registry"
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
