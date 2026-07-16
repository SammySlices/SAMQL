#!/usr/bin/env python3
"""Download the optional SamQL offline SQL-assistant pack.

Fetches:
  * llama-server from the latest ggml-org/llama.cpp GitHub release (CPU build)
  * A Qwen Instruct Q4_K_M GGUF from Hugging Face (4B / 7B)

and places them under ``assistant/``:

  assistant/runtime/llama-server[.exe]   (+ companion libs/DLLs from the release)
  assistant/models/<chosen-qwen>.gguf

Models coexist under assistant/models/ -- fetching 7B does not remove
an existing 4B (or any other) GGUF, and does not delete the runtime unless
--force re-downloads llama-server.

Run this on a machine that CAN reach GitHub + Hugging Face, then copy the
whole ``assistant/`` folder to a locked-down work PC. Runtime stays offline.

Examples:
  python tools/fetch_assistant_pack.py
  python tools/fetch_assistant_pack.py --model 4b
  python tools/fetch_assistant_pack.py --model 7b
  python tools/fetch_assistant_pack.py --skip-model   # runtime only (build default)
  python tools/fetch_assistant_pack.py --root . --force
  python tools/fetch_assistant_pack.py --platform win-cpu
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

LLAMA_REPO = "ggml-org/llama.cpp"

# Instruct Q4_K_M GGUFs for the SQL assistant picker.
# Keys are the CLI / PS1 --model values (case-insensitive).
# 4B: Qwen2.5-Coder has no 4B; use Qwen3-4B-Instruct-2507 Q4_K_M
#     (community GGUF of official Qwen weights; verified HTTP 200).
# 7B: official Qwen2.5-Coder HF GGUF repo.
DEFAULT_MODEL_KEY = "4b"
MODELS: dict[str, dict[str, str]] = {
    "4b": {
        "key": "4b",
        "label": "Qwen3-4B-Instruct-2507",
        "filename": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        "repo": "unsloth/Qwen3-4B-Instruct-2507-GGUF",
        "approx_size": "~2.5 GB",
    },
    "7b": {
        "key": "7b",
        "label": "Qwen2.5-Coder-7B-Instruct",
        "filename": "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
        "repo": "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
        "approx_size": "~4.7 GB",
    },
}

# Aliases for the default pack model (used by docs / older callers).
GGUF_NAME = MODELS[DEFAULT_MODEL_KEY]["filename"]
GGUF_URL = (
    f"https://huggingface.co/{MODELS[DEFAULT_MODEL_KEY]['repo']}/"
    f"resolve/main/{GGUF_NAME}"
)

# Prefer CPU builds -- matches ThinkPad / no-GPU posture.
PLATFORM_ASSETS = {
    "win-cpu": ("win-cpu-x64.zip", "llama-server.exe"),
    "linux-cpu": ("ubuntu-x64.tar.gz", "llama-server"),  # may vary; see resolver
    "macos-arm": ("macos-arm64.tar.gz", "llama-server"),
    "macos-x64": ("macos-x64.tar.gz", "llama-server"),
}

USER_AGENT = "SamQL-fetch-assistant-pack/1.0"


def _die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


def normalize_model_key(value: str) -> str:
    """Map user input to a MODELS key, or raise ValueError."""
    raw = (value or "").strip().lower().replace(" ", "")
    aliases = {
        "4": "4b",
        "4b": "4b",
        "medium": "4b",
        "small": "4b",
        "7": "7b",
        "7b": "7b",
        "large": "7b",
    }
    key = aliases.get(raw)
    if key is None or key not in MODELS:
        choices = ", ".join(sorted(MODELS.keys()))
        raise ValueError(f"unknown model {value!r}; choose one of: {choices}")
    return key


def resolve_model(key: str) -> dict[str, str]:
    """Return a copy of the model spec including a download URL."""
    norm = normalize_model_key(key)
    spec = dict(MODELS[norm])
    spec["url"] = (
        f"https://huggingface.co/{spec['repo']}/resolve/main/{spec['filename']}"
    )
    return spec


def _detect_platform() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system.startswith("win"):
        return "win-cpu"
    if system == "darwin":
        return "macos-arm" if machine in ("arm64", "aarch64") else "macos-x64"
    if system == "linux":
        return "linux-cpu"
    _die(f"unsupported OS for auto-detect: {system}/{machine}")


def _http_json(url: str):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _download(url: str, dest: Path, *, label: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".partial")
    if tmp.exists():
        tmp.unlink()
    print(f"Downloading {label}...")
    print(f"  {url}")
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            # Hugging Face sometimes wants this for resolve/ URLs.
            "Accept": "*/*",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp, open(tmp, "wb") as out:
            total = resp.headers.get("Content-Length")
            total_n = int(total) if total and total.isdigit() else None
            done = 0
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if total_n:
                    pct = 100.0 * done / total_n
                    print(
                        f"\r  {done / (1024 * 1024):.1f} / "
                        f"{total_n / (1024 * 1024):.1f} MiB ({pct:.0f}%)",
                        end="",
                        flush=True,
                    )
            if total_n:
                print()
    except urllib.error.HTTPError as exc:
        if tmp.exists():
            tmp.unlink()
        _die(f"download failed ({exc.code}): {url}")
    except Exception as exc:
        if tmp.exists():
            tmp.unlink()
        _die(f"download failed: {exc}")
    os.replace(tmp, dest)
    print(f"  saved {dest} ({dest.stat().st_size / (1024 * 1024):.1f} MiB)")


def _pick_llama_asset(assets: list[dict], plat: str) -> tuple[str, str, str]:
    """Return (name, browser_download_url, binary_name)."""
    names = [a.get("name") or "" for a in assets]
    binary = PLATFORM_ASSETS.get(plat, (None, "llama-server"))[1]
    if plat == "win-cpu":
        # llama-bNNNN-bin-win-cpu-x64.zip
        for a in assets:
            name = a.get("name") or ""
            if name.endswith("-bin-win-cpu-x64.zip"):
                return name, a["browser_download_url"], "llama-server.exe"
        _die(
            "no Windows CPU x64 zip in latest llama.cpp release; "
            f"saw: {', '.join(names[:12])}..."
        )
    if plat == "linux-cpu":
        # Prefer plain Ubuntu x64 CPU build (not cuda/vulkan/rocm/sycl).
        candidates = []
        for a in assets:
            name = (a.get("name") or "")
            if not name.startswith("llama-") or "ubuntu" not in name or "x64" not in name:
                continue
            if any(x in name for x in ("cuda", "vulkan", "rocm", "sycl", "openvino")):
                continue
            if name.endswith((".tar.gz", ".zip")):
                candidates.append(a)
        if not candidates:
            _die(
                "no Ubuntu x64 CPU archive in latest llama.cpp release; "
                f"saw: {', '.join(names[:12])}..."
            )
        a = candidates[0]
        return a["name"], a["browser_download_url"], "llama-server"
    if plat == "macos-arm":
        for a in assets:
            name = a.get("name") or ""
            if "macos-arm64" in name and name.endswith(".tar.gz"):
                return name, a["browser_download_url"], "llama-server"
        _die("no macOS arm64 archive in latest llama.cpp release")
    if plat == "macos-x64":
        for a in assets:
            name = a.get("name") or ""
            if "macos-x64" in name and name.endswith(".tar.gz"):
                return name, a["browser_download_url"], "llama-server"
        _die("no macOS x64 archive in latest llama.cpp release")
    _die(f"unknown platform key: {plat}")
    return binary, "", binary  # unreachable


def _extract_runtime(archive: Path, binary_name: str, runtime_dir: Path) -> Path:
    """Install the full release payload (binary + shared libs/DLLs).

    Modern llama.cpp CPU builds ship a thin ``llama-server`` plus many
    companion libraries in the same folder. Copying only the exe breaks
    at launch, so we publish the whole runtime directory.
    """
    print(f"Extracting runtime (including {binary_name}) from {archive.name}...")
    with tempfile.TemporaryDirectory(prefix="samql-llama-") as td:
        td_path = Path(td)
        if archive.suffix.lower() == ".zip" or archive.name.endswith(".zip"):
            with zipfile.ZipFile(archive, "r") as zf:
                zf.extractall(td_path)
        elif archive.name.endswith(".tar.gz") or archive.suffixes[-2:] == [".tar", ".gz"]:
            import tarfile

            with tarfile.open(archive, "r:gz") as tf:
                tf.extractall(td_path)
        else:
            _die(f"unsupported archive type: {archive.name}")

        matches = [
            p for p in td_path.rglob("*")
            if p.is_file() and p.name.lower() == binary_name.lower()
        ]
        if not matches:
            _die(f"{binary_name} not found inside {archive.name}")
        src_bin = matches[0]
        src_dir = src_bin.parent

        if runtime_dir.exists():
            shutil.rmtree(runtime_dir)
        runtime_dir.mkdir(parents=True, exist_ok=True)
        for item in src_dir.iterdir():
            target = runtime_dir / item.name
            if item.is_dir():
                shutil.copytree(item, target)
            else:
                shutil.copy2(item, target)
                if item.name.lower() == binary_name.lower():
                    try:
                        target.chmod(target.stat().st_mode | 0o111)
                    except Exception:
                        pass
        dest = runtime_dir / src_bin.name
        if not dest.is_file():
            _die(f"failed to install {binary_name} into {runtime_dir}")
        print(f"  installed runtime -> {runtime_dir}")
        print(f"  binary {dest}")
        return dest


def fetch_llama(out_dir: Path, plat: str, *, force: bool) -> Path:
    binary_name = "llama-server.exe" if plat == "win-cpu" else "llama-server"
    runtime_dir = out_dir / "runtime"
    dest = runtime_dir / binary_name
    # Also accept a legacy flat layout from earlier betas.
    legacy = out_dir / binary_name
    if dest.is_file() and not force:
        print(f"Keeping existing {dest} (pass --force to re-download)")
        return dest
    if legacy.is_file() and not force and not dest.is_file():
        print(f"Keeping existing {legacy} (pass --force to refresh into runtime/)")
        return legacy

    print("Resolving latest llama.cpp release...")
    meta = _http_json(f"https://api.github.com/repos/{LLAMA_REPO}/releases/latest")
    tag = meta.get("tag_name") or "?"
    assets = meta.get("assets") or []
    name, url, binary_name = _pick_llama_asset(assets, plat)
    print(f"  release {tag}: {name}")

    with tempfile.TemporaryDirectory(prefix="samql-llama-dl-") as td:
        archive = Path(td) / name
        _download(url, archive, label=f"llama.cpp {tag}")
        return _extract_runtime(archive, binary_name, runtime_dir)


def fetch_model(models_dir: Path, model_key: str = DEFAULT_MODEL_KEY, *, force: bool) -> Path:
    """Download one GGUF into models_dir; leave any other GGUFs untouched."""
    spec = resolve_model(model_key)
    dest = models_dir / spec["filename"]
    if dest.is_file() and not force:
        print(f"Keeping existing {dest} (pass --force to re-download)")
        return dest
    _download(spec["url"], dest, label=f"{spec['label']} ({spec['filename']})")
    return dest


def _prompt_model_key() -> str:
    """Interactive model picker; Enter keeps the 4B default."""
    print()
    print("Choose Instruct Q4_K_M GGUF to download (4b / 7b):")
    order = ("4b", "7b")
    for i, key in enumerate(order, start=1):
        spec = MODELS[key]
        marker = " (default)" if key == DEFAULT_MODEL_KEY else ""
        print(
            f"  {i}) {key.upper():<4}  {spec['label']}  "
            f"{spec['approx_size']}{marker}"
        )
        print(f"       -> assistant/models/{spec['filename']}")
    print()
    try:
        raw = input(
            f"Model [4b/7b] (default {DEFAULT_MODEL_KEY}): "
        ).strip()
    except EOFError:
        return DEFAULT_MODEL_KEY
    if not raw:
        return DEFAULT_MODEL_KEY
    # Allow picking by menu number.
    if raw.isdigit() and 1 <= int(raw) <= len(order):
        return order[int(raw) - 1]
    try:
        return normalize_model_key(raw)
    except ValueError as exc:
        print(f"  note: {exc}; using default {DEFAULT_MODEL_KEY}")
        return DEFAULT_MODEL_KEY


def _choose_model_key(explicit: str | None, *, no_prompt: bool) -> str:
    if explicit:
        try:
            return normalize_model_key(explicit)
        except ValueError as exc:
            _die(str(exc))
    if no_prompt or not sys.stdin.isatty():
        return DEFAULT_MODEL_KEY
    return _prompt_model_key()


def _list_models(models_dir: Path) -> list[Path]:
    if not models_dir.is_dir():
        return []
    return sorted(p for p in models_dir.glob("*.gguf") if p.is_file())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Download SamQL offline SQL assistant pack "
            "(llama-server + Qwen Instruct Q4_K_M GGUF)."
        ),
    )
    parser.add_argument(
        "--root",
        default=".",
        help="SamQL repo / install root (default: current directory)",
    )
    parser.add_argument(
        "--platform",
        choices=sorted(PLATFORM_ASSETS.keys()),
        default=None,
        help="llama.cpp CPU build to fetch (default: auto-detect)",
    )
    parser.add_argument(
        "--model",
        default=None,
        metavar="SIZE",
        help=(
            "Qwen GGUF to download: 4b (default) or 7b. "
            "If omitted on a TTY, prompts interactively."
        ),
    )
    parser.add_argument(
        "--no-prompt",
        action="store_true",
        help="Never prompt for model; use --model or default 4b",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download even if files already exist",
    )
    parser.add_argument(
        "--skip-llama",
        action="store_true",
        help="Only download the GGUF model",
    )
    parser.add_argument(
        "--skip-model",
        action="store_true",
        help="Only download llama-server",
    )
    args = parser.parse_args(argv)
    if args.skip_llama and args.skip_model:
        _die("nothing to do: both --skip-llama and --skip-model were set")

    root = Path(args.root).resolve()
    out = root / "assistant"
    models = out / "models"
    plat = args.platform or _detect_platform()

    print(f"Assistant pack directory: {out}")
    print(f"Platform: {plat}")

    # Runtime-only builds / -SkipModel: never prompt for or download a GGUF.
    model_key: str | None = None
    spec: dict[str, str] | None = None
    if not args.skip_model:
        model_key = _choose_model_key(args.model, no_prompt=args.no_prompt)
        spec = resolve_model(model_key)
        print(f"Model: {spec['label']} ({spec['key']}, {spec['approx_size']})")
        print(f"  file: {spec['filename']}")
    else:
        print("Model: (skipped — runtime only; drop a .gguf into Model/ later)")

    if not args.skip_llama:
        fetch_llama(out, plat, force=args.force)
    if not args.skip_model and model_key is not None:
        fetch_model(models, model_key, force=args.force)

    print()
    print("Done. Pack layout:")
    runtime = out / "runtime"
    if runtime.is_dir():
        bins = list(runtime.glob("llama-server*"))
        print(f"  assistant/runtime/  ({len(list(runtime.iterdir()))} files)")
        for b in bins:
            if b.is_file():
                print(f"    {b.name}")
    present = _list_models(models)
    if present:
        print(f"  assistant/models/  ({len(present)} GGUF file(s); others kept if present)")
        fetched_name = spec["filename"] if spec else None
        for p in present:
            size_mib = p.stat().st_size / (1024 * 1024)
            mark = "  [fetched]" if fetched_name and p.name == fetched_name else ""
            print(f"    {p.name}  ({size_mib:.1f} MiB){mark}")
    elif args.skip_model:
        print("  assistant/models/  (empty — no GGUF downloaded)")
    print()
    print("Copy the whole assistant/ folder next to SamQL if this machine")
    print("is not the one that will run the app. Runtime needs no internet.")
    print("Packaged lean/runtime installs also accept a .gguf in the")
    print("install-root Model/ folder (next to _internal); SamQL prefers")
    print("assistant/models/ when present, then Model/.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        raise SystemExit(130)
