#!/usr/bin/env python3
"""Create or resume an immutable GitHub release without overwriting assets."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import re

try:
    import resource
except ImportError:  # pragma: no cover - release reconciliation runs on Linux.
    resource = None  # type: ignore[assignment]

import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote


REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
TAG = re.compile(r"^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
OBJECT_ID = re.compile(r"^[0-9a-f]{40}$")
MAXIMUM_ASSET_BYTES = 2 * 1024 * 1024 * 1024
MAXIMUM_ASSET_NAME_BYTES = 255
MAXIMUM_ADOPTION_RECORD_BYTES = 256 * 1024
MAXIMUM_ATTESTATION_JSON_BYTES = 16 * 1024 * 1024
MAXIMUM_RELEASE_JSON_BYTES = 16 * 1024 * 1024
MAXIMUM_SETTINGS_JSON_BYTES = 64 * 1024
MAXIMUM_DIAGNOSTIC_BYTES = 16 * 1024
MAXIMUM_POLICY_EVIDENCE_BYTES = 64 * 1024
MAXIMUM_POLICY_TTL_SECONDS = 10 * 60
MAXIMUM_JSON_SAFE_INTEGER = 9_007_199_254_740_991
MAXIMUM_API_COMMAND_SECONDS = 60
MAXIMUM_TRANSFER_COMMAND_SECONDS = 5 * 60
RELEASE_PREDICATE_TYPE = "https://in-toto.io/attestation/release/v0.2"
STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
ADOPTION_PACKAGES = {
    "client": "@latchway/client",
    "openai": "@latchway/openai",
    "vercel-ai": "@latchway/vercel-ai",
    "langchain": "@latchway/langchain",
}
ADOPTION_PATTERN = re.compile(
    r"npm-release-adoption-(client|openai|vercel-ai|langchain)-"
    r"([1-9][0-9]*)-([1-9][0-9]*)\.json"
)


class Rejected(RuntimeError):
    """The existing public release differs from the intended immutable state."""


@dataclass(frozen=True)
class Asset:
    path: Path
    name: str
    size: int
    sha256: str


class Client(Protocol):
    def immutable_releases_enabled(self, repository: str) -> bool: ...

    def release(self, repository: str, tag: str) -> dict[str, Any] | None: ...

    def validate_remote_tag(self, repository: str, tag: str, expected_commit: str) -> None: ...

    def create(self, repository: str, tag: str, title: str, prerelease: bool) -> None: ...

    def download(
        self, repository: str, asset_id: int, destination: Path, maximum_bytes: int
    ) -> None: ...

    def upload(self, repository: str, tag: str, path: Path) -> None: ...

    def finalize(self, repository: str, tag: str, prerelease: bool) -> None: ...

    def verify_attestation(self, repository: str, path: Path, source_commit: str) -> None: ...

    def verify_release_attestation(
        self,
        repository: str,
        tag: str,
        expected_commit: str,
        assets: list[Asset],
    ) -> None: ...


class GitHubClient:
    def immutable_releases_enabled(self, repository: str) -> bool:
        # Consume the protected credential for this one settings request. It
        # must not remain inherited by later release mutation subprocesses.
        token = os.environ.pop("LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN", "")
        if not token or any(character in token for character in "\x00\r\n"):
            raise RuntimeError("The protected immutable-release settings credential is missing.")
        environment = os.environ.copy()
        environment["GH_TOKEN"] = token
        try:
            status, value, _ = _execute_json_command(
                [
                    "gh", "api",
                    "-H", "Accept: application/vnd.github+json",
                    "-H", "X-GitHub-Api-Version: 2026-03-10",
                    f"repos/{repository}/immutable-releases",
                ],
                "GitHub immutable-release settings lookup",
                maximum_bytes=MAXIMUM_SETTINGS_JSON_BYTES,
                env=environment,
                allow_failure=True,
            )
        except RuntimeError:
            return False
        if status != 0:
            return False
        return (
            isinstance(value, dict)
            and set(value) == {"enabled", "enforced_by_owner"}
            and value.get("enabled") is True
            and value.get("enforced_by_owner") is True
        )

    def validate_remote_tag(self, repository: str, tag: str, expected_commit: str) -> None:
        encoded_tag = quote(tag, safe="")
        reference = _gh_json(
            [
                "gh", "api",
                "-H", "Accept: application/vnd.github+json",
                "-H", "X-GitHub-Api-Version: 2026-03-10",
                f"repos/{repository}/git/ref/tags/{encoded_tag}",
            ],
            "GitHub annotated tag reference lookup",
        )
        tag_object = reference.get("object")
        if (
            reference.get("ref") != f"refs/tags/{tag}"
            or not isinstance(tag_object, dict)
            or tag_object.get("type") != "tag"
            or not isinstance(tag_object.get("sha"), str)
            or OBJECT_ID.fullmatch(tag_object["sha"]) is None
        ):
            raise Rejected("Remote release tag is not the expected annotated tag object.")
        annotated = _gh_json(
            [
                "gh", "api",
                "-H", "Accept: application/vnd.github+json",
                "-H", "X-GitHub-Api-Version: 2026-03-10",
                f"repos/{repository}/git/tags/{tag_object['sha']}",
            ],
            "GitHub annotated tag object lookup",
        )
        target = annotated.get("object")
        if (
            annotated.get("tag") != tag
            or not isinstance(target, dict)
            or target.get("type") != "commit"
            or target.get("sha") != expected_commit
        ):
            raise Rejected("Remote annotated release tag does not identify the promoted commit.")

    def release(self, repository: str, tag: str) -> dict[str, Any] | None:
        endpoint = f"repos/{repository}/releases/tags/{quote(tag, safe='')}"
        status, value, diagnostic = _execute_json_command(
            ["gh", "api", "-H", "X-GitHub-Api-Version: 2026-03-10", endpoint],
            "GitHub release lookup",
            maximum_bytes=MAXIMUM_RELEASE_JSON_BYTES,
            allow_failure=True,
        )
        if status != 0:
            if re.search(r"(?:HTTP\s+404|404\s+Not Found|release not found)", diagnostic, re.IGNORECASE):
                return None
            raise RuntimeError(_operation_failure("GitHub release lookup", diagnostic))
        if not isinstance(value, dict):
            raise RuntimeError("GitHub returned an invalid release document.")
        return value

    def create(self, repository: str, tag: str, title: str, prerelease: bool) -> None:
        arguments = [
            "gh", "release", "create", tag,
            "--repo", repository,
            "--verify-tag",
            "--draft",
            "--generate-notes",
            "--title", title,
        ]
        if prerelease:
            arguments.append("--prerelease")
        _run(arguments, "GitHub draft release creation")

    def download(
        self, repository: str, asset_id: int, destination: Path, maximum_bytes: int
    ) -> None:
        if not _is_bounded_positive_integer(maximum_bytes) or maximum_bytes > MAXIMUM_ASSET_BYTES:
            raise RuntimeError("GitHub release asset download limit is invalid.")
        endpoint = f"repos/{repository}/releases/assets/{asset_id}"
        with destination.open("wb") as output, tempfile.TemporaryFile(mode="w+b") as error_output:
            try:
                result = subprocess.run(
                    ["gh", "api", "--method", "GET", "-H", "Accept: application/octet-stream", endpoint],
                    check=False,
                    stdout=output,
                    stderr=error_output,
                    timeout=MAXIMUM_TRANSFER_COMMAND_SECONDS,
                    preexec_fn=_child_file_size_limit(max(maximum_bytes, MAXIMUM_DIAGNOSTIC_BYTES)),
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise RuntimeError(
                    "GitHub release asset download exceeded its execution bounds."
                ) from error
            diagnostic = _sanitized_diagnostic(error_output)
            output_size = os.fstat(output.fileno()).st_size
        if result.returncode != 0:
            raise RuntimeError(_operation_failure("GitHub release asset download", diagnostic))
        if output_size <= 0 or output_size > maximum_bytes:
            raise RuntimeError("GitHub release asset download returned an invalid amount of data.")

    def upload(self, repository: str, tag: str, path: Path) -> None:
        # Deliberately omit --clobber. Existing assets are downloaded and
        # verified before this method is called; immutable bytes are never replaced.
        _run(
            ["gh", "release", "upload", tag, str(path), "--repo", repository],
            "GitHub release asset upload",
        )

    def finalize(self, repository: str, tag: str, prerelease: bool) -> None:
        arguments = ["gh", "release", "edit", tag, "--repo", repository, "--draft=false"]
        if prerelease:
            arguments.append("--prerelease")
        else:
            arguments.extend(["--prerelease=false", "--latest"])
        _run(arguments, "GitHub release finalization")

    def verify_attestation(self, repository: str, path: Path, source_commit: str) -> None:
        _run(
            [
                "gh", "attestation", "verify", str(path),
                "--repo", repository,
                "--signer-workflow", f"{repository}/.github/workflows/release.yml",
                "--source-ref", "refs/heads/main",
                "--source-digest", source_commit,
                "--deny-self-hosted-runners",
            ],
            "GitHub release adoption attestation verification",
        )

    def verify_release_attestation(
        self,
        repository: str,
        tag: str,
        expected_commit: str,
        assets: list[Asset],
    ) -> None:
        attempts, delay = _attestation_retry_policy()
        release_json = _run_json_with_retries(
            ["gh", "release", "verify", tag, "--repo", repository, "--format", "json"],
            "GitHub immutable release attestation verification",
            attempts,
            delay,
        )
        _validate_release_attestation(
            release_json,
            repository=repository,
            tag=tag,
            expected_commit=expected_commit,
            assets=assets,
        )
        for asset in assets:
            asset_json = _run_json_with_retries(
                [
                    "gh", "release", "verify-asset", tag, str(asset.path),
                    "--repo", repository, "--format", "json",
                ],
                f"GitHub immutable release asset attestation verification ({asset.name})",
                attempts,
                delay,
            )
            _validate_release_attestation(
                asset_json,
                repository=repository,
                tag=tag,
                expected_commit=expected_commit,
                assets=assets,
            )


def _run(arguments: list[str], operation: str) -> None:
    with tempfile.TemporaryFile(mode="w+b") as error_output:
        try:
            result = subprocess.run(
                arguments,
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=error_output,
                timeout=MAXIMUM_TRANSFER_COMMAND_SECONDS,
                preexec_fn=_child_file_size_limit(MAXIMUM_DIAGNOSTIC_BYTES),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError(f"{operation} exceeded its execution bounds.") from error
        diagnostic = _sanitized_diagnostic(error_output)
    if result.returncode != 0:
        raise RuntimeError(_operation_failure(operation, diagnostic))


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _finite_json_float(source: str) -> float:
    value = float(source)
    if not math.isfinite(value):
        raise ValueError("non-finite JSON number")
    return value


def _strict_json_loads(document: str) -> Any:
    return json.loads(
        document,
        object_pairs_hook=_unique_json_object,
        parse_constant=_reject_json_constant,
        parse_float=_finite_json_float,
    )


def _is_bounded_positive_integer(value: Any) -> bool:
    return type(value) is int and 1 <= value <= MAXIMUM_JSON_SAFE_INTEGER


def _sanitized_diagnostic(source: Any) -> str:
    size = os.fstat(source.fileno()).st_size
    source.seek(0)
    payload = source.read(min(size, MAXIMUM_DIAGNOSTIC_BYTES))
    text = payload.decode("utf-8", errors="replace")
    text = re.sub(
        r"\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b|\bBearer\s+\S+",
        "[credential]",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", text)
    text = " ".join(text.split())
    if size > MAXIMUM_DIAGNOSTIC_BYTES:
        text = f"{text} [truncated]" if text else "[truncated]"
    return text


def _operation_failure(operation: str, diagnostic: str) -> str:
    return f"{operation} failed{f': {diagnostic}' if diagnostic else '.'}"


def _child_file_size_limit(maximum_bytes: int) -> Any:
    if resource is None:
        return None

    def configure() -> None:
        _, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
        limit = maximum_bytes if hard == resource.RLIM_INFINITY else min(maximum_bytes, hard)
        resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))

    return configure


def _execute_json_command(
    arguments: list[str],
    operation: str,
    *,
    maximum_bytes: int,
    env: dict[str, str] | None = None,
    allow_failure: bool = False,
) -> tuple[int, Any | None, str]:
    if (
        not _is_bounded_positive_integer(maximum_bytes)
        or maximum_bytes > MAXIMUM_ATTESTATION_JSON_BYTES
    ):
        raise RuntimeError(f"{operation} received an invalid JSON output limit.")
    with tempfile.TemporaryFile(mode="w+b") as output, tempfile.TemporaryFile(
        mode="w+b"
    ) as error_output:
        try:
            result = subprocess.run(
                arguments,
                check=False,
                stdout=output,
                stderr=error_output,
                env=env,
                timeout=MAXIMUM_API_COMMAND_SECONDS,
                preexec_fn=_child_file_size_limit(max(maximum_bytes, MAXIMUM_DIAGNOSTIC_BYTES)),
            )
        except subprocess.TimeoutExpired:
            diagnostic = _sanitized_diagnostic(error_output)
            if allow_failure:
                return 124, None, diagnostic or "command timed out"
            raise RuntimeError(f"{operation} exceeded its execution timeout.") from None
        except OSError as error:
            raise RuntimeError(f"{operation} could not be executed.") from error
        diagnostic = _sanitized_diagnostic(error_output)
        if result.returncode != 0:
            if allow_failure:
                return result.returncode, None, diagnostic
            raise RuntimeError(_operation_failure(operation, diagnostic))
        size = os.fstat(output.fileno()).st_size
        if size <= 0 or size > maximum_bytes:
            raise RuntimeError(f"{operation} returned an empty or oversized JSON document.")
        output.seek(0)
        payload = output.read(size)
    try:
        value = _strict_json_loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError(f"{operation} returned invalid JSON.") from error
    return result.returncode, value, diagnostic


def _gh_json(arguments: list[str], operation: str) -> dict[str, Any]:
    _, value, _ = _execute_json_command(
        arguments,
        operation,
        maximum_bytes=MAXIMUM_RELEASE_JSON_BYTES,
    )
    if not isinstance(value, dict) or not value:
        raise RuntimeError(f"{operation} returned an invalid JSON object.")
    return value


def _attestation_retry_policy() -> tuple[int, int]:
    attempts_text = os.environ.get("LATCHWAY_GITHUB_RELEASE_ATTESTATION_ATTEMPTS", "12")
    delay_text = os.environ.get("LATCHWAY_GITHUB_RELEASE_ATTESTATION_DELAY_SECONDS", "10")
    if not attempts_text.isdigit() or not delay_text.isdigit():
        raise RuntimeError("GitHub release attestation retry settings are invalid.")
    attempts = int(attempts_text)
    delay = int(delay_text)
    if not 1 <= attempts <= 30 or not 1 <= delay <= 60:
        raise RuntimeError("GitHub release attestation retry settings are invalid.")
    return attempts, delay


def _run_json_with_retries(
    arguments: list[str],
    operation: str,
    attempts: int,
    delay: int,
) -> dict[str, Any]:
    last_error = ""
    for attempt in range(1, attempts + 1):
        status, value, diagnostic = _execute_json_command(
            arguments,
            operation,
            maximum_bytes=MAXIMUM_ATTESTATION_JSON_BYTES,
            allow_failure=True,
        )
        if status == 0:
            if not isinstance(value, dict) or not value:
                raise RuntimeError(f"{operation} returned an invalid JSON object.")
            return value
        last_error = diagnostic
        if attempt < attempts:
            time.sleep(delay)
    raise RuntimeError(f"{operation} failed after {attempts} attempts: {last_error}")


def _validate_release_attestation(
    value: dict[str, Any],
    *,
    repository: str,
    tag: str,
    expected_commit: str,
    assets: list[Asset],
) -> None:
    if set(value) != {"attestation", "verificationResult"}:
        raise Rejected("GitHub release attestation JSON has an unexpected top-level schema.")
    attestation = value.get("attestation")
    verification_result = value.get("verificationResult")
    if not isinstance(attestation, dict) or not attestation:
        raise Rejected("GitHub release attestation JSON has no attestation.")
    if not isinstance(verification_result, dict) or not verification_result:
        raise Rejected("GitHub release attestation JSON has no verification result.")
    bundle = attestation.get("bundle")
    envelope = bundle.get("dsseEnvelope") if isinstance(bundle, dict) else None
    if not isinstance(envelope, dict):
        raise Rejected("GitHub release attestation has no signed DSSE envelope.")
    payload = envelope.get("payload")
    signatures = envelope.get("signatures")
    if (
        envelope.get("payloadType") != "application/vnd.in-toto+json"
        or not isinstance(payload, str)
        or not payload
        or not isinstance(signatures, list)
        or not signatures
        or any(not isinstance(signature, dict) or not signature for signature in signatures)
    ):
        raise Rejected("GitHub release attestation has an invalid signed DSSE envelope.")
    try:
        statement_bytes = base64.b64decode(payload, validate=True)
    except (ValueError, binascii.Error) as error:
        raise Rejected("GitHub release attestation DSSE payload is not valid base64.") from error
    if not statement_bytes or len(statement_bytes) > MAXIMUM_ATTESTATION_JSON_BYTES:
        raise Rejected("GitHub release attestation statement has an invalid size.")
    if base64.b64encode(statement_bytes).decode("ascii") != payload:
        raise Rejected("GitHub release attestation DSSE payload is not canonical base64.")
    try:
        statement = _strict_json_loads(statement_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise Rejected("GitHub release attestation statement is invalid JSON.") from error
    if (
        not isinstance(statement, dict)
        or set(statement) != {"_type", "subject", "predicateType", "predicate"}
        or statement.get("_type") != STATEMENT_TYPE
        or statement.get("predicateType") != RELEASE_PREDICATE_TYPE
        or not isinstance(statement.get("predicate"), dict)
        or not statement["predicate"]
    ):
        raise Rejected("GitHub release attestation statement schema is invalid.")
    subjects = statement.get("subject")
    if not isinstance(subjects, list) or not subjects:
        raise Rejected("GitHub release attestation has no subjects.")
    expected_repository_purl = f"pkg:github/{repository}"
    release_matches: list[dict[str, str]] = []
    asset_subjects: dict[str, dict[str, str]] = {}
    for subject in subjects:
        if not isinstance(subject, dict) or not isinstance(subject.get("digest"), dict):
            raise Rejected("GitHub release attestation contains an invalid subject.")
        digest = subject["digest"]
        if not digest or any(
            not isinstance(key, str) or not isinstance(item, str)
            for key, item in digest.items()
        ):
            raise Rejected("GitHub release attestation contains an invalid subject digest.")
        if set(subject) == {"uri", "digest"}:
            uri = subject.get("uri")
            purl_parts = uri.rsplit("@", 1) if isinstance(uri, str) else []
            if (
                not isinstance(uri, str)
                or len(purl_parts) != 2
                or purl_parts[0].casefold() != expected_repository_purl.casefold()
                or purl_parts[1] != tag
                or release_matches
            ):
                raise Rejected("GitHub release attestation contains an invalid release subject.")
            release_matches.append(digest)
        elif set(subject) == {"name", "digest"}:
            name = subject.get("name")
            if not isinstance(name, str) or not name or name in asset_subjects:
                raise Rejected("GitHub release attestation contains an invalid asset subject.")
            asset_subjects[name] = digest
        else:
            raise Rejected("GitHub release attestation contains an unexpected subject schema.")

    if release_matches != [{"sha1": expected_commit}]:
        raise Rejected("GitHub release attestation is not bound to the promoted source commit.")
    if set(asset_subjects) != {asset.name for asset in assets}:
        raise Rejected("GitHub release attestation does not contain the exact release asset set.")
    for asset in assets:
        if asset_subjects.get(asset.name) != {"sha256": asset.sha256}:
            raise Rejected(
                f"GitHub release attestation does not bind the exact asset bytes for {asset.name}."
            )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_assets(paths: list[str]) -> list[Asset]:
    if not paths:
        raise Rejected("At least one release asset is required.")
    assets: list[Asset] = []
    names: set[str] = set()
    for raw_path in paths:
        path = Path(raw_path)
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            raise Rejected(f"Release asset must be a regular file: {path}")
        if metadata.st_size <= 0 or metadata.st_size > MAXIMUM_ASSET_BYTES:
            raise Rejected(f"Release asset has an invalid size: {path}")
        name = path.name
        if (
            name in {"", ".", ".."}
            or "/" in name
            or "\\" in name
            or len(name.encode("utf-8")) > MAXIMUM_ASSET_NAME_BYTES
            or name in names
        ):
            raise Rejected(f"Release asset has an unsafe or duplicate name: {name}")
        names.add(name)
        digest = sha256_file(path)
        assets.append(Asset(path=path.resolve(), name=name, size=metadata.st_size, sha256=digest))
    return sorted(assets, key=lambda asset: asset.name)


def validate_immutable_policy_evidence(
    path: Path,
    *,
    repository: str,
    expected_sha256: str,
    expected_run_id: int,
    expected_run_attempt: int,
    current_time: int | None = None,
) -> int:
    if re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None:
        raise Rejected("Immutable-release policy evidence has an invalid expected digest.")
    if (
        not _is_bounded_positive_integer(expected_run_id)
        or not _is_bounded_positive_integer(expected_run_attempt)
    ):
        raise Rejected("Immutable-release policy evidence has invalid expected run coordinates.")
    now = int(time.time()) if current_time is None else current_time
    if not _is_bounded_positive_integer(now):
        raise Rejected("Immutable-release policy evidence has an invalid validation time.")
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_size <= 0
        or metadata.st_size > MAXIMUM_POLICY_EVIDENCE_BYTES
    ):
        raise Rejected("Immutable-release policy evidence is not a bounded regular file.")
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != expected_sha256:
        raise Rejected("Immutable-release policy evidence has a different digest.")
    try:
        value = _strict_json_loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise Rejected("Immutable-release policy evidence is invalid JSON.") from error
    if (
        not isinstance(value, dict)
        or set(value) != {
            "schema_version", "kind", "repository", "run_id", "run_attempt",
            "issued_at", "expires_at", "settings",
        }
        or type(value.get("schema_version")) is not int
        or value.get("schema_version") != 2
        or value.get("kind") != "latchway_github_immutable_release_policy"
        or value.get("repository") != repository
        or not _is_bounded_positive_integer(value.get("run_id"))
        or not _is_bounded_positive_integer(value.get("run_attempt"))
        or value.get("run_id") != expected_run_id
        or value.get("run_attempt") != expected_run_attempt
        or not _is_bounded_positive_integer(value.get("issued_at"))
        or not _is_bounded_positive_integer(value.get("expires_at"))
        or value["issued_at"] > now
        or value["expires_at"] <= now
        or value["expires_at"] <= value["issued_at"]
        or value["expires_at"] - value["issued_at"] > MAXIMUM_POLICY_TTL_SECONDS
        or not isinstance(value.get("settings"), dict)
        or set(value["settings"]) != {"enabled", "enforced_by_owner"}
        or value["settings"].get("enabled") is not True
        or value["settings"].get("enforced_by_owner") is not True
    ):
        raise Rejected(
            "Immutable-release policy evidence does not authorize this repository and attempt."
        )
    return value["expires_at"]


def require_immutable_policy_current(expires_at: int) -> None:
    now = int(time.time())
    if (
        not _is_bounded_positive_integer(expires_at)
        or not _is_bounded_positive_integer(now)
        or now >= expires_at
    ):
        raise Rejected("Immutable-release policy evidence expired before release mutation.")


def validate_release(
    release: dict[str, Any],
    *,
    tag: str,
    title: str,
    prerelease: bool,
    expected_assets: list[Asset],
    allow_draft: bool,
    allowed_extra: re.Pattern[str] | None = None,
) -> dict[str, dict[str, Any]]:
    if release.get("tag_name") != tag:
        raise Rejected("Existing GitHub release tag does not match the promoted tag.")
    if release.get("name") != title:
        raise Rejected("Existing GitHub release title does not match the promoted release.")
    if release.get("prerelease") is not prerelease:
        raise Rejected("Existing GitHub release prerelease state does not match the promoted version.")
    if not isinstance(release.get("draft"), bool) or (release["draft"] and not allow_draft):
        raise Rejected("Existing GitHub release is not finalized.")
    raw_assets = release.get("assets")
    if not isinstance(raw_assets, list):
        raise Rejected("Existing GitHub release has an invalid asset list.")
    expected_names = {asset.name for asset in expected_assets}
    observed: dict[str, dict[str, Any]] = {}
    for raw_asset in raw_assets:
        if not isinstance(raw_asset, dict) or not isinstance(raw_asset.get("name"), str):
            raise Rejected("Existing GitHub release has invalid asset metadata.")
        name = raw_asset["name"]
        if (
            name in {"", ".", ".."}
            or "/" in name
            or "\\" in name
            or len(name.encode("utf-8")) > MAXIMUM_ASSET_NAME_BYTES
        ):
            raise Rejected("Existing GitHub release has unsafe asset metadata.")
        if name in observed:
            raise Rejected(f"Existing GitHub release has duplicate asset {name}.")
        if name not in expected_names and (allowed_extra is None or allowed_extra.fullmatch(name) is None):
            raise Rejected(f"Existing GitHub release has unexpected asset {name}.")
        if raw_asset.get("state") != "uploaded":
            raise Rejected(f"Existing GitHub release asset {name} is not fully uploaded.")
        if not _is_bounded_positive_integer(raw_asset.get("id")):
            raise Rejected(f"Existing GitHub release asset {name} has an invalid identifier.")
        if (
            not _is_bounded_positive_integer(raw_asset.get("size"))
            or raw_asset["size"] > MAXIMUM_ASSET_BYTES
        ):
            raise Rejected(f"Existing GitHub release asset {name} has an invalid size.")
        observed[name] = raw_asset
    return observed


def validate_release_state(release: dict[str, Any], *, tag: str, title: str, prerelease: bool) -> None:
    if release.get("tag_name") != tag or release.get("name") != title:
        raise Rejected("Existing GitHub release metadata does not match the promoted release.")
    if release.get("prerelease") is not prerelease or not isinstance(release.get("draft"), bool):
        raise Rejected("Existing GitHub release state does not match the promoted release.")
    if not isinstance(release.get("immutable"), bool):
        raise Rejected("Existing GitHub release has no immutable-state proof.")
    if release["draft"]:
        if release["immutable"]:
            raise Rejected("A draft GitHub release cannot already be immutable.")
    elif release.get("immutable") is not True:
        raise Rejected("The finalized GitHub release is not immutable.")


def validate_adoption_record(
    payload: bytes, *, name: str, repository: str, tag: str,
    source_commit: str, tarballs: dict[str, Asset], manifest_sha256: str,
) -> None:
    if len(payload) == 0 or len(payload) > MAXIMUM_ADOPTION_RECORD_BYTES:
        raise Rejected(f"Adoption record {name} has an invalid size.")
    try:
        value = _strict_json_loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise Rejected(f"Adoption record {name} is not valid JSON.") from error
    match = ADOPTION_PATTERN.fullmatch(name)
    package_id = match.group(1) if match is not None else ""
    expected_run_id = int(match.group(2)) if match is not None else 0
    expected_run_attempt = int(match.group(3)) if match is not None else 0
    expected_tarball_name = f"latchway-{package_id}-{tag[1:]}.tgz"
    expected_repository = f"https://github.com/{repository}"
    source = value.get("source") if isinstance(value, dict) else None
    provenance = value.get("provenance") if isinstance(value, dict) else None
    adoption = value.get("adoption") if isinstance(value, dict) else None
    registry = value.get("registry_evidence_manifest") if isinstance(value, dict) else None
    tarball = value.get("tarball") if isinstance(value, dict) else None
    provenance_matches_adoption = (
        isinstance(provenance, dict)
        and isinstance(adoption, dict)
        and provenance.get("run_id") == adoption.get("run_id")
        and provenance.get("run_attempt") == adoption.get("run_attempt")
    )
    expected_tarball = tarballs.get(expected_tarball_name)
    expected_sha512 = None
    if expected_tarball is not None:
        digest = hashlib.sha512()
        with expected_tarball.path.open("rb") as source_file:
            while chunk := source_file.read(1024 * 1024):
                digest.update(chunk)
        expected_sha512 = digest.hexdigest()
    if (
        match is None
        or not isinstance(value, dict)
        or set(value) != {
            "schema_version", "kind", "package", "version", "release_tag", "tarball",
            "source", "provenance", "adoption", "registry_evidence_manifest",
        }
        or type(value.get("schema_version")) is not int
        or value.get("schema_version") != 1
        or value.get("kind") != "latchway_npm_release_adoption"
        or value.get("package") != ADOPTION_PACKAGES.get(package_id)
        or value.get("version") != tag[1:]
        or value.get("release_tag") != tag
        or not isinstance(tarball, dict)
        or set(tarball) != {"name", "bytes", "sha256", "sha512", "integrity"}
        or expected_tarball is None
        or tarball.get("name") != expected_tarball_name
        or type(tarball.get("bytes")) is not int
        or tarball.get("bytes") != expected_tarball.size
        or tarball.get("sha256") != expected_tarball.sha256
        or tarball.get("sha512") != expected_sha512
        or tarball.get("integrity") != f"sha512-{base64.b64encode(bytes.fromhex(expected_sha512 or '')).decode('ascii')}"
        or source != {
            "repository": expected_repository,
            "commit": source_commit,
            "workflow": ".github/workflows/release.yml",
            "ref": "refs/heads/main",
        }
        or not isinstance(provenance, dict)
        or set(provenance) != {
            "repository", "commit", "workflow", "ref", "predicate_type",
            "invocation_id", "run_id", "run_attempt",
        }
        or provenance.get("repository") != expected_repository
        or provenance.get("commit") != source_commit
        or provenance.get("workflow") != ".github/workflows/release.yml"
        or provenance.get("ref") != "refs/heads/main"
        or provenance.get("predicate_type") != "https://slsa.dev/provenance/v1"
        or not _is_bounded_positive_integer(provenance.get("run_id"))
        or not _is_bounded_positive_integer(provenance.get("run_attempt"))
        or provenance.get("invocation_id") != (
            f"{expected_repository}/actions/runs/{provenance.get('run_id')}"
            f"/attempts/{provenance.get('run_attempt')}"
        )
        or not isinstance(adoption, dict)
        or set(adoption) != {
            "repository", "commit", "workflow", "ref", "run_id", "run_attempt", "mode",
        }
        or not _is_bounded_positive_integer(expected_run_id)
        or not _is_bounded_positive_integer(expected_run_attempt)
        or not _is_bounded_positive_integer(adoption.get("run_id"))
        or not _is_bounded_positive_integer(adoption.get("run_attempt"))
        or adoption.get("run_id") != expected_run_id
        or adoption.get("run_attempt") != expected_run_attempt
        or adoption.get("repository") != expected_repository
        or adoption.get("commit") != source_commit
        or adoption.get("workflow") != ".github/workflows/release.yml"
        or adoption.get("ref") != "refs/heads/main"
        or adoption.get("mode") not in ("published", "adopted_existing")
        or (adoption.get("mode") == "published") is not provenance_matches_adoption
        or not isinstance(registry, dict)
        or set(registry) != {"file", "sha256"}
        or registry.get("file") != "npm-registry-evidence-manifest.json"
        or registry.get("sha256") != manifest_sha256
    ):
        raise Rejected(f"Adoption record {name} is not bound to this release.")


def verify_adoption_asset(
    client: Client,
    repository: str,
    tag: str,
    source_commit: str,
    name: str,
    remote: dict[str, Any],
    tarballs: dict[str, Asset],
    manifest_sha256: str,
) -> None:
    asset_id = remote.get("id")
    remote_size = remote.get("size")
    advertised_digest = remote.get("digest")
    if (
        remote.get("name") != name
        or not _is_bounded_positive_integer(asset_id)
        or not _is_bounded_positive_integer(remote_size)
        or remote_size > MAXIMUM_ADOPTION_RECORD_BYTES
        or (
            advertised_digest not in (None, "")
            and (
                not isinstance(advertised_digest, str)
                or re.fullmatch(r"sha256:[0-9a-f]{64}", advertised_digest) is None
            )
        )
    ):
        raise Rejected(f"Adoption record {name} has invalid remote asset metadata.")
    with tempfile.TemporaryDirectory(prefix="latchway-release-adoption-") as temporary:
        downloaded = Path(temporary, name)
        client.download(repository, asset_id, downloaded, remote_size)
        metadata = downloaded.lstat()
        if (
            not stat.S_ISREG(metadata.st_mode)
            or downloaded.is_symlink()
            or metadata.st_size != remote_size
            or metadata.st_size > MAXIMUM_ADOPTION_RECORD_BYTES
        ):
            raise Rejected(f"Adoption record {name} downloaded with invalid metadata.")
        payload = downloaded.read_bytes()
        if (
            isinstance(advertised_digest, str)
            and advertised_digest
            and advertised_digest != f"sha256:{hashlib.sha256(payload).hexdigest()}"
        ):
            raise Rejected(f"Adoption record {name} downloaded with a different digest.")
        validate_adoption_record(
            payload,
            name=name,
            repository=repository,
            tag=tag,
            source_commit=source_commit,
            tarballs=tarballs,
            manifest_sha256=manifest_sha256,
        )
        client.verify_attestation(repository, downloaded, source_commit)


def verify_remote_asset(client: Client, repository: str, local: Asset, remote: dict[str, Any]) -> None:
    if remote.get("size") != local.size:
        raise Rejected(f"Existing GitHub release asset {local.name} has different bytes.")
    advertised_digest = remote.get("digest")
    if advertised_digest not in (None, "", f"sha256:{local.sha256}"):
        raise Rejected(f"Existing GitHub release asset {local.name} has a different digest.")
    with tempfile.TemporaryDirectory(prefix="latchway-release-asset-") as temporary:
        downloaded = Path(temporary, local.name)
        client.download(repository, remote["id"], downloaded, local.size)
        metadata = downloaded.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != local.size:
            raise Rejected(f"Existing GitHub release asset {local.name} downloaded with a different size.")
        digest = sha256_file(downloaded)
        if digest != local.sha256:
            raise Rejected(f"Existing GitHub release asset {local.name} is not byte-identical.")


def adoption_package_ids(names: set[str] | list[str]) -> set[str]:
    package_ids: set[str] = set()
    for name in names:
        match = ADOPTION_PATTERN.fullmatch(name)
        if match is None:
            raise Rejected(f"Npm adoption history contains an invalid package record {name}.")
        package_ids.add(match.group(1))
    return package_ids


def reconcile(
    *,
    repository: str,
    tag: str,
    title: str,
    prerelease: bool,
    assets: list[Asset],
    client: Client,
    expected_commit: str,
    adoption_pattern: re.Pattern[str] | None = None,
    immutable_policy_expires_at: int | None = None,
) -> None:
    if COMMIT.fullmatch(expected_commit) is None:
        raise Rejected("The expected promoted commit is not a canonical Git object ID.")
    # The administration read is intentionally the first external operation.
    # Never create or mutate a release when GitHub cannot prove that immutable
    # releases are enabled for this repository.
    if immutable_policy_expires_at is None:
        if not client.immutable_releases_enabled(repository):
            raise Rejected(
                "Immutable GitHub releases are not enforced by the repository owner."
            )
    else:
        require_immutable_policy_current(immutable_policy_expires_at)
    release = client.release(repository, tag)
    if release is None:
        client.validate_remote_tag(repository, tag, expected_commit)
        if immutable_policy_expires_at is not None:
            require_immutable_policy_current(immutable_policy_expires_at)
        client.create(repository, tag, title, prerelease)
        release = client.release(repository, tag)
        if release is None:
            raise RuntimeError("GitHub did not expose the newly created draft release.")

    observed = validate_release(
        release,
        tag=tag,
        title=title,
        prerelease=prerelease,
        expected_assets=assets,
        allow_draft=True,
        allowed_extra=adoption_pattern,
    )
    validate_release_state(release, tag=tag, title=title, prerelease=prerelease)
    adoption_names = sorted(name for name in observed if adoption_pattern is not None and adoption_pattern.fullmatch(name))
    tarballs = {asset.name: asset for asset in assets if asset.name.endswith(".tgz")}
    registry_manifest = next(
        (asset for asset in assets if asset.name == "npm-registry-evidence-manifest.json"),
        None,
    )
    manifest_sha256 = registry_manifest.sha256 if registry_manifest is not None else ""
    expected_adoption_ids: set[str] = set()
    if adoption_pattern is not None:
        if not tarballs or registry_manifest is None:
            raise Rejected(
                "Npm adoption history requires exact release tarballs and registry evidence."
            )
        for name in adoption_names:
            verify_adoption_asset(
                client, repository, tag, expected_commit, name, observed[name],
                tarballs, manifest_sha256,
            )
        for asset in assets:
            if adoption_pattern.fullmatch(asset.name):
                match = ADOPTION_PATTERN.fullmatch(asset.name)
                if match is None or match.group(1) in expected_adoption_ids:
                    raise Rejected("Each npm package requires one unambiguous current adoption record.")
                if asset.size > MAXIMUM_ADOPTION_RECORD_BYTES:
                    raise Rejected(f"Adoption record {asset.name} has an invalid size.")
                expected_adoption_ids.add(match.group(1))
                validate_adoption_record(
                    asset.path.read_bytes(),
                    name=asset.name,
                    repository=repository,
                    tag=tag,
                    source_commit=expected_commit,
                    tarballs=tarballs,
                    manifest_sha256=manifest_sha256,
                )
                # A finalized release can satisfy a later full redispatch with
                # an already-attested historical record for the same package.
                # The new local attempt record is not uploaded in that case,
                # and the OIDC attestation step is intentionally skipped.
                if release["draft"] or asset.name in observed:
                    client.verify_attestation(repository, asset.path, expected_commit)
        if not expected_adoption_ids:
            raise Rejected("Npm adoption history requires a current record for every release package.")
    # Prove every existing byte before making any mutation. A mismatched
    # partial release must fail without uploading otherwise-missing assets.
    for asset in assets:
        remote = observed.get(asset.name)
        if remote is not None:
            verify_remote_asset(client, repository, asset, remote)
    for asset in assets:
        if asset.name not in observed:
            if release["draft"] is not True:
                if adoption_pattern is not None and adoption_pattern.fullmatch(asset.name):
                    match = ADOPTION_PATTERN.fullmatch(asset.name)
                    remote_ids = adoption_package_ids(adoption_names)
                    if match is not None and match.group(1) in remote_ids:
                        continue
                raise Rejected(f"Final GitHub release is missing immutable asset {asset.name}.")
            if immutable_policy_expires_at is not None:
                require_immutable_policy_current(immutable_policy_expires_at)
            client.upload(repository, tag, asset.path)

    release = client.release(repository, tag)
    if release is None:
        raise RuntimeError("GitHub release disappeared during asset reconciliation.")
    observed = validate_release(
        release,
        tag=tag,
        title=title,
        prerelease=prerelease,
        expected_assets=assets,
        allow_draft=True,
        allowed_extra=adoption_pattern,
    )
    expected_fixed = {
        asset.name for asset in assets
        if adoption_pattern is None or adoption_pattern.fullmatch(asset.name) is None
    }
    observed_adoptions = {
        name for name in observed
        if adoption_pattern is not None and adoption_pattern.fullmatch(name)
    }
    if not expected_fixed.issubset(observed) or (
        adoption_pattern is not None
        and not expected_adoption_ids.issubset(adoption_package_ids(observed_adoptions))
    ):
        raise Rejected("GitHub draft release does not contain the complete immutable asset set.")
    for asset in assets:
        if asset.name not in observed and adoption_pattern is not None and adoption_pattern.fullmatch(asset.name):
            continue
        verify_remote_asset(client, repository, asset, observed[asset.name])

    if release["draft"]:
        client.validate_remote_tag(repository, tag, expected_commit)
        # Re-check every retained adoption record after all uploads and as
        # close as possible to finalization. This prevents a draft writer that
        # changed an existing record during reconciliation from reaching the
        # irreversible finalize operation. The post-finalization pass below is
        # still required because GitHub does not expose an atomic
        # compare-and-finalize operation for draft asset bytes.
        for name in sorted(observed_adoptions):
            verify_adoption_asset(
                client, repository, tag, expected_commit, name, observed[name],
                tarballs, manifest_sha256,
            )
        if immutable_policy_expires_at is not None:
            require_immutable_policy_current(immutable_policy_expires_at)
        client.finalize(repository, tag, prerelease)

    final = client.release(repository, tag)
    if final is None:
        raise RuntimeError("GitHub release disappeared after finalization.")
    final_assets = validate_release(
        final,
        tag=tag,
        title=title,
        prerelease=prerelease,
        expected_assets=assets,
        allow_draft=False,
        allowed_extra=adoption_pattern,
    )
    validate_release_state(final, tag=tag, title=title, prerelease=prerelease)
    final_adoptions = {
        name for name in final_assets
        if adoption_pattern is not None and adoption_pattern.fullmatch(name)
    }
    if not expected_fixed.issubset(final_assets) or (
        adoption_pattern is not None
        and not expected_adoption_ids.issubset(adoption_package_ids(final_adoptions))
    ):
        raise Rejected("Final GitHub release does not contain the complete immutable asset set.")
    # A draft writer could have changed an allowed historical record after the
    # initial pre-mutation check. Re-download and re-verify every immutable
    # adoption extra before accepting the finalized release.
    for name in sorted(final_adoptions):
        verify_adoption_asset(
            client, repository, tag, expected_commit, name, final_assets[name],
            tarballs, manifest_sha256,
        )
    for asset in assets:
        if asset.name not in final_assets and adoption_pattern is not None and adoption_pattern.fullmatch(asset.name):
            continue
        verify_remote_asset(client, repository, asset, final_assets[asset.name])
    with tempfile.TemporaryDirectory(prefix="latchway-release-final-assets-") as temporary:
        local_by_name = {asset.name: asset for asset in assets if asset.name in final_assets}
        final_local: list[Asset] = []
        for name, remote in sorted(final_assets.items()):
            local = local_by_name.get(name)
            if local is None:
                downloaded = Path(temporary, name)
                client.download(repository, remote["id"], downloaded, remote["size"])
                local = inspect_assets([str(downloaded)])[0]
            final_local.append(local)
        client.verify_release_attestation(repository, tag, expected_commit, final_local)


def prepare_release(
    *, repository: str, tag: str, title: str, prerelease: bool,
    expected_commit: str, expected_names: set[str],
    adoption_pattern: re.Pattern[str] | None, client: Client,
) -> str:
    if COMMIT.fullmatch(expected_commit) is None:
        raise Rejected("The expected promoted commit is not a canonical Git object ID.")
    if not client.immutable_releases_enabled(repository):
        raise Rejected("Immutable GitHub releases are not enabled for this repository.")
    release = client.release(repository, tag)
    if release is None:
        client.validate_remote_tag(repository, tag, expected_commit)
        client.create(repository, tag, title, prerelease)
        release = client.release(repository, tag)
        if release is None:
            raise RuntimeError("GitHub did not expose the newly created draft release.")
    validate_release_state(release, tag=tag, title=title, prerelease=prerelease)
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise Rejected("Existing GitHub release has an invalid asset list.")
    seen: set[str] = set()
    for asset in assets:
        name = asset.get("name") if isinstance(asset, dict) else None
        if not isinstance(name, str) or name in seen:
            raise Rejected("Existing GitHub release has invalid or duplicate assets.")
        if name not in expected_names and (adoption_pattern is None or adoption_pattern.fullmatch(name) is None):
            raise Rejected(f"Existing GitHub release has unexpected asset {name}.")
        seen.add(name)
    return "draft" if release["draft"] else "immutable"


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--prerelease", action="store_true")
    parser.add_argument("--prepare-draft", action="store_true")
    parser.add_argument("--expected-asset-name", action="append", default=[])
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--npm-adoption-history", action="store_true")
    parser.add_argument("--verified-immutable-policy")
    parser.add_argument("--verified-immutable-policy-sha256")
    parser.add_argument("--verified-immutable-policy-run-id")
    parser.add_argument("--verified-immutable-policy-run-attempt")
    parser.add_argument("assets", nargs="*")
    arguments = parser.parse_args()
    if not isinstance(arguments.repository, str) or REPOSITORY.fullmatch(arguments.repository) is None:
        parser.error("--repository must be an owner/repository name")
    if TAG.fullmatch(arguments.tag) is None:
        parser.error("--tag must be a canonical semantic-version release tag")
    if not arguments.title or "\n" in arguments.title or "\r" in arguments.title:
        parser.error("--title must be a non-empty single line")
    if arguments.prepare_draft and arguments.assets:
        parser.error("--prepare-draft does not accept local assets")
    if not arguments.prepare_draft and not arguments.assets:
        parser.error("at least one release asset is required")
    if COMMIT.fullmatch(arguments.expected_commit) is None:
        parser.error("--expected-commit must be a lowercase 40-character commit ID")
    policy_arguments = (
        arguments.verified_immutable_policy,
        arguments.verified_immutable_policy_sha256,
        arguments.verified_immutable_policy_run_id,
        arguments.verified_immutable_policy_run_attempt,
    )
    if any(value is not None for value in policy_arguments) and not all(
        value is not None for value in policy_arguments
    ):
        parser.error(
            "verified immutable-policy path, digest, run ID, and run attempt must be used together"
        )
    if arguments.prepare_draft and arguments.verified_immutable_policy is not None:
        parser.error("--prepare-draft performs its own live immutable-policy check")
    for name in (
        "verified_immutable_policy_run_id",
        "verified_immutable_policy_run_attempt",
    ):
        value = getattr(arguments, name)
        if value is not None and (
            len(value) > 16
            or re.fullmatch(r"[1-9][0-9]*", value) is None
            or not _is_bounded_positive_integer(int(value))
        ):
            parser.error(f"--{name.replace('_', '-')} must be a positive JSON-safe integer")
    return arguments


def main() -> int:
    arguments = parse_arguments()
    try:
        try:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("require-gh-version.py"))],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                preexec_fn=_child_file_size_limit(MAXIMUM_DIAGNOSTIC_BYTES),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError(
                "GitHub CLI version verification exceeded its execution bounds."
            ) from error
        if result.returncode != 0:
            raise RuntimeError("GitHub CLI does not satisfy the release security baseline.")
        adoption_pattern = (
            ADOPTION_PATTERN
            if arguments.npm_adoption_history else None
        )
        client = GitHubClient()
        if arguments.prepare_draft:
            state = prepare_release(
                repository=arguments.repository,
                tag=arguments.tag,
                title=arguments.title,
                prerelease=arguments.prerelease,
                expected_commit=arguments.expected_commit,
                expected_names=set(arguments.expected_asset_name),
                adoption_pattern=adoption_pattern,
                client=client,
            )
            output = f"release_state={state}\n"
            github_output = os.environ.get("GITHUB_OUTPUT")
            if github_output:
                with Path(github_output).open("a", encoding="utf-8") as destination:
                    destination.write(output)
            else:
                print(output, end="")
            return 0
        policy_expires_at = None
        if arguments.verified_immutable_policy is not None:
            policy_expires_at = validate_immutable_policy_evidence(
                Path(arguments.verified_immutable_policy),
                repository=arguments.repository,
                expected_sha256=arguments.verified_immutable_policy_sha256,
                expected_run_id=int(arguments.verified_immutable_policy_run_id),
                expected_run_attempt=int(arguments.verified_immutable_policy_run_attempt),
            )
        assets = inspect_assets(arguments.assets)
        reconcile(
            repository=arguments.repository,
            tag=arguments.tag,
            title=arguments.title,
            prerelease=arguments.prerelease,
            assets=assets,
            client=client,
            expected_commit=arguments.expected_commit,
            adoption_pattern=adoption_pattern,
            immutable_policy_expires_at=policy_expires_at,
        )
    except (OSError, Rejected, RuntimeError) as error:
        print(f"release reconciliation rejected: {error}", file=sys.stderr)
        return 1
    print(f"Verified immutable GitHub release {arguments.repository}@{arguments.tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
