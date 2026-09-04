#!/usr/bin/env python3
"""Adversarial tests for the explicit single-maintainer release verifier."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("verify-maintainer-release.py")
SPEC = importlib.util.spec_from_file_location("verify_maintainer_release", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
REPOSITORY = {
    "latchway-js": ("javascript", "Latchway/latchway-js"),
    "latchway-ios-sdk": ("ios", "Latchway/latchway-ios-sdk"),
    "latchway-react-native-sdk": (
        "react_native",
        "Latchway/latchway-react-native-sdk",
    ),
}[SCRIPT.parents[1].name]


class MaintainerReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="latchway-maintainer-release-")
        self.root = Path(self.temporary.name) / SCRIPT.parents[1].name
        self.root.mkdir()
        self.write_contract()
        self.write_repository_metadata()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Latchway test")
        self.git("config", "user.email", "release-test@latchway.invalid")
        self.git("add", ".")
        self.git("commit", "-m", "test: exact release source")
        self.commit = self.git("rev-parse", "HEAD")
        self.original_root = MODULE.ROOT
        MODULE.ROOT = self.root

    def tearDown(self) -> None:
        MODULE.ROOT = self.original_root
        self.temporary.cleanup()

    def write_contract(self) -> None:
        (self.root / "contract.lock").write_text(
            "\n".join(
                (
                    "contract_version: 1.0.0",
                    "wire_protocol: 2",
                    "core_release: v1.0.0",
                    f"core_commit: {'a' * 40}",
                    f'bundle_sha256: "{'b' * 64}"',
                    "minimum_server_version: 1.0.0",
                    "maximum_tested_server_version: 1.0.x",
                    "",
                )
            ),
            encoding="utf-8",
        )

    def write_repository_metadata(self) -> None:
        identifier, _ = REPOSITORY
        if identifier == "javascript":
            self.package(self.root / "package.json", "@latchway/client")
            self.package(self.root / "packages/openai/package.json", "@latchway/openai")
            self.package(self.root / "packages/vercel-ai/package.json", "@latchway/vercel-ai")
            self.package(self.root / "packages/langchain/package.json", "@latchway/langchain")
        elif identifier == "ios":
            path = self.root / "Sources/Latchway/LatchwayVersion.swift"
            path.parent.mkdir(parents=True)
            path.write_text('public enum LatchwayVersion { public static let sdk = "1.0.0" }\n', encoding="utf-8")
            (self.root / "Latchway.podspec").write_text("Pod::Spec.new { |spec| spec.version = '1.0.0' }\n", encoding="utf-8")
        else:
            self.package(self.root / "package.json", "@latchway/react-native")
            value = {
                "contract": {"version": "1.0.0", "core_commit": "a" * 40, "repository": "https://github.com/Latchway/latchway.git"},
                "javascript": {"package": "@latchway/client", "version": "1.0.0", "source_commit": "c" * 40, "repository": "https://github.com/Latchway/latchway-js.git"},
                "ios": {"pod": "Latchway/AppAttest", "version": "1.0.0", "source_commit": "d" * 40, "repository": "https://github.com/Latchway/latchway-ios-sdk.git"},
                "android": {"group": "dev.latchway", "version": "1.0.0", "source_commit": "e" * 40, "repository": "https://github.com/Latchway/latchway-android.git"},
                "react_native": {"package": "@latchway/react-native", "version": "1.0.0"},
            }
            (self.root / "release-compatibility.json").write_text(json.dumps(value) + "\n", encoding="utf-8")

    @staticmethod
    def package(path: Path, name: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"name": name, "version": "1.0.0"}) + "\n", encoding="utf-8")

    def arguments(self, **changes: str) -> argparse.Namespace:
        identifier, repository = REPOSITORY
        values = {
            "repository_id": identifier,
            "repository_name": repository,
            "profile": "single_maintainer_v1",
            "release_commit": self.commit,
            "release_version": "1.0.0",
            "workflow_commit": self.commit,
            "workflow_ref": "refs/heads/main",
            "run_id": "123",
            "run_attempt": "1",
            "confirmation": "publish-v1.0.0-with-deferred-assurance",
            "intent_output": Path(self.temporary.name) / "intent.json",
            "github_output": None,
        }
        values.update(changes)
        return argparse.Namespace(**values)

    def test_accepts_exact_main_commit_and_emits_honest_intent(self) -> None:
        result = MODULE.verify(self.arguments())
        self.assertEqual(result["commit"], self.commit)
        intent = json.loads((Path(self.temporary.name) / "intent.json").read_text())
        self.assertEqual(intent["profile"], "single_maintainer_v1")
        self.assertFalse(intent["publication_ready"])
        self.assertFalse(intent["release_qualified"])
        self.assertFalse(intent["requires_independent_human_review"])
        self.assertEqual(
            intent["workflow"]["file"],
            ".github/workflows/single-maintainer-release.yml",
        )
        self.assertIn("independent_human_review", intent["deferred_evidence"])
        self.assertIn("fully_evidence_gated", intent["forbidden_claims"])
        self.assertEqual(intent["workflow"]["owner_run_id"], 123)
        self.assertEqual(intent["transaction"]["id"], result["transaction_id"])
        self.assertEqual(result["core_commit"], "a" * 40)
        self.assertEqual(result["core_bundle_sha256"], "b" * 64)
        self.assertIn("Transaction owner: https://github.com/Latchway/latchway-js/actions/runs/123", intent["github_release"]["body"])

    def test_rerun_attempt_preserves_transaction_bytes_but_new_run_cannot_adopt(self) -> None:
        first = MODULE.verify(self.arguments(run_attempt="1"))
        first_bytes = (Path(self.temporary.name) / "intent.json").read_bytes()
        second_path = Path(self.temporary.name) / "intent-rerun.json"
        second = MODULE.verify(self.arguments(run_attempt="2", intent_output=second_path))
        self.assertEqual(first["transaction_id"], second["transaction_id"])
        self.assertEqual(first["intent_sha256"], second["intent_sha256"])
        self.assertEqual(first_bytes, second_path.read_bytes())

        other_path = Path(self.temporary.name) / "intent-other-run.json"
        other = MODULE.verify(self.arguments(run_id="124", intent_output=other_path))
        self.assertNotEqual(first["transaction_id"], other["transaction_id"])
        self.assertNotEqual(first_bytes, other_path.read_bytes())

    def test_rejects_wrong_confirmation_ref_version_or_commit(self) -> None:
        cases = (
            {"confirmation": "yes"},
            {"workflow_ref": "refs/heads/feature"},
            {"release_version": "1.0.1"},
            {"workflow_commit": "f" * 40},
        )
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaisesRegex(
                MODULE.Rejected, "maintainer_release_dispatch_invalid"
            ):
                MODULE.verify(self.arguments(**changes))

    def test_rejects_dirty_source_and_contract_substitution(self) -> None:
        (self.root / "untracked").write_text("dirty\n", encoding="utf-8")
        with self.assertRaisesRegex(MODULE.Rejected, "maintainer_release_worktree_dirty"):
            MODULE.verify(self.arguments())
        (self.root / "untracked").unlink()
        contract = self.root / "contract.lock"
        contract.write_text(contract.read_text().replace("core_release: v1.0.0", "core_release: v1.0.1"), encoding="utf-8")
        self.git("add", "contract.lock")
        self.git("commit", "-m", "test: substitute contract")
        substituted = self.git("rev-parse", "HEAD")
        with self.assertRaisesRegex(MODULE.Rejected, "maintainer_release_contract_lock_invalid"):
            MODULE.verify(self.arguments(release_commit=substituted, workflow_commit=substituted))

    def test_workflow_preserves_full_gate_and_selected_trusted_publisher_tuple(self) -> None:
        repository = SCRIPT.parents[1]
        workflow = (repository / ".github/workflows/single-maintainer-release.yml").read_text(encoding="utf-8")
        core_verifier = (repository / "scripts/verify-public-core-release.sh").read_text(encoding="utf-8")
        release_surface = workflow + core_verifier
        documentation = (repository / "docs/releasing.md").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("needs: [intent, verify]", workflow)
        self.assertIn("pnpm release:check", workflow)
        self.assertIn('"$LATCHWAY_NPM_CLI" publish "$archive" --access public --provenance', workflow)
        self.assertIn("environment: single-maintainer-v1", workflow)
        self.assertNotIn("secrets.NPM_TOKEN", workflow)
        self.assertNotIn("secrets.NODE_AUTH_TOKEN", workflow)
        self.assertIn("workflow file\n`single-maintainer-release.yml`", documentation)
        self.assertIn("strict `release.yml` cannot publish", documentation)
        self.assertIn("npm permits only one trusted publisher per package", documentation)
        self.assertIn("reviewer-free `single-maintainer-v1-administration` environment", documentation)
        self.assertIn(
            "`latchway-release-profile-v1:latchway-js:single_maintainer_v1:administration`",
            documentation,
        )
        self.assertIn("validated release ETag is unchanged with a conditional `304` response", documentation)
        self.assertEqual(
            documentation.count(
                "--file single-maintainer-release.yml --environment single-maintainer-v1"
            ),
            5,
        )
        self.assertIn("javascript-single-maintainer-v1", workflow)
        self.assertIn("actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT", workflow)
        self.assertIn("bash scripts/verify-public-core-release.sh", workflow)
        self.assertIn("compare/$locked_core_commit...$core_commit", core_verifier)
        self.assertIn(".merge_base_commit.sha == $locked", core_verifier)
        self.assertIn("Refuse a new dispatch or rerun-all after any v1 mutation", workflow)
        self.assertIn("--signer-workflow \"$core_repository/.github/workflows/single-maintainer-release.yml\"", core_verifier)
        self.assertIn("$core_repository/.github/workflows/release.yml", release_surface)
        self.assertIn("$core_repository/.github/workflows/deployment-evidence.yml", release_surface)
        self.assertIn("core-release-gate.json", workflow)
        self.assertIn("EXPECTED_PROVENANCE_WORKFLOW_PATH: .github/workflows/single-maintainer-release.yml", workflow)
        self.assertIn("EXPECTED_PROVENANCE_EVENT: workflow_dispatch", workflow)
        self.assertIn("single-maintainer-npm-adoption.json", workflow)
        self.assertIn("gh release upload \"$RELEASE_TAG\" \"$asset\"", workflow)
        self.assertNotIn("--clobber", workflow)
        self.assertEqual(workflow.count("retention-days: 90"), 4)
        self.assertEqual(
            workflow.count("Require exact single-maintainer-v1 environment policy sentinel"),
            5,
        )
        self.assertEqual(
            workflow.count("latchway-release-controls-v1:latchway-js:single-maintainer-v1"),
            5,
        )
        administration_start = workflow.index("\n  immutable-release-settings:\n")
        tag_start = workflow.index("\n  tag:\n")
        administration = workflow[administration_start:tag_start]
        self.assertLess(administration_start, tag_start)
        self.assertIn("needs: [intent, verify, immutable-release-settings]", workflow)
        self.assertIn("environment: single-maintainer-v1-administration", administration)
        self.assertIn("permissions: {}", administration)
        self.assertIn(
            "latchway-release-profile-v1:latchway-js:single_maintainer_v1:administration",
            administration,
        )
        self.assertIn("${{ vars.LATCHWAY_RELEASE_PROFILE_POLICY_ID }}", administration)
        self.assertIn("${{ secrets.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN }}", administration)
        self.assertIn('"repos/$GITHUB_REPOSITORY/immutable-releases"', administration)
        self.assertIn('(keys | sort) == ["enabled","enforced_by_owner"]', administration)
        self.assertIn('.enabled == true and (.enforced_by_owner | type) == "boolean"', administration)
        self.assertNotIn("actions/checkout", administration)
        self.assertNotIn("id-token: write", administration)
        self.assertNotIn("${{ github.token }}", administration)
        self.assertEqual(
            workflow.count("${{ secrets.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN }}"),
            1,
        )
        self.assertGreaterEqual(
            workflow.count("(( major > 2 || (major == 2 && minor >= 97) ))"),
            2,
        )
        self.assertIn("Every job bearing this environment\nchecks that sentinel as its first step", documentation)
        self.assertIn("Re-run failed jobs", documentation)
        self.assertIn("never use **Re-run all jobs**", documentation)
        draft = workflow.index("Stage or adopt exact recoverable transaction draft")
        registry_mutation = workflow.index('"$LATCHWAY_NPM_CLI" publish "$archive"')
        registry_verification = workflow.index("node scripts/verify-published.mjs")
        finalization = workflow.index("Upload or adopt exact bytes then publish once")
        self.assertLess(draft, registry_mutation)
        self.assertLess(registry_mutation, registry_verification)
        self.assertLess(registry_verification, finalization)

        normalized = re.sub(r"\\\n[ \t]*", " ", workflow)
        release_commands = re.findall(r"(?m)^[ \t]*gh release [^\n]+$", normalized)
        self.assertTrue(release_commands)
        for command in release_commands:
            with self.subTest(command=command.strip()):
                self.assertIn('--repo "$GITHUB_REPOSITORY"', command)

        final_release = workflow[workflow.index("\n  github-release:\n") :]
        self.assertIn('test "$(wc -l < "$RUNNER_TEMP/expected-release-assets" | tr -d \' \')" = 32', final_release)
        self.assertIn('find "$root" -mindepth 3 -print -quit', final_release)
        self.assertIn("pre-publish-release.etag", final_release)
        self.assertIn("If-None-Match:", final_release)
        self.assertIn("'^HTTP/[0-9.]+ 304( |$)'", final_release)
        self.assertIn(".draft == false and .prerelease == false and .immutable == true", final_release)
        self.assertIn('gh release verify-asset "$RELEASE_TAG" "$asset"', final_release)
        self.assertIn(
            'gh release verify "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --format json',
            final_release,
        )
        self.assertIn("initial-tag-ref.json", final_release)
        self.assertIn("post-publish-tag-ref.json", final_release)
        self.assertIn('elif .draft == false and .immutable == true then "immutable"', final_release)
        etag_check = final_release.index("If-None-Match:")
        publication = final_release.index("gh api --method PATCH", etag_check)
        immutable_check = final_release.index(".immutable == true", publication)
        self.assertLess(etag_check, publication)
        self.assertLess(publication, immutable_check)
        self.assertNotIn("gh release delete", workflow)
        self.assertNotIn("--method DELETE", workflow)

    def test_workflow_never_interpolates_dispatch_input_inside_shell(self) -> None:
        workflow = (SCRIPT.parents[1] / ".github/workflows/single-maintainer-release.yml").read_text(encoding="utf-8")
        lines = workflow.splitlines()
        run_bodies: list[str] = []
        for index, line in enumerate(lines):
            match = re.match(r"^(\s*)run:\s*(.*)$", line)
            if match is None:
                continue
            indentation = len(match.group(1))
            body = [match.group(2)]
            for following in lines[index + 1 :]:
                if following.strip() and len(following) - len(following.lstrip()) <= indentation:
                    break
                body.append(following)
            run_bodies.append("\n".join(body))
        self.assertTrue(run_bodies)
        for body in run_bodies:
            self.assertNotIn("${{ inputs.", body)

    def git(self, *arguments: str) -> str:
        return subprocess.run(["git", "-C", str(self.root), *arguments], check=True, capture_output=True, text=True).stdout.strip()


if __name__ == "__main__":
    unittest.main()
