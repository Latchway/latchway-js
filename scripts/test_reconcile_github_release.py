#!/usr/bin/env python3
"""Offline tests for fail-closed GitHub release reconciliation."""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("reconcile-github-release.py")
SPEC = importlib.util.spec_from_file_location("reconcile_github_release", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

REPOSITORY = "Latchway/example"
TAG = "v1.0.0"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
TAG_OBJECT = "89abcdef0123456789abcdef0123456789abcdef"


def subprocess_results(
    results: list[Any],
):
    remaining = iter(results)

    def run(arguments: list[str], **kwargs: Any) -> Any:
        result = next(remaining)
        for name in ("stdout", "stderr"):
            destination = kwargs.get(name)
            payload = getattr(result, name, None)
            if hasattr(destination, "write") and payload not in (None, "", b""):
                if isinstance(payload, str):
                    payload = payload.encode("utf-8")
                destination.write(payload)
                destination.flush()
        return MODULE.subprocess.CompletedProcess(arguments, result.returncode)

    return run


class FakeClient:
    def __init__(self, release: dict[str, Any] | None = None, contents: dict[int, bytes] | None = None) -> None:
        self.value = release
        self.contents = dict(contents or {})
        self.created = 0
        self.uploaded: list[str] = []
        self.finalized = 0
        self.downloaded_asset_ids: list[int] = []
        self.attestations_verified: list[str] = []
        self.release_attestations_verified: list[str] = []
        self.release_attested_commits: list[str] = []
        self.settings_reads = 0
        self.settings_enabled = True
        self.tag_validations: list[tuple[str, str, str]] = []
        self.reject_tag_validation_calls: set[int] = set()

    def immutable_releases_enabled(self, repository: str) -> bool:
        del repository
        self.settings_reads += 1
        return self.settings_enabled

    def release(self, repository: str, tag: str) -> dict[str, Any] | None:
        del repository, tag
        if self.value is None:
            return None
        return {
            **self.value,
            "assets": [dict(asset) for asset in self.value["assets"]],
        }

    def validate_remote_tag(self, repository: str, tag: str, expected_commit: str) -> None:
        self.tag_validations.append((repository, tag, expected_commit))
        if len(self.tag_validations) in self.reject_tag_validation_calls:
            raise MODULE.Rejected("Remote annotated release tag does not identify the promoted commit.")

    def create(self, repository: str, tag: str, title: str, prerelease: bool) -> None:
        del repository
        self.created += 1
        self.value = {
            "tag_name": tag,
            "name": title,
            "draft": True,
            "prerelease": prerelease,
            "immutable": False,
            "assets": [],
        }

    def download(
        self, repository: str, asset_id: int, destination: Path, maximum_bytes: int
    ) -> None:
        del repository
        self.downloaded_asset_ids.append(asset_id)
        payload = self.contents[asset_id]
        if len(payload) > maximum_bytes:
            raise RuntimeError("fake download exceeds bound")
        destination.write_bytes(payload)

    def upload(self, repository: str, tag: str, path: Path) -> None:
        del repository, tag
        assert self.value is not None
        asset_id = max(self.contents, default=0) + 1
        payload = path.read_bytes()
        self.contents[asset_id] = payload
        self.value["assets"].append({
            "id": asset_id,
            "name": path.name,
            "size": len(payload),
            "state": "uploaded",
        })
        self.uploaded.append(path.name)

    def finalize(self, repository: str, tag: str, prerelease: bool) -> None:
        del repository, tag, prerelease
        assert self.value is not None
        self.finalized += 1
        self.value["draft"] = False
        self.value["immutable"] = True

    def verify_attestation(self, repository: str, path: Path, source_commit: str) -> None:
        del repository, source_commit
        self.attestations_verified.append(path.name)

    def verify_release_attestation(
        self, repository: str, tag: str, expected_commit: str, assets: list[Any]
    ) -> None:
        del repository, tag
        self.release_attestations_verified = [asset.name for asset in assets]
        self.release_attested_commits.append(expected_commit)


def release(*, draft: bool, assets: list[dict[str, Any]], title: str = "Latchway v1.0.0") -> dict[str, Any]:
    return {
        "tag_name": "v1.0.0",
        "name": title,
        "draft": draft,
        "prerelease": False,
        "immutable": not draft,
        "assets": assets,
    }


def adoption_record(
    *,
    package_id: str,
    tarball: MODULE.Asset,
    manifest_sha256: str,
    source_commit: str,
    adoption_run_id: int,
    adoption_run_attempt: int,
    provenance_run_id: int = 100,
    provenance_run_attempt: int = 1,
) -> bytes:
    repository = "https://github.com/Latchway/example"
    tarball_bytes = tarball.path.read_bytes()
    sha512 = MODULE.hashlib.sha512(tarball_bytes).hexdigest()
    return (json.dumps({
        "schema_version": 1,
        "kind": "latchway_npm_release_adoption",
        "package": MODULE.ADOPTION_PACKAGES[package_id],
        "version": "1.0.0",
        "release_tag": "v1.0.0",
        "tarball": {
            "name": tarball.name,
            "bytes": len(tarball_bytes),
            "sha256": MODULE.hashlib.sha256(tarball_bytes).hexdigest(),
            "sha512": sha512,
            "integrity": f"sha512-{MODULE.base64.b64encode(bytes.fromhex(sha512)).decode('ascii')}",
        },
        "source": {
            "repository": repository,
            "commit": source_commit,
            "workflow": ".github/workflows/release.yml",
            "ref": "refs/heads/main",
        },
        "provenance": {
            "repository": repository,
            "commit": source_commit,
            "workflow": ".github/workflows/release.yml",
            "ref": "refs/heads/main",
            "predicate_type": "https://slsa.dev/provenance/v1",
            "invocation_id": (
                f"{repository}/actions/runs/{provenance_run_id}"
                f"/attempts/{provenance_run_attempt}"
            ),
            "run_id": provenance_run_id,
            "run_attempt": provenance_run_attempt,
        },
        "adoption": {
            "repository": repository,
            "commit": source_commit,
            "workflow": ".github/workflows/release.yml",
            "ref": "refs/heads/main",
            "run_id": adoption_run_id,
            "run_attempt": adoption_run_attempt,
            "mode": "adopted_existing",
        },
        "registry_evidence_manifest": {
            "file": "npm-registry-evidence-manifest.json",
            "sha256": manifest_sha256,
        },
    }, sort_keys=True) + "\n").encode()


class ReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.first_path = root / "first.tgz"
        self.second_path = root / "SHA256SUMS"
        self.first_path.write_bytes(b"first immutable bytes")
        self.second_path.write_bytes(b"digest  first.tgz\n")
        self.assets = MODULE.inspect_assets([str(self.first_path), str(self.second_path)])

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def reconcile(self, client: FakeClient) -> None:
        MODULE.reconcile(
            repository=REPOSITORY,
            tag=TAG,
            title="Latchway v1.0.0",
            prerelease=False,
            assets=self.assets,
            client=client,
            expected_commit=COMMIT,
        )

    def test_creates_uploads_and_finalizes_new_release(self) -> None:
        client = FakeClient()
        self.reconcile(client)
        self.assertEqual(client.created, 1)
        self.assertEqual(client.uploaded, ["SHA256SUMS", "first.tgz"])
        self.assertEqual(client.finalized, 1)
        self.assertEqual(client.tag_validations, [(REPOSITORY, TAG, COMMIT)] * 2)
        self.assertEqual(client.release_attested_commits, [COMMIT])

    def test_resumes_partial_draft_without_overwriting_identical_asset(self) -> None:
        first = next(asset for asset in self.assets if asset.name == "first.tgz")
        client = FakeClient(
            release(
                draft=True,
                assets=[{
                    "id": 7,
                    "name": first.name,
                    "size": first.size,
                    "state": "uploaded",
                    "digest": f"sha256:{first.sha256}",
                }],
            ),
            {7: self.first_path.read_bytes()},
        )
        self.reconcile(client)
        self.assertEqual(client.created, 0)
        self.assertEqual(client.uploaded, ["SHA256SUMS"])
        self.assertEqual(client.finalized, 1)
        self.assertEqual(client.tag_validations, [(REPOSITORY, TAG, COMMIT)])
        self.assertEqual(client.downloaded_asset_ids.count(7), 3)

    def test_exact_final_release_is_a_read_only_success(self) -> None:
        remote_assets = []
        contents: dict[int, bytes] = {}
        for identifier, asset in enumerate(self.assets, 1):
            remote_assets.append({
                "id": identifier,
                "name": asset.name,
                "size": asset.size,
                "state": "uploaded",
                "digest": f"sha256:{asset.sha256}",
            })
            contents[identifier] = asset.path.read_bytes()
        client = FakeClient(release(draft=False, assets=remote_assets), contents)
        self.reconcile(client)
        self.assertEqual(client.created, 0)
        self.assertEqual(client.uploaded, [])
        self.assertEqual(client.finalized, 0)
        self.assertEqual(client.tag_validations, [])
        self.assertEqual(client.release_attested_commits, [COMMIT])

    def test_rejects_different_existing_bytes(self) -> None:
        first = next(asset for asset in self.assets if asset.name == "first.tgz")
        client = FakeClient(
            release(draft=True, assets=[{
                "id": 1,
                "name": first.name,
                "size": first.size,
                "state": "uploaded",
            }]),
            {1: b"x" * first.size},
        )
        with self.assertRaisesRegex(MODULE.Rejected, "not byte-identical"):
            self.reconcile(client)
        self.assertEqual(client.uploaded, [])
        self.assertEqual(client.finalized, 0)

    def test_rejects_unexpected_asset_and_metadata_mismatch(self) -> None:
        unexpected = FakeClient(release(draft=True, assets=[{
            "id": 1, "name": "foreign.bin", "size": 1, "state": "uploaded",
        }]), {1: b"x"})
        with self.assertRaisesRegex(MODULE.Rejected, "unexpected asset"):
            self.reconcile(unexpected)

        wrong_title = FakeClient(release(draft=True, assets=[], title="wrong"))
        with self.assertRaisesRegex(MODULE.Rejected, "title"):
            self.reconcile(wrong_title)

    def test_final_release_cannot_be_backfilled(self) -> None:
        client = FakeClient(release(draft=False, assets=[]))
        with self.assertRaisesRegex(MODULE.Rejected, "missing immutable asset"):
            self.reconcile(client)
        self.assertEqual(client.uploaded, [])

    def test_final_release_must_be_github_immutable(self) -> None:
        value = release(draft=False, assets=[])
        value["immutable"] = False
        client = FakeClient(value)
        with self.assertRaisesRegex(MODULE.Rejected, "not immutable"):
            self.reconcile(client)

    def test_disabled_immutable_setting_rejects_before_release_lookup_or_mutation(self) -> None:
        client = FakeClient()
        client.settings_enabled = False
        with self.assertRaisesRegex(MODULE.Rejected, "not enforced"):
            self.reconcile(client)
        self.assertEqual(client.settings_reads, 1)
        self.assertEqual(client.created, 0)

    def test_release_attestation_covers_every_final_asset(self) -> None:
        client = FakeClient()
        self.reconcile(client)
        self.assertEqual(client.release_attestations_verified, ["SHA256SUMS", "first.tgz"])

    def test_rejects_remote_tag_change_before_create_without_mutation(self) -> None:
        client = FakeClient()
        client.reject_tag_validation_calls = {1}
        with self.assertRaisesRegex(MODULE.Rejected, "promoted commit"):
            self.reconcile(client)
        self.assertEqual(client.created, 0)
        self.assertEqual(client.uploaded, [])
        self.assertEqual(client.finalized, 0)

    def test_rejects_remote_tag_change_immediately_before_finalization(self) -> None:
        remote_assets = []
        contents: dict[int, bytes] = {}
        for identifier, asset in enumerate(self.assets, 1):
            remote_assets.append({
                "id": identifier,
                "name": asset.name,
                "size": asset.size,
                "state": "uploaded",
                "digest": f"sha256:{asset.sha256}",
            })
            contents[identifier] = asset.path.read_bytes()
        client = FakeClient(release(draft=True, assets=remote_assets), contents)
        client.reject_tag_validation_calls = {1}
        with self.assertRaisesRegex(MODULE.Rejected, "promoted commit"):
            self.reconcile(client)
        self.assertEqual(client.uploaded, [])
        self.assertEqual(client.finalized, 0)

    def test_rejects_noncanonical_expected_commit_before_remote_action(self) -> None:
        client = FakeClient()
        with self.assertRaisesRegex(MODULE.Rejected, "canonical Git object ID"):
            MODULE.reconcile(
                repository=REPOSITORY,
                tag=TAG,
                title="Latchway v1.0.0",
                prerelease=False,
                assets=self.assets,
                client=client,
                expected_commit="A" * 40,
            )
        self.assertEqual(client.settings_reads, 0)
        self.assertEqual(client.tag_validations, [])

    def test_prepare_creates_draft_and_accepts_only_declared_names(self) -> None:
        client = FakeClient()
        state = MODULE.prepare_release(
            repository="Latchway/example",
            tag="v1.0.0",
            title="Latchway v1.0.0",
            prerelease=False,
            expected_commit=COMMIT,
            expected_names={"first.tgz"},
            adoption_pattern=None,
            client=client,
        )
        self.assertEqual(state, "draft")
        client.value["assets"].append({"id": 1, "name": "foreign", "size": 1, "state": "uploaded"})
        with self.assertRaisesRegex(MODULE.Rejected, "unexpected asset"):
            MODULE.prepare_release(
                repository="Latchway/example",
                tag="v1.0.0",
                title="Latchway v1.0.0",
                prerelease=False,
                expected_commit=COMMIT,
                expected_names={"first.tgz"},
                adoption_pattern=None,
                client=client,
            )

    def test_retry_preserves_attested_adoption_history(self) -> None:
        commit = "a" * 40
        prior_name = "npm-release-adoption-client-100-1.json"
        current_name = "npm-release-adoption-client-200-2.json"
        tarball_path = Path(self.temporary.name) / "latchway-client-1.0.0.tgz"
        tarball_path.write_bytes(self.first_path.read_bytes())
        fixed = MODULE.inspect_assets([str(tarball_path)])[0]
        manifest_path = Path(self.temporary.name) / "npm-registry-evidence-manifest.json"
        manifest_path.write_bytes(b'{"schema_version":2}\n')
        manifest_sha256 = MODULE.hashlib.sha256(manifest_path.read_bytes()).hexdigest()

        def record(run_id: int, attempt: int) -> bytes:
            return adoption_record(
                package_id="client",
                tarball=fixed,
                manifest_sha256=manifest_sha256,
                source_commit=commit,
                adoption_run_id=run_id,
                adoption_run_attempt=attempt,
                provenance_run_id=50,
            )

        current_path = Path(self.temporary.name) / current_name
        current_path.write_bytes(record(200, 2))
        prior = record(100, 1)
        client = FakeClient(
            release(draft=True, assets=[
                {"id": 1, "name": fixed.name, "size": fixed.size, "state": "uploaded"},
                {"id": 2, "name": prior_name, "size": len(prior), "state": "uploaded"},
            ]),
            {1: fixed.path.read_bytes(), 2: prior},
        )
        MODULE.reconcile(
            repository="Latchway/example",
            tag="v1.0.0",
            title="Latchway v1.0.0",
            prerelease=False,
            assets=MODULE.inspect_assets([
                str(fixed.path), str(manifest_path), str(current_path),
            ]),
            client=client,
            expected_commit=commit,
            adoption_pattern=MODULE.ADOPTION_PATTERN,
        )
        self.assertIn(current_name, client.uploaded)
        self.assertEqual(
            client.attestations_verified,
            [
                prior_name, current_name,
                prior_name, current_name,
                prior_name, current_name,
            ],
        )
        self.assertTrue(client.value["immutable"])
        self.assertEqual(set(client.release_attestations_verified), {
            fixed.name, "npm-registry-evidence-manifest.json", prior_name, current_name,
        })

        local_assets = MODULE.inspect_assets([
            str(fixed.path), str(manifest_path), str(current_path),
        ])
        manifest_asset = next(
            asset for asset in local_assets
            if asset.name == "npm-registry-evidence-manifest.json"
        )
        immutable_client = FakeClient(
            release(draft=False, assets=[
                {"id": 1, "name": fixed.name, "size": fixed.size, "state": "uploaded"},
                {"id": 2, "name": manifest_asset.name, "size": manifest_asset.size,
                 "state": "uploaded"},
                {"id": 3, "name": prior_name, "size": len(prior), "state": "uploaded"},
            ]),
            {
                1: fixed.path.read_bytes(),
                2: manifest_path.read_bytes(),
                3: prior,
            },
        )
        MODULE.reconcile(
            repository="Latchway/example",
            tag="v1.0.0",
            title="Latchway v1.0.0",
            prerelease=False,
            assets=local_assets,
            client=immutable_client,
            expected_commit=commit,
            adoption_pattern=MODULE.ADOPTION_PATTERN,
        )
        self.assertEqual(immutable_client.uploaded, [])
        self.assertEqual(immutable_client.finalized, 0)
        self.assertEqual(immutable_client.attestations_verified, [prior_name, prior_name])
        self.assertEqual(set(immutable_client.release_attestations_verified), {
            fixed.name, "npm-registry-evidence-manifest.json", prior_name,
        })
        tampered = json.loads(record(200, 2))
        tampered["tarball"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.validate_adoption_record(
                (json.dumps(tampered) + "\n").encode(),
                name=current_name,
                repository="Latchway/example",
                tag="v1.0.0",
                source_commit=commit,
                tarballs={fixed.name: fixed},
                manifest_sha256=manifest_sha256,
            )

        duplicate_key = record(200, 2).replace(
            b"{", b'{"schema_version":1,', 1,
        )
        with self.assertRaisesRegex(MODULE.Rejected, "not valid JSON"):
            MODULE.validate_adoption_record(
                duplicate_key,
                name=current_name,
                repository="Latchway/example",
                tag="v1.0.0",
                source_commit=commit,
                tarballs={fixed.name: fixed},
                manifest_sha256=manifest_sha256,
            )

        wrong_package_tarball_path = (
            Path(self.temporary.name) / "latchway-openai-1.0.0.tgz"
        )
        wrong_package_tarball_path.write_bytes(fixed.path.read_bytes())
        wrong_package_tarball = MODULE.inspect_assets([str(wrong_package_tarball_path)])[0]
        cross_bound = json.loads(record(200, 2))
        cross_bound["tarball"]["name"] = wrong_package_tarball.name
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.validate_adoption_record(
                (json.dumps(cross_bound) + "\n").encode(),
                name=current_name,
                repository="Latchway/example",
                tag="v1.0.0",
                source_commit=commit,
                tarballs={
                    fixed.name: fixed,
                    wrong_package_tarball.name: wrong_package_tarball,
                },
                manifest_sha256=manifest_sha256,
            )

        for invalid_run_id in (True, MODULE.MAXIMUM_JSON_SAFE_INTEGER + 1):
            with self.subTest(invalid_provenance_run_id=invalid_run_id):
                invalid_id = json.loads(record(200, 2))
                invalid_id["provenance"]["run_id"] = invalid_run_id
                invalid_id["provenance"]["invocation_id"] = (
                    "https://github.com/Latchway/example/actions/runs/"
                    f"{invalid_run_id}/attempts/1"
                )
                with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
                    MODULE.validate_adoption_record(
                        (json.dumps(invalid_id) + "\n").encode(),
                        name=current_name,
                        repository="Latchway/example",
                        tag="v1.0.0",
                        source_commit=commit,
                        tarballs={fixed.name: fixed},
                        manifest_sha256=manifest_sha256,
                    )

        unbounded_run_id = MODULE.MAXIMUM_JSON_SAFE_INTEGER + 1
        unbounded_record = adoption_record(
            package_id="client",
            tarball=fixed,
            manifest_sha256=manifest_sha256,
            source_commit=commit,
            adoption_run_id=unbounded_run_id,
            adoption_run_attempt=2,
        )
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.validate_adoption_record(
                unbounded_record,
                name=f"npm-release-adoption-client-{unbounded_run_id}-2.json",
                repository="Latchway/example",
                tag="v1.0.0",
                source_commit=commit,
                tarballs={fixed.name: fixed},
                manifest_sha256=manifest_sha256,
            )

        oversized_remote = FakeClient(
            release(draft=True, assets=[
                {"id": 1, "name": fixed.name, "size": fixed.size, "state": "uploaded"},
                {
                    "id": 2,
                    "name": prior_name,
                    "size": MODULE.MAXIMUM_ADOPTION_RECORD_BYTES + 1,
                    "state": "uploaded",
                },
            ]),
            {1: fixed.path.read_bytes(), 2: prior},
        )
        with self.assertRaisesRegex(MODULE.Rejected, "invalid remote asset metadata"):
            MODULE.reconcile(
                repository="Latchway/example",
                tag="v1.0.0",
                title="Latchway v1.0.0",
                prerelease=False,
                assets=local_assets,
                client=oversized_remote,
                expected_commit=commit,
                adoption_pattern=MODULE.ADOPTION_PATTERN,
            )
        self.assertEqual(oversized_remote.uploaded, [])
        self.assertEqual(oversized_remote.finalized, 0)
        self.assertEqual(oversized_remote.downloaded_asset_ids, [])

        for invalid_asset_id in (True, MODULE.MAXIMUM_JSON_SAFE_INTEGER + 1):
            with self.subTest(invalid_remote_asset_id=invalid_asset_id):
                invalid_remote = FakeClient(
                    release(draft=True, assets=[
                        {
                            "id": invalid_asset_id,
                            "name": prior_name,
                            "size": len(prior),
                            "state": "uploaded",
                        },
                    ]),
                    {2: prior},
                )
                with self.assertRaisesRegex(MODULE.Rejected, "invalid identifier"):
                    MODULE.reconcile(
                        repository="Latchway/example",
                        tag="v1.0.0",
                        title="Latchway v1.0.0",
                        prerelease=False,
                        assets=local_assets,
                        client=invalid_remote,
                        expected_commit=commit,
                        adoption_pattern=MODULE.ADOPTION_PATTERN,
                    )
                self.assertEqual(invalid_remote.downloaded_asset_ids, [])
                self.assertEqual(invalid_remote.uploaded, [])
                self.assertEqual(invalid_remote.finalized, 0)

        invalid_prior = b"{}\n"
        bad_client = FakeClient(
            release(draft=True, assets=[
                {"id": 1, "name": fixed.name, "size": fixed.size, "state": "uploaded"},
                {"id": 2, "name": prior_name, "size": len(invalid_prior), "state": "uploaded"},
            ]),
            {1: fixed.path.read_bytes(), 2: invalid_prior},
        )
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.reconcile(
                repository="Latchway/example",
                tag="v1.0.0",
                title="Latchway v1.0.0",
                prerelease=False,
                assets=MODULE.inspect_assets([
                    str(fixed.path), str(manifest_path), str(current_path),
                ]),
                client=bad_client,
                expected_commit=commit,
                adoption_pattern=MODULE.ADOPTION_PATTERN,
            )
        self.assertEqual(bad_client.uploaded, [])
        self.assertEqual(bad_client.finalized, 0)

        wrong_manifest = json.loads(record(200, 2))
        wrong_manifest["registry_evidence_manifest"]["sha256"] = "b" * 64
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.validate_adoption_record(
                (json.dumps(wrong_manifest) + "\n").encode(),
                name=current_name,
                repository="Latchway/example",
                tag="v1.0.0",
                source_commit=commit,
                tarballs={fixed.name: fixed},
                manifest_sha256=manifest_sha256,
            )

        published_with_foreign_provenance = json.loads(record(200, 2))
        published_with_foreign_provenance["adoption"]["mode"] = "published"
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.validate_adoption_record(
                (json.dumps(published_with_foreign_provenance) + "\n").encode(),
                name=current_name,
                repository="Latchway/example",
                tag="v1.0.0",
                source_commit=commit,
                tarballs={fixed.name: fixed},
                manifest_sha256=manifest_sha256,
            )

        adopted_with_current_provenance = json.loads(record(200, 2))
        adopted_with_current_provenance["provenance"]["run_id"] = 200
        adopted_with_current_provenance["provenance"]["run_attempt"] = 2
        adopted_with_current_provenance["provenance"]["invocation_id"] = (
            "https://github.com/Latchway/example/actions/runs/200/attempts/2"
        )
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.validate_adoption_record(
                (json.dumps(adopted_with_current_provenance) + "\n").encode(),
                name=current_name,
                repository="Latchway/example",
                tag="v1.0.0",
                source_commit=commit,
                tarballs={fixed.name: fixed},
                manifest_sha256=manifest_sha256,
            )

        published_current = json.loads(record(200, 2))
        published_current["provenance"] = adopted_with_current_provenance["provenance"]
        published_current["adoption"]["mode"] = "published"
        MODULE.validate_adoption_record(
            (json.dumps(published_current) + "\n").encode(),
            name=current_name,
            repository="Latchway/example",
            tag="v1.0.0",
            source_commit=commit,
            tarballs={fixed.name: fixed},
            manifest_sha256=manifest_sha256,
        )

    def test_finalization_revalidates_historical_adoption_bytes(self) -> None:
        commit = "a" * 40
        prior_name = "npm-release-adoption-client-100-1.json"
        current_name = "npm-release-adoption-client-200-2.json"
        tarball_path = Path(self.temporary.name) / "latchway-client-1.0.0.tgz"
        tarball_path.write_bytes(self.first_path.read_bytes())
        fixed = MODULE.inspect_assets([str(tarball_path)])[0]
        manifest_path = Path(self.temporary.name) / "npm-registry-evidence-manifest.json"
        manifest_path.write_bytes(b'{"schema_version":2}\n')
        manifest_sha256 = MODULE.hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        prior = adoption_record(
            package_id="client",
            tarball=fixed,
            manifest_sha256=manifest_sha256,
            source_commit=commit,
            adoption_run_id=100,
            adoption_run_attempt=1,
            provenance_run_id=99,
        )
        current_path = Path(self.temporary.name) / current_name
        current_path.write_bytes(adoption_record(
            package_id="client",
            tarball=fixed,
            manifest_sha256=manifest_sha256,
            source_commit=commit,
            adoption_run_id=200,
            adoption_run_attempt=2,
        ))

        class MutatingDraftClient(FakeClient):
            def finalize(self, repository: str, tag: str, prerelease: bool) -> None:
                # Simulate another allowed draft writer replacing bytes in the
                # narrow interval before GitHub makes the release immutable.
                self.contents[2] = self.contents[2].replace(
                    commit.encode(), b"b" * 40,
                )
                super().finalize(repository, tag, prerelease)

        client = MutatingDraftClient(
            release(draft=True, assets=[
                {"id": 1, "name": fixed.name, "size": fixed.size, "state": "uploaded"},
                {"id": 2, "name": prior_name, "size": len(prior), "state": "uploaded"},
            ]),
            {1: fixed.path.read_bytes(), 2: prior},
        )
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.reconcile(
                repository="Latchway/example",
                tag="v1.0.0",
                title="Latchway v1.0.0",
                prerelease=False,
                assets=MODULE.inspect_assets([
                    str(fixed.path), str(manifest_path), str(current_path),
                ]),
                client=client,
                expected_commit=commit,
                adoption_pattern=MODULE.ADOPTION_PATTERN,
            )
        self.assertEqual(client.finalized, 1)
        self.assertEqual(client.release_attestations_verified, [])
        self.assertGreaterEqual(client.downloaded_asset_ids.count(2), 2)

    def test_prefinalization_revalidation_rejects_changed_adoption_without_finalizing(self) -> None:
        commit = "a" * 40
        prior_name = "npm-release-adoption-client-100-1.json"
        current_name = "npm-release-adoption-client-200-2.json"
        tarball_path = Path(self.temporary.name) / "latchway-client-1.0.0.tgz"
        tarball_path.write_bytes(self.first_path.read_bytes())
        fixed = MODULE.inspect_assets([str(tarball_path)])[0]
        manifest_path = Path(self.temporary.name) / "npm-registry-evidence-manifest.json"
        manifest_path.write_bytes(b'{"schema_version":2}\n')
        manifest_sha256 = MODULE.hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        prior = adoption_record(
            package_id="client",
            tarball=fixed,
            manifest_sha256=manifest_sha256,
            source_commit=commit,
            adoption_run_id=100,
            adoption_run_attempt=1,
            provenance_run_id=99,
        )
        current_path = Path(self.temporary.name) / current_name
        current_path.write_bytes(adoption_record(
            package_id="client",
            tarball=fixed,
            manifest_sha256=manifest_sha256,
            source_commit=commit,
            adoption_run_id=200,
            adoption_run_attempt=2,
        ))

        class MutatingBeforeFinalizeClient(FakeClient):
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, **kwargs)
                self.release_reads = 0

            def release(self, repository: str, tag: str) -> dict[str, Any] | None:
                self.release_reads += 1
                # The second lookup is the post-upload snapshot. Change the
                # retained draft bytes before the immediate pre-finalize pass.
                if self.release_reads == 2:
                    self.contents[2] = self.contents[2].replace(
                        commit.encode(), b"b" * 40,
                    )
                return super().release(repository, tag)

        client = MutatingBeforeFinalizeClient(
            release(draft=True, assets=[
                {"id": 1, "name": fixed.name, "size": fixed.size, "state": "uploaded"},
                {"id": 2, "name": prior_name, "size": len(prior), "state": "uploaded"},
            ]),
            {1: fixed.path.read_bytes(), 2: prior},
        )
        with self.assertRaisesRegex(MODULE.Rejected, "not bound"):
            MODULE.reconcile(
                repository="Latchway/example",
                tag="v1.0.0",
                title="Latchway v1.0.0",
                prerelease=False,
                assets=MODULE.inspect_assets([
                    str(fixed.path), str(manifest_path), str(current_path),
                ]),
                client=client,
                expected_commit=commit,
                adoption_pattern=MODULE.ADOPTION_PATTERN,
            )
        self.assertEqual(client.finalized, 0)
        self.assertEqual(client.release_attestations_verified, [])
        self.assertGreaterEqual(client.downloaded_asset_ids.count(2), 2)

    def test_adoption_history_identifies_all_four_javascript_packages(self) -> None:
        names = {
            f"npm-release-adoption-{package_id}-200-2.json"
            for package_id in ("client", "openai", "vercel-ai", "langchain")
        }
        self.assertEqual(
            MODULE.adoption_package_ids(names),
            {"client", "openai", "vercel-ai", "langchain"},
        )
        with self.assertRaisesRegex(MODULE.Rejected, "invalid package record"):
            MODULE.adoption_package_ids({"npm-release-adoption-200-2.json"})

    def test_admin_preflight_requires_exact_enabled_response_and_consumes_protected_token(self) -> None:
        client = MODULE.GitHubClient()
        accepted = {"enabled": True, "enforced_by_owner": True}
        with patch.dict(
            os.environ, {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN": "token"}, clear=True
        ), patch.object(
            MODULE.subprocess,
            "run",
            side_effect=subprocess_results([
                MODULE.subprocess.CompletedProcess([], 0, json.dumps(accepted), "")
            ]),
        ) as run:
            self.assertTrue(client.immutable_releases_enabled(REPOSITORY))
            self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", os.environ)
            arguments = run.call_args.args[0]
            self.assertIn("X-GitHub-Api-Version: 2026-03-10", arguments)
            self.assertIn(f"repos/{REPOSITORY}/immutable-releases", arguments)
            environment = run.call_args.kwargs["env"]
            self.assertEqual(environment["GH_TOKEN"], "token")
            self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", environment)

        for response in (
            {"enabled": False, "enforced_by_owner": False},
            {"enabled": True, "enforced_by_owner": False},
            {"enabled": True},
            {"enabled": True, "enforced_by_owner": True, "unexpected": True},
        ):
            with self.subTest(response=response), patch.dict(
                os.environ, {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN": "token"}, clear=True
            ), patch.object(
                MODULE.subprocess,
                "run",
                side_effect=subprocess_results([
                    MODULE.subprocess.CompletedProcess([], 0, json.dumps(response), "")
                ]),
            ):
                self.assertFalse(client.immutable_releases_enabled(REPOSITORY))
                self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", os.environ)

        with patch.dict(
            os.environ, {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN": "token"}, clear=True
        ), patch.object(
            MODULE.subprocess,
            "run",
            side_effect=subprocess_results([
                MODULE.subprocess.CompletedProcess(
                    [], 0, '{"enabled":false,"enabled":true,"enforced_by_owner":true}', ""
                )
            ]),
        ):
            self.assertFalse(client.immutable_releases_enabled(REPOSITORY))
            self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", os.environ)

    def test_verified_policy_handoff_is_exact_and_skips_admin_credential(self) -> None:
        path = Path(self.temporary.name) / "immutable-release-policy.json"
        now = 1_800_000_000
        value = {
            "schema_version": 2,
            "kind": "latchway_github_immutable_release_policy",
            "repository": REPOSITORY,
            "run_id": 41,
            "run_attempt": 2,
            "issued_at": now,
            "expires_at": now + MODULE.MAXIMUM_POLICY_TTL_SECONDS,
            "settings": {"enabled": True, "enforced_by_owner": True},
        }
        path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
        digest = MODULE.hashlib.sha256(path.read_bytes()).hexdigest()
        expires_at = MODULE.validate_immutable_policy_evidence(
            path,
            repository=REPOSITORY,
            expected_sha256=digest,
            expected_run_id=41,
            expected_run_attempt=2,
            current_time=now,
        )
        self.assertEqual(expires_at, value["expires_at"])
        client = FakeClient()
        with patch.object(MODULE.time, "time", return_value=now):
            MODULE.reconcile(
                repository=REPOSITORY,
                tag=TAG,
                title="Latchway v1.0.0",
                prerelease=False,
                assets=self.assets,
                client=client,
                expected_commit=COMMIT,
                immutable_policy_expires_at=expires_at,
            )
        self.assertEqual(client.settings_reads, 0)

        for label, mutation in (
            ("repository", {**value, "repository": "Latchway/other"}),
            ("disabled", {**value, "settings": {"enabled": False, "enforced_by_owner": True}}),
            ("owner_false", {**value, "settings": {"enabled": True, "enforced_by_owner": False}}),
            ("schema_boolean", {**value, "schema_version": True}),
            ("wrong_run", {**value, "run_id": 42}),
            ("wrong_attempt", {**value, "run_attempt": 1}),
            ("unsafe_run", {**value, "run_id": 9_007_199_254_740_992}),
            ("boolean_attempt", {**value, "run_attempt": True}),
            ("stale", {**value, "issued_at": now - 60, "expires_at": now}),
            ("future", {**value, "issued_at": now + 1, "expires_at": now + 60}),
            ("over_ttl", {**value, "expires_at": now + MODULE.MAXIMUM_POLICY_TTL_SECONDS + 1}),
        ):
            with self.subTest(label=label):
                path.write_text(json.dumps(mutation, sort_keys=True) + "\n", encoding="utf-8")
                mutated_digest = MODULE.hashlib.sha256(path.read_bytes()).hexdigest()
                rejected_client = FakeClient()
                with self.assertRaisesRegex(MODULE.Rejected, "authorize"):
                    rejected_expiry = MODULE.validate_immutable_policy_evidence(
                        path,
                        repository=REPOSITORY,
                        expected_sha256=mutated_digest,
                        expected_run_id=41,
                        expected_run_attempt=2,
                        current_time=now,
                    )
                    MODULE.reconcile(
                        repository=REPOSITORY,
                        tag=TAG,
                        title="Latchway v1.0.0",
                        prerelease=False,
                        assets=self.assets,
                        client=rejected_client,
                        expected_commit=COMMIT,
                        immutable_policy_expires_at=rejected_expiry,
                    )
                self.assertEqual(rejected_client.settings_reads, 0)
                self.assertEqual(rejected_client.created, 0)
                self.assertEqual(rejected_client.uploaded, [])
                self.assertEqual(rejected_client.finalized, 0)

        for expected_run_id, expected_run_attempt in (
            (0, 2),
            (9_007_199_254_740_992, 2),
            (41, True),
        ):
            with self.subTest(
                expected_run_id=expected_run_id,
                expected_run_attempt=expected_run_attempt,
            ), self.assertRaisesRegex(MODULE.Rejected, "invalid expected run coordinates"):
                MODULE.validate_immutable_policy_evidence(
                    path,
                    repository=REPOSITORY,
                    expected_sha256=digest,
                    expected_run_id=expected_run_id,
                    expected_run_attempt=expected_run_attempt,
                    current_time=now,
                )

    def test_policy_cli_rejects_unbounded_run_coordinate_without_integer_conversion(self) -> None:
        path = Path(self.temporary.name) / "immutable-release-policy.json"
        arguments = [
            str(SCRIPT),
            "--repository", REPOSITORY,
            "--tag", TAG,
            "--title", "Latchway v1.0.0",
            "--expected-commit", COMMIT,
            "--verified-immutable-policy", str(path),
            "--verified-immutable-policy-sha256", "a" * 64,
            "--verified-immutable-policy-run-id", "9" * 5_000,
            "--verified-immutable-policy-run-attempt", "1",
            str(self.assets[0].path),
        ]
        with patch.object(sys, "argv", arguments), patch(
            "sys.stderr", new=io.StringIO()
        ), self.assertRaises(SystemExit) as raised:
            MODULE.parse_arguments()
        self.assertEqual(raised.exception.code, 2)

    def test_policy_expiry_immediately_before_finalize_prevents_finalization(self) -> None:
        now = 1_800_000_000
        remote_assets = []
        contents: dict[int, bytes] = {}
        for identifier, asset in enumerate(self.assets, 1):
            remote_assets.append({
                "id": identifier,
                "name": asset.name,
                "size": asset.size,
                "state": "uploaded",
                "digest": f"sha256:{asset.sha256}",
            })
            contents[identifier] = asset.path.read_bytes()
        client = FakeClient(release(draft=True, assets=remote_assets), contents)
        with patch.object(MODULE.time, "time", side_effect=[now, now + 10]):
            with self.assertRaisesRegex(MODULE.Rejected, "expired before release mutation"):
                MODULE.reconcile(
                    repository=REPOSITORY,
                    tag=TAG,
                    title="Latchway v1.0.0",
                    prerelease=False,
                    assets=self.assets,
                    client=client,
                    expected_commit=COMMIT,
                    immutable_policy_expires_at=now + 10,
                )
        self.assertEqual(client.settings_reads, 0)
        self.assertEqual(client.uploaded, [])
        self.assertEqual(client.finalized, 0)

    def test_admin_preflight_rejects_missing_or_multiline_token_without_network(self) -> None:
        client = MODULE.GitHubClient()
        for token in (None, "bad\nvalue"):
            environment = {} if token is None else {"LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN": token}
            with self.subTest(token=token), patch.dict(os.environ, environment, clear=True), patch.object(
                MODULE.subprocess, "run"
            ) as run:
                with self.assertRaisesRegex(RuntimeError, "credential is missing"):
                    client.immutable_releases_enabled(REPOSITORY)
                self.assertNotIn("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", os.environ)
                run.assert_not_called()

    def test_adoption_attestation_is_pinned_to_exact_source_commit(self) -> None:
        commit = "c" * 40
        with patch.object(MODULE, "_run") as run:
            MODULE.GitHubClient().verify_attestation(
                "Latchway/example", self.first_path, commit
            )
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--source-digest") + 1], commit)


def attestation_document(
    assets: list[MODULE.Asset],
    *,
    commit: str = COMMIT,
    include_all_assets: bool = True,
) -> dict[str, Any]:
    subjects = [{
        "uri": f"pkg:github/{REPOSITORY}@{TAG}",
        "digest": {"sha1": commit},
    }]
    if include_all_assets:
        subjects.extend(
            {"name": asset.name, "digest": {"sha256": asset.sha256}}
            for asset in assets
        )
    statement = {
        "_type": MODULE.STATEMENT_TYPE,
        "subject": subjects,
        "predicateType": MODULE.RELEASE_PREDICATE_TYPE,
        "predicate": {"release": {"tag": TAG}},
    }
    encoded = base64.b64encode(
        json.dumps(statement, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).decode("ascii")
    return {
        "attestation": {"bundle": {"dsseEnvelope": {
            "payloadType": "application/vnd.in-toto+json",
            "payload": encoded,
            "signatures": [{"sig": "verified-by-gh"}],
        }}},
        "verificationResult": {"verified": True},
    }


class GitHubClientTests(unittest.TestCase):
    def make_assets(self, temporary: str) -> list[MODULE.Asset]:
        first = Path(temporary, "first.tgz")
        second = Path(temporary, "SHA256SUMS")
        first.write_bytes(b"first")
        second.write_bytes(b"sum")
        return MODULE.inspect_assets([str(first), str(second)])

    def test_json_command_rejects_oversized_and_duplicate_key_documents(self) -> None:
        cases = (
            (b'{"value":"too large"}', 8, "oversized JSON"),
            (b'{"value":1,"value":2}', 128, "invalid JSON"),
        )
        for payload, maximum_bytes, message in cases:
            with self.subTest(message=message), patch.object(
                MODULE.subprocess,
                "run",
                side_effect=subprocess_results([
                    MODULE.subprocess.CompletedProcess([], 0, payload, b"")
                ]),
            ), self.assertRaisesRegex(RuntimeError, message):
                MODULE._execute_json_command(
                    ["gh", "api", "test"],
                    "bounded GitHub JSON test",
                    maximum_bytes=maximum_bytes,
                )

    @unittest.skipIf(MODULE.resource is None, "POSIX file-size limits are unavailable")
    def test_json_command_bounds_producer_output_and_runtime(self) -> None:
        with self.assertRaises(RuntimeError):
            MODULE._execute_json_command(
                [
                    sys.executable,
                    "-c",
                    f'import sys; sys.stdout.write("x" * {MODULE.MAXIMUM_DIAGNOSTIC_BYTES + 4096})',
                ],
                "bounded producer output test",
                maximum_bytes=128,
            )
        with patch.object(MODULE, "MAXIMUM_API_COMMAND_SECONDS", 0.01):
            with self.assertRaisesRegex(RuntimeError, "timeout"):
                MODULE._execute_json_command(
                    [sys.executable, "-c", "import time; time.sleep(1)"],
                    "bounded producer runtime test",
                    maximum_bytes=128,
                )

    def test_download_rejects_output_beyond_call_site_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, patch.object(
            MODULE.subprocess,
            "run",
            side_effect=subprocess_results([
                MODULE.subprocess.CompletedProcess([], 0, b"123456789", b"")
            ]),
        ):
            with self.assertRaisesRegex(RuntimeError, "invalid amount"):
                MODULE.GitHubClient().download(
                    REPOSITORY, 1, Path(temporary, "asset"), 8
                )

    def test_command_failure_caps_and_sanitizes_retained_stderr(self) -> None:
        secret = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        diagnostic = f"Bearer {secret}\n".encode("utf-8") + (
            b"x" * (MODULE.MAXIMUM_DIAGNOSTIC_BYTES + 100)
        )
        with patch.object(
            MODULE.subprocess,
            "run",
            side_effect=subprocess_results([
                MODULE.subprocess.CompletedProcess([], 1, b"", diagnostic)
            ]),
        ):
            with self.assertRaisesRegex(RuntimeError, "truncated") as raised:
                MODULE._execute_json_command(
                    ["gh", "api", "test"],
                    "failed GitHub JSON test",
                    maximum_bytes=128,
                )
        message = str(raised.exception)
        self.assertNotIn(secret, message)
        self.assertNotIn("\n", message)
        self.assertLessEqual(
            len(message), MODULE.MAXIMUM_DIAGNOSTIC_BYTES + 128
        )

    def test_release_and_each_asset_attestation_retry_then_bind_exact_closure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            assets = self.make_assets(temporary)
            document = json.dumps(attestation_document(assets))
            results = [
                MODULE.subprocess.CompletedProcess([], 1, "", "not propagated"),
                MODULE.subprocess.CompletedProcess([], 0, document, ""),
                MODULE.subprocess.CompletedProcess([], 1, "", "asset not propagated"),
                MODULE.subprocess.CompletedProcess([], 0, document, ""),
                MODULE.subprocess.CompletedProcess([], 0, document, ""),
            ]
            with patch.dict(
                os.environ,
                {
                    "LATCHWAY_GITHUB_RELEASE_ATTESTATION_ATTEMPTS": "2",
                    "LATCHWAY_GITHUB_RELEASE_ATTESTATION_DELAY_SECONDS": "1",
                },
            ), patch.object(
                MODULE.subprocess, "run", side_effect=subprocess_results(results)
            ) as run, patch.object(
                MODULE.time, "sleep"
            ) as sleep:
                MODULE.GitHubClient().verify_release_attestation(
                    REPOSITORY, TAG, COMMIT, assets
                )
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(commands[0], commands[1])
            self.assertEqual(commands[2], commands[3])
            self.assertEqual(commands[0][:4], ["gh", "release", "verify", TAG])
            self.assertEqual(
                {Path(command[4]).name for command in commands[3:]},
                {"first.tgz", "SHA256SUMS"},
            )
            self.assertEqual(sleep.call_count, 2)

    def test_release_attestation_rejects_wrong_commit_missing_asset_and_wrong_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            assets = self.make_assets(temporary)
            wrong_asset = attestation_document(assets)
            payload = wrong_asset["attestation"]["bundle"]["dsseEnvelope"]["payload"]
            statement = json.loads(base64.b64decode(payload, validate=True))
            statement["subject"][1]["digest"]["sha256"] = "f" * 64
            wrong_asset["attestation"]["bundle"]["dsseEnvelope"]["payload"] = (
                base64.b64encode(json.dumps(statement).encode("utf-8")).decode("ascii")
            )
            for document, message in (
                (attestation_document(assets, commit="f" * 40), "promoted source commit"),
                (attestation_document(assets, include_all_assets=False), "exact release asset set"),
                (wrong_asset, "exact asset bytes"),
            ):
                with self.subTest(message=message), patch.object(
                    MODULE.subprocess,
                    "run",
                    side_effect=subprocess_results([
                        MODULE.subprocess.CompletedProcess([], 0, json.dumps(document), "")
                    ]),
                ):
                    with self.assertRaisesRegex(MODULE.Rejected, message):
                        MODULE.GitHubClient().verify_release_attestation(
                            REPOSITORY, TAG, COMMIT, assets
                        )

    def test_release_attestation_rejects_duplicate_or_malformed_outer_and_dsse_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            assets = self.make_assets(temporary)
            malformed_envelope = attestation_document(assets)
            del malformed_envelope["attestation"]["bundle"]["dsseEnvelope"]["signatures"]
            valid = attestation_document(assets)
            payload = base64.b64decode(
                valid["attestation"]["bundle"]["dsseEnvelope"]["payload"], validate=True
            ).decode("utf-8")
            duplicate_inner = payload.replace('"_type":', '"_type":"duplicate","_type":', 1)
            inner_document = attestation_document(assets)
            inner_document["attestation"]["bundle"]["dsseEnvelope"]["payload"] = (
                base64.b64encode(duplicate_inner.encode("utf-8")).decode("ascii")
            )
            noncanonical_base64 = attestation_document(assets)
            encoded = noncanonical_base64["attestation"]["bundle"]["dsseEnvelope"]["payload"]
            self.assertTrue(encoded.endswith("=="))
            replacement = "R" if encoded[-3] == "Q" else "B"
            noncanonical_base64["attestation"]["bundle"]["dsseEnvelope"]["payload"] = (
                f"{encoded[:-3]}{replacement}=="
            )
            self.assertEqual(
                base64.b64decode(encoded, validate=True),
                base64.b64decode(
                    noncanonical_base64["attestation"]["bundle"]["dsseEnvelope"]["payload"],
                    validate=True,
                ),
            )
            outputs = [
                "",
                "not-json",
                "[]",
                "{}",
                '{"attestation":{},"attestation":{},"verificationResult":{}}',
                '{"attestation":NaN,"verificationResult":{}}',
                '{"attestation":1e9999,"verificationResult":{}}',
                '{"attestation":9007199254740992,"verificationResult":{}}',
                json.dumps(malformed_envelope),
                json.dumps(inner_document),
                json.dumps(noncanonical_base64),
            ]
            for output in outputs:
                with self.subTest(output=output[:40]), patch.object(
                    MODULE.subprocess,
                    "run",
                    side_effect=subprocess_results([
                        MODULE.subprocess.CompletedProcess([], 0, output, "")
                    ]),
                ):
                    with self.assertRaises((RuntimeError, MODULE.Rejected)):
                        MODULE.GitHubClient().verify_release_attestation(
                            REPOSITORY, TAG, COMMIT, assets
                        )

    def test_remote_tag_requires_exact_annotated_object_and_commit(self) -> None:
        reference = {
            "ref": f"refs/tags/{TAG}",
            "object": {"type": "tag", "sha": TAG_OBJECT},
        }
        annotated = {"tag": TAG, "object": {"type": "commit", "sha": COMMIT}}
        with patch.object(
            MODULE.subprocess,
            "run",
            side_effect=subprocess_results([
                MODULE.subprocess.CompletedProcess([], 0, json.dumps(reference), ""),
                MODULE.subprocess.CompletedProcess([], 0, json.dumps(annotated), ""),
            ]),
        ) as run:
            MODULE.GitHubClient().validate_remote_tag(REPOSITORY, TAG, COMMIT)
        self.assertIn(f"repos/{REPOSITORY}/git/ref/tags/{TAG}", run.call_args_list[0].args[0])
        self.assertIn(f"repos/{REPOSITORY}/git/tags/{TAG_OBJECT}", run.call_args_list[1].args[0])

        lightweight = {**reference, "object": {"type": "commit", "sha": COMMIT}}
        with patch.object(
            MODULE.subprocess,
            "run",
            side_effect=subprocess_results([
                MODULE.subprocess.CompletedProcess([], 0, json.dumps(lightweight), "")
            ]),
        ) as run:
            with self.assertRaisesRegex(MODULE.Rejected, "annotated tag object"):
                MODULE.GitHubClient().validate_remote_tag(REPOSITORY, TAG, COMMIT)
            self.assertEqual(run.call_count, 1)

        wrong_commit = {"tag": TAG, "object": {"type": "commit", "sha": "f" * 40}}
        with patch.object(
            MODULE.subprocess,
            "run",
            side_effect=subprocess_results([
                MODULE.subprocess.CompletedProcess([], 0, json.dumps(reference), ""),
                MODULE.subprocess.CompletedProcess([], 0, json.dumps(wrong_commit), ""),
            ]),
        ):
            with self.assertRaisesRegex(MODULE.Rejected, "promoted commit"):
                MODULE.GitHubClient().validate_remote_tag(REPOSITORY, TAG, COMMIT)


if __name__ == "__main__":
    unittest.main()
