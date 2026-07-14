#!/usr/bin/env python3
"""Phase 10 release, deterministic packaging, and transport regression."""
from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.aphex_transport import (  # noqa: E402
    END,
    decode_transport_file,
    decode_transport_text,
    sha256_bytes,
)
from tools.package_release import (  # noqa: E402
    package_release,
    parse_bundle_sections,
    refang_transport_text,
    verify_bundle,
)
from tools.release_preflight import load_manifest, run_preflight  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def expect_failure(action: Callable[[], object], pattern: str) -> None:
    try:
        action()
    except (ValueError, UnicodeDecodeError) as exc:
        require(re.search(pattern, str(exc), re.IGNORECASE) is not None, str(exc))
        return
    raise AssertionError(f"expected failure matching {pattern!r}")


def _transport_extensions() -> list[str]:
    release = json.loads((ROOT / "RELEASE_MANIFEST.json").read_text(encoding="utf-8"))
    extensions = (release.get("sourceTransport") or {}).get("dangerousExtensions") or []
    require(
        isinstance(extensions, list)
        and bool(extensions)
        and all(isinstance(item, str) and item for item in extensions),
        "release dangerous-extension declaration is invalid",
    )
    return extensions


def _refang_transport_text(value: str) -> str:
    return refang_transport_text(value, _transport_extensions())


def main() -> int:
    failures = [item for item in run_preflight(ROOT) if not item.ok]
    require(
        not failures,
        "release preflight failed: "
        + "; ".join(f"{item.name}: {item.detail}" for item in failures),
    )

    with (
        tempfile.TemporaryDirectory(prefix="samql-release-a-") as first_tmp,
        tempfile.TemporaryDirectory(prefix="samql-release-b-") as second_tmp,
        tempfile.TemporaryDirectory(prefix="samql-release-expanded-") as expanded_tmp,
        tempfile.TemporaryDirectory(prefix="samql-release-expanded-out-") as expanded_out_tmp,
    ):
        first = package_release(ROOT, Path(first_tmp), preflight=False)
        second = package_release(ROOT, Path(second_tmp), preflight=False)

        first_bundle = first.bundle_path.read_bytes()
        second_bundle = second.bundle_path.read_bytes()
        first_aphex = first.aphex_path.read_bytes()
        second_aphex = second.aphex_path.read_bytes()
        first_receipt = first.receipt_path.read_bytes()
        second_receipt = second.receipt_path.read_bytes()
        require(first_bundle == second_bundle, "decoded source packaging is not deterministic")
        require(first_aphex == second_aphex, "APHEX packaging is not deterministic")
        require(first_receipt == second_receipt, "release receipt is not deterministic")

        decoded, metadata = decode_transport_file(first.aphex_path, verify=True)
        require(decoded == first_bundle, "APHEX did not round-trip the decoded bundle")
        require(metadata.original_bytes == len(first_bundle), "APHEX byte metadata is wrong")
        require(metadata.expected_sha256 == sha256_bytes(first_bundle), "APHEX SHA metadata is wrong")
        require(END in first_aphex.decode("ascii"), "current APHEX transport lacks DATA_END")

        # The build-587 transport shape had no DATA_END; read compatibility is
        # intentional even though all new output is explicitly terminated.
        legacy_text = first_aphex.decode("ascii").replace(f"{END}\n", "", 1)
        legacy_decoded, _ = decode_transport_text(legacy_text, verify=True)
        require(legacy_decoded == first_bundle, "legacy EOF-terminated APHEX no longer decodes")

        sections = parse_bundle_sections(first_bundle)
        manifest = load_manifest(ROOT / "SOURCE_MANIFEST.txt")
        logical_sections = [_refang_transport_text(path) for path in sections]
        logical_manifest = [_refang_transport_text(path) for path in manifest]
        require(
            logical_sections == logical_manifest,
            "bundle section order differs from the logical manifest",
        )
        require(len(sections) == len(manifest), "bundle section count differs from manifest")
        require(first.file_count == len(manifest), "package result count differs from manifest")
        from tools.release_preflight import TEST_EXTRACT_BOOTSTRAP, TEST_EXTRACT_TREES

        logical_manifest_set = set(logical_manifest)
        missing_bootstrap = [
            rel for rel in TEST_EXTRACT_BOOTSTRAP if rel not in logical_manifest_set
        ]
        require(
            not missing_bootstrap,
            "packaged extract is missing test bootstrap files: "
            + ", ".join(missing_bootstrap[:8]),
        )
        for tree in TEST_EXTRACT_TREES:
            require(
                any(path == tree or path.startswith(tree + "/") for path in logical_manifest),
                f"packaged extract is missing test tree {tree}/",
            )
        dangerous_extension = re.compile(
            rb"(?i)\.(?:exe|dll|msi|bat|cmd|scr|vbs|ps1|jar)(?=$|[^A-Za-z0-9])"
        )
        unsafe = dangerous_extension.search(first_bundle)
        require(
            unsafe is None,
            f"bundle contains an undefanged dangerous extension token: {unsafe.group(0)!r}"
            if unsafe
            else "bundle contains an undefanged dangerous extension token",
        )
        unsafe_aphex = dangerous_extension.search(first_aphex)
        require(
            unsafe_aphex is None,
            f"APHEX transport contains an undefanged dangerous extension token: "
            f"{unsafe_aphex.group(0)!r}"
            if unsafe_aphex
            else "APHEX transport contains an undefanged dangerous extension token",
        )

        receipt = json.loads(first_receipt)
        require(receipt["build"] == "2026-07-14.595", "receipt build is wrong")
        require(receipt["version"] == "2.16.4", "receipt version is wrong")
        require(receipt["sourceFiles"] == len(manifest), "receipt source count is wrong")
        require(receipt["decodedBundle"]["sha256"] == first.bundle_sha256, "receipt bundle SHA is wrong")
        require(receipt["aphexTransport"]["sha256"] == first.aphex_sha256, "receipt APHEX SHA is wrong")
        require(receipt["verification"]["aphexRoundTrip"] is True, "receipt lacks APHEX proof")

        # Expand-SamQL restores only mail-defanged dangerous extensions.  A
        # standalone "[.]" source literal must survive reconstruction, while
        # script names and references are restored.  The release commands must
        # remain valid in that reconstructed tree and reproduce the same bytes.
        require(
            _refang_transport_text("literal [.] and Pack-SamQL.ps1")
            == "literal [.] and Pack-SamQL.ps1",
            "targeted transport refang changed a literal marker",
        )
        expanded_root = Path(expanded_tmp) / "samql"
        for safe_rel, payload in sections.items():
            logical_rel = _refang_transport_text(safe_rel)
            destination = expanded_root / logical_rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(
                _refang_transport_text(payload.decode("utf-8")).encode("utf-8")
            )
        expanded_failures = [
            item for item in run_preflight(expanded_root) if not item.ok
        ]
        require(
            not expanded_failures,
            "expanded-tree preflight failed: "
            + "; ".join(
                f"{item.name}: {item.detail}" for item in expanded_failures
            ),
        )
        expanded = package_release(
            expanded_root, Path(expanded_out_tmp), preflight=False
        )
        require(
            expanded.bundle_path.read_bytes() == first_bundle,
            "expanded-tree packaging changed canonical decoded bytes",
        )
        require(
            expanded.aphex_path.read_bytes() == first_aphex,
            "expanded-tree packaging changed canonical APHEX bytes",
        )

        # A changed bundle byte must fail the body hash/section parity check.
        tampered_bundle = bytearray(first_bundle)
        body_start = first_bundle.index(b"===== FILE: ")
        tampered_bundle[body_start + 20] ^= 1
        expect_failure(
            lambda: verify_bundle(ROOT, bytes(tampered_bundle), manifest),
            r"section|sha|path",
        )

        # A changed APHEX symbol must fail declared SHA/byte verification.
        tampered_text = first_aphex.decode("ascii")
        payload_at = tampered_text.index("DATA_BEGIN") + len("DATA_BEGIN")
        symbol_at = next(
            index
            for index in range(payload_at, len(tampered_text))
            if tampered_text[index] in "ABCDEFGHIJKLMNOP"
        )
        replacement = "A" if tampered_text[symbol_at] != "A" else "B"
        tampered_text = (
            tampered_text[:symbol_at] + replacement + tampered_text[symbol_at + 1 :]
        )
        expect_failure(
            lambda: decode_transport_text(tampered_text, verify=True),
            r"sha-256|byte count",
        )

        print(
            "Phase 10 release hardening PASS: "
            f"{first.file_count} files, "
            f"bundle {first.bundle_bytes} bytes ({first.bundle_sha256}), "
            f"APHEX {first.aphex_bytes} bytes ({first.aphex_sha256}), "
            f"receipt {first.receipt_bytes} bytes ({first.receipt_sha256})."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
