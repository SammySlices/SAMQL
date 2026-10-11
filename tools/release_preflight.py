#!/usr/bin/env python3
"""Fail-fast release identity, compatibility, source, and CI validation.

The normal application tests prove behavior.  This preflight proves that the
*thing being shipped* is one coherent release: version/build labels agree,
saved-data schema versions are declared, the manifest describes one exact
managed source tree, CI still drives the required browser, and the source
transport tooling is present.

It deliberately uses only the Python standard library so it can run before any
dependencies are installed::

    python tools/release_preflight.py --root .
    python tools/release_preflight.py --root . --json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

MANAGED_ROOTS = (
    ".github/workflows",
    "backend/samql_core",
    "frontend/e2e",
    "frontend/src",
    "tests",
    "tools",
)

# Root / toolchain files that must ship in every full-source extract so an
# Expand-SamQL destination can run ``Test-SamQL-All.ps1`` without missing pieces.
TEST_EXTRACT_BOOTSTRAP = (
    "Test-SamQL-All.ps1",
    "Run-SamQLTests.ps1",
    "Expand-SamQL.ps1",
    "Decode-SamQL-APHEX.ps1",
    "Pack-SamQL.ps1",
    "VERSION",
    "RELEASE_MANIFEST.json",
    "SOURCE_MANIFEST.txt",
    "RELEASE_CHECKLIST.md",
    "requirements-test.txt",
    "requirements-optional.txt",
    "backend/requirements.txt",
    "backend/server.py",
    "backend/launcher_app.py",
    "frontend/package.json",
    "frontend/package-lock.json",
    "frontend/vite.config.ts",
    "frontend/vitest.config.ts",
    "frontend/playwright.config.ts",
    "frontend/eslint.config.js",
    "frontend/tsconfig.json",
    "frontend/tsconfig.node.json",
    "frontend/index.html",
    "frontend/src/main.tsx",
    "frontend/src/test/setup.ts",
    "frontend/e2e/fixtures.ts",
    "frontend/e2e/run-playwright-edge.mjs",
    "frontend/e2e/workflow-smoke.spec.ts",
    "tests/run_tests.py",
    "tests/harness.py",
    "tests/paths.py",
    "tests/fixtures.py",
    "tests/node_harnesses.py",
    "tests/suites/__init__.py",
    "tests/suites/backend.py",
    "tests/suites/frontend.py",
    "tests/suites/http_api.py",
    "tests/test_release_hardening.py",
    "tests/test_optimizations_dual_engine.py",
    "tests/test_nodeflow_resources.py",
    "tests/benchmark_workloads.py",
    "tools/release_artifacts.py",
    "tools/release_preflight.py",
    "tools/package_release.py",
    "tools/aphex_transport.py",
    "tools/install_frontend_deps.py",
    "tools/normalize_npm_lock.py",
    "tools/prune_stale_source.py",
)

# Entire trees that belong in the full-source extract for a green complete suite.
TEST_EXTRACT_TREES = (
    "tests",
    "tools",
    "frontend/e2e",
)

GENERATED_PARTS = {
    "node_modules",
    "dist",
    "build",
    "playwright-report",
    "test-results",
    "__pycache__",
    ".pytest_cache",
    ".vite",
    ".vite-temp",
}

_DANGEROUS_RX = re.compile(
    r"(?i)\.(exe|dll|msi|bat|cmd|scr|vbs|ps1|jar)(?=$|[^A-Za-z0-9])"
)
_DEFANGED_DANGEROUS_RX = re.compile(
    r"(?i)\[\.\](exe|dll|msi|bat|cmd|scr|vbs|ps1|jar)(?=$|[^A-Za-z0-9])"
)
_BUILD_RX = re.compile(r"^\d{4}-\d{2}-\d{2}\.\d+$")
_SEMVER_RX = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str


class Checks:
    def __init__(self) -> None:
        self.items: list[Check] = []

    def add(self, name: str, ok: bool, detail: str) -> None:
        self.items.append(Check(name=name, ok=bool(ok), detail=detail))

    def equal(self, name: str, values: dict[str, Any]) -> None:
        unique = {json.dumps(v, sort_keys=True) for v in values.values()}
        detail = ", ".join(f"{key}={value!r}" for key, value in values.items())
        self.add(name, len(unique) == 1, detail)


def _norm(value: str | Path) -> str:
    normalized = str(value).replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized


def _refang_transport_text(value: str) -> str:
    """Restore only dangerous-extension markers emitted by the packager."""
    return _DEFANGED_DANGEROUS_RX.sub(
        lambda match: f".{match.group(1)}", value
    )


def _alternate_rel(rel: str) -> str:
    if _DEFANGED_DANGEROUS_RX.search(rel):
        return _refang_transport_text(rel)
    return _DANGEROUS_RX.sub(lambda m: f"[.]{m.group(1)}", rel)


def _logical_rel(rel: str) -> str:
    """Collapse normal/mail-safe dangerous extensions to one identity."""
    return _refang_transport_text(_norm(rel))


def _transport_rel(rel: str) -> str:
    """Return the canonical mail-safe spelling used for bundle ordering."""
    return _DANGEROUS_RX.sub(lambda match: f"[.]{match.group(1)}", _norm(rel))


def _contains_spelling(source: str, token: str) -> bool:
    """Accept a token before or after Expand-SamQL's targeted refang pass."""
    return token in source or _alternate_rel(token) in source


def resolve_manifest_path(root: Path, rel: str) -> Path:
    direct = root / Path(rel)
    if direct.is_file():
        return direct
    alternate = root / Path(_alternate_rel(rel))
    if alternate.is_file():
        return alternate
    return direct


def load_manifest(path: Path) -> list[str]:
    entries: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        rel = _norm(line)
        pure = Path(rel)
        if pure.is_absolute() or rel.startswith("../") or "/../" in f"/{rel}/":
            raise ValueError(f"unsafe manifest path: {line!r}")
        entries.append(rel)
    if not entries:
        raise ValueError(f"source manifest is empty: {path}")
    return entries


def iter_managed_files(root: Path) -> Iterable[Path]:
    for rel_root in MANAGED_ROOTS:
        base = root / rel_root
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.is_file() or path.is_symlink():
                if not any(part in GENERATED_PARTS for part in path.parts):
                    yield path


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _json(path: Path) -> Any:
    return json.loads(_read(path))


def _py_string(source: str, name: str) -> str | None:
    match = re.search(
        rf"(?m)^{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]\s*$",
        source,
    )
    return match.group(1) if match else None


def _ts_integer(source: str, name: str) -> int | None:
    match = re.search(rf"\b{re.escape(name)}\s*=\s*(\d+)\s*;", source)
    return int(match.group(1)) if match else None


def _header_value(source: str, label: str) -> str | None:
    match = re.search(rf"(?m)^{re.escape(label)}\s*(\S+)\s*$", source)
    return match.group(1) if match else None


def _count_component_tests(root: Path) -> int:
    total = 0
    for path in (root / "frontend/src").rglob("*.component.test.*"):
        if not path.is_file():
            continue
        total += len(re.findall(r"(?m)^\s*(?:it|test)\s*\(", _read(path)))
    return total


def _count_e2e_tests(root: Path) -> int:
    total = 0
    for path in (root / "frontend/e2e").glob("*.spec.ts"):
        total += len(re.findall(r"(?m)^\s*test\s*\(", _read(path)))
    return total


def _check_identity(root: Path, release: dict[str, Any], checks: Checks) -> None:
    init_source = _read(root / "backend/samql_core/__init__.py")
    package = _json(root / "frontend/package.json")
    lock = _json(root / "frontend/package-lock.json")
    version_text = _read(root / "VERSION")

    release_version = release.get("version")
    release_build = release.get("build")
    package_root = (lock.get("packages") or {}).get("") or {}

    checks.add(
        "release version syntax",
        isinstance(release_version, str) and bool(_SEMVER_RX.fullmatch(release_version)),
        str(release_version),
    )
    checks.add(
        "release build syntax",
        isinstance(release_build, str) and bool(_BUILD_RX.fullmatch(release_build)),
        str(release_build),
    )
    checks.equal(
        "version identity",
        {
            "release": release_version,
            "backend": _py_string(init_source, "__version__"),
            "package": package.get("version"),
            "lock": lock.get("version"),
            "lock root": package_root.get("version"),
            "VERSION": _header_value(version_text, "Product version:"),
        },
    )
    checks.equal(
        "build identity",
        {
            "release": release_build,
            "backend": _py_string(init_source, "BUILD"),
            "VERSION": _header_value(version_text, "Current build:"),
        },
    )
    first_log = re.search(
        r"(?m)^build\s+(\d{4}-\d{2}-\d{2}\.\d+)\s+\(v([^\)]+)\)",
        version_text,
    )
    checks.add(
        "VERSION newest entry",
        bool(first_log)
        and first_log.group(1) == release_build
        and first_log.group(2) == release_version,
        first_log.group(0) if first_log else "missing build entry",
    )
    current_entries = re.findall(
        rf"(?m)^build\s+{re.escape(str(release_build))}\s+\(v[^\)]+\)",
        version_text,
    )
    checks.add(
        "VERSION current entry unique",
        len(current_entries) == 1,
        f"{len(current_entries)} matching entries",
    )


def _check_manifest(root: Path, release: dict[str, Any], checks: Checks) -> list[str]:
    manifest_path = root / "SOURCE_MANIFEST.txt"
    try:
        entries = load_manifest(manifest_path)
    except Exception as exc:  # pragma: no cover - exercised by CLI failures
        checks.add("source manifest readable", False, str(exc))
        return []

    checks.add("source manifest readable", True, f"{len(entries)} entries")
    checks.add(
        "source manifest declared count",
        release.get("sourceFileCount") == len(entries),
        f"declared {release.get('sourceFileCount')!r}; actual {len(entries)}",
    )
    transport_entries = [_transport_rel(entry) for entry in entries]
    checks.add(
        "source manifest sorted",
        transport_entries == sorted(transport_entries),
        "canonical mail-safe ASCII path order",
    )
    checks.add(
        "source manifest unique",
        len(entries) == len(set(entries)),
        f"{len(entries) - len(set(entries))} duplicate(s)",
    )
    folded = [_logical_rel(entry).casefold() for entry in entries]
    checks.add(
        "source manifest case-safe",
        len(folded) == len(set(folded)),
        f"{len(folded) - len(set(folded))} logical/case collision(s)",
    )

    missing: list[str] = []
    invalid_utf8: list[str] = []
    noncanonical_text: list[str] = []
    generated: list[str] = []
    unsafe_sources: list[str] = []
    resolved_expected: set[str] = set()
    for rel in entries:
        path = resolve_manifest_path(root, rel)
        if not path.is_file():
            missing.append(rel)
            continue
        actual_rel = _norm(path.relative_to(root))
        resolved_expected.add(actual_rel.casefold())
        try:
            resolved = path.resolve(strict=True)
            resolved.relative_to(root.resolve())
            if path.is_symlink():
                unsafe_sources.append(rel)
        except (OSError, ValueError):
            unsafe_sources.append(rel)
        if any(part in GENERATED_PARTS for part in Path(rel).parts):
            generated.append(rel)
        try:
            raw_bytes = path.read_bytes()
            raw_bytes.decode("utf-8")
            if (
                raw_bytes.startswith(b"\xef\xbb\xbf")
                or b"\r" in raw_bytes
                or not raw_bytes.endswith(b"\n")
                or re.search(rb"(?m)^===== FILE:", raw_bytes)
            ):
                noncanonical_text.append(rel)
        except UnicodeDecodeError:
            invalid_utf8.append(rel)

    checks.add(
        "manifest files exist",
        not missing,
        "all present" if not missing else ", ".join(missing[:8]),
    )
    checks.add(
        "manifest is text-only",
        not invalid_utf8,
        "all UTF-8" if not invalid_utf8 else ", ".join(invalid_utf8[:8]),
    )
    checks.add(
        "manifest text is canonical",
        not noncanonical_text,
        "LF / no BOM / terminal newline / no section-marker collision"
        if not noncanonical_text
        else ", ".join(noncanonical_text[:8]),
    )
    checks.add(
        "manifest excludes generated artifacts",
        not generated,
        "clean" if not generated else ", ".join(generated[:8]),
    )
    checks.add(
        "manifest sources are regular in-tree files",
        not unsafe_sources,
        "no symlink or root escape"
        if not unsafe_sources
        else ", ".join(unsafe_sources[:8]),
    )

    actual = {
        _norm(path.relative_to(root)).casefold()
        for path in iter_managed_files(root)
    }
    expected_managed = {
        item
        for item in resolved_expected
        if any(item == base.casefold() or item.startswith(base.casefold() + "/")
               for base in MANAGED_ROOTS)
    }
    extra = sorted(actual - expected_managed)
    absent = sorted(expected_managed - actual)
    checks.add(
        "managed source tree exact",
        not extra and not absent,
        (
            f"{len(actual)} managed files"
            if not extra and not absent
            else f"extra={extra[:6]!r}; absent={absent[:6]!r}"
        ),
    )
    required = {
        "ARCHITECTURE.md",
        "Decode-SamQL-APHEX.ps1",
        "Pack-SamQL.ps1",
        "RELEASE_MANIFEST.json",
        "RELEASE_CHECKLIST.md",
        "tools/release_artifacts.py",
        "tools/release_preflight.py",
        "tools/package_release.py",
        "tools/aphex_transport.py",
        "tests/test_release_hardening.py",
        "frontend/src/lib/releaseHardening.component.test.ts",
    }
    logical_entries = {_logical_rel(entry) for entry in entries}
    logical_required = {_logical_rel(entry) for entry in required}
    missing_required = sorted(logical_required - logical_entries)
    checks.add(
        "Phase 10 release files manifested",
        not missing_required,
        ", ".join(missing_required) or "complete",
    )
    return entries


def _check_saved_data(root: Path, release: dict[str, Any], checks: Checks) -> None:
    saved = release.get("savedData") or {}
    workflow = _read(root / "frontend/src/lib/workflowFile.ts")
    notebook = _read(root / "frontend/src/lib/notebook.ts")
    nodeflow = _read(root / "frontend/src/lib/nodeFlowModel.ts")
    app = _read(root / "frontend/src/App.tsx")
    migrations = _read(root / "frontend/src/lib/migrations.ts")

    observed = {
        "workflowEnvelope": _ts_integer(workflow, "WF_FILE_VERSION"),
        "workflowPayload": _ts_integer(workflow, "WF_PAYLOAD_VERSION"),
        "notebook": _ts_integer(notebook, "NB_FILE_VERSION"),
        "nodeFlowGraph": _ts_integer(nodeflow, "NODEFLOW_FILE_VERSION"),
        "nodeFlowTabs": _ts_integer(nodeflow, "NODEFLOW_TABS_VERSION"),
        "browserSession": _ts_integer(app, "SESSION_VERSION"),
    }
    declared = {
        key: (value or {}).get("current")
        for key, value in saved.items()
        if isinstance(value, dict)
    }
    checks.equal(
        "saved-data version declarations",
        {"release": declared, "source": observed},
    )

    invalid_ranges = [
        key
        for key, value in saved.items()
        if not isinstance(value, dict)
        or not isinstance(value.get("current"), int)
        or not isinstance(value.get("oldestReadable"), int)
        or value["oldestReadable"] < 0
        or value["oldestReadable"] > value["current"]
    ]
    checks.add(
        "saved-data compatibility ranges",
        not invalid_ranges,
        "valid" if not invalid_ranges else ", ".join(invalid_ranges),
    )
    for token in (
        "cloneMigrationInput",
        "must advance exactly one version",
        "migration output must be an object",
        "migration plan is incomplete",
    ):
        checks.add(
            f"migration rail: {token}",
            token in migrations,
            "present" if token in migrations else "missing",
        )


def _yaml_without_comment(line: str) -> str:
    """Remove YAML comments while preserving hashes inside quoted scalars."""
    quote: str | None = None
    escaped = False
    for index, char in enumerate(line):
        if escaped:
            escaped = False
            continue
        if quote == '"' and char == "\\":
            escaped = True
            continue
        if char in {"'", '"'}:
            if quote is None:
                quote = char
            elif quote == char:
                quote = None
            continue
        if char == "#" and quote is None:
            return line[:index]
    return line


def _yaml_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


# Unquoted YAML null spellings — invalid as branch names unless quoted.
_YAML_NULL = frozenset({"null", "Null", "NULL", "~"})

# Characters that are never allowed in an unquoted plain branch-name scalar.
# Colon, braces, brackets, anchors, aliases, tags, whitespace, comma.
_PLAIN_BRANCH_RX = re.compile(r"^[A-Za-z0-9._/\-*]+$")


def _decode_branch_scalar(token: str) -> tuple[str, bool, str | None]:
    """Decode one branch-name scalar token.

    ``token`` is the raw text of a single scalar, *already stripped of leading
    and trailing whitespace*.  It may be unquoted, single-quoted, or
    double-quoted.

    Returns ``(value, was_quoted, error)``:

    - ``value`` — the decoded branch name (empty string on error).
    - ``was_quoted`` — ``True`` when the token used single or double quotes.
    - ``error`` — a descriptive string on failure, ``None`` on success.

    Strict subset supported:

    **Plain scalars**
        Must match ``[A-Za-z0-9._/\\-*]+``.  Colons, braces, brackets,
        anchors (``&``), aliases (``*``), tags (``!``), whitespace, and any
        other structural character are rejected.

    **Single-quoted scalars** (``'...'``)
        Only the ``''`` doubled-apostrophe escape is recognised.  No other
        escape sequences.  Balanced closing quote required.  Trailing garbage
        after the closing quote is rejected.

    **Double-quoted scalars** (``"..."``)
        Only ``\\"`` and ``\\\\`` escapes are supported; any other ``\\``
        sequence is rejected (fail closed — this is a narrow gate validator,
        not a full YAML implementation).  Balanced closing quote required.
        Trailing garbage after the closing quote is rejected.

    Null provenance: ``_YAML_NULL`` spellings are rejected only when the
    scalar is *unquoted* (``was_quoted=False``).  A quoted ``"null"`` or
    ``'~'`` is a valid branch name.
    """
    if not token:
        return "", False, "empty branch scalar"

    ch = token[0]

    if ch == "'":
        # Single-quoted scalar.
        buf: list[str] = []
        i = 1
        n = len(token)
        while i < n:
            c = token[i]
            if c == "'":
                if i + 1 < n and token[i + 1] == "'":
                    buf.append("'")
                    i += 2
                else:
                    i += 1
                    # Trailing garbage after closing quote?
                    rest = token[i:].strip()
                    if rest:
                        return "", True, (
                            f"trailing garbage after single-quoted scalar: {rest!r}"
                        )
                    value = "".join(buf)
                    if not value:
                        return "", True, "empty single-quoted branch scalar"
                    return value, True, None
            else:
                buf.append(c)
                i += 1
        return "", True, "unbalanced single quote in branch scalar"

    if ch == '"':
        # Double-quoted scalar.
        buf = []
        i = 1
        n = len(token)
        while i < n:
            c = token[i]
            if c == "\\":
                i += 1
                if i >= n:
                    return "", True, "unbalanced double quote in branch scalar"
                esc = token[i]
                if esc == '"':
                    buf.append('"')
                elif esc == "\\":
                    buf.append("\\")
                else:
                    return "", True, (
                        f"unsupported escape sequence \\{esc!r} in double-quoted branch scalar"
                    )
                i += 1
            elif c == '"':
                i += 1
                rest = token[i:].strip()
                if rest:
                    return "", True, (
                        f"trailing garbage after double-quoted scalar: {rest!r}"
                    )
                value = "".join(buf)
                if not value:
                    return "", True, "empty double-quoted branch scalar"
                return value, True, None
            else:
                buf.append(c)
                i += 1
        return "", True, "unbalanced double quote in branch scalar"

    # Plain scalar.
    if not _PLAIN_BRANCH_RX.fullmatch(token):
        # Diagnose the first illegal character for a clearer error.
        bad = next((c for c in token if not re.match(r"[A-Za-z0-9._/\-*]", c)), "?")
        return "", False, (
            f"invalid character {bad!r} in plain branch scalar {token!r}"
        )
    if token in _YAML_NULL:
        return "", False, f"null entry {token!r} in branch list"
    return token, False, None


def _parse_flow_sequence(raw: str) -> tuple[list[str], str | None]:
    """Parse a YAML flow-sequence string (contents between ``[`` and ``]``).

    Strict dependency-free subset: plain scalars matching
    ``[A-Za-z0-9._/\\-*]+``, single-quoted scalars (``''`` escape only),
    and double-quoted scalars (``\\"`` and ``\\\\`` only).

    Rejects:
    - Unbalanced or unclosed quotes.
    - Unsupported YAML constructs at the start of a slot (``{``, ``[``).
    - Invalid characters in plain scalars (colon, structural chars, etc.).
    - Trailing garbage after a quoted scalar before the next comma or end.
    - Unsupported double-quoted escape sequences.
    - Empty entries (leading/trailing/double comma).
    - Unquoted YAML null spellings; quoted null-like names are accepted.

    Returns ``(items, None)`` on success or ``([], error_str)`` on failure.
    """
    items: list[str] = []
    i = 0
    n = len(raw)

    def skip_ws() -> None:
        nonlocal i
        while i < n and raw[i] in " \t":
            i += 1

    def read_one_scalar() -> tuple[str, str | None]:
        """Read and decode the next scalar from the stream.

        Advances ``i`` past the scalar content (and closing quote when
        quoted).  Trailing garbage after a quoted scalar is detected here
        before returning.
        """
        nonlocal i
        if i >= n:
            return "", None
        ch = raw[i]

        if ch in ("&", "*", "!", "{", "["):
            return "", f"unsupported YAML construct {ch!r} in flow sequence"

        if ch == "'":
            # Single-quoted: stream version (consume chars one-by-one).
            i += 1
            buf: list[str] = []
            while i < n:
                c = raw[i]
                if c == "'":
                    if i + 1 < n and raw[i + 1] == "'":
                        buf.append("'")
                        i += 2
                    else:
                        i += 1  # consume closing quote
                        # Trailing garbage check: only ws/,/] allowed next.
                        skip_ws()
                        if i < n and raw[i] not in (",", "]", "#"):
                            return "", (
                                f"trailing garbage after single-quoted scalar: "
                                f"{raw[i:i+8]!r}"
                            )
                        value = "".join(buf)
                        if not value:
                            return "", "empty single-quoted branch scalar"
                        return value, None
                else:
                    buf.append(c)
                    i += 1
            return "", "unbalanced single quote in flow sequence"

        if ch == '"':
            # Double-quoted: stream version.
            i += 1
            buf = []
            while i < n:
                c = raw[i]
                if c == "\\":
                    i += 1
                    if i >= n:
                        return "", "unbalanced double quote in flow sequence"
                    esc = raw[i]
                    if esc == '"':
                        buf.append('"')
                    elif esc == "\\":
                        buf.append("\\")
                    else:
                        return "", (
                            f"unsupported escape sequence \\{esc!r} "
                            f"in double-quoted branch scalar"
                        )
                    i += 1
                elif c == '"':
                    i += 1  # consume closing quote
                    # Trailing garbage check.
                    skip_ws()
                    if i < n and raw[i] not in (",", "]", "#"):
                        return "", (
                            f"trailing garbage after double-quoted scalar: "
                            f"{raw[i:i+8]!r}"
                        )
                    value = "".join(buf)
                    if not value:
                        return "", "empty double-quoted branch scalar"
                    return value, None
                else:
                    buf.append(c)
                    i += 1
            return "", "unbalanced double quote in flow sequence"

        # Plain scalar: read until delimiter, then validate grammar.
        start = i
        while i < n and raw[i] not in (",", "]", "#"):
            i += 1
        token = raw[start:i].strip()
        if not token:
            return "", None  # empty — caller checks
        if not _PLAIN_BRANCH_RX.fullmatch(token):
            bad = next((c for c in token if not re.match(r"[A-Za-z0-9._/\-*]", c)), "?")
            return "", f"invalid character {bad!r} in plain branch scalar {token!r}"
        if token in _YAML_NULL:
            return "", f"null entry {token!r} in inline branch list"
        return token, None

    # Main loop.
    skip_ws()
    if i >= n or raw[i:].strip() == "":
        return [], None  # empty list

    while i < n:
        skip_ws()
        if i >= n:
            break
        if raw[i] == "#":
            break

        scalar, err = read_one_scalar()
        if err:
            return [], err

        if scalar == "":
            return [], "empty entry in inline branch list"

        items.append(scalar)

        skip_ws()
        if i >= n or raw[i] == "#":
            break
        if raw[i] == ",":
            i += 1
            skip_ws()
            if i >= n or raw[i] in ("#",):
                return [], "empty trailing entry in inline branch list"
            if raw[i] == ",":
                return [], "empty entry (double comma) in inline branch list"
            if raw[i] == "]":
                return [], "empty trailing entry in inline branch list"
        else:
            break

    return items, None


def _workflow_push_branches(source: str) -> tuple[set[str], str | None]:
    """Read one unambiguous ``on.push.branches`` mapping.

    In block form, only direct-child list items at one consistent indentation
    are accepted.  Any non-list child (nested mapping or sequence key),
    inconsistent list indentation, deeper list indentation introduced by a
    nested structure, empty block, malformed inline list, or duplicate relevant
    mapping causes an immediate fail-closed return.

    Indentless block sequences (items at the same column as the ``branches:``
    key) are accepted when all items share that same column; mixing indentless
    and indented items fails closed.

    Block items are decoded through ``_decode_branch_scalar`` for strict
    validation; quoted null-like names are accepted (provenance preserved).
    """
    stack: list[tuple[int, str]] = []
    branches: set[str] = set()
    branches_indent: int | None = None
    branches_item_indent: int | None = None  # locked on first block list item
    seen_paths: set[tuple[str, ...]] = set()
    trigger_paths = {("on",), ("on", "push"), ("on", "push", "branches")}

    for raw_line in source.splitlines():
        code = _yaml_without_comment(raw_line).rstrip()
        if not code.strip():
            continue
        indent = len(code) - len(code.lstrip(" "))
        content = code.strip()

        if branches_indent is not None:
            # Indentless items sit at exactly branches_indent and start with "-".
            # Indented items sit strictly deeper than branches_indent.
            if indent < branches_indent:
                # Exiting the block — stop collecting, continue normal parsing.
                branches_indent = None
                branches_item_indent = None
                # Fall through to normal mapping parser for this line.
            elif indent == branches_indent:
                # Either an indentless list item or a sibling key at same level.
                if not content.startswith("-"):
                    # Sibling key — exit block mode, reparse this line.
                    branches_indent = None
                    branches_item_indent = None
                    # Fall through to the mapping parser below.
                else:
                    # Indentless list item.
                    if branches_item_indent is None:
                        branches_item_indent = indent
                    elif branches_item_indent != indent:
                        return branches, "inconsistent list indentation under block branches"
                    raw_item = content[1:].strip()
                    value, was_quoted, err = _decode_branch_scalar(raw_item)
                    if err:
                        return branches, err
                    if not was_quoted and value in _YAML_NULL:
                        return branches, f"null entry {value!r} in block branch list"
                    branches.add(value)
                    continue
            else:
                # indent > branches_indent — strictly inside the block.
                if not content.startswith("-"):
                    return branches, "non-list child under block branches"
                if branches_item_indent is None:
                    branches_item_indent = indent
                elif indent != branches_item_indent:
                    return branches, "inconsistent list indentation under block branches"
                raw_item = content[1:].strip()
                value, was_quoted, err = _decode_branch_scalar(raw_item)
                if err:
                    return branches, err
                if not was_quoted and value in _YAML_NULL:
                    return branches, f"null entry {value!r} in block branch list"
                branches.add(value)
                continue

            if branches_indent is not None:
                pass  # pragma: no cover

        while stack and stack[-1][0] >= indent:
            stack.pop()
        key_match = re.fullmatch(r"([^:\s]+)\s*:\s*(.*)", content)
        if not key_match:
            continue
        key = _yaml_scalar(key_match.group(1))
        value = key_match.group(2).strip()
        path = [item[1] for item in stack] + [key]
        stack.append((indent, key))

        path_key = tuple(path)
        if path_key in trigger_paths:
            if path_key in seen_paths:
                return branches, "duplicate mapping: " + ".".join(path)
            seen_paths.add(path_key)

        if path != ["on", "push", "branches"]:
            continue
        if value.startswith("[") and value.endswith("]"):
            items, err = _parse_flow_sequence(value[1:-1])
            if err:
                return branches, err
            for item in items:
                branches.add(item)
        elif value.startswith("["):
            return branches, "malformed inline branch list (missing closing bracket)"
        elif not value:
            branches_indent = indent
            branches_item_indent = None
        else:
            return branches, "branches must be an inline or block list"

    return branches, None


def _check_quality_and_ci(root: Path, release: dict[str, Any], checks: Checks) -> None:
    gates = release.get("qualityGates") or {}
    component_count = _count_component_tests(root)
    e2e_count = _count_e2e_tests(root)
    nodeflow_lines = len(_read(root / "frontend/src/components/NodeFlow.tsx").splitlines())

    checks.add(
        "component test inventory",
        component_count >= int(gates.get("componentTestsMinimum", 0)),
        f"{component_count} tests (minimum {gates.get('componentTestsMinimum')})",
    )
    checks.add(
        "Edge E2E inventory",
        e2e_count >= int(gates.get("edgeE2eTestsMinimum", 0)),
        f"{e2e_count} tests (minimum {gates.get('edgeE2eTestsMinimum')})",
    )
    checks.add(
        "NodeFlow composition bound",
        nodeflow_lines <= int(gates.get("nodeFlowShellMaximumLines", 0)),
        f"{nodeflow_lines} lines (maximum {gates.get('nodeFlowShellMaximumLines')})",
    )

    workflow = _read(root / ".github/workflows/windows-browser.yml")
    push_branches, trigger_error = _workflow_push_branches(workflow)
    checks.add(
        "Windows release workflow trigger",
        trigger_error is None and "master" in push_branches,
        trigger_error
        or "push branches: " + (", ".join(sorted(push_branches)) or "none"),
    )
    required_channel = str(gates.get("requiredBrowserChannel") or "msedge")
    workflow_tokens = (
        "runs-on: windows-latest",
        f"PLAYWRIGHT_BROWSER_CHANNEL: {required_channel}",
        "python tools/release_artifacts.py verify-tree --root .",
        "python tests/test_release_hardening.py",
        "python tests/run_tests.py --build",
        "python tests/test_optimizations_dual_engine.py",
        "python tests/test_nodeflow_resources.py",
        "python tests/benchmark_workloads.py --self-test",
        "SAMQL_TEST_PYTHON: python",
        "npm run test:e2e",
        "frontend/playwright-report",
        "frontend/test-results",
    )
    missing = [token for token in workflow_tokens if token not in workflow]
    checks.add(
        "Windows release workflow",
        not missing,
        "complete" if not missing else ", ".join(missing),
    )

    package = _json(root / "frontend/package.json")
    scripts = package.get("scripts") or {}
    checks.add(
        "zero-warning lint gate",
        "--max-warnings 0" in str(scripts.get("lint", "")),
        str(scripts.get("lint")),
    )
    checks.add(
        "release component script",
        scripts.get("test:release")
        == "node ./node_modules/vitest/vitest.mjs run src/lib/releaseHardening.component.test.ts",
        str(scripts.get("test:release")),
    )


def _iter_test_tree_files(root: Path, rel_root: str) -> list[str]:
    base = root / rel_root
    if not base.exists():
        return []
    out: list[str] = []
    for path in base.rglob("*"):
        if not path.is_file() and not path.is_symlink():
            continue
        if any(part in GENERATED_PARTS for part in path.parts):
            continue
        out.append(_norm(path.relative_to(root)))
    return sorted(out)


def _check_complete_test_extract(
    root: Path,
    release: dict[str, Any],
    checks: Checks,
    manifest_entries: list[str],
) -> None:
    """Prove the packaged source tree is enough to run Test-SamQL-All.

    The full-source / APHEX extract is named ``all_tests_ui`` for a reason: after
    Expand-SamQL, the destination must contain the suite runner, Python and
    frontend harnesses, Playwright specs, lockfile, and install helpers — not
    just application code.
    """
    entry_set = set(manifest_entries)
    missing_bootstrap = [
        rel
        for rel in TEST_EXTRACT_BOOTSTRAP
        if rel not in entry_set or not (root / rel).is_file()
    ]
    checks.add(
        "complete test extract bootstrap",
        not missing_bootstrap,
        (
            f"{len(TEST_EXTRACT_BOOTSTRAP)} bootstrap files manifested"
            if not missing_bootstrap
            else ", ".join(missing_bootstrap[:8])
        ),
    )

    tree_missing: list[str] = []
    tree_counts: list[str] = []
    for tree in TEST_EXTRACT_TREES:
        files = _iter_test_tree_files(root, tree)
        if not files and not (root / tree).exists():
            tree_missing.append(f"{tree}/ (absent)")
            continue
        absent = [rel for rel in files if rel not in entry_set]
        tree_missing.extend(absent)
        tree_counts.append(f"{tree}={len(files)}")
    checks.add(
        "complete test extract trees",
        not tree_missing,
        (
            "; ".join(tree_counts)
            if not tree_missing
            else ", ".join(tree_missing[:8])
        ),
    )

    all_tests = _read(resolve_manifest_path(root, "Test-SamQL-All.ps1"))
    suite_tokens = (
        "tests\\run_tests.py",
        "tests\\test_release_hardening.py",
        "tests\\test_optimizations_dual_engine.py",
        "tests\\test_nodeflow_resources.py",
        "tests\\benchmark_workloads.py",
        "tools\\install_frontend_deps.py",
        "tools\\normalize_npm_lock.py",
        "tools\\prune_stale_source.py",
        "tools\\release_artifacts.py",
        "requirements-test.txt",
        "npm run test:e2e",
        "frontend\\package-lock.json",
    )
    missing_suite = [token for token in suite_tokens if token not in all_tests]
    checks.add(
        "complete suite runner wiring",
        not missing_suite,
        "Test-SamQL-All invokes every packaged suite entry"
        if not missing_suite
        else ", ".join(missing_suite),
    )

    package = _json(root / "frontend/package.json")
    scripts = package.get("scripts") or {}
    required_scripts = {
        "test:component": "node ./node_modules/vitest/vitest.mjs run",
        "test:e2e": "node ./node_modules/@playwright/test/cli.js test",
        "test:frontend": "npm run test:component && npm run check",
        "typecheck": "node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json --pretty false",
        "lint": 'node ./node_modules/eslint/bin/eslint.js "src/**/*.{ts,tsx}" --max-warnings 0',
        "build": "node ./node_modules/vite/bin/vite.js build",
        "check": "npm run typecheck && npm run lint && npm run build",
    }
    missing_scripts = [
        name
        for name, expected in required_scripts.items()
        if scripts.get(name) != expected
    ]
    checks.add(
        "frontend test toolchain scripts",
        not missing_scripts,
        "package.json scripts ready for extract"
        if not missing_scripts
        else ", ".join(missing_scripts),
    )

    vitest = _read(root / "frontend/vitest.config.ts")
    checks.add(
        "vitest setup is packaged",
        'setupFiles: ["./src/test/setup.ts"]' in vitest
        and "frontend/src/test/setup.ts" in entry_set,
        "src/test/setup.ts wired and manifested",
    )

    expander = _read(resolve_manifest_path(root, "Expand-SamQL.ps1"))
    checks.add(
        "expand points at the complete suite",
        "Test-SamQL-All" in expander
        and "complete suite" in expander.lower(),
        "Expand-SamQL documents Test-SamQL-All",
    )


def _check_docs_and_transport(root: Path, release: dict[str, Any], checks: Checks) -> None:
    source_transport = release.get("sourceTransport") or {}
    dangerous = source_transport.get("dangerousExtensions")
    checks.add(
        "APHEX transport declaration",
        source_transport.get("format") == "APHEX-1"
        and isinstance(source_transport.get("lineLength"), int)
        and source_transport.get("lineLength") >= 64
        and isinstance(dangerous, list)
        and set(dangerous) == {"exe", "dll", "msi", "bat", "cmd", "scr", "vbs", "ps1", "jar"},
        json.dumps(source_transport, sort_keys=True),
    )

    runtime = release.get("runtime") or {}
    checks.add(
        "runtime floor declaration",
        runtime.get("pythonMinimum") == "3.10"
        and runtime.get("nodeMinimum") == "20.19"
        and runtime.get("npmMinimum") == "10",
        json.dumps(runtime, sort_keys=True),
    )

    readme = _read(root / "README.md")
    distribution = _read(root / "DISTRIBUTION.md")
    checklist = _read(root / "RELEASE_CHECKLIST.md")
    architecture = _read(root / "ARCHITECTURE.md")
    doc_tokens = (
        "Python 3.10+",
        "Node.js 20.19+",
        "tools/release_artifacts.py",
        "tools/release_preflight.py",
        "Pack-SamQL.ps1",
        "RELEASE_MANIFEST.json",
    )
    missing_readme = [
        token for token in doc_tokens if not _contains_spelling(readme, token)
    ]
    checks.add(
        "release documentation",
        not missing_readme
        and "release_artifacts.py" in distribution
        and "Microsoft Edge" in checklist
        and "NodeFlow.tsx" in architecture
        and "Release ownership" in architecture,
        "complete" if not missing_readme else ", ".join(missing_readme),
    )

    expander = _read(resolve_manifest_path(root, "Expand-SamQL.ps1"))
    decoder = _read(resolve_manifest_path(root, "Decode-SamQL-APHEX.ps1"))
    pack_wrapper = _read(resolve_manifest_path(root, "Pack-SamQL.ps1"))
    launcher = _read(resolve_manifest_path(root, "Start-SamQL-AppWindow.ps1"))
    all_tests = _read(resolve_manifest_path(root, "Test-SamQL-All.ps1"))
    checks.add(
        "fail-closed source expansion",
        "Verified bundle integrity" in expander
        and "No destination files were changed" in expander
        and "duplicate or case-colliding FILE section" in expander
        and "$dangerousExtensionPattern" in expander
        and "[regex]::Replace($raw" in expander
        and "$raw.Replace($fang" not in expander,
        "pre-write count/hash/path verification + targeted refang",
    )
    # Expand's capture group must match RELEASE_MANIFEST dangerousExtensions
    # exactly so pack/expand cannot drift.
    expand_m = re.search(r"\\\[\\.\\\]\((?P<exts>[^)]+)\)", expander)
    declared = {
        str(item).lstrip(".").lower()
        for item in (dangerous or [])
        if isinstance(item, str) and item
    }
    expand_set = set()
    if expand_m:
        expand_set = {
            part.strip().lower()
            for part in expand_m.group("exts").split("|")
            if part.strip()
        }
    checks.add(
        "Expand dangerous-extension parity",
        bool(expand_m) and expand_set == declared == {
            "exe", "dll", "msi", "bat", "cmd", "scr", "vbs", "ps1", "jar"
        },
        "expand=%s declared=%s" % (sorted(expand_set), sorted(declared)),
    )
    checks.add(
        "APHEX decoder boundary",
        "DATA_END" in decoder
        and "Expected SHA256" in decoder
        and "(?m)^DATA_BEGIN" in decoder
        and "(?m)^DATA_END" in decoder,
        "line-anchored payload marker and SHA verification",
    )
    checks.add(
        "release wrapper boundary",
        "tools\\release_artifacts.py" in pack_wrapper
        and 'Join-Path $Root "release"' in pack_wrapper
        and "release_artifacts.py" in all_tests
        and "tests\\test_release_hardening.py" in all_tests,
        "canonical package and complete-suite wiring",
    )
    checks.add(
        "standalone launcher cold-start budget",
        "$bootBudgetS = 300" in launcher
        and "within ${bootBudgetS}s" in launcher,
        "300 seconds",
    )


def run_preflight(root: Path) -> list[Check]:
    root = root.resolve()
    checks = Checks()
    manifest_path = root / "RELEASE_MANIFEST.json"
    try:
        release = _json(manifest_path)
    except Exception as exc:
        return [Check("release manifest readable", False, str(exc))]

    checks.add(
        "release manifest readable",
        isinstance(release, dict) and release.get("schemaVersion") == 1,
        f"schema {release.get('schemaVersion')!r}",
    )
    checks.add(
        "release phase",
        release.get("product") == "SamQL" and release.get("phase") == 10,
        f"{release.get('product')!r} phase {release.get('phase')!r}",
    )
    checks.add(
        "release source manifest declaration",
        release.get("sourceManifest") == "SOURCE_MANIFEST.txt",
        str(release.get("sourceManifest")),
    )
    generated = release.get("generatedAt")
    checks.add(
        "deterministic release timestamp",
        isinstance(generated, str)
        and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", generated)),
        str(generated),
    )
    _check_identity(root, release, checks)
    manifest_entries = _check_manifest(root, release, checks)
    _check_saved_data(root, release, checks)
    _check_quality_and_ci(root, release, checks)
    _check_complete_test_extract(root, release, checks, manifest_entries)
    _check_docs_and_transport(root, release, checks)
    return checks.items


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="SamQL source root (default: parent of tools/)",
    )
    parser.add_argument("--json", action="store_true", help="emit machine-readable results")
    parser.add_argument("--quiet", action="store_true", help="print failures only")
    args = parser.parse_args(argv)

    results = run_preflight(args.root)
    failures = [item for item in results if not item.ok]
    if args.json:
        print(
            json.dumps(
                {
                    "ok": not failures,
                    "checks": [asdict(item) for item in results],
                    "failed": len(failures),
                },
                indent=2,
                sort_keys=True,
            )
        )
    else:
        for item in results:
            if args.quiet and item.ok:
                continue
            mark = "PASS" if item.ok else "FAIL"
            print(f"[{mark}] {item.name}: {item.detail}")
        print(
            f"Release preflight: {len(results) - len(failures)} passed, "
            f"{len(failures)} failed."
        )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
