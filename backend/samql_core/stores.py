"""Persistence stores: app config, query history, saved queries, and
schema signatures. JSON-file backed under ``~/.samql`` (canonical), with
a one-time copy from the legacy ``~/.json_csv_sql_explorer`` layout so
existing installs keep history, saved queries, connection profiles, and
secrets. Override with ``SAMQL_CONFIG_DIR`` for tests / multi-instance.

This module is GUI-free and lifted directly from the original
single-file application.
"""
import datetime as _dt
import json
import os
import shutil
from pathlib import Path

# Canonical durable config dir (SamQL-branded). Legacy name kept for
# one-time migration and docs that mention the original on-disk layout.
APP_CONFIG_DIRNAME = ".samql"
LEGACY_APP_CONFIG_DIRNAME = ".json_csv_sql_explorer"
_MIGRATION_MARKER = ".migrated_from_json_csv_sql_explorer"
KEYRING_SERVICE_SQL = "json_csv_sql_explorer_sql"
KEYRING_SERVICE_API = "json_csv_sql_explorer_api"
KEYRING_API_USER = "default"


def app_config_dir(dirname=None):
    """Resolve the durable SamQL config directory.

    Precedence:
    1. ``SAMQL_CONFIG_DIR`` env — absolute isolation for tests / multi-instance
    2. Explicit ``dirname`` that is neither canonical nor legacy — custom
       home subdirectory (or absolute path)
    3. ``~/.samql``, creating it and one-time copying from
       ``~/.json_csv_sql_explorer`` when the new dir is missing or empty
    """
    env = (os.environ.get("SAMQL_CONFIG_DIR") or "").strip()
    if env:
        path = Path(env).expanduser()
        if not path.is_absolute():
            path = (Path.cwd() / path).resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    if dirname is not None and dirname not in (
            APP_CONFIG_DIRNAME, LEGACY_APP_CONFIG_DIRNAME):
        path = Path(dirname)
        if not path.is_absolute():
            path = Path.home() / dirname
        path.mkdir(parents=True, exist_ok=True)
        return path

    return _ensure_canonical_config_dir()


def _ensure_canonical_config_dir():
    dest = Path.home() / APP_CONFIG_DIRNAME
    legacy = Path.home() / LEGACY_APP_CONFIG_DIRNAME
    try:
        dest_exists = dest.is_dir()
        dest_empty = dest_exists and not any(dest.iterdir())
        if dest_exists and not dest_empty:
            return dest
        if legacy.is_dir() and (not dest_exists or dest_empty):
            dest.mkdir(parents=True, exist_ok=True)
            _migrate_legacy_config(legacy, dest)
            return dest
        dest.mkdir(parents=True, exist_ok=True)
        return dest
    except Exception:
        try:
            dest.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        return dest


def _migrate_legacy_config(legacy, dest):
    """Copy legacy durable files into ``dest`` without overwriting."""
    try:
        for item in legacy.iterdir():
            target = dest / item.name
            if target.exists():
                continue
            try:
                if item.is_dir():
                    shutil.copytree(item, target)
                elif item.is_file():
                    shutil.copy2(item, target)
            except Exception:
                pass
        marker = dest / _MIGRATION_MARKER
        if not marker.exists():
            marker.write_text(
                "migrated from %s\n" % legacy, encoding="utf-8")
    except Exception:
        pass


def _replace_retry(tmp, dst, tries=6, delay=0.025):
    """Replace ``dst`` atomically, retrying transient Windows sharing errors.

    Antivirus and indexers can briefly open a freshly written JSON file.  A
    short retry ladder prevents a best-effort persistence write from silently
    losing the newest state while remaining a single-shot operation on POSIX.
    """
    import time as _t
    tmp = Path(tmp)
    dst = Path(dst)
    last = None
    for i in range(tries):
        try:
            tmp.replace(dst)
            return True
        except (PermissionError, OSError) as exc:
            last = exc
            _t.sleep(delay * (i + 1))
    if last is not None:
        raise last
    return False


def atomic_write_json(path, value, *, indent=2):
    """Write JSON to ``path`` with same-directory atomic replacement.

    The temporary file has a unique name so concurrent saves cannot trample
    each other.  It is flushed and fsynced before replacement, and is removed
    on every failure path.  Persistence stores intentionally remain
    best-effort, so callers receive ``False`` instead of a startup-breaking
    exception while tests and diagnostics can still observe the outcome.
    """
    import tempfile

    path = Path(path)
    tmp_path = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(path.parent),
            prefix=".%s." % path.name,
            suffix=".tmp",
            delete=False,
        ) as fh:
            tmp_path = Path(fh.name)
            json.dump(value, fh, indent=indent)
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError:
                pass
        _replace_retry(tmp_path, path)
        tmp_path = None
        return True
    except Exception:
        return False
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass


def _quarantine_corrupt_json(path, keep=3):
    """Preserve an unreadable persistence file instead of silently
    overwriting it with an empty store on the next save. Returns the backup
    path when quarantine succeeds, otherwise ``None``.

    A valid JSON document with the wrong top-level shape is corruption too:
    every store below validates its expected container before accepting it.
    """
    path = Path(path)
    try:
        if not path.exists():
            return None
        stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        target = path.with_name(path.name + ".corrupt-" + stamp)
        # Avoid a vanishingly unlikely collision without deleting evidence.
        n = 1
        while target.exists():
            target = path.with_name(path.name + ".corrupt-" + stamp + "-%d" % n)
            n += 1
        _replace_retry(path, target)
        backups = sorted(path.parent.glob(path.name + ".corrupt-*"),
                         key=lambda x: x.stat().st_mtime, reverse=True)
        for old in backups[max(1, int(keep)):]:
            try:
                old.unlink()
            except OSError:
                pass
        return target
    except Exception:
        return None


def _load_json_container(path, expected_type):
    """Load one persistence file and enforce its top-level shape.

    Syntax/encoding/shape corruption is quarantined so startup stays usable
    while the original bytes remain available for recovery and diagnostics.
    Transient filesystem errors simply leave the store empty; they do not move
    a potentially healthy file.
    """
    path = Path(path)
    if not path.exists():
        return expected_type()
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = json.load(f)
        if value is None:
            return expected_type()
        if not isinstance(value, expected_type):
            raise ValueError("expected %s at top level" % expected_type.__name__)
        if expected_type is list and any(not isinstance(e, dict) for e in value):
            raise ValueError("expected a list of objects")
        return value
    except (json.JSONDecodeError, UnicodeError, TypeError, ValueError):
        _quarantine_corrupt_json(path)
        return expected_type()
    except OSError:
        return expected_type()


class ConfigStore:
    def __init__(self, dirname=None, filename="config.json"):
        self.path = app_config_dir(dirname) / filename
        self.data = {}
        self._load()

    def _load(self):
        self.data = _load_json_container(self.path, dict)

    def save(self):
        return atomic_write_json(self.path, self.data)

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value
        self.save()


class QueryHistoryStore:
    MAX_ENTRIES = 200
    RETENTION_DAYS = 30          # history older than this is dropped

    def __init__(self, dirname=None, filename="history.json"):
        self.path = app_config_dir(dirname) / filename
        self.entries = []
        self._load()

    def _load(self):
        self.entries = _load_json_container(self.path, list)
        # Enforce the retention window on load, so stale history is dropped
        # every time the app starts; persist the trimmed list if it changed.
        if self._prune_old():
            self._save()

    def _prune_old(self):
        """Remove entries whose 'ts' is older than RETENTION_DAYS.

        Entries without a parseable 'ts' are always kept -- this is what lets
        SavedQueryStore (whose records have no timestamp) opt out of expiry by
        setting RETENTION_DAYS = None. Returns True if anything was removed.
        """
        days = self.RETENTION_DAYS
        if not days:
            return False
        cutoff = _dt.datetime.now() - _dt.timedelta(days=days)
        kept, changed = [], False
        for e in self.entries:
            ts = e.get("ts")
            if ts:
                try:
                    if _dt.datetime.fromisoformat(ts) < cutoff:
                        changed = True
                        continue                    # too old -> drop
                except (ValueError, TypeError):
                    pass                            # unparseable -> keep
            kept.append(e)
        if changed:
            self.entries = kept
        return changed

    def _save(self):
        return atomic_write_json(self.path, self.entries)

    def add(self, sql, target="__local__", row_count=None,
            elapsed_sec=None, error=None):
        if not sql or not sql.strip():
            return
        _sql = sql.strip()
        if len(_sql) > 200_000:
            # entries are capped in COUNT but not SIZE (audit 2026-07-02 C):
            # a reuse-miss retry inlines whole chains, so one entry could be
            # megabytes. Keep history light; the result itself has the run.
            _sql = _sql[:200_000] + "\n-- [history: truncated]"
        entry = {
            "sql": _sql,
            "target": target,
            "row_count": row_count,
            "elapsed_sec": elapsed_sec,
            "error": error,
            "ts": _dt.datetime.now().isoformat(timespec="seconds"),
        }
        self.entries.append(entry)
        self._prune_old()                           # drop anything past 30 days
        if len(self.entries) > self.MAX_ENTRIES:
            self.entries = self.entries[-self.MAX_ENTRIES:]
        self._save()

    def search(self, needle):
        n = (needle or "").strip().lower()
        results = []
        for e in reversed(self.entries):
            if not n or n in e.get("sql", "").lower():
                results.append(e)
        return results

    def clear(self):
        """.523: the nuclear reset -- forget every restorable load, exactly
        like a graceful shutdown does, so the next state is launch-empty."""
        self.entries = []
        self._save()

    def all(self):
        return list(reversed(self.entries))


class SavedQueryStore(QueryHistoryStore):
    RETENTION_DAYS = None        # saved queries never expire

    def __init__(self, dirname=None, filename="saved.json"):
        super().__init__(dirname, filename)

    def upsert(self, name, sql, tags=None):
        name = (name or "").strip()
        if not name:
            return None
        now = _dt.datetime.now().isoformat(timespec="seconds")
        for e in self.entries:
            if e.get("name") == name:
                e["sql"] = sql
                if tags is not None:
                    e["tags"] = list(tags)
                e["last_used"] = now
                self._save()
                return e
        new = {
            "name": name,
            "sql": sql,
            "tags": list(tags or []),
            "created_at": now,
            "last_used": now,
        }
        self.entries.append(new)
        self._save()
        return new

    def delete(self, name):
        before = len(self.entries)
        self.entries = [e for e in self.entries if e.get("name") != name]
        if len(self.entries) != before:
            self._save()
            return True
        return False

    def get(self, name):
        for e in self.entries:
            if e.get("name") == name:
                return e
        return None

    def all(self):
        return sorted(self.entries,
                      key=lambda e: e.get("last_used", ""),
                      reverse=True)

    def search(self, needle):
        n = (needle or "").strip().lower()
        if not n:
            return self.all()
        out = []
        for e in self.all():
            if (n in e.get("name", "").lower()
                    or n in e.get("sql", "").lower()
                    or any(n in t.lower() for t in e.get("tags", []))):
                out.append(e)
        return out




class WorkflowStore:
    """Named saved workflows persisted to disk so a user can save and reload
    them across sessions. Each entry has a ``kind`` -- "ide" (a SQL script),
    "journal" (a notebook document) or "node" (a visual data-flow graph) -- and
    its content lives under ``graph`` (kept that name for back-compat with the
    original NodeFlow-only store). Entries are keyed by (kind, name), so the
    same name can exist once per kind. Legacy entries written before kinds
    existed are treated as "node"."""
    MAX_ENTRIES = 400
    KINDS = ("ide", "journal", "node", "dashboard")

    def __init__(self, dirname=None, filename="workflows.json"):
        self.path = app_config_dir(dirname) / filename
        self.entries = []
        self._load()

    @staticmethod
    def _kind(k):
        k = (k or "node").strip().lower()
        return k if k in WorkflowStore.KINDS else "node"

    def _load(self):
        self.entries = _load_json_container(self.path, list)
        # migrate: stamp a kind on any pre-kinds entry
        changed = False
        for e in self.entries:
            if not e.get("kind"):
                e["kind"] = "node"
                changed = True
        if changed:
            self._save()

    def _save(self):
        return atomic_write_json(self.path, self.entries)

    def upsert(self, name, graph, kind="node"):
        name = (name or "").strip()
        if not name:
            return None
        kind = self._kind(kind)
        now = _dt.datetime.now().isoformat(timespec="seconds")
        for e in self.entries:
            if e.get("name") == name and self._kind(e.get("kind")) == kind:
                e["graph"] = graph
                e["kind"] = kind
                e["last_used"] = now
                self._save()
                return e
        new = {"name": name, "kind": kind, "graph": graph,
               "created_at": now, "last_used": now}
        self.entries.append(new)
        if len(self.entries) > self.MAX_ENTRIES:
            self.entries = self.entries[-self.MAX_ENTRIES:]
        self._save()
        return new

    def delete(self, name, kind="node"):
        kind = self._kind(kind)
        before = len(self.entries)
        self.entries = [
            e for e in self.entries
            if not (e.get("name") == name and self._kind(e.get("kind")) == kind)
        ]
        if len(self.entries) != before:
            self._save()
            return True
        return False

    def get(self, name, kind="node"):
        kind = self._kind(kind)
        for e in self.entries:
            if e.get("name") == name and self._kind(e.get("kind")) == kind:
                return e
        return None

    def all(self):
        """Lightweight summaries (no payloads) for the picker, each tagged with
        its kind so the UI can group them into IDE / Journal / Node sections."""
        out = []
        for e in sorted(self.entries, key=lambda e: e.get("last_used", ""),
                        reverse=True):
            g = e.get("graph") or {}
            kind = self._kind(e.get("kind"))
            item = {
                "name": e.get("name"),
                "kind": kind,
                "created_at": e.get("created_at"),
                "last_used": e.get("last_used"),
            }
            if kind == "node":
                item["nodes"] = len(g.get("nodes") or []) if isinstance(g, dict) else 0
                item["edges"] = len(g.get("edges") or []) if isinstance(g, dict) else 0
            elif kind == "ide":
                sql = g.get("sql") if isinstance(g, dict) else None
                item["preview"] = (sql or "")[:160]
            elif kind == "journal":
                cells = g.get("cells") if isinstance(g, dict) else None
                item["cells"] = len(cells) if isinstance(cells, list) else None
            elif kind == "dashboard":
                docs = g.get("dashboards") if isinstance(g, dict) else None
                if isinstance(docs, list):
                    item["dashboards"] = len(docs)
                    item["widgets"] = sum(
                        len(d.get("widgets") or d.get("cells") or [])
                        for d in docs if isinstance(d, dict)
                    )
                else:
                    widgets = g.get("widgets") or g.get("cells") if isinstance(g, dict) else None
                    item["widgets"] = len(widgets) if isinstance(widgets, list) else 0
            out.append(item)
        return out



class LoadManifestStore:
    """Remembers the CURRENT session's restorable loads for the next launch.

    Stored as a JSON list under the durable config dir
    (``session_manifest.json``). This is a session snapshot, not an
    unbounded load history: callers rewrite it to match currently loaded
    tables so a restart never replays orphaned older files. Only stable,
    re-readable sources belong here -- transient uploads and
    credential-bearing connections (SQL Server) are left out.
    """
    MAX_ENTRIES = 300

    def __init__(self, dirname=None,
                 filename="session_manifest.json"):
        self.path = app_config_dir(dirname) / filename
        self.entries = []
        self._load()

    def _load(self):
        self.entries = _load_json_container(self.path, list)

    def _save(self):
        return atomic_write_json(self.path, self.entries)

    def add(self, kind, path, destination="auto", base_name=None,
            recursive=False, origin=None):
        if not path:
            return
        # de-dupe by (kind, path): newest settings win, moved to the end
        self.entries = [e for e in self.entries
                        if not (e.get("kind") == kind
                                and e.get("path") == path)]
        entry = {
            "kind": kind, "path": path, "destination": destination,
            "base_name": base_name, "recursive": bool(recursive),
            "ts": _dt.datetime.now().isoformat(timespec="seconds"),
        }
        # .550: the ORIGINAL source, when known -- a browser upload's real
        # filename (browsers withhold the full path), or the full path for
        # a native/folder load. ``path`` is where SamQL parked/converted
        # the bytes; ``origin`` is where they came from.
        if origin:
            entry["origin"] = origin
        self.entries.append(entry)
        if len(self.entries) > self.MAX_ENTRIES:
            self.entries = self.entries[-self.MAX_ENTRIES:]
        self._save()

    def replace(self, entries):
        """Atomically replace the whole snapshot (latest successful persist)."""
        self.entries = list(entries or [])
        if len(self.entries) > self.MAX_ENTRIES:
            self.entries = self.entries[-self.MAX_ENTRIES:]
        self._save()

    def all(self):
        return list(self.entries)

    def remove_for_table(self, table_name):
        """Best-effort: drop a single-file entry whose target table matches a
        table the user just dropped, so the drop survives a restart."""
        if not table_name:
            return
        import os as _os
        t = str(table_name).lower()

        def _matches(e):
            if e.get("kind") != "file":
                return False
            bn = e.get("base_name")
            if bn and str(bn).lower() == t:
                return True
            stem = _os.path.splitext(
                _os.path.basename(e.get("path") or ""))[0]
            return stem.lower() == t

        before = len(self.entries)
        self.entries = [e for e in self.entries if not _matches(e)]
        if len(self.entries) != before:
            self._save()

    def clear(self):
        self.entries = []
        self._save()
