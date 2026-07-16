import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LoadThresholdsPanel } from "../components/LoadThresholdsPanel";
import { StorageMemoryModal } from "../components/StorageMemoryModal";

const thresholdsFixture = {
  ok: true,
  thresholds: {
    ondisk_mb: {
      value: 512,
      source: "default",
      default: 512,
      env: "SAMQL_ONDISK_MB",
      unit: "MB",
      label: "On-disk Parquet threshold",
      help: "help text",
      min: 0,
      max: 1048576,
      kind: "float",
      zero_means: "disable soft threshold",
    },
    ondisk_hard_mb: {
      value: 256,
      source: "default",
      default: 256,
      env: "SAMQL_ONDISK_HARD_MB",
      unit: "MB",
      label: "On-disk Parquet hard floor",
      help: "help",
      min: 0,
      max: 1048576,
      kind: "float",
      zero_means: "disable hard floor",
    },
    json_ondisk_mb: {
      value: 64,
      source: "default",
      default: 64,
      env: "SAMQL_JSON_ONDISK_MB",
      unit: "MB",
      label: "JSON on-disk Parquet threshold",
      help: "help",
      min: 0,
      max: 1048576,
      kind: "float",
      zero_means: "use generic threshold only",
    },
    json_stream_mb: {
      value: 32,
      source: "default",
      default: 32,
      env: "SAMQL_JSON_STREAM_MB",
      unit: "MB",
      label: "JSON → NDJSON rewrite threshold",
      help: "help",
      min: 1,
      max: 1048576,
      kind: "float",
      zero_means: null,
    },
    json_stream_flatten_mb: {
      value: 256,
      source: "default",
      default: 256,
      env: "SAMQL_JSON_STREAM_FLATTEN_MB",
      unit: "MB",
      label: "Single-object stream-flatten threshold",
      help: "help",
      min: 0,
      max: 1048576,
      kind: "float",
      zero_means: "disable",
    },
    json_object_mb: {
      value: 256,
      source: "default",
      default: 256,
      env: "SAMQL_JSON_OBJECT_MB",
      unit: "MB",
      label: "DuckDB JSON max object size",
      help: "help",
      min: 1,
      max: 1024,
      kind: "int",
      zero_means: null,
    },
    json_max_depth: {
      value: 2,
      source: "default",
      default: 2,
      env: "SAMQL_JSON_MAX_DEPTH",
      unit: "levels",
      label: "JSON load depth (flatten-off)",
      help: "help",
      min: 0,
      max: 32,
      kind: "int",
      zero_means: "single JSON column per row",
    },
    flatten_max_depth: {
      value: 64,
      source: "default",
      default: 64,
      env: "SAMQL_FLATTEN_MAX_DEPTH",
      unit: "levels",
      label: "Flatten nesting depth",
      help: "help",
      min: 1,
      max: 256,
      kind: "int",
      zero_means: null,
    },
    upload_mb: {
      value: 16384,
      source: "default",
      default: 16384,
      env: "SAMQL_UPLOAD_MB",
      unit: "MB",
      label: "Drag-drop upload ceiling",
      help: "help",
      min: 0,
      max: 1048576,
      kind: "int",
      zero_means: "unlimited",
    },
    filecache_gb: {
      value: 32,
      source: "default",
      default: 32,
      env: "SAMQL_FILECACHE_GB",
      unit: "GB",
      label: "Conversion cache budget",
      help: "help",
      min: 1,
      max: 1024,
      kind: "float",
      zero_means: null,
    },
  },
  overrides: {},
};

vi.mock("../lib/api", () => ({
  api: {
    loadThresholdsInfo: vi.fn(),
    loadThresholdsConfigure: vi.fn(),
    storageReport: vi.fn(),
    storageClean: vi.fn(),
    freeMemory: vi.fn(),
    sweepTemp: vi.fn(),
    flowCacheInfo: vi.fn(),
  },
}));

import { api } from "../lib/api";

describe("LoadThresholdsPanel", () => {
  beforeEach(() => {
    vi.mocked(api.loadThresholdsInfo).mockResolvedValue(thresholdsFixture as any);
    vi.mocked(api.loadThresholdsConfigure).mockImplementation(async (opts) => {
      if (opts.reset) return thresholdsFixture as any;
      const next = structuredClone(thresholdsFixture) as typeof thresholdsFixture;
      for (const [k, v] of Object.entries(opts.thresholds || {})) {
        const field = next.thresholds[k as keyof typeof next.thresholds];
        if (field) {
          field.value = v as number;
          field.source = "override";
        }
      }
      return next as any;
    });
  });

  it("loads fields and applies an ondisk override", async () => {
    const toast = vi.fn();
    render(<LoadThresholdsPanel onToast={toast} />);
    await waitFor(() =>
      expect(screen.getByTestId("load-threshold-ondisk_mb")).toBeInTheDocument(),
    );
    const input = screen.getByTestId("load-threshold-ondisk_mb") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "128" } });
    fireEvent.click(screen.getByTestId("load-thresholds-apply"));
    await waitFor(() =>
      expect(api.loadThresholdsConfigure).toHaveBeenCalledWith(
        expect.objectContaining({
          thresholds: expect.objectContaining({ ondisk_mb: 128 }),
        }),
      ),
    );
    expect(toast).toHaveBeenCalledWith(
      "ok",
      "Load thresholds saved",
      expect.any(String),
    );
  });
});

describe("StorageMemoryModal load thresholds tab", () => {
  it("shows the Load thresholds tab and panel", async () => {
    vi.mocked(api.loadThresholdsInfo).mockResolvedValue(thresholdsFixture as any);
    render(
      <StorageMemoryModal
        busy={false}
        report={null}
        mem={null}
        initialTab="loads"
        onClose={() => {}}
        onToast={() => {}}
        onRefreshReport={() => {}}
        onMemFreed={() => {}}
      />,
    );
    expect(screen.getByTestId("load-thresholds-tab")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("load-thresholds-panel")).toBeInTheDocument(),
    );
  });
});

describe("StorageMemoryModal JSON & flatten tab", () => {
  beforeEach(() => {
    vi.mocked(api.loadThresholdsInfo).mockResolvedValue(thresholdsFixture as any);
    vi.mocked(api.loadThresholdsConfigure).mockImplementation(async (opts) => {
      if (opts.reset) return thresholdsFixture as any;
      const next = structuredClone(thresholdsFixture) as typeof thresholdsFixture;
      for (const [k, v] of Object.entries(opts.thresholds || {})) {
        const field = next.thresholds[k as keyof typeof next.thresholds];
        if (field) {
          field.value = v as number;
          field.source = "override";
        }
      }
      return next as any;
    });
  });

  it("renders both depth controls at their defaults", async () => {
    render(
      <StorageMemoryModal
        busy={false}
        report={null}
        mem={null}
        initialTab="jsonflatten"
        onClose={() => {}}
        onToast={() => {}}
        onRefreshReport={() => {}}
        onMemFreed={() => {}}
      />,
    );
    expect(screen.getByTestId("json-flatten-tab")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("json-flatten-panel")).toBeInTheDocument(),
    );
    const depth = (await screen.findByTestId(
      "load-threshold-json_max_depth",
    )) as HTMLInputElement;
    expect(depth.value).toBe("2");
    const flat = screen.getByTestId(
      "load-threshold-flatten_max_depth",
    ) as HTMLInputElement;
    expect(flat.value).toBe("64");
  });

  it("saves an edited JSON load depth via the settings API", async () => {
    render(
      <StorageMemoryModal
        busy={false}
        report={null}
        mem={null}
        initialTab="jsonflatten"
        onClose={() => {}}
        onToast={() => {}}
        onRefreshReport={() => {}}
        onMemFreed={() => {}}
      />,
    );
    const depth = (await screen.findByTestId(
      "load-threshold-json_max_depth",
    )) as HTMLInputElement;
    fireEvent.change(depth, { target: { value: "4" } });
    fireEvent.click(screen.getByTestId("json-flatten-apply"));
    await waitFor(() =>
      expect(api.loadThresholdsConfigure).toHaveBeenCalledWith(
        expect.objectContaining({
          thresholds: expect.objectContaining({ json_max_depth: 4 }),
        }),
      ),
    );
  });
});
