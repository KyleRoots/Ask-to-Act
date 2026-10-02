import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  bullhornTokensTable: {},
  usersTable: {},
  firmsTable: {},
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  sql: vi.fn(),
}));

const { __bullhornAuthTestHooks } = await import("./bullhorn-auth.js");

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env["BULLHORN_CLIENT_ID"] = "client-id";
  process.env["BULLHORN_CLIENT_SECRET"] = "client-secret";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("Bullhorn refresh token endpoint handling", () => {
  it("posts the refresh grant to the token endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh");
      return new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "new-refresh",
          expires_in: 600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      __bullhornAuthTestHooks.fetchTokenWithRefresh("https://oauth.example", "old-refresh"),
    ).resolves.toMatchObject({
      access_token: "access",
      refresh_token: "new-refresh",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth.example/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("classifies definitive invalid_grant separately from ambiguous errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 400 })),
    );

    await expect(
      __bullhornAuthTestHooks.fetchTokenWithRefresh("https://oauth.example", "old-refresh"),
    ).rejects.toMatchObject({ kind: "invalid_grant" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("temporarily unavailable", { status: 503 })),
    );

    await expect(
      __bullhornAuthTestHooks.fetchTokenWithRefresh("https://oauth.example", "old-refresh"),
    ).rejects.toMatchObject({ kind: "ambiguous" });
  });

  it("times out without claiming provider processing stopped", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      ),
    );

    const pending = __bullhornAuthTestHooks.fetchTokenWithRefresh(
      "https://oauth.example",
      "old-refresh",
    );
    const expectation = expect(pending).rejects.toMatchObject({
      kind: "ambiguous",
      message: expect.stringContaining("may still complete"),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;
  });
});
