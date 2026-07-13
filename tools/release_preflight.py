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
    audit_name = (
        f"AUDIT_{str(release.get('build', '')).split('.')[0]}_"
        f"refactor_phase{release.get('phase')}.md"
    )
    required = {
        "ARCHITECTURE.md",
        "Decode-SamQL-APHEX.ps1",
        "Pack-SamQL.ps1",
        "RELEASE_MANIFEST.json",
        "RELEASE_CHECKLIST.md",
        audit_name,
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
        == "vitest run src/lib/releaseHardening.component.test.ts",
        str(scripts.get("test:release")),
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
        and "release_artifacts.py" in all_tests
        and "tests\\test_release_hardening.py" in all_tests,
        "canonical package and complete-suite wiring",
    )
    checks.add(
        "standalone launcher cold-start budget",
        "AddSeconds(120)" in launcher and "within 120s" in launcher,
        "120 seconds",
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
    _check_manifest(root, release, checks)
    _check_saved_data(root, release, checks)
    _check_quality_and_ci(root, release, checks)
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
