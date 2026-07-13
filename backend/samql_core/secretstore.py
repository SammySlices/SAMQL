"""Encrypted storage for saved connection passwords.

On Windows, secrets are encrypted with DPAPI (CryptProtectData) tied to the
current user account -- the same mechanism the ``keyring`` package uses on
Windows, called directly through ``ctypes`` so we stay stdlib-only (a hard
requirement here: no third-party crypto). The encrypted blob is stored
base64-encoded in ``~/.json_csv_sql_explorer/secrets.json``.

On any non-Windows platform, or if DPAPI can't be loaded, encryption is
unavailable and NOTHING is stored -- a plaintext password is never written to
disk. Callers check ``available`` before offering to save a password.

The store logic is decoupled from the cipher: ``SecretStore`` takes a
``protector`` of (protect, unprotect) callables, defaulting to DPAPI. Tests
inject a reversible fake so the persistence logic is covered without Windows.
"""
import base64
import json
import os
import sys
import threading

from .stores import APP_CONFIG_DIRNAME

_DPAPI_DESC = "SamQL saved credential"
_CRYPTPROTECT_UI_FORBIDDEN = 0x01


def _build_dpapi():
    """Return (protect, unprotect) bound to crypt32, or None when DPAPI is
    unavailable (non-Windows, or the DLLs/symbols can't be loaded)."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD),
                        ("pbData", ctypes.POINTER(ctypes.c_char))]

        def _to_blob(data):
            buf = ctypes.create_string_buffer(bytes(data), len(data))
            return DATA_BLOB(len(data),
                             ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))

        def _from_blob(blob):
            return ctypes.string_at(blob.pbData, int(blob.cbData))

        _protect = crypt32.CryptProtectData
        _protect.restype = wintypes.BOOL
        _unprotect = crypt32.CryptUnprotectData
        _unprotect.restype = wintypes.BOOL
        _local_free = kernel32.LocalFree

        def protect(plaintext):
            data_in = _to_blob(str(plaintext).encode("utf-8"))
            data_out = DATA_BLOB()
            ok = _protect(ctypes.byref(data_in),
                          ctypes.c_wchar_p(_DPAPI_DESC),
                          None, None, None,
                          _CRYPTPROTECT_UI_FORBIDDEN,
                          ctypes.byref(data_out))
            if not ok:
                raise OSError(ctypes.get_last_error(),
                              "CryptProtectData failed")
            try:
                return _from_blob(data_out)
            finally:
                _local_free(data_out.pbData)

        def unprotect(blob):
            data_in = _to_blob(blob)
            data_out = DATA_BLOB()
            ok = _unprotect(ctypes.byref(data_in),
                            None, None, None, None,
                            _CRYPTPROTECT_UI_FORBIDDEN,
                            ctypes.byref(data_out))
            if not ok:
                raise OSError(ctypes.get_last_error(),
                              "CryptUnprotectData failed")
            try:
                return _from_blob(data_out).decode("utf-8")
            finally:
                _local_free(data_out.pbData)

        return protect, unprotect
    except Exception:
        return None


# Resolve once at import; cheap to reuse for capability checks.
_DPAPI = _build_dpapi()


def dpapi_available():
    """True when DPAPI encryption is usable (Windows + crypt32 loaded)."""
    return _DPAPI is not None


class SecretStore:
    """A small encrypted key -> secret store.

    ``protector`` is (protect, unprotect) where ``protect(str) -> bytes`` and
    ``unprotect(bytes) -> str``; the default ("dpapi") uses Windows DPAPI. When
    no protector is available, ``available`` is False and ``set`` is a no-op
    returning False -- a plaintext secret is never persisted.
    """

    def __init__(self, dirname=APP_CONFIG_DIRNAME, filename="secrets.json",
                 protector="dpapi"):
        self._lock = threading.RLock()
        self.path = os.path.join(os.path.expanduser("~"), dirname, filename)
        if protector == "dpapi":
            protector = _DPAPI
        self._protect = protector[0] if protector else None
        self._unprotect = protector[1] if protector else None
        self._data = self._load()

    @property
    def available(self):
        return self._protect is not None and self._unprotect is not None

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                d = json.load(fh)
            if isinstance(d, dict) and isinstance(d.get("secrets"), dict):
                return dict(d["secrets"])
        except Exception:
            pass
        return {}

    def _save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"secrets": self._data}, fh)
            os.replace(tmp, self.path)
            try:
                os.chmod(self.path, 0o600)
            except Exception:
                pass
        except Exception:
            pass

    def set(self, key, plaintext):
        """Encrypt + persist a secret. Returns True on success, False when
        encryption is unavailable or the input is empty (never stores
        plaintext)."""
        if not key or plaintext is None or plaintext == "":
            return False
        if not self.available:
            return False
        try:
            blob = self._protect(str(plaintext))
        except Exception:
            return False
        with self._lock:
            self._data[key] = base64.b64encode(bytes(blob)).decode("ascii")
            self._save()
        return True

    def get(self, key):
        """Decrypt + return a stored secret, or None if absent/undecryptable."""
        if not key or not self.available:
            return None
        with self._lock:
            b64 = self._data.get(key)
        if not b64:
            return None
        try:
            return self._unprotect(base64.b64decode(b64))
        except Exception:
            return None

    def has(self, key):
        with self._lock:
            return bool(self._data.get(key))

    def delete(self, key):
        with self._lock:
            if key in self._data:
                del self._data[key]
                self._save()
                return True
        return False
