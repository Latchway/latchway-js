#!/usr/bin/env python3
"""Adversarial tests for the GitHub CLI release-security baseline."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("require-gh-version.py")
WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "release.yml"


class GitHubCLIVersionTests(unittest.TestCase):
    def run_script(self, contents: bytes) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "gh"
            executable.write_bytes(contents)
            executable.chmod(0o700)
            return subprocess.run(
                [sys.executable, str(SCRIPT), "--gh", str(executable)],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )

    def run_fake(self, version: str) -> subprocess.CompletedProcess[str]:
        return self.run_script(
            (
                "#!/bin/sh\n"
                f"printf '%s\\n' 'gh version {version} (2026-08-29)' "
                "'https://github.com/cli/cli/releases'\n"
            ).encode("utf-8")
        )

    def test_rejects_2_96_series(self) -> None:
        result = self.run_fake("2.96.99")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("below required minimum 2.97.0", result.stderr)

    def test_accepts_2_97_and_newer(self) -> None:
        for version in ("2.97.0", "2.97.1", "3.0.0"):
            with self.subTest(version=version):
                self.assertEqual(self.run_fake(version).returncode, 0)

    def test_rejects_ambiguous_version_output(self) -> None:
        result = self.run_fake("2.97.0-rc.1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unrecognized version string", result.stderr)

    def test_rejects_oversized_output_before_retaining_it(self) -> None:
        result = self.run_script(
            b"#!/bin/sh\nhead -c 32768 /dev/zero | tr '\\000' x\n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("version probe failed", result.stderr)

    def test_rejects_invalid_utf8_output(self) -> None:
        result = self.run_script(b"#!/bin/sh\nprintf 'gh version 2.97.0 \\377\\n'\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid UTF-8", result.stderr)

    def test_workflow_guards_earliest_signer_workflow_verification(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        guard = workflow.index("version_line=$(gh version | head -n 1)")
        signer_workflow = workflow.index("--signer-workflow")
        self.assertLess(guard, signer_workflow)
        authorization = workflow.split("\n  authorize-promotion:\n", 1)[1].split(
            "\n  verify-promotion:\n", 1
        )[0]
        self.assertNotIn("scripts/require-gh-version.py", authorization)


if __name__ == "__main__":
    unittest.main()
