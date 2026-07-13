#!/usr/bin/env python3
"""Remove obsolete SamQL source/test files left by an older full-source build.

The full-source expander writes every file in the selected bundle, but older
expanders did not delete files that disappeared in a later build. TypeScript,
ESLint, Python compileall, and test discovery recurse through source trees, so a
retired file can still break a clean release even when every current file was
successfully overwritten.

This tool is intentionally conservative. It only examines bundle-owned source
and test directories and compares them with SOURCE_MANIFEST.txt. It never walks
node_modules, dist/build output, Playwright reports, caches outside those source
trees, or user data.
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

MANAGED_ROOTS = (
    ".github/workflows",
    "backend/samql_core",
    "frontend/e2e",
    "frontend/src",
    "tests",
    "tools",
)


def _norm(value: str | Path) -> str:
    return str(value).replace("\\", "/").lstrip("./")


def load_manifest(path: Path) -> set[str]:
    """Read non-empty, non-comment relative paths from the source manifest."""
    entries: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        rel = _norm(line)
        if rel.startswith("../") or "/../" in f"/{rel}/" or Path(rel).is_absolute():
            raise ValueError(f"unsafe manifest path: {line!r}")
        entries.add(rel)
    if not entries:
        raise ValueError(f"source manifest is empty: {path}")
    return entries


def find_stale_files(root: Path, expected: Iterable[str]) -> list[Path]:
    """Return files under managed roots that are absent from ``expected``."""
    root = root.resolve()
    expected_set = {_norm(item).casefold() for item in expected}
    stale: list[Path] = []
    for rel_root in MANAGED_ROOTS:
        base = root / rel_root
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() and not path.is_symlink():
                continue
            rel = _norm(path.relative_to(root)).casefold()
            if rel not in expected_set:
                stale.append(path)
    return sorted(stale, key=lambda p: _norm(p.relative_to(root)).casefold())


def prune(root: Path, manifest: Path, *, check: bool = False) -> list[str]:
    """Delete stale managed files, or only report them when ``check`` is true."""
    root = root.resolve()
    manifest = manifest.resolve()
    expected = load_manifest(manifest)
    stale = find_stale_files(root, expected)
    removed: list[str] = []
    for path in stale:
        rel = _norm(path.relative_to(root))
        removed.append(rel)
        if not check:
            path.unlink(missing_ok=True)

    if not check:
        # Retired files can leave empty test/source directories behind.
        for rel_root in MANAGED_ROOTS:
            base = root / rel_root
            if not base.exists():
                continue
            dirs = sorted(
                (p for p in base.rglob("*") if p.is_dir()),
                key=lambda p: len(p.parts),
                reverse=True,
            )
            for directory in dirs:
                try:
                    directory.rmdir()
                except OSError:
                    pass
    return removed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--check", action="store_true",
                        help="report stale files and fail instead of deleting them")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    manifest = (args.manifest or (root / "SOURCE_MANIFEST.txt")).resolve()
    if not manifest.is_file():
        parser.error(f"source manifest not found: {manifest}")

    stale = prune(root, manifest, check=args.check)
    for rel in stale:
        prefix = "STALE" if args.check else "REMOVED"
        print(f"{prefix} {rel}")
    if args.check and stale:
        print(f"Found {len(stale)} obsolete managed source file(s).")
        return 1
    print(f"Managed source tree is exact ({len(stale)} obsolete file(s) removed).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
