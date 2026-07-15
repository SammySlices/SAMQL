"""Local SQL assistant (English → DuckDB / SparkSQL) via bundled llama.cpp.

Phase 1 design (beta):
  * Model: Qwen2.5-Coder-1.5B-Instruct Q4_K_M GGUF (Apache 2.0)
  * Runtime: llama-server binary next to SamQL (NOT in-process, NOT Ollama)
  * Offline only: loopback HTTP; never call cloud APIs
  * Scheduling: refuse generation while DuckDB is busy (queries preempt chat)
  * Prompt: schema summary only — no nested JSON sample dumps

The assistant pack is optional. When missing, status reports install
instructions; chat returns a clear error. No load/join/flatten behaviour
is changed by this module.
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
import urllib.request
from pathlib import Path

# Default model id shown in UI / pack docs.
DEFAULT_MODEL_NAME = "Qwen2.5-Coder-1.5B-Instruct"
DEFAULT_QUANT = "Q4_K_M"
DEFAULT_GGUF_GLOBS = (
    "qwen2.5-coder-1.5b-instruct*q4*.gguf",
    "qwen2.5-coder-1.5b*q4*.gguf",
    "*.gguf",
)

# Keep prompts small on ThinkPad-class machines.
_MAX_TABLES = 40
_MAX_COLS_PER_TABLE = 48
_MAX_PROMPT_CHARS = 12000

_lock = threading.RLock()
_proc = None  # type: ignore[var-annotated]
_proc_port = None  # type: ignore[var-annotated]
_cancel = threading.Event()
_generating = False


def _is_windows():
    return os.name == "nt" or sys.platform.startswith("win")


def _candidate_roots():
    """Places to look for the offline assistant pack."""
    roots = []
    env = (os.environ.get("SAMQL_ASSISTANT_DIR") or "").strip()
    if env:
        roots.append(Path(env))
    # Next to the running process (PyInstaller / source checkout).
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


def find_pack(root=None):
    """Locate llama-server + a GGUF model. Returns a status dict."""
    roots = [Path(root)] if root else _candidate_roots()
    bin_name = _llama_binary_name()
    for base in roots:
        try:
            if not base.is_dir():
                continue
        except Exception:
            continue
        binary = base / bin_name
        # Also accept llama-server without extension on Windows if present.
        if not binary.is_file():
            alt = base / "llama-server"
            if alt.is_file():
                binary = alt
        models_dir = base / "models"
        model = None
        search_dirs = []
        if models_dir.is_dir():
            search_dirs.append(models_dir)
        search_dirs.append(base)
        for d in search_dirs:
            for pattern in DEFAULT_GGUF_GLOBS:
                try:
                    hits = sorted(d.glob(pattern))
                except Exception:
                    hits = []
                for hit in hits:
                    if hit.is_file() and hit.suffix.lower() == ".gguf":
                        model = hit
                        break
                if model is not None:
                    break
            if model is not None:
                break
        if binary.is_file() and model is not None:
            return {
                "ok": True,
                "root": str(base),
                "binary": str(binary),
                "model": str(model),
                "model_name": DEFAULT_MODEL_NAME,
                "quant": DEFAULT_QUANT,
            }
        if binary.is_file() and model is None:
            return {
                "ok": False,
                "root": str(base),
                "binary": str(binary),
                "model": None,
                "reason": "model_missing",
                "hint": (
                    "Place a Qwen2.5-Coder-1.5B-Instruct Q4_K_M .gguf under "
                    "assistant/models/ (copied from a machine that can download)."
                ),
            }
        if model is not None and not binary.is_file():
            return {
                "ok": False,
                "root": str(base),
                "binary": None,
                "model": str(model),
                "reason": "binary_missing",
                "hint": (
                    "Place llama-server%s next to the model pack under "
                    "assistant/." % (".exe" if _is_windows() else "")
                ),
            }
    return {
        "ok": False,
        "root": None,
        "binary": None,
        "model": None,
        "reason": "pack_missing",
        "hint": (
            "Copy an offline assistant pack to ./assistant/ "
            "(llama-server + Qwen2.5-Coder-1.5B Q4 GGUF). "
            "No download is required on locked-down machines if the pack "
            "was prepared elsewhere. See assistant/README.txt."
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
    system = (
        "You are SamQL's offline SQL assistant. Convert English requests into "
        "%s only. Use only the provided tables/columns. Prefer simple, "
        "runnable queries. For nested JSON columns, use the query hints when "
        "present (json_extract / UNNEST / ->>). Do not invent tables. "
        "Reply with a short explanation, then a single fenced sql code block."
        % dialect_label
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


def _llama_base_url():
    env = (os.environ.get("SAMQL_LLAMA_URL") or "").strip().rstrip("/")
    if env:
        return env
    with _lock:
        if _proc_port:
            return "http://127.0.0.1:%d" % _proc_port
    return None


def _http_json(url, payload, timeout=120.0):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
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
            with urllib.request.urlopen(req, timeout=1.5) as resp:
                if 200 <= getattr(resp, "status", 200) < 500:
                    return True
        except Exception:
            pass
        # Some builds expose only /v1/models
        try:
            req = urllib.request.Request(base.rstrip("/") + "/v1/models", method="GET")
            with urllib.request.urlopen(req, timeout=1.5) as resp:
                if 200 <= getattr(resp, "status", 200) < 500:
                    return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def ensure_server(pack=None):
    """Start bundled llama-server if needed. Returns base URL or raises."""
    global _proc, _proc_port
    existing = _llama_base_url()
    if existing and (os.environ.get("SAMQL_LLAMA_URL") or "").strip():
        return existing
    with _lock:
        if _proc is not None and _proc.poll() is None and _proc_port:
            return "http://127.0.0.1:%d" % _proc_port
        pack = pack or find_pack()
        if not pack.get("ok"):
            raise RuntimeError(pack.get("hint") or "Assistant pack not available.")
        port = _free_port()
        cmd = [
            pack["binary"],
            "-m", pack["model"],
            "--host", "127.0.0.1",
            "--port", str(port),
            "-c", "4096",
            "-ngl", "0",  # CPU-only for ThinkPad / locked GPUs
        ]
        creationflags = 0
        if _is_windows():
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        _proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        _proc_port = port
    base = "http://127.0.0.1:%d" % port
    if not _wait_ready(base):
        stop_server()
        raise RuntimeError(
            "llama-server failed to become ready. Check the assistant pack "
            "binary and GGUF model."
        )
    return base


def stop_server():
    global _proc, _proc_port
    with _lock:
        proc, _proc = _proc, None
        _proc_port = None
    if proc is None:
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
    avail_mb = mem.get("memory_available_mb") or 0
    refuse_ram = bool(avail_mb and avail_mb < 1536)
    return {
        "enabled": True,
        "available": bool(pack.get("ok")) and not refuse_ram,
        "pack_ok": bool(pack.get("ok")),
        "reason": None if pack.get("ok") else pack.get("reason"),
        "hint": pack.get("hint"),
        "root": pack.get("root"),
        "model": pack.get("model"),
        "model_name": DEFAULT_MODEL_NAME,
        "quant": DEFAULT_QUANT,
        "duckdb_busy": busy,
        "generating": bool(_generating),
        "server_url": _llama_base_url(),
        "memory": mem,
        "refuse_low_memory": refuse_ram,
    }


def cancel():
    """Cooperative cancel for an in-flight chat generation."""
    _cancel.set()
    return {"ok": True}


def chat(session, question, dialect="native", timeout_s=180.0):
    """Generate SQL help. Refuses when DuckDB is busy or pack/RAM missing."""
    global _generating
    q = str(question or "").strip()
    if not q:
        return {"ok": False, "error": "Ask a question about your tables."}

    st = status(session)
    if st.get("refuse_low_memory"):
        return {
            "ok": False,
            "error": (
                "Not enough free RAM for the local assistant "
                "(need ~1.5 GiB free while DuckDB is idle)."
            ),
            "status": st,
        }
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
        base = ensure_server()
        if _cancel.is_set():
            return {"ok": False, "error": "Cancelled.", "cancelled": True}

        payload = {
            "model": DEFAULT_MODEL_NAME,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 800,
            "stream": False,
        }
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
                    "status": status(session),
                }
            except Exception:
                return {
                    "ok": False,
                    "error": "llama-server HTTP error: %s" % (e,),
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

        choices = data.get("choices") or []
        text = ""
        if choices and isinstance(choices[0], dict):
            msg = choices[0].get("message") or {}
            text = str(msg.get("content") or choices[0].get("text") or "")
        if not text:
            text = str(data.get("content") or "")
        sql = extract_sql(text)
        return {
            "ok": True,
            "reply": text.strip(),
            "sql": sql,
            "dialect": meta["dialect"],
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
