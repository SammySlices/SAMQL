#!/usr/bin/env python3
"""Encode and decode SamQL's mail-safe APHEX-1 source transport.

APHEX maps each hexadecimal nibble to one letter (A=0 through P=15). The
payload therefore contains only uppercase ASCII letters and line breaks, which
survives mail gateways that rewrite attachments or reject executable-looking
text. It is reversible transport encoding, not cryptographic encryption.

Examples::

    python tools/aphex_transport.py encode bundle.txt -o transport.txt
    python tools/aphex_transport.py decode transport.txt -o bundle.txt
    python tools/aphex_transport.py verify transport.txt --source bundle.txt
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

ALPHABET = "ABCDEFGHIJKLMNOP"
REVERSE = {char: value for value, char in enumerate(ALPHABET)}
BEGIN = "DATA_BEGIN"
END = "DATA_END"


@dataclass(frozen=True)
class TransportMetadata:
    original_file: str | None
    original_bytes: int | None
    expected_sha256: str | None


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


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def aphex_encode(data: bytes) -> str:
    out = bytearray(len(data) * 2)
    for index, value in enumerate(data):
        out[index * 2] = ord(ALPHABET[value >> 4])
        out[index * 2 + 1] = ord(ALPHABET[value & 0x0F])
    return out.decode("ascii")


def aphex_decode(payload: str) -> bytes:
    compact = "".join(payload.split()).upper()
    if not compact:
        raise ValueError("APHEX payload is empty.")
    if len(compact) % 2:
        raise ValueError("APHEX payload has an odd number of symbols.")
    output = bytearray(len(compact) // 2)
    for index in range(0, len(compact), 2):
        high = REVERSE.get(compact[index])
        low = REVERSE.get(compact[index + 1])
        if high is None or low is None:
            bad = compact[index : index + 2]
            raise ValueError(f"APHEX payload contains an invalid symbol pair: {bad!r}.")
        output[index // 2] = (high << 4) | low
    return bytes(output)


def _metadata(text: str) -> TransportMetadata:
    file_match = re.search(r"(?m)^Original file:\s*(.*?)\s*$", text)
    size_match = re.search(r"(?m)^Original bytes:\s*(\d+)\s*$", text)
    sha_match = re.search(r"(?mi)^Expected SHA256:\s*([0-9a-f]{64})\s*$", text)
    return TransportMetadata(
        original_file=file_match.group(1) if file_match else None,
        original_bytes=int(size_match.group(1)) if size_match else None,
        expected_sha256=sha_match.group(1).lower() if sha_match else None,
    )


def _line_marker(text: str, marker: str, start: int = 0) -> re.Match[str] | None:
    return re.search(rf"(?m)^{re.escape(marker)}[ \t]*\r?$", text[start:])


def decode_transport_text(text: str, *, verify: bool = True) -> tuple[bytes, TransportMetadata]:
    begin_match = _line_marker(text, BEGIN)
    if begin_match is None:
        raise ValueError(f"Transport is missing {BEGIN}.")
    begin_start = begin_match.start()
    payload_start = begin_match.end()

    relative_end = _line_marker(text, END, payload_start)
    if relative_end is None:
        # Build 587-era transports ended at EOF. Keep read compatibility while
        # all newly generated transports use an explicit terminator.
        payload_end = len(text)
    else:
        payload_end = payload_start + relative_end.start()
        trailing_start = payload_start + relative_end.end()
        if text[trailing_start:].strip():
            raise ValueError(f"Transport contains unexpected data after {END}.")

    data = aphex_decode(text[payload_start:payload_end])
    metadata = _metadata(text[:begin_start])
    if verify:
        if (
            metadata.original_file is None
            or metadata.original_bytes is None
            or metadata.expected_sha256 is None
        ):
            raise ValueError(
                "APHEX header must declare Original file, Original bytes, and Expected SHA256."
            )
        if len(data) != metadata.original_bytes:
            raise ValueError(
                f"Decoded byte count mismatch: got {len(data)}; "
                f"expected {metadata.original_bytes}."
            )
        actual_sha = sha256_bytes(data)
        if actual_sha != metadata.expected_sha256:
            raise ValueError(
                f"Decoded SHA-256 mismatch: got {actual_sha}; "
                f"expected {metadata.expected_sha256}."
            )
    return data, metadata


def decode_transport_file(path: Path, *, verify: bool = True) -> tuple[bytes, TransportMetadata]:
    return decode_transport_text(path.read_text(encoding="ascii"), verify=verify)


def build_transport_text(
    data: bytes,
    *,
    original_file: str,
    build: str,
    line_length: int = 128,
) -> str:
    if line_length < 32 or line_length % 2:
        raise ValueError("APHEX line length must be an even integer of at least 32.")
    if not original_file or Path(original_file).name != original_file:
        raise ValueError("APHEX Original file must be a base file name.")
    sequence = build.rsplit(".", 1)[-1] if "." in build else build
    encoded = aphex_encode(data)
    lines = [encoded[i : i + line_length] for i in range(0, len(encoded), line_length)]
    header = [
        f"SAMQL BUILD {sequence} MAIL-SAFE APHEX TRANSPORT",
        "",
        f"Original file: {original_file}",
        f"Original bytes: {len(data)}",
        f"Expected SHA256: {sha256_bytes(data)}",
        "",
        "Decode this file with:",
        "  python tools/aphex_transport.py decode <transport> -o <bundle>",
        "After decoding, expand the restored full-source bundle with Expand-SamQL[.]ps1.",
        "",
        BEGIN,
    ]
    return "\n".join([*header, *lines, END, ""])


def encode_file(source: Path, output: Path, *, build: str, line_length: int = 128) -> None:
    data = source.read_bytes()
    text = build_transport_text(
        data,
        original_file=source.name,
        build=build,
        line_length=line_length,
    )
    _atomic_write_bytes(output, text.encode("ascii"))


def _infer_build(source: Path) -> str:
    head = source.read_text(encoding="utf-8", errors="replace")[:4096]
    match = re.search(r"(?m)^#\s*build:\s*(\d{4}-\d{2}-\d{2}\.\d+)\s*$", head)
    if not match:
        raise ValueError("Could not infer the build from the source bundle header; pass --build.")
    return match.group(1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    encode = sub.add_parser("encode", help="encode a binary/text file to APHEX-1")
    encode.add_argument("source", type=Path)
    encode.add_argument("-o", "--output", type=Path, required=True)
    encode.add_argument("--build", help="SamQL build id; inferred from a bundle header")
    encode.add_argument("--line-length", type=int, default=128)

    decode = sub.add_parser("decode", help="decode and verify an APHEX-1 transport")
    decode.add_argument("transport", type=Path)
    decode.add_argument("-o", "--output", type=Path, required=True)
    decode.add_argument("--no-verify", action="store_true")

    verify = sub.add_parser("verify", help="verify APHEX metadata and optional source identity")
    verify.add_argument("transport", type=Path)
    verify.add_argument("--source", type=Path)

    args = parser.parse_args(argv)
    if args.command == "encode":
        build = args.build or _infer_build(args.source)
        encode_file(args.source, args.output, build=build, line_length=args.line_length)
        print(
            f"Wrote {args.output} ({args.output.stat().st_size} bytes; "
            f"source SHA-256 {sha256_bytes(args.source.read_bytes())})."
        )
        return 0

    data, metadata = decode_transport_file(
        args.transport,
        verify=not getattr(args, "no_verify", False),
    )
    if args.command == "decode":
        _atomic_write_bytes(args.output, data)
        print(f"Wrote {args.output} ({len(data)} bytes; SHA-256 {sha256_bytes(data)}).")
        return 0

    if args.source and args.source.read_bytes() != data:
        raise SystemExit("APHEX payload does not match --source byte-for-byte.")
    print(
        "APHEX verified: "
        f"{len(data)} bytes, SHA-256 {sha256_bytes(data)}, "
        f"original={metadata.original_file or 'unknown'}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
