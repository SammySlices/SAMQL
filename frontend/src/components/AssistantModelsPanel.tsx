import React, { useCallback, useEffect, useState } from "react";
import { api, type AssistantModelsInfo, type AssistantModelEntry } from "../lib/api";
import { FileBrowser } from "./load/FileBrowser";
import { Icon } from "./Icon";
import { Modal } from "./Modal";

type ToastFn = (
  kind: "ok" | "error" | "warn",
  title: string,
  msg?: string,
) => void;

type AssistantMode = "local" | "api";

/**
 * Settings panel: local .gguf library OR OpenAI-compatible API endpoint.
 *
 * Assistant-only — does not touch load/join/flatten.
 */
export const AssistantModelsPanel: React.FC<{
  onToast: ToastFn;
  embedded?: boolean;
}> = ({ onToast, embedded }) => {
  const [info, setInfo] = useState<AssistantModelsInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);
  const [apiBase, setApiBase] = useState("");
  const [apiModel, setApiModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [probeMsg, setProbeMsg] = useState("");

  const apply = useCallback((next: AssistantModelsInfo) => {
    setInfo(next);
    setError("");
    if (next?.api) {
      setApiBase(next.api.base_url || "");
      setApiModel(next.api.model || "");
    }
    // Never echo the key; leave the password field blank after load/save.
    setApiKey("");
    if (next?.api_probe) {
      if (next.api_probe.ok) {
        const n = next.api_probe.model_ids?.length;
        setProbeMsg(
          n != null && n > 0
            ? `Connected — ${n} model id(s) listed`
            : `Connected via ${next.api_probe.probe || "API"}`,
        );
      } else {
        setProbeMsg(next.api_probe.error || "Connection failed");
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.assistantModelsInfo();
      apply(next);
      setProbeMsg("");
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (
    action: () => Promise<AssistantModelsInfo>,
    okTitle: string,
    okMsg?: string,
  ) => {
    setBusy(true);
    setError("");
    try {
      const next = await action();
      apply(next);
      if (next?.api_probe && !next.api_probe.ok) {
        onToast("warn", "SQL assistant", next.api_probe.error || "Probe failed");
      } else {
        onToast("ok", okTitle, okMsg);
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      setError(msg);
      onToast("error", "SQL assistant", msg);
    } finally {
      setBusy(false);
    }
  };

  const mode: AssistantMode =
    info?.mode === "api" ? "api" : "local";
  const models: AssistantModelEntry[] = info?.models || [];
  const selectedId = info?.selected_id ?? null;
  const useDefault = info?.use_default !== false && !selectedId;

  const setMode = (next: AssistantMode) => {
    void run(
      () => api.assistantModelsConfigure({ mode: next }),
      next === "api" ? "Using API endpoint" : "Using local models",
      next === "api"
        ? "Chat will call the configured OpenAI-compatible URL when DuckDB is idle"
        : "Chat will use the local pack / selected GGUF when available",
    );
  };

  const saveApi = () => {
    const body: {
      mode: "api";
      api: { base_url: string; model: string; api_key?: string };
    } = {
      mode: "api",
      api: {
        base_url: apiBase.trim(),
        model: apiModel.trim(),
      },
    };
    if (apiKey.trim()) {
      body.api.api_key = apiKey.trim();
    }
    void run(
      () => api.assistantModelsConfigure(body),
      "API settings saved",
      apiBase.trim() || "Base URL cleared",
    );
  };

  const testApi = () => {
    const body: {
      mode: "api";
      test_api: true;
      api: { base_url: string; model: string; api_key?: string };
    } = {
      mode: "api",
      test_api: true,
      api: {
        base_url: apiBase.trim(),
        model: apiModel.trim(),
      },
    };
    if (apiKey.trim()) {
      body.api.api_key = apiKey.trim();
    }
    void run(
      () => api.assistantModelsConfigure(body),
      "API connection OK",
      "OpenAI-compatible endpoint reachable",
    );
  };

  const clearApi = () => {
    void run(
      () => api.assistantModelsConfigure({ clear_api: true, mode: "local" }),
      "API settings cleared",
      "Switched back to local models",
    );
    setProbeMsg("");
  };

  const body = (
    <div className="asst-models-panel" data-testid="assistant-models-panel">
      <div className="hint" style={{ marginBottom: 10 }}>
        Choose a <strong>local GGUF</strong> (offline llama-server pack — no
        internet at chat time) or an <strong>OpenAI-compatible API</strong> (
        <span className="mono">POST …/v1/chat/completions</span>; uses the
        network when the base URL is remote). The SQL assistant only runs while
        DuckDB is idle. API keys are stored with Windows DPAPI when available
        and are never shown again after save.
      </div>

      {error && (
        <div className="error-box" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}

      <div
        className="asst-mode-tabs"
        role="tablist"
        aria-label="SQL assistant source"
        style={{
          display: "flex",
          gap: 6,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          role="tab"
          className={"btn sm" + (mode === "local" ? " primary" : " ghost")}
          data-testid="assistant-mode-local"
          aria-selected={mode === "local"}
          disabled={busy}
          onClick={() => setMode("local")}
        >
          Local models
        </button>
        <button
          type="button"
          role="tab"
          className={"btn sm" + (mode === "api" ? " primary" : " ghost")}
          data-testid="assistant-mode-api"
          aria-selected={mode === "api"}
          disabled={busy}
          onClick={() => setMode("api")}
        >
          API
        </button>
      </div>

      {mode === "api" ? (
        <div
          className="asst-api-form"
          data-testid="assistant-api-form"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <label className="field">
            <span className="faint" style={{ fontSize: 12 }}>
              Base URL
            </span>
            <input
              className="input mono"
              data-testid="assistant-api-base"
              placeholder="https://api.openai.com or http://127.0.0.1:8080"
              value={apiBase}
              disabled={busy}
              onChange={(e) => setApiBase(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="faint" style={{ fontSize: 12 }}>
              Model id (optional)
            </span>
            <input
              className="input mono"
              data-testid="assistant-api-model"
              placeholder="gpt-4o-mini / qwen2.5-coder / …"
              value={apiModel}
              disabled={busy}
              onChange={(e) => setApiModel(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="faint" style={{ fontSize: 12 }}>
              API key (optional)
              {info?.api?.has_api_key ? " — saved key on file" : ""}
              {info?.api?.secrets_available === false
                ? " — DPAPI unavailable; key kept in memory for this session only"
                : ""}
            </span>
            <input
              className="input mono"
              type="password"
              data-testid="assistant-api-key"
              placeholder={
                info?.api?.has_api_key
                  ? "•••••••• (leave blank to keep)"
                  : "sk-… or leave blank"
              }
              value={apiKey}
              disabled={busy}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
            />
          </label>

          <div className="hint" style={{ fontSize: 12 }}>
            How-to: point Base URL at any OpenAI-compatible server (OpenAI,
            Azure OpenAI gateway, llama-server, LM Studio, vLLM, etc.). SamQL
            calls <span className="mono">/v1/chat/completions</span>. Leave the
            key blank for local loopback servers that do not require auth.
          </div>

          {probeMsg && (
            <div
              className="faint"
              data-testid="assistant-api-probe"
              style={{ fontSize: 12 }}
            >
              {probeMsg}
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button
              type="button"
              className="btn primary"
              data-testid="assistant-api-save"
              disabled={busy}
              onClick={() => saveApi()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn"
              data-testid="assistant-api-test"
              disabled={busy || !apiBase.trim()}
              onClick={() => testApi()}
            >
              Test connection
            </button>
            <button
              type="button"
              className="btn ghost sm"
              data-testid="assistant-api-clear"
              disabled={busy}
              onClick={() => clearApi()}
            >
              Clear API
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => void refresh()}
              title="Refresh"
            >
              <Icon.Refresh size={14} />
            </button>
            {info?.api?.configured && (
              <span className="faint" style={{ fontSize: 12 }}>
                Active:{" "}
                <span className="mono">
                  {info.active_model_name || info.api.model || "API"}
                </span>
              </span>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="hint" style={{ marginBottom: 10 }}>
            Local mode stays offline at runtime: SamQL talks only to a
            loopback llama-server with a local{" "}
            <span className="mono">.gguf</span> (no tools / web fetch). Register
            models from this PC, then pick which one the SQL assistant uses. If
            none is selected, SamQL uses pack discovery under{" "}
            <span className="mono">assistant/models/</span> (4B when present,
            otherwise the only GGUF found).
          </div>

          <div
            className="asst-models-list"
            role="radiogroup"
            aria-label="Active SQL assistant model"
            style={{ display: "flex", flexDirection: "column", gap: 6 }}
          >
            <label
              className="asst-model-row"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "8px 6px",
                borderRadius: 6,
                border: "1px solid var(--border, #ddd)",
              }}
            >
              <input
                type="radio"
                name="asst-model"
                data-testid="assistant-model-default"
                checked={useDefault}
                disabled={busy}
                onChange={() =>
                  void run(
                    () => api.assistantModelsConfigure({ use_default: true }),
                    "Using default pack model",
                    "Next chat will load the pack GGUF when present",
                  )
                }
              />
              <span>
                <strong>Use default pack model</strong>
                <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                  {info?.default_model
                    ? info.default_model
                    : info?.pack_ok === false
                      ? info.pack_hint || "Pack model not found yet"
                      : "Pack discovery (assistant/models/)"}
                </div>
              </span>
            </label>

            {models.map((m) => (
              <label
                key={m.id}
                className="asst-model-row"
                data-testid={`assistant-model-row-${m.id}`}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "8px 6px",
                  borderRadius: 6,
                  border: "1px solid var(--border, #ddd)",
                }}
              >
                <input
                  type="radio"
                  name="asst-model"
                  data-testid={`assistant-model-select-${m.id}`}
                  checked={selectedId === m.id}
                  disabled={busy || m.exists === false}
                  onChange={() =>
                    void run(
                      () =>
                        api.assistantModelsConfigure({ selected_id: m.id }),
                      "Active model updated",
                      m.label,
                    )
                  }
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{m.label}</strong>
                  {!m.exists && (
                    <span className="faint" style={{ marginLeft: 6 }}>
                      (missing)
                    </span>
                  )}
                  <div
                    className="faint mono"
                    style={{
                      fontSize: 11,
                      marginTop: 2,
                      wordBreak: "break-all",
                    }}
                    title={m.path}
                  >
                    {m.path}
                  </div>
                </span>
                <button
                  type="button"
                  className="btn sm ghost"
                  data-testid={`assistant-model-remove-${m.id}`}
                  disabled={busy}
                  title="Remove from library (does not delete the file)"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void run(
                      () =>
                        api.assistantModelsConfigure({ remove_id: m.id }),
                      "Model removed from library",
                    );
                  }}
                >
                  Remove
                </button>
              </label>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              marginTop: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button
              type="button"
              className="btn"
              data-testid="assistant-model-browse"
              disabled={busy}
              onClick={() => setBrowseOpen(true)}
            >
              <Icon.Folder size={14} /> Browse for .gguf…
            </button>
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => void refresh()}
              title="Refresh"
            >
              <Icon.Refresh size={14} />
            </button>
            {info?.active_model_name && (
              <span className="faint" style={{ fontSize: 12 }}>
                Active:{" "}
                <span className="mono">{info.active_model_name}</span>
                {info.preferred_missing
                  ? " (selected file missing — using pack default)"
                  : ""}
              </span>
            )}
          </div>
        </>
      )}

      {browseOpen && (
        <FileBrowser
          acceptExt="gguf"
          onClose={() => setBrowseOpen(false)}
          onPick={(path) => {
            setBrowseOpen(false);
            void run(
              () => api.assistantModelsConfigure({ add: { path } }),
              "Model added",
              path,
            );
          }}
        />
      )}
    </div>
  );

  if (embedded) return body;

  return body;
};

export const AssistantModelsModal: React.FC<{
  onClose: () => void;
  onToast: ToastFn;
}> = ({ onClose, onToast }) => (
  <Modal
    title="SQL assistant"
    onClose={onClose}
    wide
    testId="assistant-models-modal"
  >
    <AssistantModelsPanel onToast={onToast} embedded />
  </Modal>
);
