# Releasing `@latchway/client`

The repository contains a fail-closed npm release workflow. Version `1.0.0` is
the intended stable source coordinate; pushing its annotated tag remains an
explicit maintainer release action. Preparing that version does not create a
tag, an npm version, or a GitHub release.

## Registry and repository setup

Before the first automated release, configure these external controls:

1. Protect release tags and the `npm` GitHub environment. Require an independent
   reviewer for the environment.
2. In npm package settings, configure the GitHub Actions trusted publisher for
   organization `Latchway`, repository `latchway-js`, workflow file
   `release.yml`, environment `npm`, and the `npm publish` action.
3. Disallow package-token publication after trusted publishing is working.
   Never add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or an npm auth token to this
   repository or workflow.
4. Confirm the public package repository URL is exactly
   `https://github.com/Latchway/latchway-js`.

npm currently requires a package to exist before its trusted publisher can be
configured. If `@latchway/client` has no npm package record, initial namespace
bootstrap remains an external registry operation. Do not bypass that limitation
by adding a long-lived token to `release.yml`; complete the reviewed npm
bootstrap procedure first, then enable the trusted publisher and the automated
release path.

## Candidate preparation

Change `package.json` from the development version to an exact stable `X.Y.Z`
version in a reviewed commit. Do not use prerelease or build suffixes. Update
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
export checks, two clean reproducible builds, two byte-identical package
operations, an archive allowlist and credential scan, and clean Node ESM and
TypeScript consumers installed from the exact tarball.

Review `.artifacts/package-evidence.json`,
`.artifacts/release-candidate-evidence.json`, and `.artifacts/SHA256SUMS`.
Generated artifacts are ignored by Git and must not be committed.

## Tag and publish

After the release commit is on `main`, create and push an annotated tag whose
name exactly matches `v` plus `package.json` version:

```bash
git tag -a vX.Y.Z -m "@latchway/client X.Y.Z"
git push origin vX.Y.Z
```

Lightweight tags, non-canonical repositories, commits not reachable from
`origin/main`, mismatched versions, and any version containing `-dev` or another
prerelease suffix fail before dependency installation. The release workflow:

1. Repeats the full candidate gate in a clean GitHub-hosted runner.
2. Transfers only the verified tarball, checksum, and machine-readable evidence
   to a separately permissioned `npm` environment job.
3. Re-verifies the artifact and tag, then runs
   `npm publish "$RELEASE_TARBALL" --provenance --access public` with npm OIDC.
   It has `id-token: write` and no long-lived npm credential.
4. Downloads the exact registry tarball, checks byte identity and exports,
   validates npm signature and trusted-publisher metadata, verifies the SLSA
   provenance subject and source workflow/commit, and runs
   `npm audit signatures`.
5. Creates the GitHub release only after all registry checks pass. The release
   includes the tarball, `SHA256SUMS`, and verification evidence.

If npm accepts the package but a later step is interrupted, rerunning the same
tag is recoverable only when the immutable npm version has the exact verified
integrity. The post-publish provenance checks still have to bind it to the same
canonical tag, commit, workflow, and run; a merely matching version string is
never treated as success.

## Consumer verification

After release, a consumer can verify the downloaded archive checksum and npm
attestations:

```bash
shasum -a 256 -c SHA256SUMS
npm audit signatures
```

The GitHub workflow run, npm package version, and GitHub release must all report
the same version, SHA-256 checksum, SHA-512 integrity, source commit, and
annotated tag before the release is considered complete.
