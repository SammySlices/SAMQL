"""Per-user SamQL instance records (audit C-1).

A running server writes ``{port, pid, token, build}`` to a file only its own
user can read. The launcher reads that file to (a) learn the token it needs to
open the UI and (b) prove that the server answering on a port is OURS before
attaching to it: ``/api/health`` publishes ``token_fingerprint(token)``, and a
launcher attaches only when that matches the token in its own instance file.

On a shared Windows host (RDS/Citrix) every session shares loopback, so a
health marker alone (``app: samql``) can't tell user A's server from user B's.
The token never leaves the user's own profile directory; another user can
neither read the file nor derive the token from the fingerprint.

Stdlib only, and no samql_core import: the AppWindow launcher imports this on
its hot path.
"""
import hashlib
import json
import os
import socket
import tempfile

# Owner-only DACL, protected from inheritance: the file owner and SYSTEM get
# full control, nobody else gets anything. OW = OWNER RIGHTS (S-1-3-4).
_OWNER_ONLY_SDDL = "D:P(A;;FA;;;OW)(A;;FA;;;SY)"


def config_root(env=None):
    """Mirror ``samql_core.stores.app_config_dir`` without importing it:
    ``SAMQL_CONFIG_DIR`` wins, else ``~/.samql``."""
    env = os.environ if env is None else env
    configured = (env.get("SAMQL_CONFIG_DIR") or "").strip()
    if configured:
        return os.path.abspath(os.path.expanduser(configured))
    return os.path.join(os.path.expanduser("~"), ".samql")


def instance_dir(env=None):
    return os.path.join(config_root(env), "instances")


def instance_path(port, env=None):
    return os.path.join(instance_dir(env), "%d.json" % int(port))


def token_fingerprint(token):
    """Public, non-reversible identity of a server's token (64 bits of
    SHA-256). Safe to publish on the token-free /api/health."""
    token = str(token or "")
    if not token:
        return ""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def restrict_to_owner(path, os_name=None):
    """Make ``path`` readable by its owner only. Best effort: returns True
    when the restriction was applied."""
    os_name = os.name if os_name is None else os_name
    if os_name != "nt":
        try:
            os.chmod(path, 0o600 if os.path.isfile(path) else 0o700)
            return True
        except OSError:
            return False
    # Windows (not executed on the Linux CI): replace the inherited ACL with
    # an owner-only, protected DACL. The user profile is private by default;
    # this also covers a SAMQL_CONFIG_DIR pointed somewhere shared.
    try:
        import ctypes
        from ctypes import wintypes
        advapi = ctypes.windll.advapi32
        kernel = ctypes.windll.kernel32
        sd = ctypes.c_void_p()
        conv = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
        conv.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
                         ctypes.POINTER(ctypes.c_void_p),
                         ctypes.POINTER(wintypes.ULONG)]
        conv.restype = wintypes.BOOL
        if not conv(_OWNER_ONLY_SDDL, 1, ctypes.byref(sd), None):
            return False
        try:
            setsec = advapi.SetFileSecurityW
            setsec.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
                               ctypes.c_void_p]
            setsec.restype = wintypes.BOOL
            DACL_SECURITY_INFORMATION = 0x00000004
            PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
            return bool(setsec(
                str(path),
                DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION, sd))
        finally:
            kernel.LocalFree(sd)
    except Exception:
        return False


def write_instance(port, token, pid=None, build="", env=None):
    """Atomically publish this server's instance record. The temp file is
    locked down BEFORE it is renamed into place, so the token is never
    visible under a readable name."""
    folder = instance_dir(env)
    os.makedirs(folder, exist_ok=True)
    restrict_to_owner(folder)
    record = {"port": int(port), "pid": int(pid or os.getpid()),
              "token": str(token), "build": str(build or "")}
    fd, tmp = tempfile.mkstemp(prefix=".inst_", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            restrict_to_owner(tmp)
            json.dump(record, fh)
        final = instance_path(port, env)
        os.replace(tmp, final)
        restrict_to_owner(final)
        return final
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_instance(port, env=None):
    try:
        with open(instance_path(port, env), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not data.get("token"):
        return None
    return data


def list_instances(env=None):
    """Every readable instance record of this user, lowest port first."""
    try:
        names = os.listdir(instance_dir(env))
    except OSError:
        return []
    out = []
    for name in names:
        stem, ext = os.path.splitext(name)
        if ext != ".json" or not stem.isdigit():
            continue
        data = read_instance(int(stem), env)
        if data is not None:
            out.append(data)
    return sorted(out, key=lambda d: int(d.get("port") or 0))


def remove_instance(port, pid=None, env=None):
    """Remove the record for ``port`` if it is ours (``pid`` matches)."""
    data = read_instance(port, env)
    if data is None:
        return False
    if pid is not None and int(data.get("pid") or 0) != int(pid):
        return False
    try:
        os.unlink(instance_path(port, env))
        return True
    except OSError:
        return False


def owned_token(port, health, env=None):
    """The token for the server on ``port`` when, and only when, it is this
    user's: its health fingerprint must match our own instance record."""
    if not isinstance(health, dict):
        return None
    if str(health.get("app") or "").lower() != "samql":
        return None
    data = read_instance(port, env)
    if data is None:
        return None
    published = str(health.get("instance") or "")
    if not published or published != token_fingerprint(data["token"]):
        return None
    return str(data["token"])


def launch_url(port, token=None):
    base = "http://127.0.0.1:%d/" % int(port)
    if not token:
        return base
    from urllib.parse import quote
    return base + "?t=" + quote(str(token), safe="")


def exclusive_bind(sock, os_name=None):
    """Refuse to share a port that is already bound. On Windows
    SO_REUSEADDR lets a second socket bind a LISTENING port (another user's
    server), so use SO_EXCLUSIVEADDRUSE there. Elsewhere SO_REUSEADDR only
    skips TIME_WAIT and never shares a live listener, so keep it."""
    os_name = os.name if os_name is None else os_name
    if os_name == "nt":
        opt = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if opt is not None:
            sock.setsockopt(socket.SOL_SOCKET, opt, 1)
        return "exclusive"
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    return "reuse"


def free_port(preferred, host="127.0.0.1", span=50):
    """First port at or after ``preferred`` this process could bind
    exclusively (0 when none in the span)."""
    for port in [preferred] + list(range(preferred + 1, preferred + span)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sk:
            try:
                exclusive_bind(sk)
                sk.bind((host, port))
                return port
            except OSError:
                continue
    return 0
