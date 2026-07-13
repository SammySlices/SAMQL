#!/usr/bin/env python3
"""Build and verify SamQL's decoded and APHEX full-source transports.

The source bundle is constructed only from ``SOURCE_MANIFEST.txt``. Every
section is canonical UTF-8 text, executable-looking extensions are mail-
defanged, and the exact section body is hashed in the header. APHEX is then
encoded and decoded again; packaging fails unless the decoded bytes match the
full-source bundle byte-for-byte.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # supports both ``python tools/...`` and ``import tools...``
    from .aphex_transport import (
        build_transport_text,
        decode_transport_file,
        decode_transport_text,
        sha256_bytes,
    )
    from .release_preflight import load_manifest, resolve_manifest_path, run_preflight
except ImportError:  # pragma: no cover - normal direct-script path
    from aphex_transport import (
        build_transport_text,
        decode_transport_file,
        decode_transport_text,
        sha256_bytes,
    )
    from release_preflight import load_manifest, resolve_manifest_path, run_preflight

HEADER_RX = re.compile(r"(?m)^===== FILE: (?P<path>.*?) =====[ \t]*\n")
BODY_MARKER = b"===== FILE: "


@dataclass(frozen=True)
class PackageResult:
    bundle_path: Path
    aphex_path: Path
    receipt_path: Path
    file_count: int
    body_sha256: str
    bundle_sha256: str
    aphex_sha256: str
    receipt_sha256: str
    bundle_bytes: int
    aphex_bytes: int
    receipt_bytes: int


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    """Publish complete bytes with a same-directory atomic replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_temp = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temp = Path(raw_temp)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def _normalize_text(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n") + "\n"


def _extension_choices(extensions: list[str]) -> str:
    choices = "|".join(re.escape(ext.lstrip(".")) for ext in extensions)
    if not choices:
        raise ValueError("sourceTransport.dangerousExtensions cannot be empty")
    return choices


def _defang_pattern(extensions: list[str]) -> re.Pattern[str]:
    return re.compile(
        rf"(?i)\.(?P<extension>{_extension_choices(extensions)})"
        r"(?=$|[^A-Za-z0-9])"
    )


def _refang_pattern(extensions: list[str]) -> re.Pattern[str]:
    return re.compile(
        rf"(?i)\[\.\](?P<extension>{_extension_choices(extensions)})"
        r"(?=$|[^A-Za-z0-9])"
    )


def _defang(value: str, pattern: re.Pattern[str]) -> str:
    return pattern.sub(lambda match: "[.]" + match.group("extension"), value)


def refang_transport_text(value: str, extensions: list[str]) -> str:
    """Reverse mail defanging without rewriting ordinary ``[.]`` literals."""
    pattern = _refang_pattern(extensions)
    return pattern.sub(lambda match: "." + match.group("extension"), value)


def _generated_label(value: str | None) -> str:
    if not value:
        raise ValueError("RELEASE_MANIFEST generatedAt is required for deterministic packaging")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Invalid RELEASE_MANIFEST generatedAt: {value!r}") from exc
    return stamp.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _release(root: Path) -> dict[str, Any]:
    path = root / "RELEASE_MANIFEST.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        raise ValueError("RELEASE_MANIFEST.json must contain a schemaVersion 1 object")
    return raw


def _transport_pattern(release: dict[str, Any]) -> re.Pattern[str]:
    extensions = (release.get("sourceTransport") or {}).get("dangerousExtensions") or []
    if not isinstance(extensions, list) or not all(isinstance(item, str) for item in extensions):
        raise ValueError("sourceTransport.dangerousExtensions must be a string list")
    return _defang_pattern(extensions)


def _manifest_source_file(root: Path, rel: str) -> Path:
    """Resolve one declared source without allowing symlink/root escape."""
    root = root.resolve()
    path = resolve_manifest_path(root, rel)
    if not path.is_file():
        raise FileNotFoundError(f"Manifest file is missing: {rel}")
    try:
        path.resolve(strict=True).relative_to(root)
    except (OSError, ValueError) as exc:
        raise ValueError(f"Manifest source escapes the release root: {rel}") from exc
    if path.is_symlink():
        raise ValueError(f"Manifest source must not be a symlink: {rel}")
    return path


def build_bundle_bytes(root: Path) -> tuple[bytes, list[str], str]:
    root = root.resolve()
    release = _release(root)
    entries = load_manifest(root / "SOURCE_MANIFEST.txt")
    declared_count = release.get("sourceFileCount")
    if declared_count != len(entries):
        raise ValueError(
            f"RELEASE_MANIFEST sourceFileCount is {declared_count!r}; "
            f"SOURCE_MANIFEST has {len(entries)} entries"
        )
    defang_rx = _transport_pattern(release)

    sections: list[str] = []
    for rel in entries:
        path = _manifest_source_file(root, rel)
        source = path.read_text(encoding="utf-8")
        safe_rel = _defang(rel.replace("\\", "/"), defang_rx)
        safe_source = _defang(_normalize_text(source), defang_rx)
        sections.append(f"===== FILE: {safe_rel} =====\n{safe_source}")

    body = "".join(sections).encode("utf-8")
    body_sha = sha256_bytes(body)
    build = str(release.get("build") or "")
    generated = _generated_label(release.get("generatedAt"))
    header = (
        "############################################################\n"
        "# SamQL source bundle\n"
        f"#   build:     {build}\n"
        f"#   files:     {len(entries)}\n"
        f"#   sha256:    {body_sha}  (of the section body below)\n"
        f"#   generated: {generated}\n"
        "#   contents:  complete source + tests + UI (Test-SamQL-All ready)\n"
        "#   reconstruct with Expand-SamQL[.]ps1 (this header is ignored)\n"
        "############################################################\n"
    ).encode("utf-8")
    return header + body, entries, body_sha


def parse_bundle_sections(bundle: bytes) -> dict[str, bytes]:
    try:
        text = bundle.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("Bundle is not valid UTF-8") from exc
    matches = list(HEADER_RX.finditer(text))
    if not matches:
        raise ValueError("Bundle has no FILE sections")
    sections: dict[str, bytes] = {}
    folded: set[str] = set()
    for index, match in enumerate(matches):
        rel = match.group("path").strip()
        if not rel:
            raise ValueError("Bundle contains an empty section path")
        if rel in sections:
            raise ValueError(f"Bundle contains duplicate section: {rel}")
        if rel.casefold() in folded:
            raise ValueError(f"Bundle contains a case-colliding section: {rel}")
        folded.add(rel.casefold())
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[rel] = text[start:end].encode("utf-8")
    return sections


def verify_bundle(root: Path, bundle: bytes, entries: list[str]) -> None:
    root = root.resolve()
    release = _release(root)
    defang_rx = _transport_pattern(release)
    sections = parse_bundle_sections(bundle)
    expected_paths = [_defang(rel.replace("\\", "/"), defang_rx) for rel in entries]
    if list(sections) != expected_paths:
        raise ValueError("Bundle section order/path list does not match SOURCE_MANIFEST.txt")

    for rel, safe_rel in zip(entries, expected_paths):
        path = _manifest_source_file(root, rel)
        expected = _defang(
            _normalize_text(path.read_text(encoding="utf-8")), defang_rx
        ).encode("utf-8")
        if sections[safe_rel] != expected:
            raise ValueError(f"Bundle section does not match source bytes: {rel}")

    body_offset = bundle.find(BODY_MARKER)
    if body_offset < 0:
        raise ValueError("Bundle section marker is missing")
    header = bundle[:body_offset].decode("utf-8")
    body = bundle[body_offset:]
    sha_match = re.search(r"(?m)^#\s*sha256:\s*([0-9a-f]{64})", header)
    count_match = re.search(r"(?m)^#\s*files:\s*(\d+)", header)
    build_match = re.search(r"(?m)^#\s*build:\s*(\S+)", header)
    if not sha_match or sha_match.group(1) != sha256_bytes(body):
        raise ValueError("Bundle section-body SHA-256 header is invalid")
    if not count_match or int(count_match.group(1)) != len(entries):
        raise ValueError("Bundle file-count header is invalid")
    if not build_match or build_match.group(1) != release.get("build"):
        raise ValueError("Bundle build header does not match RELEASE_MANIFEST.json")


def package_release(
    root: Path,
    output_dir: Path,
    *,
    preflight: bool = True,
) -> PackageResult:
    root = root.resolve()
    output_dir = output_dir.resolve()
    if preflight:
        failures = [item for item in run_preflight(root) if not item.ok]
        if failures:
            summary = "; ".join(f"{item.name}: {item.detail}" for item in failures)
            raise ValueError(f"Release preflight failed: {summary}")

    release = _release(root)
    build = str(release["build"])
    sequence = build.rsplit(".", 1)[-1]
    line_length = int((release.get("sourceTransport") or {}).get("lineLength", 128))
    bundle, entries, body_sha = build_bundle_bytes(root)
    verify_bundle(root, bundle, entries)

    bundle_name = f"samql_full_source_all_tests_ui_{build}.txt"
    aphex_name = f"SAMQL_BUILD_{sequence}_EMAIL_SAFE_APHEX.txt"
    receipt_name = f"SAMQL_BUILD_{sequence}_RELEASE_RECEIPT.json"
    bundle_path = output_dir / bundle_name
    aphex_path = output_dir / aphex_name
    receipt_path = output_dir / receipt_name

    aphex_text = build_transport_text(
        bundle,
        original_file=bundle_name,
        build=build,
        line_length=line_length,
    )
    aphex_bytes_value = aphex_text.encode("ascii")
    decoded, metadata = decode_transport_text(aphex_text, verify=True)
    if decoded != bundle:
        raise ValueError("APHEX decode did not reproduce the full-source bundle byte-for-byte")
    if metadata.original_file != bundle_name:
        raise ValueError("APHEX Original file metadata is inconsistent")

    bundle_sha = sha256_bytes(bundle)
    aphex_sha = sha256_bytes(aphex_bytes_value)
    receipt = {
        "schemaVersion": 1,
        "product": release.get("product"),
        "version": release.get("version"),
        "build": build,
        "phase": release.get("phase"),
        "generatedAt": release.get("generatedAt"),
        "sourceFiles": len(entries),
        "releaseManifestSha256": sha256_bytes(
            (root / "RELEASE_MANIFEST.json").read_bytes()
        ),
        "sourceManifestSha256": sha256_bytes(
            (root / "SOURCE_MANIFEST.txt").read_bytes()
        ),
        "decodedBundle": {
            "file": bundle_name,
            "bytes": len(bundle),
            "sha256": bundle_sha,
            "sectionBodySha256": body_sha,
        },
        "aphexTransport": {
            "file": aphex_name,
            "format": (release.get("sourceTransport") or {}).get("format"),
            "bytes": len(aphex_bytes_value),
            "sha256": aphex_sha,
            "decodedBytes": len(decoded),
            "decodedSha256": sha256_bytes(decoded),
        },
        "verification": {
            "preflight": bool(preflight),
            "manifestSectionParity": True,
            "bundleBodyHash": True,
            "aphexRoundTrip": True,
        },
    }
    receipt_bytes_value = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )

    # All verification above is in-memory; only complete verified bytes are
    # now published. Each artifact is replaced atomically.
    _atomic_write_bytes(bundle_path, bundle)
    _atomic_write_bytes(aphex_path, aphex_bytes_value)
    _atomic_write_bytes(receipt_path, receipt_bytes_value)

    # Exercise real on-disk decoding and identity after publication.
    disk_decoded, _ = decode_transport_file(aphex_path, verify=True)
    if disk_decoded != bundle_path.read_bytes():
        raise ValueError("On-disk APHEX round trip changed bundle bytes")
    if receipt_path.read_bytes() != receipt_bytes_value:
        raise ValueError("Published release receipt differs from verified bytes")

    return PackageResult(
        bundle_path=bundle_path,
        aphex_path=aphex_path,
        receipt_path=receipt_path,
        file_count=len(entries),
        body_sha256=body_sha,
        bundle_sha256=bundle_sha,
        aphex_sha256=aphex_sha,
        receipt_sha256=sha256_bytes(receipt_bytes_value),
        bundle_bytes=len(bundle),
        aphex_bytes=len(aphex_bytes_value),
        receipt_bytes=len(receipt_bytes_value),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--skip-preflight", action="store_true")
    parser.add_argument("--json", action="store_true", help="print package metadata as JSON")
    args = parser.parse_args(argv)

    result = package_release(
        args.root,
        args.output_dir,
        preflight=not args.skip_preflight,
    )
    payload = {
        "bundle": str(result.bundle_path),
        "aphex": str(result.aphex_path),
        "receipt": str(result.receipt_path),
        "files": result.file_count,
        "bodySha256": result.body_sha256,
        "bundleSha256": result.bundle_sha256,
        "aphexSha256": result.aphex_sha256,
        "receiptSha256": result.receipt_sha256,
        "bundleBytes": result.bundle_bytes,
        "aphexBytes": result.aphex_bytes,
        "receiptBytes": result.receipt_bytes,
    }
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(f"Packaged {result.file_count} files.")
        print(f"Decoded: {result.bundle_path} ({result.bundle_bytes} bytes)")
        print(f"  SHA-256 {result.bundle_sha256}")
        print(f"APHEX:   {result.aphex_path} ({result.aphex_bytes} bytes)")
        print(f"  SHA-256 {result.aphex_sha256}")
        print(f"Receipt: {result.receipt_path} ({result.receipt_bytes} bytes)")
        print(f"  SHA-256 {result.receipt_sha256}")
        print("APHEX round trip: byte-for-byte PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
