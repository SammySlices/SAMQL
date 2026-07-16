#!/usr/bin/env python3
"""Assistant packaging modes for SamQL build.ps1 / build.sh.

Modes
  1 / lean      — do not ship the pack (smallest build)
  2 / runtime   — after PyInstaller, stage llama-server runtime only (no GGUF;
                  default for AppWindow distribution)
  3 / post      — after PyInstaller, copy full assistant/ (runtime + GGUF, ~+1 GiB+)
  4 / embed     — bake full assistant/ into the PyInstaller payload (~+1 GiB+)

The build scripts prompt interactively when no mode is passed and stdin is a TTY.
Non-interactive / CI defaults to runtime (runtime-without-model). Use lean for
offline/CI builds that must not download llama-server.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

MODES = {
    "1": "lean",
    "2": "runtime",
    "3": "post",
    "4": "embed",
    "lean": "lean",
    "sidecar": "lean",
    "runtime": "runtime",
    "runtime-only": "runtime",
    "post": "post",
    "embed": "embed",
    "bundle": "embed",
}

# Modes that stage or embed the assistant pack after/during the build.
STAGED_MODES = frozenset({"runtime", "post"})
FULL_PACK_MODES = frozenset({"post", "embed"})  # require a GGUF

MODELS_README = """No GGUF model is shipped with this SamQL build.

Download a model later (pick one size; runtime is already present):

  Windows:
    .\\Fetch-SamQL-Assistant.ps1 -Model 4b
    .\\Fetch-SamQL-Assistant.ps1 -Model 7b

  Any OS:
    python tools/fetch_assistant_pack.py --model 4b
    python tools/fetch_assistant_pack.py --model 7b

Models land under assistant/models/. The llama-server runtime under
assistant/runtime/ is shared across model sizes.
"""

PROMPT = """
SQL assistant packaging (llama.cpp llama-server; GGUF optional):
  1) Lean              — SamQL only. No assistant/ staged.
  2) Runtime (default) — Stage llama-server + DLLs next to dist (no GGUF).
                         Download a model later via Fetch-SamQL-Assistant.
  3) Post-build pack   — Stage full assistant/ (runtime + GGUF, ~+1 GB+).
  4) Embed in exe      — Bake full assistant/ into the PyInstaller payload.

Enter 1, 2, 3, or 4
""".strip()


def _is_windows() -> bool:
    return os.name == "nt" or sys.platform.startswith("win")


def normalize_mode(raw: str | None) -> str | None:
    if raw is None:
        return None
    key = str(raw).strip().lower()
    if not key:
        return None
    return MODES.get(key)


def prompt_mode(default: str = "runtime") -> str:
    if not sys.stdin.isatty():
        print(
            f"assistant pack: non-interactive session -> defaulting to '{default}'",
            file=sys.stderr,
            flush=True,
        )
        return default
    print(PROMPT, file=sys.stderr)
    try:
        default_key = {
            "lean": "1",
            "runtime": "2",
            "post": "3",
            "embed": "4",
        }.get(default, "2")
        answer = input(f"[{default_key}] ").strip()
    except EOFError:
        answer = ""
    mode = normalize_mode(answer) if answer else default
    if mode is None:
        print(f"unrecognized choice {answer!r}; using '{default}'", file=sys.stderr)
        return default
    return mode


def resolve_mode(
    cli: str | None = None,
    *,
    env: str | None = None,
    interactive: bool = True,
    default: str = "runtime",
) -> str:
    for raw in (cli, env, os.environ.get("SAMQL_ASSISTANT_PACK")):
        mode = normalize_mode(raw)
        if mode:
            return mode
    if interactive:
        return prompt_mode(default=default)
    return default


def _find_llama_binary(base: Path) -> Path | None:
    bin_name = "llama-server.exe" if _is_windows() else "llama-server"
    candidates = (
        base / "runtime" / bin_name,
        base / "runtime" / "llama-server",
        base / "runtime" / "llama-server.exe",
        base / bin_name,
        base / "llama-server",
    )
    for cand in candidates:
        if cand.is_file():
            return cand
    return None


def _find_model(base: Path) -> Path | None:
    models = base / "models"
    if not models.is_dir():
        return None
    hits = sorted(models.glob("*.gguf"))
    return hits[0] if hits else None


def pack_status(root: Path, *, require_model: bool = True) -> dict:
    """Return whether assistant/runtime (+ optional model) look ready to ship."""
    base = root / "assistant"
    binary = _find_llama_binary(base)
    model = _find_model(base)
    runtime_ok = binary is not None and binary.is_file()
    model_ok = model is not None and model.is_file()
    ok = runtime_ok and (model_ok if require_model else True)
    return {
        "ok": ok,
        "runtime_ok": runtime_ok,
        "model_ok": model_ok,
        "root": str(base),
        "binary": str(binary) if binary is not None else None,
        "model": str(model) if model is not None else None,
    }


def ensure_pack(
    root: Path,
    *,
    fetch: bool,
    platform: str | None = None,
    require_model: bool = True,
) -> dict:
    """Make sure the assistant pack exists; optionally download it."""
    st = pack_status(root, require_model=require_model)
    if st["ok"]:
        print(f"assistant pack OK: {st['binary']}")
        if st["model"]:
            print(f"                 {st['model']}")
        elif not require_model:
            print("                 (no GGUF — runtime-only; fetch a model later)")
        return st
    if not fetch:
        need = "runtime + GGUF" if require_model else "runtime (llama-server)"
        raise SystemExit(
            f"assistant pack incomplete under assistant/ (need {need}).\n"
            "Run:  python tools/fetch_assistant_pack.py\n"
            "  or: .\\Fetch-SamQL-Assistant.ps1\n"
            f"Missing binary={st['binary']!r} model={st['model']!r}"
        )
    kind = "runtime + GGUF" if require_model else "runtime only (no GGUF)"
    print(f"assistant pack missing/incomplete -- fetching {kind} ...")
    from fetch_assistant_pack import main as fetch_main  # type: ignore

    # Full pack uses the 4B default (non-interactive).
    # Runtime-only uses --skip-model so builds never pull multi-GB GGUFs.
    args = ["--root", str(root), "--force", "--no-prompt"]
    if require_model:
        args.extend(["--model", "4b"])
    else:
        args.append("--skip-model")
    if platform:
        args.extend(["--platform", platform])
    elif _is_windows():
        args.extend(["--platform", "win-cpu"])
    rc = fetch_main(args)
    if rc != 0:
        raise SystemExit(f"fetch_assistant_pack failed with exit {rc}")
    st = pack_status(root, require_model=require_model)
    if not st["ok"]:
        raise SystemExit(
            "assistant pack still incomplete after fetch "
            f"(binary={st['binary']!r} model={st['model']!r})"
        )
    return st


def _write_models_readme(models_dir: Path) -> None:
    models_dir.mkdir(parents=True, exist_ok=True)
    readme = models_dir / "README.txt"
    readme.write_text(MODELS_README, encoding="utf-8")


def stage_post_build(root: Path, *, include_models: bool = True) -> list[Path]:
    """Copy assistant/ beside dist outputs (modes runtime / post)."""
    src = root / "assistant"
    if not src.is_dir():
        raise SystemExit(f"missing source pack: {src}")
    targets = [root / "dist" / "assistant"]
    onedir = root / "dist" / "SamQL-AppWindow"
    if onedir.is_dir():
        targets.append(onedir / "assistant")
    ignore = ["*.partial", "__pycache__"]
    if not include_models:
        ignore.append("*.gguf")
    written: list[Path] = []
    for dest in targets:
        if dest.exists():
            shutil.rmtree(dest)
        print(f"staging assistant pack -> {dest}"
              + ("" if include_models else " (runtime only, no GGUF)"))
        shutil.copytree(
            src,
            dest,
            ignore=shutil.ignore_patterns(*ignore),
        )
        if not include_models:
            # Drop any leftover model blobs and leave a fetch hint.
            models_dest = dest / "models"
            if models_dest.is_dir():
                for gguf in models_dest.glob("*.gguf"):
                    gguf.unlink()
            _write_models_readme(models_dest)
        written.append(dest)
    return written


def apply_env_for_mode(mode: str) -> None:
    """Set/clear env vars consumed by samql.spec and later build steps."""
    os.environ["SAMQL_ASSISTANT_PACK"] = mode
    if mode == "embed":
        os.environ["SAMQL_ASSISTANT_EMBED"] = "1"
    else:
        os.environ.pop("SAMQL_ASSISTANT_EMBED", None)


def _zip_directory(source_dir: Path, zip_path: Path) -> None:
    """Zip ``source_dir`` so the archive root is its basename folder.

    Prefers ``tar -a`` (Windows bsdtar / libarchive) which tolerates multi-GB
    trees; falls back to ``zipfile`` with ZIP64. Avoids PowerShell
    ``Compress-Archive``, which has failed on large assistant packs.
    """
    source_dir = source_dir.resolve()
    if not source_dir.is_dir():
        raise SystemExit(f"zip source missing: {source_dir}")
    zip_path = zip_path.resolve()
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    if zip_path.exists():
        zip_path.unlink()
    parent = source_dir.parent
    name = source_dir.name
    tar = shutil.which("tar")
    if tar:
        # -a: archive format from extension (.zip); -C: root entry = name/
        proc = subprocess.run(
            [tar, "-a", "-c", "-f", str(zip_path), "-C", str(parent), name],
            check=False,
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0 and zip_path.is_file() and zip_path.stat().st_size > 0:
            return
        err = (proc.stderr or proc.stdout or "").strip()
        print(
            f"tar zip failed (exit {proc.returncode}); falling back to zipfile"
            + (f": {err}" if err else ""),
            file=sys.stderr,
        )
        if zip_path.exists():
            zip_path.unlink()
    # ZIP64 so multi-GB GGUF trees do not hit the classic 2 GiB limit.
    with zipfile.ZipFile(
        zip_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True
    ) as zf:
        for path in sorted(source_dir.rglob("*")):
            if path.is_file():
                arcname = Path(name) / path.relative_to(source_dir)
                zf.write(path, arcname.as_posix())
    if not zip_path.is_file() or zip_path.stat().st_size <= 0:
        raise SystemExit(f"failed to write zip: {zip_path}")


def write_onedir_distribution_zips(
    onedir: Path,
    *,
    lean_zip: Path,
    assistant_zip: Path | None = None,
) -> list[Path]:
    """Write AppWindow onedir zip(s) for distribution.

    Always writes ``lean_zip`` from the onedir tree **without** ``assistant/``.
    When ``assistant/`` is present under ``onedir`` and ``assistant_zip`` is
    set, also writes that archive **with** the staged SQL assistant pack
    (llama.cpp runtime; GGUF only if already staged). Restores ``assistant/``
    into ``onedir`` afterward so the live dist folder matches the build mode.
    """
    onedir = onedir.resolve()
    if not onedir.is_dir():
        raise SystemExit(f"onedir missing: {onedir}")
    written: list[Path] = []
    asst = onedir / "assistant"
    asst_aside: Path | None = None
    try:
        if asst.is_dir() and assistant_zip is not None:
            print(f"zipping AppWindow + SQL assistant runtime -> {assistant_zip}")
            _zip_directory(onedir, assistant_zip)
            written.append(assistant_zip.resolve())
            asst_aside = onedir.parent / "_assistant_aside_for_lean_zip"
            if asst_aside.exists():
                shutil.rmtree(asst_aside)
            shutil.move(str(asst), str(asst_aside))
        print(f"zipping AppWindow (no assistant/) -> {lean_zip}")
        _zip_directory(onedir, lean_zip)
        written.append(lean_zip.resolve())
    finally:
        if asst_aside is not None and asst_aside.exists():
            if asst.exists():
                shutil.rmtree(asst)
            shutil.move(str(asst_aside), str(asst))
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_resolve = sub.add_parser("resolve", help="Resolve mode (prompt if needed) and print it")
    p_resolve.add_argument(
        "--mode",
        default="",
        help="1|2|3|4 or lean|runtime|post|embed",
    )
    p_resolve.add_argument("--default", default="runtime")
    p_resolve.add_argument("--no-prompt", action="store_true")
    p_resolve.add_argument("--export-env", action="store_true",
                           help="also print SAMQL_ASSISTANT_* assignments")

    p_ensure = sub.add_parser("ensure", help="Require an assistant pack (fetch if asked)")
    p_ensure.add_argument("--root", default=".")
    p_ensure.add_argument("--fetch", action="store_true")
    p_ensure.add_argument("--platform", default="")
    p_ensure.add_argument(
        "--runtime-only",
        action="store_true",
        help="Require llama-server only (no GGUF). Uses fetch --skip-model.",
    )

    p_stage = sub.add_parser("stage-post", help="Copy assistant/ into dist/")
    p_stage.add_argument("--root", default=".")
    p_stage.add_argument("--fetch", action="store_true",
                         help="download the pack first if missing")
    p_stage.add_argument("--platform", default="")
    p_stage.add_argument(
        "--runtime-only",
        action="store_true",
        help="Stage runtime + models/README only (exclude *.gguf)",
    )

    p_status = sub.add_parser("status", help="Print pack readiness JSON-ish lines")
    p_status.add_argument("--root", default=".")
    p_status.add_argument(
        "--runtime-only",
        action="store_true",
        help="OK if llama-server is present (GGUF optional)",
    )

    p_zips = sub.add_parser(
        "zip-onedir",
        help="Write SamQL-AppWindow.zip (+ optional -Assistant.zip) via tar/ZIP64",
    )
    p_zips.add_argument("--root", default=".")
    p_zips.add_argument(
        "--onedir",
        default="",
        help="Path to SamQL-AppWindow folder (default: <root>/dist/SamQL-AppWindow)",
    )
    p_zips.add_argument(
        "--lean-zip",
        default="",
        help="Lean zip path (default: <root>/dist/SamQL-AppWindow.zip)",
    )
    p_zips.add_argument(
        "--assistant-zip",
        default="",
        help="With-assistant zip (default: <root>/dist/SamQL-AppWindow-Assistant.zip "
             "when onedir/assistant exists; pass 'none' to skip)",
    )

    args = parser.parse_args(argv)
    if args.cmd == "resolve":
        mode = resolve_mode(
            args.mode or None,
            interactive=not args.no_prompt,
            default=args.default,
        )
        apply_env_for_mode(mode)
        print(mode)
        if args.export_env:
            print(f"SAMQL_ASSISTANT_PACK={mode}")
            if mode == "embed":
                print("SAMQL_ASSISTANT_EMBED=1")
            else:
                print("SAMQL_ASSISTANT_EMBED=")
        return 0

    root = Path(getattr(args, "root", ".")).resolve()
    require_model = not bool(getattr(args, "runtime_only", False))

    if args.cmd == "status":
        st = pack_status(root, require_model=require_model)
        for k, v in st.items():
            print(f"{k}={v}")
        return 0 if st["ok"] else 2

    if args.cmd == "ensure":
        ensure_pack(
            root,
            fetch=bool(args.fetch),
            platform=(args.platform or None),
            require_model=require_model,
        )
        return 0

    if args.cmd == "stage-post":
        include_models = not bool(args.runtime_only)
        if args.fetch:
            ensure_pack(
                root,
                fetch=True,
                platform=(args.platform or None),
                require_model=include_models,
            )
        else:
            ensure_pack(
                root,
                fetch=False,
                require_model=include_models,
            )
        for dest in stage_post_build(root, include_models=include_models):
            print(f"staged {dest}")
        return 0

    if args.cmd == "zip-onedir":
        onedir = (
            Path(args.onedir).resolve()
            if args.onedir
            else (root / "dist" / "SamQL-AppWindow")
        )
        lean_zip = (
            Path(args.lean_zip).resolve()
            if args.lean_zip
            else (root / "dist" / "SamQL-AppWindow.zip")
        )
        asst_arg = (args.assistant_zip or "").strip().lower()
        if asst_arg in ("none", "skip", "-"):
            assistant_zip: Path | None = None
        elif args.assistant_zip:
            assistant_zip = Path(args.assistant_zip).resolve()
        elif (onedir / "assistant").is_dir():
            assistant_zip = root / "dist" / "SamQL-AppWindow-Assistant.zip"
        else:
            assistant_zip = None
        for dest in write_onedir_distribution_zips(
            onedir, lean_zip=lean_zip, assistant_zip=assistant_zip
        ):
            print(f"wrote {dest}")
        return 0

    return 1


if __name__ == "__main__":
    # Allow `python tools/assistant_build_pack.py` from repo root.
    tools_dir = Path(__file__).resolve().parent
    if str(tools_dir) not in sys.path:
        sys.path.insert(0, str(tools_dir))
    raise SystemExit(main())
