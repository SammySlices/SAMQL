#!/usr/bin/env python3
"""Assistant packaging modes for SamQL build.ps1 / build.sh.

Modes
  1 / lean   — do not ship the pack (default; smallest build)
  2 / post   — after PyInstaller, copy assistant/ next to dist outputs (~+1 GiB)
  3 / embed  — bake assistant/ into the PyInstaller payload via SAMQL_ASSISTANT_EMBED

The build scripts prompt interactively when no mode is passed and stdin is a TTY.
Non-interactive / CI defaults to lean.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

MODES = {
    "1": "lean",
    "2": "post",
    "3": "embed",
    "lean": "lean",
    "sidecar": "lean",
    "post": "post",
    "embed": "embed",
    "bundle": "embed",
}

PROMPT = """
SQL assistant packaging (Qwen2.5-Coder-1.5B + llama-server):
  1) Lean (default)  — SamQL only. Copy assistant/ beside the exe later yourself.
  2) Post-build pack — After build, place assistant/ next to dist/ outputs (~+1 GB).
  3) Embed in exe    — Bake assistant/ into the PyInstaller payload (~+1 GB).

Enter 1, 2, or 3
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


def prompt_mode(default: str = "lean") -> str:
    if not sys.stdin.isatty():
        print(
            f"assistant pack: non-interactive session → defaulting to '{default}'",
            file=sys.stderr,
            flush=True,
        )
        return default
    print(PROMPT, file=sys.stderr)
    try:
        default_key = "1" if default == "lean" else "2" if default == "post" else "3"
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
    default: str = "lean",
) -> str:
    for raw in (cli, env, os.environ.get("SAMQL_ASSISTANT_PACK")):
        mode = normalize_mode(raw)
        if mode:
            return mode
    if interactive:
        return prompt_mode(default=default)
    return default


def pack_status(root: Path) -> dict:
    """Return whether assistant/runtime + model look ready to ship."""
    base = root / "assistant"
    bin_name = "llama-server.exe" if _is_windows() else "llama-server"
    binary = base / "runtime" / bin_name
    if not binary.is_file():
        # Flat / cross-platform fallbacks
        for cand in (
            base / "runtime" / "llama-server",
            base / "runtime" / "llama-server.exe",
            base / bin_name,
            base / "llama-server",
        ):
            if cand.is_file():
                binary = cand
                break
    models = base / "models"
    model = None
    if models.is_dir():
        hits = sorted(models.glob("*.gguf"))
        if hits:
            model = hits[0]
    ok = binary.is_file() and model is not None and model.is_file()
    return {
        "ok": ok,
        "root": str(base),
        "binary": str(binary) if binary.is_file() else None,
        "model": str(model) if model is not None else None,
    }


def ensure_pack(root: Path, *, fetch: bool, platform: str | None = None) -> dict:
    """Make sure the assistant pack exists; optionally download it."""
    st = pack_status(root)
    if st["ok"]:
        print(f"assistant pack OK: {st['binary']}")
        print(f"                 {st['model']}")
        return st
    if not fetch:
        raise SystemExit(
            "assistant pack incomplete under assistant/.\n"
            "Run:  python tools/fetch_assistant_pack.py\n"
            "  or: .\\Fetch-SamQL-Assistant.ps1\n"
            f"Missing binary={st['binary']!r} model={st['model']!r}"
        )
    print("assistant pack missing/incomplete — running fetch_assistant_pack.py …")
    from fetch_assistant_pack import main as fetch_main  # type: ignore

    args = ["--root", str(root), "--force"]
    if platform:
        args.extend(["--platform", platform])
    elif _is_windows():
        args.extend(["--platform", "win-cpu"])
    rc = fetch_main(args)
    if rc != 0:
        raise SystemExit(f"fetch_assistant_pack failed with exit {rc}")
    st = pack_status(root)
    if not st["ok"]:
        raise SystemExit(
            "assistant pack still incomplete after fetch "
            f"(binary={st['binary']!r} model={st['model']!r})"
        )
    return st


def stage_post_build(root: Path) -> list[Path]:
    """Copy assistant/ beside dist outputs (mode 2)."""
    src = root / "assistant"
    if not src.is_dir():
        raise SystemExit(f"missing source pack: {src}")
    targets = [root / "dist" / "assistant"]
    onedir = root / "dist" / "SamQL-AppWindow"
    if onedir.is_dir():
        targets.append(onedir / "assistant")
    written: list[Path] = []
    for dest in targets:
        if dest.exists():
            shutil.rmtree(dest)
        print(f"staging assistant pack → {dest}")
        shutil.copytree(
            src,
            dest,
            ignore=shutil.ignore_patterns("*.partial", "__pycache__"),
        )
        written.append(dest)
    return written


def apply_env_for_mode(mode: str) -> None:
    """Set/clear env vars consumed by samql.spec and later build steps."""
    os.environ["SAMQL_ASSISTANT_PACK"] = mode
    if mode == "embed":
        os.environ["SAMQL_ASSISTANT_EMBED"] = "1"
    else:
        os.environ.pop("SAMQL_ASSISTANT_EMBED", None)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_resolve = sub.add_parser("resolve", help="Resolve mode (prompt if needed) and print it")
    p_resolve.add_argument("--mode", default="", help="1|2|3 or lean|post|embed")
    p_resolve.add_argument("--default", default="lean")
    p_resolve.add_argument("--no-prompt", action="store_true")
    p_resolve.add_argument("--export-env", action="store_true",
                           help="also print SAMQL_ASSISTANT_* assignments")

    p_ensure = sub.add_parser("ensure", help="Require a complete assistant pack (fetch if asked)")
    p_ensure.add_argument("--root", default=".")
    p_ensure.add_argument("--fetch", action="store_true")
    p_ensure.add_argument("--platform", default="")

    p_stage = sub.add_parser("stage-post", help="Copy assistant/ into dist/ (mode 2)")
    p_stage.add_argument("--root", default=".")
    p_stage.add_argument("--fetch", action="store_true",
                         help="download the pack first if missing")
    p_stage.add_argument("--platform", default="")

    p_status = sub.add_parser("status", help="Print pack readiness JSON-ish lines")
    p_status.add_argument("--root", default=".")

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
    if args.cmd == "status":
        st = pack_status(root)
        for k, v in st.items():
            print(f"{k}={v}")
        return 0 if st["ok"] else 2

    if args.cmd == "ensure":
        ensure_pack(
            root,
            fetch=bool(args.fetch),
            platform=(args.platform or None),
        )
        return 0

    if args.cmd == "stage-post":
        if args.fetch:
            ensure_pack(root, fetch=True, platform=(args.platform or None))
        else:
            ensure_pack(root, fetch=False)
        for dest in stage_post_build(root):
            print(f"staged {dest}")
        return 0

    return 1


if __name__ == "__main__":
    # Allow `python tools/assistant_build_pack.py` from repo root.
    tools_dir = Path(__file__).resolve().parent
    if str(tools_dir) not in sys.path:
        sys.path.insert(0, str(tools_dir))
    raise SystemExit(main())
