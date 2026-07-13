"""Named connection profiles (non-secret fields) paired with SecretStore.

Passwords stay in ``SecretStore`` under keys ``mssql:<name>`` / ``api:<name>``.
This module persists the rest of the profile (server, URL, auth user, etc.)
so Load tabs and NodeFlow nodes can reuse a named profile by key without
embedding credentials in workflows or localStorage.
"""
from __future__ import annotations

import os
import threading
from typing import Any

from .stores import APP_CONFIG_DIRNAME, atomic_write_json


def profile_key(kind: str, name: str) -> str:
    kind = (kind or "").strip().lower()
    name = (name or "").strip()
    if kind not in ("mssql", "api"):
        raise ValueError("kind must be 'mssql' or 'api'")
    if not name:
        raise ValueError("profile name is required")
    return "%s:%s" % (kind, name)


def parse_profile_key(key: str) -> tuple[str, str] | None:
    key = (key or "").strip()
    if ":" not in key:
        return None
    kind, name = key.split(":", 1)
    kind = kind.strip().lower()
    name = name.strip()
    if kind not in ("mssql", "api") or not name:
        return None
    return kind, name


class ConnectionProfileStore:
    """JSON registry of connection profiles (no passwords)."""

    def __init__(self, dirname=APP_CONFIG_DIRNAME,
                 filename="connection_profiles.json"):
        self._lock = threading.RLock()
        self.path = os.path.join(os.path.expanduser("~"), dirname, filename)
        self._data: dict[str, Any] = {"profiles": {}}
        self._load()

    def _load(self) -> None:
        try:
            if not os.path.isfile(self.path):
                return
            import json
            with open(self.path, encoding="utf-8") as fh:
                raw = json.load(fh)
            if isinstance(raw, dict) and isinstance(raw.get("profiles"), dict):
                self._data = {"profiles": dict(raw["profiles"])}
        except Exception:
            self._data = {"profiles": {}}

    def _save(self) -> bool:
        return bool(atomic_write_json(self.path, self._data))

    def list(self, *, secrets=None) -> list[dict[str, Any]]:
        with self._lock:
            out = []
            for key, entry in sorted(self._data["profiles"].items()):
                if not isinstance(entry, dict):
                    continue
                kind = entry.get("kind") or (parse_profile_key(key) or ("", ""))[0]
                name = entry.get("name") or (parse_profile_key(key) or ("", ""))[1]
                has_secret = False
                if secrets is not None:
                    try:
                        has_secret = bool(secrets.has(key))
                    except Exception:
                        has_secret = False
                out.append({
                    "key": key,
                    "kind": kind,
                    "name": name,
                    "fields": dict(entry.get("fields") or {}),
                    "has_secret": has_secret,
                })
            return out

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._data["profiles"].get(key)
            if not isinstance(entry, dict):
                return None
            return {
                "key": key,
                "kind": entry.get("kind"),
                "name": entry.get("name"),
                "fields": dict(entry.get("fields") or {}),
            }

    def upsert(self, kind: str, name: str, fields: dict | None) -> dict[str, Any]:
        key = profile_key(kind, name)
        with self._lock:
            self._data["profiles"][key] = {
                "kind": kind.strip().lower(),
                "name": name.strip(),
                "fields": dict(fields or {}),
            }
            self._save()
            return self.get(key) or {"key": key}

    def delete(self, key: str) -> bool:
        with self._lock:
            if key not in self._data["profiles"]:
                return False
            del self._data["profiles"][key]
            self._save()
            return True
