import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  connectionProfilesList: vi.fn(),
  connectionProfilesUpsert: vi.fn(),
  connectionProfilesDelete: vi.fn(),
}));

vi.mock("./api", () => ({
  api: apiMock,
}));

import {
  deleteConnectionProfile,
  listConnectionProfiles,
  profileKey,
  upsertConnectionProfile,
} from "./connectionProfiles";

describe("connectionProfiles helpers", () => {
  beforeEach(() => {
    apiMock.connectionProfilesList.mockReset();
    apiMock.connectionProfilesUpsert.mockReset();
    apiMock.connectionProfilesDelete.mockReset();
  });

  it("builds mssql:/api: profile keys", () => {
    expect(profileKey("mssql", "Prod")).toBe("mssql:Prod");
    expect(profileKey("api", "  HR  ")).toBe("api:HR");
  });

  it("lists profiles and filters by kind", async () => {
    apiMock.connectionProfilesList.mockResolvedValue({
      profiles: [
        {
          key: "mssql:Prod",
          kind: "mssql",
          name: "Prod",
          fields: { server: "db1" },
        },
        {
          key: "api:HR",
          kind: "api",
          name: "HR",
          fields: { url: "https://example.test" },
        },
      ],
      secrets_available: true,
    });
    const all = await listConnectionProfiles();
    expect(all.map((p) => p.key)).toEqual(["mssql:Prod", "api:HR"]);
    const apis = await listConnectionProfiles("api");
    expect(apis).toEqual([
      {
        key: "api:HR",
        kind: "api",
        name: "HR",
        fields: { url: "https://example.test" },
      },
    ]);
  });

  it("upserts and returns the server profile", async () => {
    apiMock.connectionProfilesUpsert.mockResolvedValue({
      ok: true,
      profile: {
        key: "api:HR",
        kind: "api",
        name: "HR",
        fields: { url: "https://example.test" },
        has_secret: true,
      },
      has_secret: true,
      secrets_available: true,
    });
    const profile = await upsertConnectionProfile({
      kind: "api",
      name: "HR",
      fields: { url: "https://example.test" },
      password: "secret",
    });
    expect(apiMock.connectionProfilesUpsert).toHaveBeenCalledWith({
      kind: "api",
      name: "HR",
      fields: { url: "https://example.test" },
      password: "secret",
    });
    expect(profile.key).toBe("api:HR");
    expect(profile.has_secret).toBe(true);
  });

  it("deletes by key", async () => {
    apiMock.connectionProfilesDelete.mockResolvedValue({ ok: true });
    await deleteConnectionProfile("mssql:Prod");
    expect(apiMock.connectionProfilesDelete).toHaveBeenCalledWith(
      "mssql:Prod",
    );
  });
});
