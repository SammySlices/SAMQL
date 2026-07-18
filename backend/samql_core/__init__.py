"""SamQL core -- the headless engine behind the React UI.

This package is the GUI-free heart of the original SamQL desktop tool:
the SQLite / DuckDB engines, file loaders, JSON flattener, SQL routing,
profiler, result paging, and persistence stores. The HTTP server
(``server.py``) is a thin transport layer over :class:`Session`.

Nothing in here imports tkinter. Heavy third-party packages (duckdb,
pyarrow, sqlglot, pyodbc, openpyxl, ijson) are optional and probed at
import time; the stdlib path (SQLite + CSV/JSON) always works. ``orjson``
is required for fast JSON rewrite / API payloads
(``backend/requirements.txt`` + distribution builds); a stdlib fallback
remains if it is missing.
"""
from __future__ import annotations

__version__ = "2.16.4"
# Iteration / build label. Bump the trailing sequence each delivered round so
# the exact build can be confirmed in the UI (top bar) and the source bundle.
BUILD = "2026-07-18.662"
APP_NAME = "SamQL"

# ---- session orchestration -----------------------------------------
from .session import (
    Session,
    json_safe,
    DUCKDB_TARGET,
    LOCAL_TARGET,
    DISPLAY_LIMIT,
)

# ---- persistence stores ---------------------------------------------
from .stores import (
    ConfigStore,
    QueryHistoryStore,
    SavedQueryStore,
    APP_CONFIG_DIRNAME,
    LEGACY_APP_CONFIG_DIRNAME,
    app_config_dir,
    KEYRING_SERVICE_SQL,
    KEYRING_SERVICE_API,
    atomic_write_json,
)

# ---- engines & optional-feature flags -------------------------------
from .engines import (
    DBManager,
    DuckDBManager,
    HAS_DUCKDB,
    HAS_PYARROW,
)

# ---- loaders, flattening, inference ---------------------------------
from .loaders import load_file, load_csv, load_json, load_parquet
from .flatten import read_json_any_format, JSONFlattener
from .inference import (
    infer_affinity,
    infer_affinities,
    try_parse_date,
    detect_date_format,
)

# ---- SQL utilities --------------------------------------------------
from .sqlutil import (
    classify_sql_statement,
    split_sql_batches,
    split_statements,
    split_sql_statements_spans,
    find_statement_at,
    wrap_sorted_sql,
    sqlglot_transform,
    HAS_SQLGLOT,
)

# ---- profiling & API loading ----------------------------------------
from .profiler import profile_table, profile_column
from .apiload import load_api, fetch_json, build_url

# ---- optional MSSQL -------------------------------------------------
from .mssql import (
    SQLServerConnection,
    build_mssql_conn_str,
    classify_mssql_error,
    odbc_drivers,
    HAS_PYODBC,
)

__all__ = [
    "__version__", "BUILD", "APP_NAME",
    "Session", "json_safe",
    "DUCKDB_TARGET", "LOCAL_TARGET", "DISPLAY_LIMIT",
    "ConfigStore", "QueryHistoryStore", "SavedQueryStore",
    "APP_CONFIG_DIRNAME", "LEGACY_APP_CONFIG_DIRNAME", "app_config_dir",
    "KEYRING_SERVICE_SQL", "KEYRING_SERVICE_API",
    "DBManager", "DuckDBManager", "HAS_DUCKDB", "HAS_PYARROW",
    "load_file", "load_csv", "load_json", "load_parquet",
    "read_json_any_format", "JSONFlattener",
    "infer_affinity", "infer_affinities", "try_parse_date",
    "detect_date_format",
    "classify_sql_statement", "split_sql_batches", "split_statements",
    "wrap_sorted_sql", "sqlglot_transform", "HAS_SQLGLOT",
    "profile_table", "profile_column",
    "load_api", "fetch_json", "build_url",
    "SQLServerConnection", "build_mssql_conn_str", "classify_mssql_error",
    "odbc_drivers", "HAS_PYODBC",
]
