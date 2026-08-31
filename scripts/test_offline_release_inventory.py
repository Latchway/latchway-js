#!/usr/bin/env python3
"""Regression checks for the offline release-test and workflow-schema gates."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "scripts/run-offline-release-tests.py"
SPEC = importlib.util.spec_from_file_location("run_offline_release_tests", RUNNER_PATH)
assert SPEC is not None and SPEC.loader is not None
RUNNER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RUNNER
SPEC.loader.exec_module(RUNNER)


class OfflineReleaseInventoryTests(unittest.TestCase):
    def test_manifest_covers_every_tracked_python_test(self) -> None:
        self.assertEqual(tuple(sorted(RUNNER.TEST_PATHS)), RUNNER.repository_test_paths())

    def test_standard_checks_run_the_offline_release_umbrella(self) -> None:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        scripts = package["scripts"]
        self.assertEqual(
            scripts["test:offline-release"],
            "python3 scripts/run-offline-release-tests.py",
        )
        self.assertIn("pnpm test:offline-release", scripts["check"])
        candidate = (ROOT / "scripts/verify-release-candidate.mjs").read_text(
            encoding="utf-8"
        )
        self.assertIn('["offline-release-tests", "test:offline-release"]', candidate)

    def test_ci_installs_and_runs_the_pinned_actionlint_gate(self) -> None:
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        installer = (ROOT / "scripts/install-actionlint.mjs").read_text(
            encoding="utf-8"
        )
        verifier = (ROOT / "scripts/verify-workflows.mjs").read_text(encoding="utf-8")
        self.assertIn("node scripts/install-actionlint.mjs", ci)
        self.assertIn("pnpm release:check", ci)
        self.assertIn('const VERSION = "1.7.12";', installer)
        self.assertIn('version.stdout.split(/\\r?\\n/u, 1)[0] !== "1.7.12"', verifier)


if __name__ == "__main__":
    unittest.main()
