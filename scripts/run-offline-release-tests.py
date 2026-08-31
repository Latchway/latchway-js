#!/usr/bin/env python3
"""Run every tracked offline Python release regression fail-closed."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
TEST_PATHS = (
    "scripts/test_build_docs_bundle.py",
    "scripts/test_offline_release_inventory.py",
    "scripts/test_reconcile_github_release.py",
    "scripts/test_release_promotion.py",
    "scripts/test_require_gh_version.py",
)


def repository_test_paths() -> tuple[str, ...]:
    result = subprocess.run(
        [
            "git",
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            "scripts/test_*.py",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return tuple(sorted(path for path in result.stdout.decode().split("\0") if path))


def validate_inventory() -> None:
    tracked = repository_test_paths()
    expected = tuple(sorted(TEST_PATHS))
    if tracked != expected:
        missing = sorted(set(tracked) - set(expected))
        stale = sorted(set(expected) - set(tracked))
        raise SystemExit(
            "offline release test inventory mismatch; "
            f"uncovered tracked tests={missing!r}; stale entries={stale!r}"
        )
    for relative in expected:
        path = ROOT / relative
        if not path.is_file() or path.is_symlink():
            raise SystemExit(f"offline release test must be a regular file: {relative}")


def main() -> None:
    validate_inventory()
    environment = os.environ.copy()
    python_path = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = str(ROOT / "scripts")
    if python_path:
        environment["PYTHONPATH"] += os.pathsep + python_path
    subprocess.run(
        [sys.executable, "-m", "unittest", *TEST_PATHS],
        cwd=ROOT,
        env=environment,
        check=True,
    )
    print(f"offline release test inventory passed: {len(TEST_PATHS)} tracked modules")


if __name__ == "__main__":
    main()
