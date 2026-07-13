#!/usr/bin/env python3
"""Canonical SamQL release verification, packaging, and APHEX interface.

The stable command delegates to small standard-library modules:
``release_preflight`` validates the source tree, ``package_release`` constructs
and verifies the decoded bundle and receipt, and ``aphex_transport`` owns the
reversible mail-safe encoding.

Examples::

    python tools/release_artifacts.py verify-tree --root .
    python tools/release_artifacts.py package --root . --output-dir release
    python tools/release_artifacts.py decode transport.txt --output bundle.txt
    python tools/release_artifacts.py verify-artifacts --root . \
        --bundle bundle.txt --aphex transport.txt
"""
from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any

try:  # importable module and direct-script execution
    from .aphex_transport import decode_transport_file, sha256_bytes
    from .package_release import package_release, verify_bundle
    from .release_preflight import load_manifest, run_preflight
except ImportError:  # pragma: no cover - normal direct-script path
    from aphex_transport import decode_transport_file, sha256_bytes
    from package_release import package_release, verify_bundle
    from release_preflight import load_manifest, run_preflight


def _atomic_write(path: Path, data: bytes) -> None:
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


def verify_tree(root: Path, *, quiet: bool = False) -> list[str]:
    results = run_preflight(root.resolve())
    failures = [item for item in results if not item.ok]
    if not quiet:
        for item in results:
            print(f"[{'PASS' if item.ok else 'FAIL'}] {item.name}: {item.detail}")
        print(f"Release tree: {len(results) - len(failures)} passed, {len(failures)} failed.")
    if failures:
        raise ValueError(
            "Release tree verification failed: "
            + "; ".join(f"{item.name}: {item.detail}" for item in failures)
        )
    return [item.name for item in results]


def verify_artifacts(
    root: Path,
    bundle_path: Path,
    aphex_path: Path,
    *,
    preflight: bool = True,
) -> dict[str, Any]:
    root = root.resolve()
    if preflight:
        verify_tree(root, quiet=True)
    entries = load_manifest(root / "SOURCE_MANIFEST.txt")
    bundle = bundle_path.read_bytes()
    verify_bundle(root, bundle, entries)
    decoded, metadata = decode_transport_file(aphex_path, verify=True)
    if decoded != bundle:
        raise ValueError("APHEX payload does not match the decoded source bundle byte-for-byte")
    if metadata.original_file != bundle_path.name:
        raise ValueError(
            f"APHEX Original file is {metadata.original_file!r}; expected {bundle_path.name!r}"
        )
    return {
        "files": len(entries),
        "bundle": str(bundle_path.resolve()),
        "bundleBytes": len(bundle),
        "bundleSha256": sha256_bytes(bundle),
        "aphex": str(aphex_path.resolve()),
        "aphexBytes": aphex_path.stat().st_size,
        "aphexSha256": sha256_bytes(aphex_path.read_bytes()),
        "roundTrip": True,
    }


def package(root: Path, output_dir: Path) -> dict[str, Any]:
    root = root.resolve()
    result = package_release(root, output_dir.resolve(), preflight=True)
    verified = verify_artifacts(
        root,
        result.bundle_path,
        result.aphex_path,
        preflight=False,
    )
    return {
        **verified,
        "bodySha256": result.body_sha256,
        "receipt": str(result.receipt_path),
        "receiptBytes": result.receipt_bytes,
        "receiptSha256": result.receipt_sha256,
    }


def _print_payload(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return
    for key, value in payload.items():
        print(f"{key}: {value}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    verify = sub.add_parser("verify-tree", help="validate one coherent release source tree")
    verify.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    verify.add_argument("--json", action="store_true")

    pack = sub.add_parser("package", help="produce and verify decoded/APHEX artifacts")
    pack.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    pack.add_argument("--output-dir", type=Path, required=True)
    pack.add_argument("--json", action="store_true")

    decode = sub.add_parser("decode", help="decode and verify an APHEX transport")
    decode.add_argument("transport", type=Path)
    decode.add_argument("--output", "-o", type=Path, required=True)
    decode.add_argument("--json", action="store_true")

    artifacts = sub.add_parser("verify-artifacts", help="verify bundle sections and APHEX identity")
    artifacts.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    artifacts.add_argument("--bundle", type=Path, required=True)
    artifacts.add_argument("--aphex", type=Path, required=True)
    artifacts.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    try:
        if args.command == "verify-tree":
            results = run_preflight(args.root.resolve())
            failures = [item for item in results if not item.ok]
            payload = {
                "ok": not failures,
                "passed": len(results) - len(failures),
                "failed": len(failures),
                "checks": [
                    {"name": item.name, "ok": item.ok, "detail": item.detail}
                    for item in results
                ],
            }
            if args.json:
                _print_payload(payload, True)
            else:
                for item in results:
                    print(f"[{'PASS' if item.ok else 'FAIL'}] {item.name}: {item.detail}")
                print(f"Release tree: {payload['passed']} passed, {payload['failed']} failed.")
            return 1 if failures else 0
        if args.command == "package":
            _print_payload(package(args.root, args.output_dir), args.json)
            return 0
        if args.command == "decode":
            data, metadata = decode_transport_file(args.transport, verify=True)
            _atomic_write(args.output.resolve(), data)
            _print_payload(
                {
                    "output": str(args.output.resolve()),
                    "bytes": len(data),
                    "sha256": sha256_bytes(data),
                    "original": metadata.original_file,
                },
                args.json,
            )
            return 0
        _print_payload(
            verify_artifacts(args.root, args.bundle, args.aphex),
            args.json,
        )
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, f"release artifact error: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
