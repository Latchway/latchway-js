#!/usr/bin/env python3
"""Adversarial tests for the explicit single-maintainer release verifier."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
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
        self.assertIn("--rawfile body", workflow)
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
        self.assertEqual(
            documentation.count(
                "--file single-maintainer-release.yml --environment single-maintainer-v1"
            ),
            5,
        )

    def git(self, *arguments: str) -> str:
        return subprocess.run(["git", "-C", str(self.root), *arguments], check=True, capture_output=True, text=True).stdout.strip()


if __name__ == "__main__":
    unittest.main()
