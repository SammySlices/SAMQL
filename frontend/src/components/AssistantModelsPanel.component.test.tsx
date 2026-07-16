import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantModelsPanel } from "./AssistantModelsPanel";

vi.mock("../lib/api", () => ({
  api: {
    assistantModelsInfo: vi.fn(),
    assistantModelsConfigure: vi.fn(),
  },
}));

vi.mock("./load/FileBrowser", () => ({
  FileBrowser: ({ onPick, onClose }: any) => (
    <div data-testid="fake-file-browser">
      <button
        type="button"
        onClick={() => onPick("C:\\models\\extra.gguf")}
      >
        pick-gguf
      </button>
      <button type="button" onClick={onClose}>
        close-browser
      </button>
    </div>
  ),
}));

import { api } from "../lib/api";

const baseInfo = {
  ok: true,
  mode: "local" as const,
  models: [
    {
      id: "abc123",
      path: "C:\\models\\custom.gguf",
      label: "custom.gguf",
      exists: true,
    },
  ],
  selected_id: null as string | null,
  use_default: true,
  active_model_name: "Qwen3-4B-Instruct-2507",
  default_model: "C:\\assistant\\models\\qwen.gguf",
  pack_ok: true,
  api: {
    base_url: null as string | null,
    model: null as string | null,
    has_api_key: false,
    secrets_available: true,
    configured: false,
  },
};

describe("AssistantModelsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.assistantModelsInfo as any).mockResolvedValue({ ...baseInfo });
    (api.assistantModelsConfigure as any).mockImplementation(async (opts: any) => {
      if (opts?.mode === "api" || opts?.api || opts?.test_api) {
        return {
          ...baseInfo,
          mode: "api",
          api: {
            base_url: opts?.api?.base_url || "https://api.example.com",
            model: opts?.api?.model || "demo",
            has_api_key: Boolean(opts?.api?.api_key) || false,
            secrets_available: true,
            configured: true,
          },
          active_model_name: opts?.api?.model || "demo",
          api_probe: opts?.test_api
            ? { ok: true, probe: "models", model_ids: ["demo"] }
            : undefined,
        };
      }
      if (opts?.clear_api) {
        return { ...baseInfo, mode: "local" };
      }
      if (opts?.mode === "local") {
        return { ...baseInfo, mode: "local" };
      }
      if (opts?.add) {
        return {
          ...baseInfo,
          models: [
            ...baseInfo.models,
            {
              id: "new1",
              path: typeof opts.add === "string" ? opts.add : opts.add.path,
              label: "extra.gguf",
              exists: true,
            },
          ],
        };
      }
      if (opts?.use_default) {
        return { ...baseInfo, selected_id: null, use_default: true };
      }
      if (opts?.selected_id) {
        return {
          ...baseInfo,
          selected_id: opts.selected_id,
          use_default: false,
        };
      }
      if (opts?.remove_id) {
        return { ...baseInfo, models: [], selected_id: null, use_default: true };
      }
      return { ...baseInfo };
    });
  });

  it("lists registered models and can select one", async () => {
    const toast = vi.fn();
    render(<AssistantModelsPanel onToast={toast} />);
    await waitFor(() => {
      expect(screen.getByTestId("assistant-models-panel")).toBeTruthy();
    });
    expect(screen.getByTestId("assistant-model-default")).toBeChecked();
    fireEvent.click(screen.getByTestId("assistant-model-select-abc123"));
    await waitFor(() => {
      expect(api.assistantModelsConfigure).toHaveBeenCalledWith({
        selected_id: "abc123",
      });
    });
    expect(toast).toHaveBeenCalled();
  });

  it("browse adds a gguf via FileBrowser", async () => {
    const toast = vi.fn();
    render(<AssistantModelsPanel onToast={toast} />);
    await waitFor(() => screen.getByTestId("assistant-model-browse"));
    fireEvent.click(screen.getByTestId("assistant-model-browse"));
    fireEvent.click(screen.getByText("pick-gguf"));
    await waitFor(() => {
      expect(api.assistantModelsConfigure).toHaveBeenCalledWith({
        add: { path: "C:\\models\\extra.gguf" },
      });
    });
  });

  it("switches to API mode and saves base URL", async () => {
    const toast = vi.fn();
    render(<AssistantModelsPanel onToast={toast} />);
    await waitFor(() => screen.getByTestId("assistant-mode-api"));
    fireEvent.click(screen.getByTestId("assistant-mode-api"));
    await waitFor(() => {
      expect(api.assistantModelsConfigure).toHaveBeenCalledWith({
        mode: "api",
      });
    });
    await waitFor(() => screen.getByTestId("assistant-api-form"));
    fireEvent.change(screen.getByTestId("assistant-api-base"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.change(screen.getByTestId("assistant-api-model"), {
      target: { value: "demo-model" },
    });
    fireEvent.change(screen.getByTestId("assistant-api-key"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByTestId("assistant-api-save"));
    await waitFor(() => {
      expect(api.assistantModelsConfigure).toHaveBeenCalledWith({
        mode: "api",
        api: {
          base_url: "https://api.example.com/v1",
          model: "demo-model",
          api_key: "sk-test",
        },
      });
    });
  });

  it("tests API connection", async () => {
    (api.assistantModelsInfo as any).mockResolvedValue({
      ...baseInfo,
      mode: "api",
      api: {
        base_url: "https://api.example.com",
        model: "demo",
        has_api_key: false,
        secrets_available: true,
        configured: true,
      },
    });
    const toast = vi.fn();
    render(<AssistantModelsPanel onToast={toast} />);
    await waitFor(() => screen.getByTestId("assistant-api-test"));
    fireEvent.click(screen.getByTestId("assistant-api-test"));
    await waitFor(() => {
      expect(api.assistantModelsConfigure).toHaveBeenCalledWith(
        expect.objectContaining({ test_api: true, mode: "api" }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("assistant-api-probe").textContent).toMatch(
        /Connected/i,
      );
    });
  });
});
