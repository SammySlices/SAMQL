import { apiToken, expect, openApp, test } from "./fixtures";

test("HttpOnly capability cookie authenticates the API", async ({ page, request }) => {
  await openApp(page);
  const token = await apiToken(page);

  const unauthenticated = await request.get("/api/tables");
  expect(unauthenticated.status()).toBe(403);

  const authenticated = await request.get("/api/tables", {
    headers: { "X-SamQL-Token": token },
  });
  expect(authenticated.ok()).toBeTruthy();
});

test("hostile origins and oversized JSON are rejected", async ({
  page,
  request,
}) => {
  await openApp(page);
  const token = await apiToken(page);

  const hostile = await request.post("/api/nuke", {
    headers: {
      Origin: "https://evil.example",
      "X-SamQL-Token": token,
      "Content-Type": "application/json",
      Connection: "close",
    },
    data: {},
  });
  expect(hostile.status()).toBe(403);

  const oversized = await request.post("/api/query", {
    headers: {
      "X-SamQL-Token": token,
      "Content-Type": "application/json",
      Connection: "close",
    },
    data: JSON.stringify({ sql: "x".repeat(1024 * 1024) }),
  });
  expect(oversized.status()).toBe(413);
  const oversizedBody = await oversized.json();
  expect(String(oversizedBody.error || "")).toContain("SAMQL_JSON_BODY_MB");
});
