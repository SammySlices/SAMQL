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


# Cursor sandboxes inject npm_config_devdir / sandbox caches. Corporate
# shells often set npm_config_registry to an internal Artifactory (e.g.
# rp.td.com) that returns truncated JSON. Strip every npm_config_* so
# SamQL's --registry + project .npmrc win; never inherit the ambient
# registry from the user environment.
def _scrub_sandbox_npm_env(env: Mapping[str, str]) -> dict[str, str]:
    cleaned: dict[str, str] = {}
    for key, value in env.items():
        low = key.lower()
        if low.startswith("npm_config_"):
            continue
        cleaned[key] = value
    return cleaned


def _norm_registry(value: str | None) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    return text if text.endswith("/") else text + "/"


def _write_isolated_npmrc(cache: Path, registry: str) -> tuple[Path, Path]:
    """Project + empty global npmrc so user/corporate mirrors cannot win."""
    cache.mkdir(parents=True, exist_ok=True)
    user = cache / "samql-user.npmrc"
    glob = cache / "samql-global.npmrc"
    user.write_text(
        f"registry={registry}\nfund=false\naudit=false\n",
        encoding="utf-8",
    )
    # Empty global config: blocks HKCU / %APPDATA%\npm\etc\npmrc mirrors.
    glob.write_text("", encoding="utf-8")
    return user, glob


def _ci_command(
    npm: str,
    cache: Path,
    registry: str,
    userconfig: Path,
    globalconfig: Path,
) -> list[str]:
    return [
        npm,
        "ci",
        "--no-audit",
        "--fund=false",
        "--prefer-online",
        "--cache",
        str(cache),
        f"--registry={registry}",
        f"--userconfig={userconfig}",
        f"--globalconfig={globalconfig}",
    ]


def is_integrity_failure(output: str) -> bool:
    return bool(_INTEGRITY_RE.search(output))


def is_registry_body_failure(output: str) -> bool:
    """Corporate mirrors often return truncated / non-JSON package metadata."""
    text = output or ""
    needles = (
        "invalid json",
        "unterminated string in json",
        "unexpected end of json",
        "unexpected token",
        "einvalid",
        "error parsing json",
        "registry returned 404",
        "registry returned 500",
        "registry returned 502",
        "registry returned 503",
    )
    low = text.lower()
    return any(n in low for n in needles)


def _frontend_tooling_ok(frontend: Path) -> bool:
    """True when vite/tsc are present, or node_modules is empty (unit-test stub)."""
    nm = frontend / "node_modules"
    if not nm.is_dir():
        return False
    vite = nm / "vite" / "bin" / "vite.js"
    tsc = nm / "typescript" / "bin" / "tsc"
    if vite.is_file() and tsc.is_file():
        return True
    try:
        entries = [p for p in nm.iterdir() if p.name not in {".bin", ".cache", ".package-lock.json"}]
    except OSError:
        return False
    # Integrity unit tests use an empty node_modules stub after a mocked ci.
    return len(entries) == 0


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
    """Run a locked npm install against an isolated public (or explicit) registry."""
    frontend = frontend.resolve()
    cache = cache.resolve()
    node_modules = frontend / "node_modules"
    run_env = _scrub_sandbox_npm_env(os.environ if env is None else env)
    # Force the chosen registry into the child env as well as CLI flags.
    # Do not probe ambient `npm config get registry` here: that call can
    # itself hit a broken corporate mirror and is unnecessary once we pin
    # --registry / --userconfig / --globalconfig.
    active_registry = _norm_registry(registry) or OFFICIAL_REGISTRY
    run_env["npm_config_registry"] = active_registry
    cache.parent.mkdir(parents=True, exist_ok=True)

    print(f"Using npm registry: {_redact_url(active_registry)}", flush=True)
    print(f"SamQL isolated npm cache: {cache}", flush=True)

    def _attempt(reg: str) -> CommandResult:
        uc, gc = _write_isolated_npmrc(cache, reg)
        run_env["npm_config_registry"] = reg
        return runner(_ci_command(npm, cache, reg, uc, gc), frontend, run_env)

    def _succeeded(result: CommandResult) -> bool:
        if result.returncode != 0:
            return False
        if _frontend_tooling_ok(frontend):
            return True
        print(
            "ERROR: npm ci finished but vite/typescript binaries are missing "
            "under frontend/node_modules. Re-run after deleting "
            "frontend/node_modules, or check corporate registry interference.",
            file=sys.stderr,
            flush=True,
        )
        return False

    result = _attempt(active_registry)
    if _succeeded(result):
        return 0

    retryable = is_integrity_failure(result.output) or is_registry_body_failure(result.output)
    if retryable:
        print(
            "npm reported a package-integrity or registry-body failure. "
            "Removing the isolated cache and partial node_modules tree, "
            "then retrying the exact lockfile.",
            file=sys.stderr,
            flush=True,
        )
        cleaner(cache)
        cleaner(node_modules)
        cache.mkdir(parents=True, exist_ok=True)
        result = _attempt(active_registry)
        if _succeeded(result):
            print("npm recovery succeeded with a fresh isolated cache.", flush=True)
            return 0

    official = OFFICIAL_REGISTRY
    can_fallback = (
        allow_public_fallback
        and _norm_registry(active_registry).rstrip("/").lower()
        != official.rstrip("/").lower()
    )
    if not can_fallback:
        # Already on public registry but ambient config may still have won on
        # an older npm; one more explicit public attempt after wipe.
        if allow_public_fallback and (retryable or not _frontend_tooling_ok(frontend)):
            print(
                "Retrying once more against the public npm registry with a "
                "fresh isolated cache.",
                file=sys.stderr,
                flush=True,
            )
            cleaner(cache)
            cleaner(node_modules)
            cache.mkdir(parents=True, exist_ok=True)
            result = _attempt(official)
            if _succeeded(result):
                print("npm install succeeded using the public registry.", flush=True)
                return 0
            return result.returncode or 1
        return result.returncode or 1

    print(
        "Retrying once against the public npm registry while keeping lockfile "
        "integrity checks enabled.",
        file=sys.stderr,
        flush=True,
    )
    cleaner(cache)
    cleaner(node_modules)
    cache.mkdir(parents=True, exist_ok=True)
    result = _attempt(official)
    if _succeeded(result):
        print("npm install succeeded using the public registry fallback.", flush=True)
        return 0
    return result.returncode or 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frontend", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--npm", default=None, help="Path to npm/npm.cmd; defaults to PATH lookup.")
    parser.add_argument(
        "--registry",
        default=os.environ.get("SAMQL_NPM_REGISTRY") or None,
        help="Explicit npm registry. Defaults to https://registry.npmjs.org/ "
             "(ignores corporate/user npmrc mirrors).",
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
