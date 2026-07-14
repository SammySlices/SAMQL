"""SharePoint authentication helpers.

Modes:
  * ``bearer`` — access token from the secret store (or test-only ``config.token``)
  * ``device_code`` / ``interactive`` — MSAL public-client OAuth; tokens persisted
    under the node's secret key as a small JSON blob (refreshable)
  * ``windows`` — current-user Negotiate/NTLM for classic on-prem SharePoint
    (no bearer token; transport handles auth)

MSAL and Windows Negotiate packages are optional; missing deps return a clear
error instead of crashing the app.
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any

# Well-known public client used by Azure CLI — works for device-code in many
# tenants without registering a custom app. Users can override client_id.
DEFAULT_PUBLIC_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
DEFAULT_TENANT = "organizations"
DEFAULT_SCOPES = (
    "https://graph.microsoft.com/Sites.Read.All",
    "https://graph.microsoft.com/Files.Read.All",
    "offline_access",
)

AUTH_MODES = frozenset({
    "bearer", "device_code", "interactive", "windows",
})


class SharePointAuthError(ValueError):
    """User-facing auth failure."""


def normalize_auth_mode(raw) -> str:
    mode = str(raw or "bearer").strip().lower().replace("-", "_")
    if mode in ("device", "devicecode"):
        mode = "device_code"
    if mode in ("browser", "msa", "msal", "oauth"):
        mode = "interactive"
    if mode in ("integrated", "negotiate", "ntlm", "sspi"):
        mode = "windows"
    if mode not in AUTH_MODES:
        mode = "bearer"
    return mode


def msal_available() -> bool:
    try:
        import importlib.util
        return importlib.util.find_spec("msal") is not None
    except Exception:
        return False


def windows_negotiate_available() -> bool:
    """True when a Negotiate HTTP client can be constructed on this box."""
    try:
        import importlib.util as iu
        if iu.find_spec("requests") is None:
            return False
        if iu.find_spec("requests_negotiate_sspi") is not None:
            return True
        if iu.find_spec("requests_negotiate") is not None:
            return True
    except Exception:
        return False
    return False


def _parse_oauth_blob(raw: str | None) -> dict | None:
    if not raw or not str(raw).strip().startswith("{"):
        return None
    try:
        data = json.loads(raw)
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("kind") != "oauth":
        return None
    return data


def _oauth_blob(access: str, refresh: str | None, expires_at: float,
                client_id: str, tenant_id: str, scopes: list[str]) -> str:
    return json.dumps({
        "kind": "oauth",
        "access_token": access,
        "refresh_token": refresh or "",
        "expires_at": float(expires_at or 0),
        "client_id": client_id,
        "tenant_id": tenant_id,
        "scopes": list(scopes),
    }, separators=(",", ":"))


def _pca(client_id: str, tenant_id: str):
    import msal  # type: ignore
    authority = "https://login.microsoftonline.com/%s" % (
        tenant_id or DEFAULT_TENANT)
    return msal.PublicClientApplication(client_id, authority=authority)


def _token_from_result(result: dict) -> tuple[str, str | None, float]:
    if not isinstance(result, dict):
        raise SharePointAuthError("Unexpected OAuth response.")
    if result.get("error"):
        desc = result.get("error_description") or result.get("error")
        raise SharePointAuthError(str(desc))
    access = (result.get("access_token") or "").strip()
    if not access:
        raise SharePointAuthError("OAuth did not return an access token.")
    refresh = (result.get("refresh_token") or "").strip() or None
    expires_in = result.get("expires_in")
    try:
        expires_at = time.time() + float(expires_in or 3600) - 60
    except (TypeError, ValueError):
        expires_at = time.time() + 3500
    return access, refresh, expires_at


def _cfg_client(cfg: dict) -> tuple[str, str, list[str]]:
    client_id = (cfg.get("client_id") or "").strip() or DEFAULT_PUBLIC_CLIENT_ID
    tenant_id = (cfg.get("tenant_id") or "").strip() or DEFAULT_TENANT
    scopes_raw = cfg.get("scopes")
    if isinstance(scopes_raw, str) and scopes_raw.strip():
        scopes = [s.strip() for s in scopes_raw.split() if s.strip()]
    elif isinstance(scopes_raw, (list, tuple)):
        scopes = [str(s).strip() for s in scopes_raw if str(s).strip()]
    else:
        scopes = list(DEFAULT_SCOPES)
    return client_id, tenant_id, scopes


def _secret_key(cfg: dict) -> str:
    sk = (cfg.get("secret_key") or "").strip()
    if not sk:
        # Stable default so sign-in can persist without an extra field.
        site = (cfg.get("site_url") or "sharepoint").strip()
        sk = "sharepoint:" + "".join(
            c if c.isalnum() else "_" for c in site[-48:]
        )
    return sk


def load_access_token(secrets, cfg: dict) -> str:
    """Return a usable access token string for bearer/Graph calls."""
    # Test / one-shot override
    if cfg.get("token"):
        return str(cfg.get("token") or "").strip()

    sk = (cfg.get("secret_key") or "").strip()
    if not sk:
        return ""
    try:
        raw = secrets.get(sk) or ""
    except Exception:
        raw = ""
    blob = _parse_oauth_blob(raw)
    if blob is None:
        return str(raw or "").strip()

    access = str(blob.get("access_token") or "").strip()
    expires_at = float(blob.get("expires_at") or 0)
    if access and expires_at > time.time():
        return access

    refresh = str(blob.get("refresh_token") or "").strip()
    if not refresh or not msal_available():
        return access  # may be expired; caller gets HTTP 401

    client_id = str(blob.get("client_id") or DEFAULT_PUBLIC_CLIENT_ID)
    tenant_id = str(blob.get("tenant_id") or DEFAULT_TENANT)
    scopes = blob.get("scopes") or list(DEFAULT_SCOPES)
    try:
        app = _pca(client_id, tenant_id)
        result = app.acquire_token_by_refresh_token(refresh, scopes=list(scopes))
        access, new_refresh, exp = _token_from_result(result)
        secrets.set(sk, _oauth_blob(
            access, new_refresh or refresh, exp, client_id, tenant_id,
            list(scopes)))
        return access
    except Exception:
        return access


def resolve_auth(session, cfg: dict) -> dict[str, Any]:
    """Return ``{mode, token, secret_key}`` for SharePoint HTTP calls."""
    cfg = dict(cfg or {})
    mode = normalize_auth_mode(cfg.get("auth_mode"))
    sk = _secret_key(cfg)
    if mode == "windows":
        return {"mode": "windows", "token": "", "secret_key": sk}
    token = load_access_token(session.secrets, {**cfg, "secret_key": sk})
    return {"mode": "bearer", "token": token, "secret_key": sk}


def start_device_code(session, cfg: dict) -> dict:
    """Begin MSAL device-code flow; stash state on the session for poll."""
    if not msal_available():
        raise SharePointAuthError(
            "Device-code sign-in needs the 'msal' package "
            "(pip install msal). Re-run the SamQL build to bundle it."
        )
    cfg = dict(cfg or {})
    client_id, tenant_id, scopes = _cfg_client(cfg)
    sk = _secret_key(cfg)
    app = _pca(client_id, tenant_id)
    flow = app.initiate_device_flow(scopes=scopes)
    if "user_code" not in flow:
        raise SharePointAuthError(
            flow.get("error_description")
            or flow.get("error")
            or "Could not start device-code sign-in."
        )
    flow_id = uuid.uuid4().hex
    store = getattr(session, "_sp_device_flows", None)
    if store is None:
        store = {}
        session._sp_device_flows = store
    store[flow_id] = {
        "flow": flow,
        "client_id": client_id,
        "tenant_id": tenant_id,
        "scopes": scopes,
        "secret_key": sk,
        "started": time.time(),
    }
    return {
        "ok": True,
        "flow_id": flow_id,
        "user_code": flow.get("user_code"),
        "verification_uri": flow.get("verification_uri")
            or flow.get("verification_uri_complete")
            or "https://microsoft.com/devicelogin",
        "message": flow.get("message") or (
            "Go to %s and enter code %s"
            % (flow.get("verification_uri"), flow.get("user_code"))
        ),
        "secret_key": sk,
        "expires_in": flow.get("expires_in"),
    }


def poll_device_code(session, flow_id: str, *, block: bool = False) -> dict:
    """Poll (or block once) for device-code completion; persist tokens."""
    if not msal_available():
        raise SharePointAuthError("msal is not available in this build.")
    store = getattr(session, "_sp_device_flows", None) or {}
    entry = store.get(flow_id)
    if not entry:
        raise SharePointAuthError(
            "Device-code session expired or unknown. Start sign-in again."
        )
    import msal  # type: ignore
    app = _pca(entry["client_id"], entry["tenant_id"])
    flow = entry["flow"]
    if block:
        result = app.acquire_token_by_device_flow(flow)
    else:
        # Non-blocking: one short attempt; MSAL blocks on interval by default,
        # so use a tiny timeout via flow copy when possible.
        flow_once = dict(flow)
        flow_once["interval"] = 1
        flow_once["expires_at"] = time.time() + 2
        try:
            result = app.acquire_token_by_device_flow(flow_once)
        except Exception as exc:
            return {"ok": True, "pending": True, "detail": str(exc)}

    if result.get("error") == "authorization_pending" or (
            result.get("error") and "pending" in str(
                result.get("error_description") or "").lower()):
        return {"ok": True, "pending": True}

    access, refresh, exp = _token_from_result(result)
    sk = entry["secret_key"]
    ok = session.secrets.set(
        sk,
        _oauth_blob(access, refresh, exp, entry["client_id"],
                    entry["tenant_id"], entry["scopes"]),
    )
    store.pop(flow_id, None)
    if not ok and not session.secrets.available:
        raise SharePointAuthError(
            "Signed in, but the OS secret store is unavailable — "
            "cannot save the token."
        )
    return {"ok": True, "stored": True, "secret_key": sk,
            "available": session.secrets.available}


def interactive_sign_in(session, cfg: dict) -> dict:
    """Browser / system-webview interactive MSAL sign-in; persist tokens."""
    if not msal_available():
        raise SharePointAuthError(
            "Interactive sign-in needs the 'msal' package "
            "(pip install msal). Re-run the SamQL build to bundle it."
        )
    cfg = dict(cfg or {})
    client_id, tenant_id, scopes = _cfg_client(cfg)
    sk = _secret_key(cfg)
    app = _pca(client_id, tenant_id)
    accounts = app.get_accounts()
    result = None
    if accounts:
        result = app.acquire_token_silent(scopes, account=accounts[0])
    if not result or not result.get("access_token"):
        result = app.acquire_token_interactive(scopes=scopes)
    access, refresh, exp = _token_from_result(result or {})
    ok = session.secrets.set(
        sk, _oauth_blob(access, refresh, exp, client_id, tenant_id, scopes))
    if not ok and not session.secrets.available:
        raise SharePointAuthError(
            "Signed in, but the OS secret store is unavailable — "
            "cannot save the token."
        )
    return {"ok": True, "stored": True, "secret_key": sk,
            "available": session.secrets.available}


def auth_capabilities() -> dict:
    return {
        "msal": msal_available(),
        "windows_negotiate": windows_negotiate_available(),
        "default_client_id": DEFAULT_PUBLIC_CLIENT_ID,
        "default_tenant": DEFAULT_TENANT,
        "modes": sorted(AUTH_MODES),
    }
