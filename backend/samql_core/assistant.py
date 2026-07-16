"""SQL assistant (English → DuckDB / SparkSQL).

Default path: optional local llama.cpp pack (GGUF + llama-server).
Alternative: OpenAI-compatible remote/local HTTP API
(``POST {base}/v1/chat/completions``).

Phase 1 design (beta):
  * Local model: Qwen3-4B-Instruct-2507 Q4_K_M GGUF (default; optional 7B)
  * Local runtime: llama-server binary next to SamQL (NOT in-process, NOT Ollama)
  * API mode: user-configured base URL (+ optional key / model id)
  * Scheduling: refuse generation while DuckDB is busy (queries preempt chat)
  * Prompt: schema summary only — no nested JSON sample dumps

Networking:
  * Local pack mode is offline by design: llama-server binds 127.0.0.1,
    loads a local GGUF, and chat is plain ``/v1/chat/completions`` with no
    tools / MCP / URL fetch. Hugging Face / GitHub downloads happen only in
    ``tools/fetch_assistant_pack.py`` (build/Fetch time), not at chat time.
  * API mode intentionally uses the configured base URL (may be remote).

The assistant pack is optional. When missing (and API mode is not selected),
status reports install instructions; chat returns a clear error. No
load/join/flatten behaviour is changed by this module.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Default model id shown in UI / pack docs (pack-default preference only).
# User-selected / sole GGUFs (incl. Phi-4-mini Q3_K_M) always win over this.
DEFAULT_MODEL_NAME = "Qwen3-4B-Instruct-2507"
DEFAULT_QUANT = "Q4_K_M"
# Discovery preference when no Settings preferred path is set:
# Qwen3-4B → Phi-4-mini → other 4B instruct → any *.gguf (7B, etc.).
DEFAULT_GGUF_GLOBS = (
    "Qwen3-4B-Instruct-2507*q4*.gguf",
    "Qwen3-4B*q4*.gguf",
    "Phi-4-mini*Instruct*Q3_K_M*.gguf",
    "Phi-4-mini*Q3_K_M*.gguf",
    "Phi-4-mini*.gguf",
    "phi-4-mini*q3*.gguf",
    "phi-4-mini*.gguf",
    "*phi*4*mini*q3*.gguf",
    "*4b*instruct*q4*.gguf",
    "*Q3_K_M*.gguf",
    "*.gguf",
)

ASSISTANT_MODE_LOCAL = "local"
ASSISTANT_MODE_API = "api"
ASSISTANT_API_SECRET_KEY = "assistant_api_key"

# Keep prompts small on ThinkPad-class machines.
_MAX_TABLES = 40
_MAX_COLS_PER_TABLE = 48
_MAX_PROMPT_CHARS = 12000

_lock = threading.RLock()
_proc = None  # type: ignore[var-annotated]
_proc_port = None  # type: ignore[var-annotated]
_proc_model = None  # type: ignore[var-annotated]  # GGUF path loaded by sidecar
_preferred_model_path = None  # type: ignore[var-annotated]  # None = pack default
# DuckDB memory_limit (MB) before we shed budget for a local model load.
_duckdb_mb_before_assist = None  # type: ignore[var-annotated]
_duck_engine_for_restore = None  # type: ignore[var-annotated]
# OpenAI-compatible API runtime (in-memory; key never logged).
_api_mode = ASSISTANT_MODE_LOCAL  # type: ignore[var-annotated]
_api_base_url = None  # type: ignore[var-annotated]
_api_model = None  # type: ignore[var-annotated]
_api_key = None  # type: ignore[var-annotated]
_cancel = threading.Event()
_generating = False


def _is_windows():
    return os.name == "nt" or sys.platform.startswith("win")


def _same_path(a, b):
    """True when two filesystem paths refer to the same location."""
    if not a or not b:
        return False
    try:
        return Path(a).resolve() == Path(b).resolve()
    except Exception:
        try:
            return os.path.normcase(os.path.abspath(str(a))) == os.path.normcase(
                os.path.abspath(str(b))
            )
        except Exception:
            return str(a) == str(b)


def _resolve_gguf(path):
    """Return a Path to an existing .gguf file, or None."""
    if not path:
        return None
    try:
        p = Path(str(path)).expanduser()
        if p.is_file() and p.suffix.lower() == ".gguf":
            return p
    except Exception:
        return None
    return None


def estimate_gguf_ram_mb(model_path) -> int:
    """Rough RSS for a Q4_K_M GGUF + llama-server + modest context.

    Weights ≈ on-disk size; add runtime/KV overhead. Scales with the file so
    4B (~2.5 GiB) and 7B (~4.7 GiB) get different budgets — not a flat size
    free-RAM gate.
    """
    try:
        size_b = int(Path(model_path).stat().st_size)
    except Exception:
        return 2048
    if size_b < 1024:
        return 2048
    # Ceil to MiB so small fixtures still scale; no artificial 256 MiB floor.
    size_mb = max(1, (size_b + 1024 * 1024 - 1) // (1024 * 1024))
    # ~5% mapping slack + fixed sidecar/context overhead
    return int(size_mb * 1.05 + 768)


def _os_reserve_mb(total_mb: float) -> int:
    """RAM to leave for OS + SamQL UI while a local model is loaded."""
    if not total_mb:
        return 2048
    return max(2048, int(float(total_mb) * 0.08))


def _duck_engine(session):
    try:
        db = getattr(session, "db", None)
        return getattr(db, "duck", None) if db is not None else None
    except Exception:
        return None


def plan_local_model_memory(session, model_path) -> dict:
    """Decide whether a GGUF fits and how much DuckDB budget to shed.

    Dynamically scales with machine RAM and the selected model size. When
    free RAM is tight but DuckDB's ``memory_limit`` is large, we recommend
    shrinking DuckDB temporarily so the assistant can load.
    """
    from . import resourcebudget

    snap = resourcebudget.snapshot()
    total_mb = float(snap.get("memory_total_mb") or 0)
    avail_mb = float(snap.get("memory_available_mb") or 0)
    need_mb = float(estimate_gguf_ram_mb(model_path))
    reserve_mb = float(_os_reserve_mb(total_mb))
    duck = _duck_engine(session)
    duck_mb = float(getattr(duck, "_applied_resource_memory_mb", 0) or 0) if duck else 0.0
    # Keep DuckDB usable for light work while the model is loaded.
    duck_floor = max(1024.0, total_mb * 0.12) if total_mb else 1024.0
    duck_target = None
    if total_mb and need_mb:
        # Leave model + OS reserve; remainder may stay with DuckDB.
        room_for_duck = max(duck_floor, total_mb - need_mb - reserve_mb)
        if duck_mb and room_for_duck + 64 < duck_mb:
            duck_target = int(room_for_duck)
    reclaimable = max(0.0, duck_mb - (duck_target or duck_mb)) if duck_target else 0.0
    # Shrinking memory_limit does not free RSS instantly — count part of it.
    effective_mb = avail_mb + reclaimable * 0.65
    machine_fits = (not total_mb) or (total_mb >= need_mb + reserve_mb * 0.5)
    # Accept if effective free covers most of the model, or machine is large
    # enough and we can shed DuckDB budget.
    can_run = bool(machine_fits) and (
        effective_mb >= need_mb * 0.55
        or (total_mb >= need_mb + reserve_mb and (duck_target is not None or avail_mb >= need_mb * 0.4))
    )
    # Very small free + no duck to shed + machine too small → refuse
    if total_mb and total_mb < need_mb * 0.85:
        can_run = False
        machine_fits = False
    return {
        "need_mb": round(need_mb, 1),
        "total_mb": round(total_mb, 1),
        "available_mb": round(avail_mb, 1),
        "effective_mb": round(effective_mb, 1),
        "reserve_mb": round(reserve_mb, 1),
        "duckdb_mb": round(duck_mb, 1),
        "duckdb_target_mb": duck_target,
        "machine_fits": machine_fits,
        "can_run": can_run,
        "model": str(model_path) if model_path else None,
    }


def _loaded_duckdb_table_names(session) -> list:
    """Names of currently loaded DuckDB tables (catalog only — never mutated)."""
    names = []
    try:
        tree = session.tables_tree() if session is not None else []
    except Exception:
        tree = []
    for t in tree or []:
        if not isinstance(t, dict):
            continue
        if t.get("remote"):
            continue
        eng = str(t.get("engine") or "").lower()
        if eng and eng not in ("duckdb", "duck"):
            continue
        name = str(t.get("name") or "").strip()
        if name:
            names.append(name)
    return names


def prepare_memory_for_model(session, model_path) -> dict:
    """Lower DuckDB ``memory_limit`` when needed so a local GGUF can load.

    **Never drops, unregisters, or truncates loaded tables.** The only engine
    mutation is ``SET memory_limit = …`` via ``apply_resource_memory_mb``.
    We do **not** call ``Session.free_memory``, ``drop_table``, ``clearAll``,
    or any catalog wipe. Table names are snapshotted before/after as a
    safety check.
    """
    global _duckdb_mb_before_assist, _duck_engine_for_restore
    plan = plan_local_model_memory(session, model_path)
    duck = _duck_engine(session)
    target = plan.get("duckdb_target_mb")
    tables_before = _loaded_duckdb_table_names(session)
    # Shed whenever DuckDB is oversized relative to the model — even if the
    # pre-shed plan said can_run (free RAM may still be fragmented).
    if duck is not None and target:
        before = int(getattr(duck, "_applied_resource_memory_mb", 0) or 0)
        if before and target < before:
            if _duckdb_mb_before_assist is None:
                _duckdb_mb_before_assist = before
            _duck_engine_for_restore = duck
            try:
                # Ceiling only — must not drop views/tables.
                duck.apply_resource_memory_mb(
                    int(target), allow_decrease=True, wait=False
                )
            except Exception:
                pass
            plan = plan_local_model_memory(session, model_path)
            plan["duckdb_shed_mb"] = before - int(
                getattr(duck, "_applied_resource_memory_mb", 0) or target
            )
    tables_after = _loaded_duckdb_table_names(session)
    plan["tables_preserved"] = sorted(tables_before) == sorted(tables_after)
    plan["tables_before"] = list(tables_before)
    if tables_before and sorted(tables_before) != sorted(tables_after):
        # Should be unreachable — refuse the assist path rather than continue
        # if catalog membership somehow changed.
        plan["can_run"] = False
        plan["tables_lost"] = sorted(set(tables_before) - set(tables_after))
        return plan
    # Re-evaluate after shed: machine large enough + effective free.
    if plan.get("machine_fits") and (
        float(plan.get("effective_mb") or 0) >= float(plan.get("need_mb") or 0) * 0.5
        or float(plan.get("available_mb") or 0) >= float(plan.get("need_mb") or 0) * 0.4
        or (
            float(plan.get("total_mb") or 0)
            >= float(plan.get("need_mb") or 0) + float(plan.get("reserve_mb") or 0)
        )
    ):
        plan["can_run"] = True
    return plan


def restore_duckdb_memory_after_assist(session=None) -> dict:
    """Restore DuckDB memory_limit after the local model sidecar stops."""
    global _duckdb_mb_before_assist, _duck_engine_for_restore
    before = _duckdb_mb_before_assist
    duck = _duck_engine(session) or _duck_engine_for_restore
    _duckdb_mb_before_assist = None
    _duck_engine_for_restore = None
    if not before:
        return {"restored": False, "reason": "no_prior"}
    if duck is None:
        return {"restored": False, "reason": "no_duck", "prior_mb": before}
    try:
        ok = duck.apply_resource_memory_mb(
            int(before), allow_decrease=False, wait=False
        )
        return {"restored": bool(ok), "prior_mb": before}
    except Exception as exc:
        return {"restored": False, "reason": str(exc), "prior_mb": before}


def set_preferred_model(path):
    """Prefer this GGUF when starting llama-server (None = pack default)."""
    global _preferred_model_path
    resolved = _resolve_gguf(path)
    # Keep the requested path even if missing so status can report it;
    # find_pack falls back to pack discovery when the file is absent.
    value = None
    if path is not None and str(path).strip():
        try:
            value = str(Path(str(path).strip()).expanduser())
            if resolved is not None:
                value = str(resolved.resolve())
        except Exception:
            value = str(path).strip()
    with _lock:
        prev = _preferred_model_path
        _preferred_model_path = value
    return {
        "preferred_model": _preferred_model_path,
        "exists": resolved is not None,
        "changed": prev != _preferred_model_path,
    }


def get_preferred_model():
    with _lock:
        return _preferred_model_path


def normalize_api_base(url):
    """Strip trailing slash and optional ``/v1`` so callers can append paths."""
    u = str(url or "").strip()
    if not u:
        return ""
    u = u.rstrip("/")
    if u.lower().endswith("/v1"):
        u = u[:-3].rstrip("/")
    return u


def set_api_runtime(mode=None, base_url=None, model=None, api_key=None,
                    clear_api_key=False, update_key=False):
    """Push Settings API config into module memory (key never logged)."""
    global _api_mode, _api_base_url, _api_model, _api_key
    with _lock:
        if mode is not None:
            m = str(mode or "").strip().lower()
            if m not in (ASSISTANT_MODE_LOCAL, ASSISTANT_MODE_API):
                m = ASSISTANT_MODE_LOCAL
            _api_mode = m
        if base_url is not None:
            _api_base_url = normalize_api_base(base_url) or None
        if model is not None:
            mid = str(model or "").strip()
            _api_model = mid or None
        if clear_api_key:
            _api_key = None
        elif update_key:
            key = str(api_key or "").strip()
            _api_key = key or None
    return get_api_runtime()


def get_api_runtime():
    """Redacted snapshot of in-memory API runtime (never includes the key)."""
    with _lock:
        return {
            "mode": _api_mode or ASSISTANT_MODE_LOCAL,
            "base_url": _api_base_url,
            "model": _api_model,
            "has_api_key": bool(_api_key),
        }


def api_mode_active():
    with _lock:
        return (_api_mode or ASSISTANT_MODE_LOCAL) == ASSISTANT_MODE_API


def _api_chat_url(base=None):
    root = normalize_api_base(base if base is not None else _api_base_url)
    if not root:
        return None
    return root.rstrip("/") + "/v1/chat/completions"


def _api_models_url(base=None):
    root = normalize_api_base(base if base is not None else _api_base_url)
    if not root:
        return None
    return root.rstrip("/") + "/v1/models"


def _api_auth_headers(api_key=None):
    key = api_key if api_key is not None else _api_key
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if key:
        headers["Authorization"] = "Bearer %s" % key
    return headers


def probe_api(base_url=None, api_key=None, model=None, timeout=12.0):
    """Test an OpenAI-compatible endpoint (models list, else tiny chat).

    Does not log credentials. Returns ``{ok, …}`` for the Settings UI.
    """
    base = normalize_api_base(base_url if base_url is not None else _api_base_url)
    if not base:
        return {
            "ok": False,
            "error": "Base URL is required (OpenAI-compatible /v1 endpoint).",
        }
    key = api_key if api_key is not None else _api_key
    mid = (model if model is not None else _api_model) or "samql"
    headers = _api_auth_headers(key)
    models_url = base.rstrip("/") + "/v1/models"
    try:
        req = urllib.request.Request(models_url, headers=headers, method="GET")
        with _urlopen(req, timeout=float(timeout)) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            status_code = getattr(resp, "status", 200)
        if 200 <= status_code < 300:
            data = json.loads(body) if body else {}
            ids = []
            for item in (data.get("data") or []):
                if isinstance(item, dict) and item.get("id"):
                    ids.append(str(item["id"]))
            return {
                "ok": True,
                "probe": "models",
                "base_url": base,
                "model_ids": ids[:40],
                "status_code": status_code,
            }
    except Exception as e:
        models_err = err_str(e)
    else:
        models_err = "models endpoint returned non-success"

    # Fallback: minimal chat completions (some gateways omit /v1/models).
    chat_url = base.rstrip("/") + "/v1/chat/completions"
    payload = {
        "model": mid,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "temperature": 0,
        "stream": False,
    }
    try:
        data = _http_json(chat_url, payload, timeout=float(timeout), headers=headers)
        return {
            "ok": True,
            "probe": "chat",
            "base_url": base,
            "model": mid,
            "has_choices": bool(data.get("choices")),
        }
    except Exception as e:
        return {
            "ok": False,
            "error": "API probe failed: %s (models: %s)" % (err_str(e), models_err),
            "base_url": base,
        }


def _display_model_name(model_path, using_default=False):
    """Human-facing model label derived from the GGUF actually chosen.

    Always follows ``model_path`` when present so pack-default discovery of a
    sole non-default file (e.g. a 7B GGUF) is never mislabeled as
    ``DEFAULT_MODEL_NAME``. ``using_default`` is kept for call-site
    compatibility and does not affect the label.
    """
    _ = using_default
    if not model_path:
        return DEFAULT_MODEL_NAME
    try:
        name = Path(str(model_path)).name
    except Exception:
        name = str(model_path).strip()
    if not name:
        return DEFAULT_MODEL_NAME
    if name.lower().endswith(".gguf"):
        name = name[:-5]
    return name


def _discover_gguf(search_dirs):
    """Pick a pack GGUF under search_dirs.

    Preference order (via DEFAULT_GGUF_GLOBS): Qwen3-4B, then Phi-4-mini,
    then other instruct patterns, then any ``*.gguf``. A sole Phi (or any
    single GGUF) is always selected; Settings preferred path bypasses this.
    """
    for d in search_dirs:
        for pattern in DEFAULT_GGUF_GLOBS:
            try:
                hits = sorted(d.glob(pattern))
            except Exception:
                hits = []
            for hit in hits:
                if hit.is_file() and hit.suffix.lower() == ".gguf":
                    return hit
    return None


def _user_model_dirs(pack_base=None):
    """Install-root ``Model/`` folders for user-dropped GGUFs.

    Packaged AppWindow layouts that omit a bundled GGUF ship an empty
    ``Model/`` next to ``_internal`` / ``frontend_dist`` (sibling of
    ``assistant/``). Repo-dev fetch still writes ``assistant/models/``;
    lean/runtime recipients drop a ``.gguf`` into ``Model/``.
    """
    dirs = []
    if pack_base is not None:
        try:
            base = Path(pack_base)
            # assistant/ -> sibling Model/; also accept Model inside a
            # mis-copied tree next to the pack root.
            dirs.append(base.parent / "Model")
            dirs.append(base / "Model")
        except Exception:
            pass
    try:
        me = Path(sys.executable).resolve().parent
        dirs.append(me / "Model")
    except Exception:
        pass
    try:
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            # onedir: _MEIPASS is .../_internal; Model sits beside it.
            dirs.append(Path(meipass).parent / "Model")
    except Exception:
        pass
    try:
        here = Path(__file__).resolve()
        # backend/samql_core/assistant.py → repo root
        dirs.append(here.parents[2] / "Model")
    except Exception:
        pass
    try:
        dirs.append(Path.cwd() / "Model")
    except Exception:
        pass
    out, seen = [], set()
    for d in dirs:
        try:
            key = str(d.resolve())
        except Exception:
            key = str(d)
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    return out


def _candidate_roots():
    """Places to look for the offline assistant pack."""
    roots = []
    env = (os.environ.get("SAMQL_ASSISTANT_DIR") or "").strip()
    if env:
        roots.append(Path(env))
    # PyInstaller embed (mode 3): pack lives under sys._MEIPASS/assistant.
    try:
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            roots.append(Path(meipass) / "assistant")
    except Exception:
        pass
    # Next to the running process (PyInstaller onedir / post-build mode 2 /
    # source checkout).
    try:
        me = Path(sys.executable).resolve().parent
        roots.append(me / "assistant")
        roots.append(me.parent / "assistant")
    except Exception:
        pass
    try:
        here = Path(__file__).resolve()
        # backend/samql_core/assistant.py → repo root
        roots.append(here.parents[2] / "assistant")
        roots.append(here.parents[1] / "assistant")
    except Exception:
        pass
    try:
        roots.append(Path.cwd() / "assistant")
    except Exception:
        pass
    # Deduplicate while preserving order.
    out, seen = [], set()
    for r in roots:
        try:
            key = str(r.resolve())
        except Exception:
            key = str(r)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _llama_binary_name():
    return "llama-server.exe" if _is_windows() else "llama-server"


def find_pack(root=None, preferred_model=None):
    """Locate llama-server + a GGUF model. Returns a status dict.

    When ``preferred_model`` (or the module preferred path) points at an
    existing ``.gguf``, that file is used instead of pack-default discovery.
    Missing preferred paths fall back to DEFAULT_GGUF_GLOBS under the pack.
    """
    if preferred_model is None:
        preferred_model = get_preferred_model()
    pref = _resolve_gguf(preferred_model)
    preferred_missing = bool(
        preferred_model and str(preferred_model).strip() and pref is None
    )
    roots = [Path(root)] if root else _candidate_roots()
    bin_name = _llama_binary_name()
    for base in roots:
        try:
            if not base.is_dir():
                continue
        except Exception:
            continue
        # Prefer assistant/runtime/ (full llama.cpp release payload with libs).
        # Fall back to a flat assistant/llama-server for older manual packs.
        binary = None
        for candidate in (base / "runtime" / bin_name, base / bin_name):
            if candidate.is_file():
                binary = candidate
                break
        if binary is None and not _is_windows():
            alt = base / "runtime" / "llama-server"
            if not alt.is_file():
                alt = base / "llama-server"
            if alt.is_file():
                binary = alt
        models_dir = base / "models"
        # Resolution order for pack-default discovery (preferred path wins
        # separately via Settings): assistant/models/ (bundled) → install
        # Model/ (user drop-in) → flat files under the pack root.
        search_dirs = []
        if models_dir.is_dir():
            search_dirs.append(models_dir)
        for ud in _user_model_dirs(base):
            try:
                if ud.is_dir() and ud not in search_dirs:
                    search_dirs.append(ud)
            except Exception:
                continue
        search_dirs.append(base)
        default_model = _discover_gguf(search_dirs)
        # Preferred GGUF wins when present; otherwise pack default discovery.
        if pref is not None:
            model = pref
            using_default = False
        else:
            model = default_model
            using_default = True
        model_name = _display_model_name(
            str(model) if model is not None else None, using_default
        )
        if binary is not None and binary.is_file() and model is not None:
            out = {
                "ok": True,
                "root": str(base),
                "binary": str(binary),
                "model": str(model),
                "model_name": model_name,
                "quant": DEFAULT_QUANT if using_default else None,
                "using_default": using_default,
                "preferred_model": (
                    str(preferred_model).strip() if preferred_model else None
                ),
                "preferred_missing": preferred_missing,
                "default_model": str(default_model) if default_model else None,
            }
            return out
        if binary is not None and binary.is_file() and model is None:
            return {
                "ok": False,
                "root": str(base),
                "binary": str(binary),
                "model": None,
                "reason": "model_missing",
                "using_default": True,
                "preferred_model": (
                    str(preferred_model).strip() if preferred_model else None
                ),
                "preferred_missing": preferred_missing,
                "hint": (
                    "Place a .gguf (Qwen3-4B Instruct Q4_K_M or "
                    "Phi-4-mini Instruct Q3_K_M) under assistant/models/ "
                    "or the install-root Model/ folder "
                    "(or run tools/fetch_assistant_pack.py)."
                ),
            }
        if model is not None and (binary is None or not binary.is_file()):
            # Preferred GGUF may live outside this pack root — keep looking
            # for llama-server under later candidate roots.
            if pref is not None:
                continue
            return {
                "ok": False,
                "root": str(base),
                "binary": None,
                "model": str(model),
                "model_name": model_name,
                "reason": "binary_missing",
                "using_default": using_default,
                "preferred_model": (
                    str(preferred_model).strip() if preferred_model else None
                ),
                "preferred_missing": preferred_missing,
                "hint": (
                    "Place llama-server%s under assistant/runtime/ "
                    "(or run tools/fetch_assistant_pack.py / "
                    "Fetch-SamQL-Assistant.ps1)."
                    % (".exe" if _is_windows() else "")
                ),
            }
    # Preferred GGUF alone is not enough without llama-server binary.
    if pref is not None:
        return {
            "ok": False,
            "root": None,
            "binary": None,
            "model": str(pref),
            "model_name": _display_model_name(str(pref), False),
            "reason": "binary_missing",
            "using_default": False,
            "preferred_model": str(pref),
            "preferred_missing": False,
            "hint": (
                "Place llama-server%s under assistant/runtime/ "
                "(or run tools/fetch_assistant_pack.py / "
                "Fetch-SamQL-Assistant.ps1)."
                % (".exe" if _is_windows() else "")
            ),
        }
    return {
        "ok": False,
        "root": None,
        "binary": None,
        "model": None,
        "reason": "pack_missing",
        "using_default": True,
        "preferred_model": (
            str(preferred_model).strip() if preferred_model else None
        ),
        "preferred_missing": preferred_missing,
        "hint": (
            "Run tools/fetch_assistant_pack.py (or Fetch-SamQL-Assistant.ps1) "
            "on a machine that can download, then copy ./assistant/ next to "
            "SamQL. See assistant/README.txt."
        ),
    }


def _quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def schema_prompt(tables, dialect="native"):
    """Build a compact schema-only system/user preamble.

    ``tables`` is the Session.tables_tree() shape (list of dicts). Never
    include sample row payloads or Field Explorer trees.
    """
    dialect = "spark" if str(dialect).lower() == "spark" else "duckdb"
    dialect_label = "Spark SQL" if dialect == "spark" else "DuckDB SQL"
    lines = []
    n_tables = 0
    for t in tables or []:
        if not isinstance(t, dict):
            continue
        if t.get("remote"):
            continue  # skip remote catalog stubs for v1
        name = str(t.get("name") or "").strip()
        if not name:
            continue
        n_tables += 1
        if n_tables > _MAX_TABLES:
            lines.append("-- … additional tables omitted …")
            break
        eng = str(t.get("engine") or "")
        cols = t.get("columns") or []
        col_bits = []
        for i, c in enumerate(cols):
            if i >= _MAX_COLS_PER_TABLE:
                col_bits.append("…")
                break
            if isinstance(c, dict):
                cname = str(c.get("name") or "")
                ctype = str(c.get("type") or "")
                hint = str(c.get("hint") or "").strip()
                bit = "%s %s" % (cname, ctype)
                if hint:
                    bit += " /* %s */" % hint[:80]
                col_bits.append(bit)
            else:
                col_bits.append(str(c))
        lines.append(
            "TABLE %s (%s) -- engine=%s"
            % (_quote_ident(name), ", ".join(col_bits) or "/* no columns */", eng)
        )
    schema_block = "\n".join(lines) if lines else "(no local tables loaded)"
    if dialect == "spark":
        dialect_rules = (
            "Write Spark SQL only (not MySQL/Postgres/T-SQL). Prefer "
            "Spark-compatible functions; avoid DuckDB-only helpers."
        )
    else:
        dialect_rules = (
            "Write DuckDB SQL only (not MySQL, Postgres, SQLite, or T-SQL). "
            "Prefer DuckDB functions and idioms: json_extract / "
            "json_extract_string, UNNEST, list_extract, struct_extract, "
            "read_json_auto / read_csv_auto when relevant, TRY_CAST, "
            "QUALIFY, EXCLUDE / REPLACE in SELECT. Do not invent "
            "Postgres operators (e.g. #>, jsonb_*) or MySQL-only functions."
        )
    system = (
        "You are SamQL's SQL assistant. Convert English requests into "
        "%s. %s Use only the provided tables/columns. Prefer simple, "
        "runnable queries. For nested JSON columns, follow the query hints "
        "when present. Do not invent tables. "
        "Reply with a short explanation, then a single fenced sql code block."
        % (dialect_label, dialect_rules)
    )
    return {
        "system": system,
        "schema": schema_block,
        "dialect": dialect,
        "dialect_label": dialect_label,
    }


def build_messages(tables, question, dialect="native"):
    meta = schema_prompt(tables, dialect=dialect)
    user = (
        "Dialect: %s\n\nLoaded schema:\n%s\n\nQuestion:\n%s"
        % (meta["dialect_label"], meta["schema"], str(question or "").strip())
    )
    if len(user) > _MAX_PROMPT_CHARS:
        user = user[: _MAX_PROMPT_CHARS - 20] + "\n…[truncated]…"
    return [
        {"role": "system", "content": meta["system"]},
        {"role": "user", "content": user},
    ], meta


def extract_sql(text):
    """Pull the first fenced sql/sqlite/duckdb block, else best-effort body."""
    raw = str(text or "")
    lower = raw.lower()
    for tag in ("```sql", "```duckdb", "```spark", "```sparksql", "```"):
        start = lower.find(tag)
        if start < 0:
            continue
        after = start + len(tag)
        # skip optional language token newline already handled by tag match
        end = lower.find("```", after)
        if end < 0:
            body = raw[after:].strip()
        else:
            body = raw[after:end].strip()
        # drop a leading language word if ``` alone was used with sql\n
        if body.lower().startswith(("sql\n", "duckdb\n", "spark\n", "sparksql\n")):
            body = body.split("\n", 1)[1].strip()
        if body:
            return body
    # Fallback: lines that look like SQL.
    keep = []
    for line in raw.splitlines():
        s = line.strip()
        if not s:
            if keep:
                keep.append("")
            continue
        if keep or s.upper().startswith(
            ("SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "CREATE",
             "DESCRIBE", "SHOW", "EXPLAIN", "COPY", "FROM", "PIVOT")
        ):
            keep.append(line.rstrip())
    return "\n".join(keep).strip()


def duckdb_busy(session):
    """True when DuckDB holds its write lock or has in-flight statements."""
    if session is None:
        return False
    try:
        st = session.status() or {}
        eng = (st.get("engines") or {}).get("duckdb") or {}
        if eng.get("busy"):
            return True
    except Exception:
        pass
    # Also treat any registered running query targeting duckdb as busy.
    try:
        with session._running_lock:
            running = list(getattr(session, "_running", {}).values())
        for eng in running:
            kind = getattr(eng, "ENGINE_KIND", None) or getattr(eng, "kind", None)
            if kind == "duckdb" or eng is getattr(session, "duckdb", None):
                return True
    except Exception:
        pass
    return False


def _free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])
    finally:
        try:
            s.close()
        except Exception:
            pass


def _is_loopback_url(url):
    """True when *url* targets loopback (local offline sidecar / local API)."""
    u = str(url or "").strip()
    if not u:
        return False
    try:
        parsed = urllib.parse.urlparse(u if "://" in u else "http://" + u)
        host = (parsed.hostname or "").lower()
    except Exception:
        return False
    return host in ("127.0.0.1", "localhost", "::1")


def _validate_local_llama_url(url):
    """Require loopback for local-mode external llama-server URLs."""
    u = str(url or "").strip().rstrip("/")
    if not u:
        return None
    if not _is_loopback_url(u):
        raise RuntimeError(
            "SAMQL_LLAMA_URL must be a loopback URL "
            "(http://127.0.0.1:PORT or http://localhost:PORT) for local "
            "offline mode. Use Settings → SQL assistant → API for remote "
            "OpenAI-compatible endpoints."
        )
    return u


def _llama_base_url():
    """Return the local sidecar base URL, or None.

    Does not raise on a mis-set ``SAMQL_LLAMA_URL`` (status UI); 
    :func:`ensure_server` enforces loopback before chat.
    """
    env = (os.environ.get("SAMQL_LLAMA_URL") or "").strip().rstrip("/")
    if env:
        return env
    with _lock:
        if _proc_port:
            return "http://127.0.0.1:%d" % _proc_port
    return None


# Env keys that can make llama-server download models, enable agent tools,
# or turn on the WebUI MCP CORS proxy. Cleared in the child process so a
# parent shell cannot re-enable outbound/agent features at runtime.
_LLAMA_CHILD_ENV_CLEAR = (
    "LLAMA_ARG_HF_REPO",
    "LLAMA_ARG_HF_FILE",
    "LLAMA_ARG_HF_REPO_V",
    "LLAMA_ARG_HF_FILE_V",
    "LLAMA_ARG_MODEL_URL",
    "LLAMA_ARG_DOCKER_REPO",
    "LLAMA_ARG_TOOLS",
    "LLAMA_ARG_AGENT",
    "LLAMA_ARG_UI_MCP_PROXY",
    "LLAMA_ARG_WEBUI_MCP_PROXY",
)


def _llama_server_child_env(base_env=None):
    """Environment for the bundled llama-server: offline, no agent/tools/HF.

    Does not mutate the parent SamQL process environment.
    """
    env = dict(os.environ if base_env is None else base_env)
    for key in _LLAMA_CHILD_ENV_CLEAR:
        env.pop(key, None)
    # Prefer explicit offline + no WebUI even if the binary ignores unknown
    # CLI flags on very old builds (fetch pulls current llama.cpp releases).
    env["LLAMA_ARG_OFFLINE"] = "1"
    env["LLAMA_ARG_UI"] = "0"
    env["LLAMA_ARG_WEBUI"] = "0"
    return env


def _llama_server_cmd(binary, model, port, ctx):
    """Args for a local, offline-only llama-server sidecar.

    No ``--hf-*`` / ``--model-url`` / ``--tools`` / ``--agent`` /
    ``--ui-mcp-proxy``. Chat from SamQL never passes tool schemas.
    """
    return [
        str(binary),
        "-m", str(model),
        "--host", "127.0.0.1",
        "--port", str(port),
        "-c", str(ctx),
        "-ngl", "0",  # CPU-only for ThinkPad / locked GPUs
        "--offline",  # block HF / model-url network inside llama-server
        "--no-webui",  # no browser UI / MCP host surface
    ]


def _chat_completion_payload(model_id, messages, *, max_tokens=800):
    """OpenAI chat body for the SQL assistant — never includes tools."""
    return {
        "model": model_id,
        "messages": messages,
        "temperature": 0.1,
        "max_tokens": int(max_tokens),
        "stream": False,
    }


def _urlopen(req, timeout):
    """urllib open; disable HTTP(S)_PROXY for loopback (local pack path)."""
    url = getattr(req, "full_url", None) or req.get_full_url()
    if _is_loopback_url(url):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        return opener.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


def _http_json(url, payload, timeout=120.0, headers=None):
    data = json.dumps(payload).encode("utf-8")
    hdrs = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(
        url,
        data=data,
        headers=hdrs,
        method="POST",
    )
    with _urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return json.loads(body) if body else {}


def _wait_ready(base, timeout=45.0):
    deadline = time.time() + timeout
    health = base.rstrip("/") + "/health"
    while time.time() < deadline:
        if _cancel.is_set():
            return False
        try:
            req = urllib.request.Request(health, method="GET")
            with _urlopen(req, timeout=1.5) as resp:
                if 200 <= getattr(resp, "status", 200) < 500:
                    return True
        except Exception:
            pass
        # Some builds expose only /v1/models
        try:
            req = urllib.request.Request(base.rstrip("/") + "/v1/models", method="GET")
            with _urlopen(req, timeout=1.5) as resp:
                if 200 <= getattr(resp, "status", 200) < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def ensure_server(pack=None):
    """Start bundled llama-server if needed. Returns base URL or raises.

    If the sidecar is already running a different GGUF than the current
    preference / pack discovery, it is stopped and restarted with the
    desired model. External ``SAMQL_LLAMA_URL`` servers are left alone.
    """
    global _proc, _proc_port, _proc_model
    env_url = (os.environ.get("SAMQL_LLAMA_URL") or "").strip()
    if env_url:
        # Local mode may only talk to a loopback llama-server.
        return _validate_local_llama_url(env_url)
    pack = pack or find_pack()
    if not pack.get("ok"):
        raise RuntimeError(pack.get("hint") or "Assistant pack not available.")
    desired = pack.get("model")
    with _lock:
        if (
            _proc is not None
            and _proc.poll() is None
            and _proc_port
            and desired
            and _proc_model
            and _same_path(_proc_model, desired)
        ):
            return "http://127.0.0.1:%d" % _proc_port
    # Dead process, first start, or model mismatch — (re)start.
    stop_server()
    with _lock:
        if (
            _proc is not None
            and _proc.poll() is None
            and _proc_port
            and desired
            and _proc_model
            and _same_path(_proc_model, desired)
        ):
            return "http://127.0.0.1:%d" % _proc_port
        port = _free_port()
        # Scale context with free RAM so large GGUFs leave room for weights.
        ctx = 4096
        try:
            from . import resourcebudget
            avail = float(resourcebudget.snapshot().get("memory_available_mb") or 0)
            need = float(estimate_gguf_ram_mb(pack.get("model")))
            if avail and need and avail < need + 2048:
                ctx = 2048
            if avail and need and avail < need + 512:
                ctx = 1024
        except Exception:
            pass
        # Chat template: leave unset so llama-server uses the template
        # embedded in the GGUF (Qwen, Phi-4-mini, etc.). Do NOT pass
        # --chat-template / --jinja overrides that assume one family.
        # Offline hardening: --offline / --no-webui + scrubbed child env
        # (no HF download args, no --tools / --agent / MCP proxy).
        cmd = _llama_server_cmd(pack["binary"], pack["model"], port, ctx)
        creationflags = 0
        if _is_windows():
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        # Run with cwd = binary dir so companion DLLs/.so resolve.
        bin_dir = str(Path(pack["binary"]).resolve().parent)
        _proc = subprocess.Popen(
            cmd,
            cwd=bin_dir,
            env=_llama_server_child_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        _proc_port = port
        _proc_model = desired
    base = "http://127.0.0.1:%d" % port
    if not _wait_ready(base):
        stop_server()
        raise RuntimeError(
            "llama-server failed to become ready. Check the assistant pack "
            "binary and GGUF model."
        )
    return base


def stop_server(session=None):
    global _proc, _proc_port, _proc_model
    with _lock:
        proc, _proc = _proc, None
        _proc_port = None
        _proc_model = None
    if proc is None:
        restore_duckdb_memory_after_assist(session)
        return
    try:
        proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    restore_duckdb_memory_after_assist(session)


def sync_server_model():
    """Stop llama-server when its loaded GGUF no longer matches preference.

    Does not start the sidecar (next chat / ensure_server does). Safe while
    DuckDB is busy — only touches the assistant process.
    """
    if (os.environ.get("SAMQL_LLAMA_URL") or "").strip():
        return {"stopped": False, "reason": "external_url"}
    pack = find_pack()
    desired = pack.get("model") if pack.get("ok") else None
    with _lock:
        running = _proc is not None and _proc.poll() is None
        current = _proc_model
    if not running:
        return {"stopped": False, "reason": "not_running"}
    if desired and current and _same_path(current, desired):
        return {"stopped": False, "reason": "already_matched"}
    stop_server()
    return {
        "stopped": True,
        "reason": "model_changed",
        "desired": desired,
        "previous": current,
    }


def status(session=None):
    """UI-facing assistant status snapshot."""
    pack = find_pack()
    busy = duckdb_busy(session)
    mem = {}
    try:
        from . import resourcebudget
        snap = resourcebudget.snapshot()
        mem = {
            "memory_total_mb": snap.get("memory_total_mb"),
            "memory_available_mb": snap.get("memory_available_mb"),
        }
    except Exception:
        pass
    using_default = bool(pack.get("using_default", True))
    # Prefer the sidecar's loaded GGUF when it is running; otherwise the pack
    # selection. Always derive the label from that path (never hardcode 4B).
    loaded_model = None
    with _lock:
        if _proc is not None and _proc.poll() is None and _proc_model:
            loaded_model = _proc_model
    display_model = loaded_model or pack.get("model")
    model_name = _display_model_name(display_model, using_default) if display_model else (
        pack.get("model_name") or DEFAULT_MODEL_NAME
    )
    api = get_api_runtime()
    mode = api.get("mode") or ASSISTANT_MODE_LOCAL
    api_configured = bool(api.get("base_url"))
    if mode == ASSISTANT_MODE_API:
        available = api_configured
        reason = None
        hint = None
        if not api_configured:
            reason = "api_not_configured"
            hint = (
                "Configure an OpenAI-compatible base URL under "
                "Settings → SQL assistant → API."
            )
        model_name = api.get("model") or "API model"
        return {
            "enabled": True,
            "mode": ASSISTANT_MODE_API,
            "available": available,
            "pack_ok": bool(pack.get("ok")),
            "reason": reason,
            "hint": hint,
            "root": pack.get("root"),
            "model": api.get("model"),
            "model_name": model_name,
            "quant": None,
            "using_default": False,
            "preferred_model": pack.get("preferred_model") or get_preferred_model(),
            "preferred_missing": bool(pack.get("preferred_missing")),
            "default_model": pack.get("default_model"),
            "duckdb_busy": busy,
            "generating": bool(_generating),
            "server_url": api.get("base_url"),
            "memory": mem,
            "refuse_low_memory": False,
            "memory_plan": None,
            "api": {
                "base_url": api.get("base_url"),
                "model": api.get("model"),
                "has_api_key": bool(api.get("has_api_key")),
                "configured": api_configured,
            },
        }
    # Model-aware RAM plan (replaces the old flat 1.5 GiB free gate).
    plan = None
    refuse_ram = False
    if pack.get("ok") and pack.get("model"):
        try:
            plan = plan_local_model_memory(session, pack.get("model"))
            refuse_ram = not bool(plan.get("can_run"))
            mem = {
                **mem,
                "model_need_mb": plan.get("need_mb"),
                "effective_mb": plan.get("effective_mb"),
                "duckdb_mb": plan.get("duckdb_mb"),
                "duckdb_target_mb": plan.get("duckdb_target_mb"),
            }
        except Exception:
            plan = None
            refuse_ram = False
    return {
        "enabled": True,
        "mode": ASSISTANT_MODE_LOCAL,
        "available": bool(pack.get("ok")) and not refuse_ram,
        "pack_ok": bool(pack.get("ok")),
        "reason": None if pack.get("ok") else pack.get("reason"),
        "hint": pack.get("hint"),
        "root": pack.get("root"),
        "model": display_model or pack.get("model"),
        "model_name": model_name,
        "quant": pack.get("quant") if pack.get("quant") is not None else (
            DEFAULT_QUANT if using_default else None
        ),
        "using_default": using_default,
        "preferred_model": pack.get("preferred_model") or get_preferred_model(),
        "preferred_missing": bool(pack.get("preferred_missing")),
        "default_model": pack.get("default_model"),
        "duckdb_busy": busy,
        "generating": bool(_generating),
        "server_url": _llama_base_url(),
        "memory": mem,
        "refuse_low_memory": refuse_ram,
        "memory_plan": plan,
        "api": {
            "base_url": api.get("base_url"),
            "model": api.get("model"),
            "has_api_key": bool(api.get("has_api_key")),
            "configured": api_configured,
        },
    }


def cancel():
    """Cooperative cancel for an in-flight chat generation."""
    _cancel.set()
    return {"ok": True}


def _parse_chat_completion(data):
    choices = data.get("choices") or []
    text = ""
    if choices and isinstance(choices[0], dict):
        msg = choices[0].get("message") or {}
        text = str(msg.get("content") or choices[0].get("text") or "")
    if not text:
        text = str(data.get("content") or "")
    return text


def chat(session, question, dialect="native", timeout_s=180.0):
    """Generate SQL help. Refuses when DuckDB is busy or pack/RAM/API missing."""
    global _generating
    q = str(question or "").strip()
    if not q:
        return {"ok": False, "error": "Ask a question about your tables."}

    st = status(session)
    use_api = (st.get("mode") or ASSISTANT_MODE_LOCAL) == ASSISTANT_MODE_API

    if use_api:
        if not (st.get("api") or {}).get("configured") and not get_api_runtime().get(
            "base_url"
        ):
            return {
                "ok": False,
                "error": st.get("hint") or (
                    "API mode selected but no base URL is configured."
                ),
                "status": st,
            }
    else:
        if not st.get("pack_ok"):
            return {
                "ok": False,
                "error": st.get("hint") or "Assistant pack not installed.",
                "status": st,
            }
    if duckdb_busy(session):
        return {
            "ok": False,
            "error": (
                "DuckDB is busy. The assistant only runs while the engine "
                "is idle — finish or cancel the current query/load, then retry."
            ),
            "status": status(session),
            "queued_reason": "duckdb_busy",
        }

    # Local models: shed DuckDB budget dynamically, then re-check (model-sized).
    if not use_api:
        model_path = st.get("model")
        if not model_path:
            pack_now = find_pack()
            model_path = pack_now.get("model") if pack_now.get("ok") else None
        plan = prepare_memory_for_model(session, model_path) if model_path else {
            "can_run": False
        }
        st = status(session)
        if not plan.get("can_run"):
            need = plan.get("need_mb") or st.get("memory", {}).get("model_need_mb")
            total = plan.get("total_mb") or st.get("memory", {}).get("memory_total_mb")
            avail = plan.get("available_mb") or st.get("memory", {}).get(
                "memory_available_mb"
            )
            return {
                "ok": False,
                "error": (
                    "Not enough RAM for this local model right now "
                    "(needs ~%.0f MiB; machine %.0f MiB total, %.0f MiB free). "
                    "SamQL tried to shrink DuckDB's budget to make room. "
                    "Close other apps, pick a smaller GGUF in Settings → SQL "
                    "assistant, or free loaded tables."
                    % (
                        float(need or 0),
                        float(total or 0),
                        float(avail or 0),
                    )
                ),
                "status": st,
                "memory_plan": plan,
            }

    tables = []
    try:
        tables = session.tables_tree() if session is not None else []
    except Exception:
        tables = []
    messages, meta = build_messages(tables, q, dialect=dialect)

    _cancel.clear()
    _generating = True
    try:
        # Re-check busy immediately before starting the sidecar / request.
        if duckdb_busy(session):
            return {
                "ok": False,
                "error": "DuckDB became busy before generation started.",
                "queued_reason": "duckdb_busy",
                "status": status(session),
            }
        if _cancel.is_set():
            return {"ok": False, "error": "Cancelled.", "cancelled": True}

        if use_api:
            api = get_api_runtime()
            base = api.get("base_url")
            url = _api_chat_url(base)
            if not url:
                return {
                    "ok": False,
                    "error": "API base URL is not configured.",
                    "status": status(session),
                }
            model_id = api.get("model") or "samql"
            payload = _chat_completion_payload(model_id, messages, max_tokens=800)
            try:
                data = _http_json(
                    url,
                    payload,
                    timeout=float(timeout_s),
                    headers=_api_auth_headers(),
                )
            except Exception as e:
                if _cancel.is_set():
                    return {"ok": False, "error": "Cancelled.", "cancelled": True}
                return {
                    "ok": False,
                    "error": "Assistant API request failed: %s" % err_str(e),
                    "status": status(session),
                }
            if _cancel.is_set():
                return {"ok": False, "error": "Cancelled.", "cancelled": True}
            text = _parse_chat_completion(data)
            sql = extract_sql(text)
            return {
                "ok": True,
                "reply": text.strip(),
                "sql": sql,
                "dialect": meta["dialect"],
                "mode": ASSISTANT_MODE_API,
                "status": status(session),
            }

        base = ensure_server()
        if _cancel.is_set():
            return {"ok": False, "error": "Cancelled.", "cancelled": True}

        payload = _chat_completion_payload(
            DEFAULT_MODEL_NAME, messages, max_tokens=800
        )
        url = base.rstrip("/") + "/v1/chat/completions"
        try:
            data = _http_json(url, payload, timeout=float(timeout_s))
        except urllib.error.HTTPError as e:
            # Fallback for older llama.cpp completion endpoint.
            try:
                prompt = (
                    messages[0]["content"] + "\n\n" + messages[1]["content"]
                    + "\n\nAssistant:"
                )
                data = _http_json(
                    base.rstrip("/") + "/completion",
                    {
                        "prompt": prompt,
                        "n_predict": 800,
                        "temperature": 0.1,
                        "stop": ["</s>", "<|im_end|>", "User:"],
                    },
                    timeout=float(timeout_s),
                )
                text = str(data.get("content") or data.get("completion") or "")
                sql = extract_sql(text)
                return {
                    "ok": True,
                    "reply": text.strip(),
                    "sql": sql,
                    "dialect": meta["dialect"],
                    "mode": ASSISTANT_MODE_LOCAL,
                    "status": status(session),
                }
            except Exception:
                return {
                    "ok": False,
                    "error": "llama-server HTTP error: %s" % err_str(e),
                    "status": status(session),
                }
        except Exception as e:
            if _cancel.is_set():
                return {"ok": False, "error": "Cancelled.", "cancelled": True}
            return {
                "ok": False,
                "error": "Assistant request failed: %s" % err_str(e),
                "status": status(session),
            }

        if _cancel.is_set():
            return {"ok": False, "error": "Cancelled.", "cancelled": True}

        text = _parse_chat_completion(data)
        sql = extract_sql(text)
        return {
            "ok": True,
            "reply": text.strip(),
            "sql": sql,
            "dialect": meta["dialect"],
            "mode": ASSISTANT_MODE_LOCAL,
            "status": status(session),
        }
    finally:
        _generating = False


def err_str(e):
    try:
        from .errfmt import err_str as _e
        return _e(e)
    except Exception:
        return str(e) or e.__class__.__name__
