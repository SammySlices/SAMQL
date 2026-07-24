"""Optional Microsoft SQL Server connectivity (pyodbc).

Ported faithfully from the original desktop app. Everything here is
guarded so the package imports cleanly when pyodbc / pywin32 are not
installed -- the rest of SamQL works without MSSQL support.

The public surface used by :class:`samql_core.session.Session` is the
:class:`SQLServerConnection` class plus a small ``execute_cursor``
adapter so a remote connection plugs into the same result-draining
path as the local SQLite / DuckDB engines.
"""
from __future__ import annotations

import re
import sys
import threading
from contextlib import contextmanager

from .rows import spill_rows
from .sqlutil import (split_sql_batches, classify_sql_statement,
                      split_statements)

# ---- optional dependencies ------------------------------------------
try:
    import pyodbc
    HAS_PYODBC = True
except Exception:
    pyodbc = None
    HAS_PYODBC = False

HAS_PYWIN32 = False
if sys.platform == "win32":
    try:
        import win32security
        import win32con
        HAS_PYWIN32 = True
    except Exception:
        HAS_PYWIN32 = False


_SESSION_CONTEXT_LEADERS = ("use", "set")


def _batch_is_session_context_only(batch):
    """True only when EVERY statement in ``batch`` is a bare USE/SET.

    USE / SET change session context (current database, session options) and
    write no data, so a read-only connection may run them. But
    ``classify_sql_statement`` inspects only a batch's LEADING keyword, so a
    single GO-batch such as ``SET NOCOUNT ON; DELETE FROM t`` would classify as
    a write, lead with ``SET``, and -- if we bypassed on the head alone --
    smuggle the DELETE past the read-only guard. Splitting the batch into
    ``;``-separated statements (string/comment aware) and requiring every one to
    lead with USE/SET closes that hole while keeping the legitimate
    database-switch (``USE [db]``) working."""
    stmts = [s for s in split_statements(batch) if s.strip()]
    if not stmts:
        return False
    for s in stmts:
        m = re.match(r"\s*([A-Za-z_]+)", s)
        if not m or m.group(1).lower() not in _SESSION_CONTEXT_LEADERS:
            return False
    return True


def odbc_drivers():
    """Return the list of installed ODBC drivers (empty without pyodbc)."""
    if not HAS_PYODBC:
        return []
    try:
        return list(pyodbc.drivers())
    except Exception:
        return []


def best_odbc_driver(drivers):
    """Pick the best installed "SQL Server" ODBC driver, preferring newer
    versions (18 > 17 > 13 > 11). Returns "" when the list is empty. This is
    why the app copes with SQL Server tooling being installed in different
    places / versions on different machines -- it queries the installed
    drivers rather than assuming a fixed path."""
    drivers = [d for d in (drivers or []) if d]
    if not drivers:
        return ""

    def rank(d):
        for i in (18, 17, 13, 11):
            if str(i) in d:
                return i
        return 1 if "SQL Server" in d else 0
    return max(drivers, key=rank)


def split_domain_user(raw):
    """Split a 'DOMAIN\\user' login into (domain, user). With no backslash the
    domain is empty. Used to build the (domain, user, password) tuple for the
    'Alternate Windows account (runas /netonly)' method, which authenticates
    network connections via win32 LogonUser impersonation."""
    raw = (raw or "").strip()
    if "\\" in raw:
        domain, user = raw.split("\\", 1)
        return domain.strip(), user.strip()
    return "", raw


# ---- connection-string builder (pure, suite-testable) ---------------
def build_mssql_conn_str(driver, server, port="", auth="windows",
                         user="", pwd="", encrypt=True, trust=True,
                         multi_subnet=False, extra="", app="SamQL"):
    """Pure ODBC connection-string builder. ``auth`` is 'windows',
    'windows_alt', or 'sql'. Braces in passwords are escaped per ODBC
    quoting rules."""
    if not driver:
        raise ValueError("Select an ODBC driver.")
    server = (server or "").strip()
    if not server:
        raise ValueError("Server is required.")
    parts = ["DRIVER={%s}" % driver]
    port = (port or "").strip()
    if port:
        server = f"{server},{port}"
    parts.append(f"SERVER={server}")
    if auth in ("windows", "windows_alt"):
        parts.append("Trusted_Connection=yes")
        if auth == "windows_alt":
            if not (user or "").strip():
                raise ValueError(
                    "Username is required for Alternate Windows.")
            if not pwd:
                raise ValueError(
                    "Password is required for Alternate Windows.")
    else:
        if not user:
            raise ValueError("Username is required for SQL Login.")
        parts.append(f"UID={user}")
        parts.append("PWD={%s}" % str(pwd).replace("}", "}}"))
    parts.append("Encrypt=%s" % ("yes" if encrypt else "no"))
    if trust:
        parts.append("TrustServerCertificate=yes")
    if multi_subnet:
        parts.append("MultiSubnetFailover=Yes")
    if app:
        parts.append(f"APP={app}")
    extra = (extra or "").strip().strip(";")
    if extra:
        parts.append(extra)
    return ";".join(parts)


_MSSQL_ERROR_RULES = (
    (("certificate chain", "ssl provider", "certificate verify"),
     "TLS certificate not trusted (self-signed or internal CA)",
     'Tick "Trust server certificate" (with Encrypt on), or turn '
     "Encrypt off for legacy servers."),
    (("im002",),
     "ODBC driver name not installed on this machine",
     "Pick a driver from the dropdown (it lists pyodbc.drivers())."),
    (("error locating server/instance", "error: 26"),
     "Named instance not resolved (SQL Browser / UDP 1434 blocked)",
     "Use the explicit TCP port instead of the instance name."),
    (("login timeout expired", "hyt00", "timeout error"),
     "Connection timed out (firewall, wrong port, or an Availability "
     "Group listener spanning subnets)",
     "Enable MultiSubnetFailover, raise the login timeout, confirm "
     "the port."),
    (("login failed for user", "28000"),
     "Authentication rejected by the server",
     "Check account/domain; with Alternate Windows the password is "
     "only validated by the remote server."),
    (("ssl security error", "der encoding"),
     "TLS handshake failure (legacy driver vs modern TLS policy)",
     'Use "ODBC Driver 17/18 for SQL Server" instead of the legacy '
     '"SQL Server" driver.'),
    (("invalid connection string attribute",),
     "Driver too old for one of the options sent",
     "Untick MultiSubnetFailover / clear extra options, or install "
     "ODBC Driver 17/18."),
    (("connection refused", "tcp provider"),
     "TCP connection refused (wrong port or blocked)",
     "Verify host/port; default is 1433."),
)


def classify_mssql_error(message):
    """Map an ODBC error message to (cause, suggested fix)."""
    low = str(message or "").lower()
    for needles, cause, fix in _MSSQL_ERROR_RULES:
        if any(n in low for n in needles):
            return cause, fix
    return ("Unrecognized ODBC error",
            "Run Diagnose for a driver/encryption matrix and check "
            "reachability (ping / telnet to the port).")




class SQLServerConnection:
    """A serialized, GO-aware, auto-reconnecting MSSQL connection.

    Optional Alternate-Windows credentials (domain, user, password) are
    supported on Windows via pywin32 LogonUser impersonation.
    """

    def __init__(self, name, conn_str, alt_creds=None,
                 login_timeout=15, stmt_timeout=0, read_only=False):
        if not HAS_PYODBC:
            raise RuntimeError(
                "pyodbc is not installed.  Install with:  pip install pyodbc")
        self.name = name
        self.conn_str = conn_str
        self.alt_creds = alt_creds
        self._token = None
        self._active_cursor = None
        self._cursor_lock = threading.Lock()
        if alt_creds:
            if not HAS_PYWIN32:
                raise RuntimeError(
                    "Alternate Windows credentials require pywin32 on "
                    "Windows.\nInstall with:  pip install pywin32")
            domain, user, password = alt_creds
            try:
                self._token = win32security.LogonUser(
                    user,
                    domain or None,
                    password,
                    win32con.LOGON32_LOGON_NEW_CREDENTIALS,
                    win32con.LOGON32_PROVIDER_WINNT50,
                )
            except Exception as e:
                raise RuntimeError(
                    f"LogonUser failed for {domain}\\{user}: {e}\n\n"
                    "Note: with NEW_CREDENTIALS, the password is not "
                    "validated locally -- this error usually means the "
                    "username or domain is malformed.")
        self.login_timeout = max(1, int(login_timeout or 15))
        self.stmt_timeout = max(0, int(stmt_timeout or 0))
        # Serialize every statement: pyodbc connections are not safe for
        # concurrent use. Metadata/browse queries are additionally bounded
        # by meta_timeout so a slow catalog query cannot hang the UI.
        self._exec_lock = threading.Lock()
        self.meta_timeout = max(15, self.login_timeout)
        self.read_only = bool(read_only)
        self.last_messages = []
        self.spid = None
        # table metadata for the session's introspection layer
        self.table_columns = {}
        self.table_sources = {}
        with self._impersonate():
            self.conn = pyodbc.connect(
                conn_str, autocommit=True,
                timeout=self.login_timeout)
        if self.stmt_timeout:
            try:
                self.conn.timeout = self.stmt_timeout
            except Exception:
                pass
        self._fetch_spid()

    def _fetch_spid(self):
        try:
            with self._impersonate():
                cur = self.conn.cursor()
                cur.execute("SELECT @@SPID")
                row = cur.fetchone()
                self.spid = int(row[0]) if row else None
                cur.close()
        except Exception:
            self.spid = None

    @staticmethod
    def _is_dead_link(err):
        s = str(err)
        return ("08S01" in s or "08003" in s or "10054" in s
                or "10053" in s
                or "Communication link failure" in s)

    def _reconnect(self):
        try:
            self.conn.close()
        except Exception:
            pass
        with self._impersonate():
            self.conn = pyodbc.connect(
                self.conn_str, autocommit=True,
                timeout=self.login_timeout)
        if self.stmt_timeout:
            try:
                self.conn.timeout = self.stmt_timeout
            except Exception:
                pass
        self._fetch_spid()

    @contextmanager
    def _impersonate(self):
        if self._token is None:
            yield
            return
        win32security.ImpersonateLoggedOnUser(self._token)
        try:
            yield
        finally:
            try:
                win32security.RevertToSelf()
            except Exception:
                pass

    def execute(self, sql):
        """GO-aware, read-only-enforcing, auto-reconnecting executor.
        Returns ``(cols, rows)`` where rows may be a disk-backed store."""
        batches = split_sql_batches(sql) or [sql]
        if self.read_only:
            for b in batches:
                if classify_sql_statement(b) == "write":
                    # USE / SET switch session context (current database,
                    # session options) -- they write no DATA, so a read-only
                    # connection permits them (this is exactly what the connect
                    # form's read-only hint promises). But classify keys off the
                    # LEADING keyword only, so bypassing on the batch head alone
                    # would let a trailing write ride along, e.g.
                    # "SET NOCOUNT ON; DELETE FROM t". Require EVERY statement in
                    # the batch to be a bare USE/SET before allowing it through.
                    if _batch_is_session_context_only(b):
                        continue
                    head = b.strip().split(None, 1)[0][:14]
                    raise RuntimeError(
                        f'Read-only connection "{self.name}": blocked '
                        f"non-SELECT batch ({head} ...). Untick "
                        f"Read-only on the connection to allow writes.")
        with self._exec_lock:
            try:
                return self._execute_batches(batches)
            except pyodbc.Error as e:
                if not self._is_dead_link(e):
                    raise
                self._reconnect()
                return self._execute_batches(batches)

    def execute_cursor(self, sql, batch=1000):
        """Adapter for the session's result-draining path. MSSQL results
        are fully spilled to disk by :func:`spill_rows`, so there is no
        live cursor to hand back -- return ``(cols, rows, None)``."""
        cols, rows = self.execute(sql)
        if cols is None:
            return None, None, None
        return cols, rows, None

    def _drain_messages(self, cur):
        try:
            msgs = list(getattr(cur, "messages", None) or [])
            for item in msgs:
                try:
                    self.last_messages.append(str(item[-1]))
                except Exception:
                    self.last_messages.append(str(item))
            if msgs:
                try:
                    cur.messages = []
                except Exception:
                    pass
        except Exception:
            pass

    def _execute_batches(self, batches):
        self.last_messages = []
        with self._impersonate():
            cur = self.conn.cursor()
            with self._cursor_lock:
                self._active_cursor = cur
            try:
                cols, rows = None, None
                for b in batches:
                    cur.execute(b)
                    while True:
                        self._drain_messages(cur)
                        if cur.description is not None:
                            cols = [
                                (d[0] if d[0] else f"col_{i}")
                                for i, d in enumerate(
                                    cur.description, start=1)
                            ]
                            rows = spill_rows(cur)
                        else:
                            cols, rows = None, None
                        try:
                            has_more = cur.nextset()
                        except pyodbc.Error:
                            has_more = False
                        if not has_more:
                            break
                return cols, rows
            finally:
                with self._cursor_lock:
                    self._active_cursor = None
                try:
                    cur.close()
                except Exception:
                    pass

    def interrupt(self):
        with self._cursor_lock:
            cur = self._active_cursor
        if cur is not None:
            try:
                cur.cancel()
            except Exception:
                pass

    @contextmanager
    def _meta_session(self):
        with self._exec_lock:
            try:
                prev = self.conn.timeout
            except Exception:
                prev = self.stmt_timeout
            try:
                try:
                    self.conn.timeout = int(self.meta_timeout)
                except Exception:
                    pass
                with self._impersonate():
                    yield
            finally:
                try:
                    self.conn.timeout = prev
                except Exception:
                    pass

    def list_databases(self):
        try:
            with self._meta_session():
                cur = self.conn.cursor()
                try:
                    cur.execute(
                        "SELECT name FROM sys.databases "
                        "WHERE state_desc = 'ONLINE' "
                        "ORDER BY name")
                    out = [r[0] for r in cur.fetchall()]
                    if out:
                        cur.close()
                        return out
                except Exception:
                    pass
                cats = set()
                try:
                    for r in cur.tables():
                        if r.table_cat:
                            cats.add(r.table_cat)
                except Exception:
                    pass
                cur.close()
                return sorted(cats)
        except Exception:
            return []

    def list_tables(self, catalog=None):
        try:
            with self._meta_session():
                cur = self.conn.cursor()
                out = []
                kwargs_t = {"tableType": "TABLE"}
                kwargs_v = {"tableType": "VIEW"}
                if catalog:
                    kwargs_t["catalog"] = catalog
                    kwargs_v["catalog"] = catalog
                for r in cur.tables(**kwargs_t):
                    out.append((r.table_schem or "", r.table_name))
                for r in cur.tables(**kwargs_v):
                    out.append((r.table_schem or "", r.table_name))
                cur.close()
                return out
        except Exception:
            return []

    def list_columns(self, catalog=None):
        """Return {(schema, table): [(column, data_type), ...]} for every base
        table and view, in a single INFORMATION_SCHEMA pass. Used to populate
        the catalog with table + column names only -- no row data is read."""
        out = {}
        prefix = ("[%s]." % catalog) if catalog else ""
        q = ("SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE "
             "FROM " + prefix + "INFORMATION_SCHEMA.COLUMNS "
             "ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION")
        try:
            with self._meta_session():
                cur = self.conn.cursor()
                try:
                    cur.execute(q)
                    for sch, tbl, col, dt in cur.fetchall():
                        out.setdefault((sch or "", tbl), []).append(
                            (col, dt or ""))
                finally:
                    cur.close()
        except Exception:
            return out
        return out

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass
        if self._token is not None:
            try:
                self._token.Close()
            except Exception:
                pass
            self._token = None
