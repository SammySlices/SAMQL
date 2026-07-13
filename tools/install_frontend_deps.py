#!/usr/bin/env python3
"""Install SamQL frontend dependencies with integrity-safe recovery.

The installer keeps npm's normal Subresource Integrity checks enabled. It uses
an isolated project cache so a damaged global npm cache cannot poison the test
run. If npm reports EINTEGRITY or a corrupted tarball, the isolated cache and
partial node_modules tree are removed and the exact locked install is retried.
If a configured corporate mirror still returns bad bytes, one final public
registry attempt is made unless explicitly disabled.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Callable, Iterable, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit

OFFICIAL_REGISTRY = "https://registry.npmjs.org/"
_INTEGRITY_RE = re.compile(
    r"(?:\bEINTEGRITY\b|integrity checksum failed|tarball data.*seems to be corrupted|checksum failed)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    output: str


Runner = Callable[[Sequence[str], Path, Mapping[str, str]], CommandResult]
Cleaner = Callable[[Path], None]


def _redact_url(value: str) -> str:
    """Hide embedded registry credentials while keeping useful diagnostics."""
    try:
        parts = urlsplit(value)
    except ValueError:
        return value
    if not parts.scheme or not parts.netloc:
        return value
    host = parts.hostname or ""
    if parts.port:
        host += f":{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


def _resolve_npm(explicit: str | None) -> str:
    if explicit:
        return explicit
    names = ("npm.cmd", "npm") if os.name == "nt" else ("npm", "npm.cmd")
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    raise FileNotFoundError("npm was not found on PATH")


def _run_streaming(command: Sequence[str], cwd: Path, env: Mapping[str, str]) -> CommandResult:
    shown = " ".join(_redact_url(arg) if arg.startswith(("http://", "https://")) else arg for arg in command)
    print(f"Running: {shown}", flush=True)
    proc = subprocess.Popen(
        list(command),
        cwd=str(cwd),
        env=dict(env),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    output_lines: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line, end="", flush=True)
        output_lines.append(line)
    return CommandResult(proc.wait(), "".join(output_lines))


def _remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path, ignore_errors=False)


def _configured_registry(
    npm: str,
    frontend: Path,
    env: Mapping[str, str],
    runner: Runner,
) -> str | None:
    result = runner([npm, "config", "get", "registry"], frontend, env)
    if result.returncode != 0:
        return None
    for line in reversed(result.output.splitlines()):
        value = line.strip()
        if value.startswith(("http://", "https://")):
            return value if value.endswith("/") else value + "/"
    return None


def _ci_command(npm: str, cache: Path, registry: str | None) -> list[str]:
    command = [
        npm,
        "ci",
        "--no-audit",
        "--fund=false",
        "--prefer-online",
        "--cache",
        str(cache),
    ]
    if registry:
        command.append(f"--registry={registry}")
    return command


def is_integrity_failure(output: str) -> bool:
    return bool(_INTEGRITY_RE.search(output))


def install_with_recovery(
    *,
    frontend: Path,
    npm: str,
    cache: Path,
    registry: str | None,
    allow_public_fallback: bool,
    env: Mapping[str, str] | None = None,
    runner: Runner = _run_streaming,
    cleaner: Cleaner = _remove_tree,
) -> int:
    """Run a locked npm install, recovering only from integrity corruption."""
    frontend = frontend.resolve()
    cache = cache.resolve()
    node_modules = frontend / "node_modules"
    run_env = dict(os.environ if env is None else env)
    cache.parent.mkdir(parents=True, exist_ok=True)

    configured = registry or _configured_registry(npm, frontend, run_env, runner)
    active_registry = registry
    if configured:
        print(f"Configured npm registry: {_redact_url(configured)}", flush=True)
    print(f"SamQL isolated npm cache: {cache}", flush=True)

    result = runner(_ci_command(npm, cache, active_registry), frontend, run_env)
    if result.returncode == 0:
        return 0
    if not is_integrity_failure(result.output):
        return result.returncode

    print(
        "npm reported a package-integrity failure. Removing the isolated cache "
        "and partial node_modules tree, then retrying the exact lockfile.",
        file=sys.stderr,
        flush=True,
    )
    cleaner(cache)
    cleaner(node_modules)
    cache.mkdir(parents=True, exist_ok=True)

    result = runner(_ci_command(npm, cache, active_registry), frontend, run_env)
    if result.returncode == 0:
        print("npm integrity recovery succeeded with a fresh isolated cache.", flush=True)
        return 0
    if not is_integrity_failure(result.output):
        return result.returncode

    configured_normalized = (configured or "").rstrip("/").lower()
    official_normalized = OFFICIAL_REGISTRY.rstrip("/").lower()
    can_fallback = (
        allow_public_fallback
        and registry is None
        and configured_normalized
        and configured_normalized != official_normalized
    )
    if not can_fallback:
        return result.returncode

    print(
        "The configured npm mirror returned corrupt bytes twice. Retrying once "
        "against the public npm registry while keeping lockfile integrity checks enabled.",
        file=sys.stderr,
        flush=True,
    )
    cleaner(cache)
    cleaner(node_modules)
    cache.mkdir(parents=True, exist_ok=True)
    result = runner(
        _ci_command(npm, cache, OFFICIAL_REGISTRY),
        frontend,
        run_env,
    )
    if result.returncode == 0:
        print("npm install succeeded using the public registry fallback.", flush=True)
    return result.returncode


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frontend", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--npm", default=None, help="Path to npm/npm.cmd; defaults to PATH lookup.")
    parser.add_argument(
        "--registry",
        default=os.environ.get("SAMQL_NPM_REGISTRY") or None,
        help="Explicit npm registry. Defaults to npm's configured registry.",
    )
    parser.add_argument(
        "--no-public-fallback",
        action="store_true",
        default=os.environ.get("SAMQL_NPM_NO_PUBLIC_FALLBACK", "").strip().lower()
        in {"1", "true", "yes", "on"},
        help="Do not retry the public npm registry after repeated mirror corruption.",
    )
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = _parser().parse_args(list(argv) if argv is not None else None)
    try:
        npm = _resolve_npm(args.npm)
        if not args.frontend.is_dir():
            raise FileNotFoundError(f"frontend directory not found: {args.frontend}")
        lock = args.frontend / "package-lock.json"
        if not lock.is_file():
            raise FileNotFoundError(f"package lock not found: {lock}")
        return install_with_recovery(
            frontend=args.frontend,
            npm=npm,
            cache=args.cache,
            registry=args.registry,
            allow_public_fallback=not args.no_public_fallback,
        )
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
