"""Tunable load-file size thresholds (Parquet conversion, JSON stream, upload).

Values can come from (highest precedence first):

1. Runtime overrides set via Storage & memory → Load thresholds (persisted in
   ``config.json`` under ``load_thresholds``).
2. Environment variables (``SAMQL_*``) for admin / one-off launches.
3. Built-in defaults.

Call ``apply_overrides`` / ``clear_overrides`` from Session; loaders and the
HTTP upload cap read through the helpers below so UI changes take effect
immediately without restarting.
"""
from __future__ import annotations

import os
import threading

# Field metadata: env key, default, numeric kind, UI copy.
# ``zero_means`` documents what 0 does (None = 0 is just a small number).
FIELDS = {
    "ondisk_mb": {
        "env": "SAMQL_ONDISK_MB",
        "default": 512.0,
        "kind": "float",
        "min": 0,
        "max": 1024 * 1024,
        "unit": "MB",
        "label": "On-disk Parquet threshold",
        "help": "CSV/Parquet files at or above this size convert to an on-disk "
                "Parquet cache instead of an in-memory table. 0 disables this "
                "soft threshold (the hard floor below still applies).",
        "zero_means": "disable soft threshold",
    },
    "ondisk_hard_mb": {
        "env": "SAMQL_ONDISK_HARD_MB",
        "default": 256.0,
        "kind": "float",
        "min": 0,
        "max": 1024 * 1024,
        "unit": "MB",
        "label": "On-disk Parquet hard floor",
        "help": "Files at or above this size always convert to Parquet, even "
                "when the soft threshold is disabled. 0 turns the floor off.",
        "zero_means": "disable hard floor",
    },
    "json_ondisk_mb": {
        "env": "SAMQL_JSON_ONDISK_MB",
        "default": 64.0,
        "kind": "float",
        "min": 0,
        "max": 1024 * 1024,
        "unit": "MB",
        "label": "JSON on-disk Parquet threshold",
        "help": "Nested JSON converts to Parquet sooner than flat CSV "
                "(structs expand in memory). 0 uses only the generic "
                "threshold / hard floor.",
        "zero_means": "use generic threshold only",
    },
    "json_stream_mb": {
        "env": "SAMQL_JSON_STREAM_MB",
        "default": 32.0,
        "kind": "float",
        "min": 1,
        "max": 1024 * 1024,
        "unit": "MB",
        "label": "JSON → NDJSON rewrite threshold",
        "help": "Non-NDJSON JSON at or above this size is rewritten to temp "
                "NDJSON before DuckDB reads it (bounded memory, cancellable).",
        "zero_means": None,
    },
    "json_stream_flatten_mb": {
        "env": "SAMQL_JSON_STREAM_FLATTEN_MB",
        "default": 256.0,
        "kind": "float",
        "min": 0,
        "max": 1024 * 1024,
        "unit": "MB",
        "label": "Single-object stream-flatten threshold",
        "help": "A single JSON object at or above this size uses the Python "
                "streaming flattener (spill) instead of one giant STRUCT. "
                "0 disables that short-circuit.",
        "zero_means": "disable stream-flatten short-circuit",
    },
    "json_object_mb": {
        "env": "SAMQL_JSON_OBJECT_MB",
        "default": 256,
        "kind": "int",
        "min": 1,
        "max": 1024,
        "unit": "MB",
        "label": "DuckDB JSON max object size",
        "help": "Per-record ceiling passed to DuckDB's JSON reader "
                "(``maximum_object_size``). Also clamped by the live engine "
                "memory budget.",
        "zero_means": None,
    },
    "upload_mb": {
        "env": "SAMQL_UPLOAD_MB",
        "default": 16384,
        "kind": "int",
        "min": 0,
        "max": 1024 * 1024,
        "unit": "MB",
        "label": "Drag-drop upload ceiling",
        "help": "Largest multipart upload accepted. Larger files should use "
                "Load Data → File (path). 0 disables the ceiling.",
        "zero_means": "unlimited uploads",
    },
    "filecache_gb": {
        "env": "SAMQL_FILECACHE_GB",
        "default": 32.0,
        "kind": "float",
        "min": 1,
        "max": 1024,
        "unit": "GB",
        "label": "Conversion cache budget",
        "help": "Persistent Parquet conversion cache size. LRU eviction when "
                "over budget.",
        "zero_means": None,
    },
}

_lock = threading.RLock()
# User-configured overrides (from UI / config.json). Missing key → env/default.
_overrides = {}


def _parse_number(raw, kind, default):
    try:
        if kind == "int":
            return int(float(raw))
        return float(raw)
    except Exception:
        return default


def _from_env(meta):
    env = meta["env"]
    default = meta["default"]
    kind = meta["kind"]
    if env not in os.environ:
        return default, "default"
    return _parse_number(os.environ.get(env), kind, default), "env"


def get_raw(name):
    """Return ``(value, source)`` for a field. source is override|env|default."""
    meta = FIELDS[name]
    with _lock:
        if name in _overrides and _overrides[name] is not None:
            return _overrides[name], "override"
    return _from_env(meta)


def get_float(name):
    val, _src = get_raw(name)
    return float(val)


def get_int(name):
    val, _src = get_raw(name)
    return int(val)


def effective_map():
    """Snapshot of every field: value, source, default, metadata for the UI."""
    out = {}
    with _lock:
        for name, meta in FIELDS.items():
            val, src = get_raw(name)
            out[name] = {
                "value": val,
                "source": src,
                "default": meta["default"],
                "env": meta["env"],
                "unit": meta["unit"],
                "label": meta["label"],
                "help": meta["help"],
                "min": meta["min"],
                "max": meta["max"],
                "kind": meta["kind"],
                "zero_means": meta.get("zero_means"),
            }
    return out


def apply_overrides(updates, replace=False):
    """Merge ``updates`` into the override map. Unknown keys ignored.

    When ``replace`` is True, clear existing overrides first (used when
    reloading a full config dict). Returns the effective map.
    """
    cleaned = {}
    if isinstance(updates, dict):
        for name, meta in FIELDS.items():
            if name not in updates:
                continue
            raw = updates[name]
            if raw is None:
                continue
            val = _parse_number(raw, meta["kind"], meta["default"])
            lo, hi = meta["min"], meta["max"]
            if meta["kind"] == "int":
                val = int(max(lo, min(hi, val)))
            else:
                val = float(max(lo, min(hi, val)))
            cleaned[name] = val
    with _lock:
        if replace:
            _overrides.clear()
        _overrides.update(cleaned)
    return effective_map()


def clear_overrides():
    """Drop all UI overrides so env vars / defaults apply again."""
    with _lock:
        _overrides.clear()
    return effective_map()


def overrides_snapshot():
    """Copy of currently applied overrides (for persisting to config)."""
    with _lock:
        return dict(_overrides)
