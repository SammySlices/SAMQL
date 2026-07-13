#!/usr/bin/env python3
"""Make an npm package-lock portable across registries.

npm lockfiles pin dependency versions and integrity hashes. Absolute HTTP(S)
``resolved`` URLs, however, can capture a build machine's private registry and
make ``npm ci`` fail elsewhere. Removing only those URL fields lets npm use the
registry configured on the current machine while keeping the dependency graph
and integrity checks fully locked.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
from typing import Any


def _absolute_registry_url(value: object) -> bool:
    return isinstance(value, str) and value.lower().startswith(("http://", "https://"))


def normalize(lock: dict[str, Any]) -> list[tuple[str, str]]:
    """Remove absolute HTTP(S) resolved URLs and return what changed."""
    removed: list[tuple[str, str]] = []
    packages = lock.get("packages")
    if not isinstance(packages, dict):
        raise ValueError("package-lock.json has no object-valued 'packages' map")

    for package_path, metadata in packages.items():
        if not isinstance(metadata, dict):
            continue
        resolved = metadata.get("resolved")
        if _absolute_registry_url(resolved):
            removed.append((str(package_path), str(resolved)))
            del metadata["resolved"]
    return removed


def _write_atomic(path: Path, lock: dict[str, Any]) -> None:
    text = json.dumps(lock, indent=2, ensure_ascii=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lockfile", type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Fail if normalization is needed.")
    mode.add_argument("--write", action="store_true", help="Normalize the lockfile atomically.")
    args = parser.parse_args()

    path: Path = args.lockfile
    try:
        lock = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(lock, dict):
            raise ValueError("package-lock.json top level must be an object")
        removed = normalize(lock)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"ERROR: {path}: {exc}")
        return 2

    if not removed:
        print(f"Portable npm lockfile: OK ({path})")
        return 0

    if args.write:
        try:
            _write_atomic(path, lock)
        except OSError as exc:
            print(f"ERROR: could not update {path}: {exc}")
            return 2
        print(f"Portable npm lockfile: removed {len(removed)} registry-specific resolved URL(s).")
        return 0

    print(f"Portable npm lockfile: {len(removed)} registry-specific resolved URL(s) found:")
    for package_path, url in removed[:20]:
        label = package_path or "<root>"
        print(f"  {label}: {url}")
    if len(removed) > 20:
        print(f"  ... and {len(removed) - 20} more")
    print("Run this tool with --write to normalize the lockfile.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
