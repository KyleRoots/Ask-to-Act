import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  const writes: Array<{
    userId: string;
    values: Record<string, unknown>;
    set: Record<string, unknown>;
  }> = [];

  function columnName(column: unknown): string {
    if (typeof column === "string") return column;
    if (
      column &&
      typeof column === "object" &&
      "name" in column &&
      typeof column.name === "string"
    ) {
      return column.name;
    }
    return "unknown";
  }

  function eq(column: unknown, value: unknown) {
    return { column: columnName(column), value };
  }

  function and(...parts: Array<{ column: string; value: unknown }>) {
    return parts;
  }

  function createDb() {
    return {
      select(_shape?: unknown) {
        const query: {
          table?: string;
          where?: Array<{ column: string; value: unknown }>;
        } = {};
        const builder = {
          from(table: { _name?: string } | string) {
            query.table = typeof table === "string" ? table : table._name;
            return builder;
          },
          where(
            condition:
              | { column: string; value: unknown }
              | Array<{ column: string; value: unknown }>,
          ) {
            query.where = Array.isArray(condition) ? condition : [condition];
            return builder;
          },
          limit(_count?: number) {
            if (query.table === "users") {
              const userId = query.where?.find((part) => part.column === "id")?.value;
              if (typeof userId === "string") return Promise.resolve([{ id: userId }]);
              return Promise.resolve([]);
            }
            const userId = query.where?.find((part) => part.column === "userId")?.value;
            if (typeof userId !== "string") return Promise.resolve([]);
            const row = rows.get(userId);
            return Promise.resolve(row ? [{ ...row }] : []);
          },
        };
        return builder;
      },
      insert(_table?: unknown) {
        let values: Record<string, unknown> = {};
        const builder = {
          values(next: Record<string, unknown>) {
            values = next;
            return builder;
          },
          onConflictDoUpdate(config: { set: Record<string, unknown> }) {
            const userId = String(values.userId);
            const existing = rows.get(userId);
            if (existing) {
              rows.set(userId, { ...existing, ...config.set });
            } else {
              rows.set(userId, { ...values });
            }
            writes.push({
              userId,
              values: { ...values },
              set: { ...config.set },
            });
            return Promise.resolve();
          },
        };
        return builder;
      },
      delete(_table?: unknown) {
        return {
          where(
            condition:
              | { column: string; value: unknown }
              | Array<{ column: string; value: unknown }>,
          ) {
            const parts = Array.isArray(condition) ? condition : [condition];
            const userId = parts.find((part) => part.column === "userId")?.value;
            if (typeof userId === "string") rows.delete(userId);
            return Promise.resolve();
          },
        };
      },
    };
  }

  return { rows, writes, eq, and, createDb };
});

vi.mock("@workspace/db", () => ({
  db: state.createDb(),
  userMailboxesTable: {
    _name: "user_mailboxes",
    userId: "userId",
    provider: "provider",
  },
  usersTable: {
    _name: "users",
    id: "id",
    name: "name",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: state.eq,
  and: state.and,
}));

const {
  getUserMailboxSession,
  MailboxNotConnectedError,
  MailboxReconnectRequiredError,
} = await import("./m365-auth.js");

const originalEnv = { ...process.env };
const TOKEN_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";

function seedMailbox(input: {
  userId: string;
  refreshToken: string | null;
  accessToken?: string | null;
  mailboxEmail?: string | null;
  tokenExpiresAt?: number | null;
  revokedAt?: Date | null;
}) {
  state.rows.set(input.userId, {
    userId: input.userId,
    provider: "microsoft365",
    mailboxEmail: input.mailboxEmail ?? "recruiter@example.com",
    refreshToken: input.refreshToken,
    accessToken: input.accessToken ?? null,
    tokenExpiresAt: input.tokenExpiresAt ?? null,
    revokedAt: input.revokedAt ?? null,
    lastError: null,
    scope: "offline_access openid profile email User.Read Mail.Send",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function sessionWritesFor(userId: string) {
  return state.writes.filter(
    (write) =>
      write.userId === userId &&
      ("accessToken" in write.set || "accessToken" in write.values),
  );
}

function requestUrl(input: string): string {
  return input;
}

function refreshTokenFrom(init?: RequestInit): string | null {
  const body = init?.body;
  if (body instanceof URLSearchParams) return body.get("refresh_token");
  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  state.rows.clear();
  state.writes.length = 0;
  process.env["M365_CLIENT_ID"] = "test-client-id";
  process.env["M365_CLIENT_SECRET"] = "test-client-secret";
  process.env["M365_REDIRECT_URI"] = "https://example.test/m365/callback";
  process.env["LOG_LEVEL"] = "silent";
  delete process.env["TOKEN_ENCRYPTION_KEY"];
  delete process.env["M365_TENANT_ID"];
  delete process.env["M365_SCOPE"];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("getUserMailboxSession refresh token handling", () => {
  it("returns the in-memory session without calling the token endpoint or writing", async () => {
    const userId = "user-m365-memory-valid";
    seedMailbox({
      userId,
      refreshToken: "stored-refresh",
      accessToken: "memory-access",
      mailboxEmail: "memory@example.com",
      tokenExpiresAt: Date.now() + 10 * 60 * 1000,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const first = await getUserMailboxSession(userId);
    expect(first).toMatchObject({
      accessToken: "memory-access",
      mailboxEmail: "memory@example.com",
    });

    const writesBefore = state.writes.length;
    const second = await getUserMailboxSession(userId);

    expect(second).toEqual(first);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.writes.length).toBe(writesBefore);
    expect(sessionWritesFor(userId)).toEqual([]);
  });

  it("returns a still-valid stored session without calling the token endpoint", async () => {
    const userId = "user-m365-stored-valid";
    seedMailbox({
      userId,
      refreshToken: "stored-refresh",
      accessToken: "stored-access",
      mailboxEmail: "stored@example.com",
      tokenExpiresAt: Date.now() + 10 * 60 * 1000,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const session = await getUserMailboxSession(userId);

    expect(session).toMatchObject({
      provider: "microsoft365",
      accessToken: "stored-access",
      mailboxEmail: "stored@example.com",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionWritesFor(userId)).toEqual([]);
  });

  it("stores the new refresh token and access token from the token response", async () => {
    const userId = "user-m365-refresh-rotated";
    seedMailbox({
      userId,
      refreshToken: "previous-refresh",
      accessToken: "expired-access",
      mailboxEmail: "old@example.com",
      tokenExpiresAt: Date.now() - 10 * 60 * 1000,
    });
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === TOKEN_URL) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeInstanceOf(URLSearchParams);
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("previous-refresh");
        expect(body.get("client_id")).toBe("test-client-id");
        return jsonResponse({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }
      return jsonResponse({
        mail: "Rotated@Example.com",
        userPrincipalName: "rotated@example.com",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await getUserMailboxSession(userId);

    expect(session).toMatchObject({
      accessToken: "rotated-access",
      mailboxEmail: "rotated@example.com",
    });
    expect(state.rows.get(userId)).toMatchObject({
      refreshToken: "rotated-refresh",
      accessToken: "rotated-access",
      mailboxEmail: "rotated@example.com",
    });
    expect(fetchMock).toHaveBeenCalledWith(TOKEN_URL, expect.objectContaining({ method: "POST" }));
  });

  it("keeps the previous refresh token when the token response omits it", async () => {
    const userId = "user-m365-refresh-omitted";
    seedMailbox({
      userId,
      refreshToken: "previous-refresh",
      accessToken: "expired-access",
      tokenExpiresAt: Date.now() - 10 * 60 * 1000,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (requestUrl(input) === TOKEN_URL) {
          return jsonResponse({
            access_token: "renewed-access",
            expires_in: 3600,
          });
        }
        return jsonResponse({ mail: "kept@example.com" });
      }),
    );

    const session = await getUserMailboxSession(userId);

    expect(session.accessToken).toBe("renewed-access");
    const stored = state.rows.get(userId);
    expect(stored?.refreshToken).toBe("previous-refresh");
    expect(stored?.accessToken).toBe("renewed-access");
    expect(stored?.refreshToken).not.toBeNull();
    expect(stored?.refreshToken).not.toBe("");
    const sessionWrite = sessionWritesFor(userId).at(-1);
    expect(sessionWrite?.set.refreshToken).toBe("previous-refresh");
    expect(sessionWrite?.set.refreshToken).not.toBeNull();
    expect(sessionWrite?.set.refreshToken).not.toBe("");
  });

  it("throws and does not write a session when the response and the row both lack a refresh token", async () => {
    const userId = "user-m365-refresh-gone";
    seedMailbox({
      userId,
      refreshToken: "vanish-refresh",
      accessToken: "expired-access",
      tokenExpiresAt: Date.now() - 10 * 60 * 1000,
    });
    const writesBefore = state.writes.length;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (requestUrl(input) === TOKEN_URL) {
          const row = state.rows.get(userId);
          if (row) row.refreshToken = null;
          return jsonResponse({
            access_token: "should-not-store",
            expires_in: 3600,
          });
        }
        return jsonResponse({ mail: "gone@example.com" });
      }),
    );

    await expect(getUserMailboxSession(userId)).rejects.toBeInstanceOf(
      MailboxReconnectRequiredError,
    );

    const laterWrites = state.writes.slice(writesBefore);
    expect(laterWrites.some((write) => "accessToken" in write.set || "accessToken" in write.values)).toBe(
      false,
    );
    for (const write of laterWrites) {
      expect(write.values.refreshToken).toBeUndefined();
      expect(write.set.refreshToken).toBeUndefined();
    }
    expect(JSON.stringify(laterWrites)).not.toContain("should-not-store");
  });

  it("records lastError, drops the in-memory session, and keeps the stored refresh token when refresh fails", async () => {
    const userId = "user-m365-refresh-failed";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    seedMailbox({
      userId,
      refreshToken: "keep-refresh",
      accessToken: "cached-access",
      mailboxEmail: "failed@example.com",
      tokenExpiresAt: Date.now() + 60_000,
    });

    const cached = await getUserMailboxSession(userId);
    expect(cached.accessToken).toBe("cached-access");

    vi.setSystemTime(new Date("2026-06-01T12:02:00.000Z"));
    const fetchMock = vi.fn(async (input: string) => {
      expect(input).toBe(TOKEN_URL);
      return new Response("invalid_grant", { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUserMailboxSession(userId)).rejects.toBeInstanceOf(
      MailboxReconnectRequiredError,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = state.rows.get(userId);
    expect(stored?.refreshToken).toBe("keep-refresh");
    expect(stored?.lastError).toEqual(expect.stringContaining("Microsoft 365 refresh failed"));
    expect(sessionWritesFor(userId)).toEqual([]);

    // Rewind into the old cache window. A deleted in-memory session must come
    // back from the mailbox row, not the access token cached before the failure.
    vi.setSystemTime(new Date("2026-06-01T12:00:30.000Z"));
    stored!.accessToken = "db-access";
    const afterFailure = vi.fn();
    vi.stubGlobal("fetch", afterFailure);

    const reloaded = await getUserMailboxSession(userId);

    expect(reloaded.accessToken).toBe("db-access");
    expect(afterFailure).not.toHaveBeenCalled();
  });

  it("shares an in-flight refresh for the same user and not for a different user", async () => {
    const userId = "user-m365-inflight";
    const otherUserId = "user-m365-inflight-other";
    seedMailbox({
      userId,
      refreshToken: "refresh-case-7",
      accessToken: "expired-access",
      tokenExpiresAt: Date.now() - 10 * 60 * 1000,
    });
    seedMailbox({
      userId: otherUserId,
      refreshToken: "refresh-case-7-other",
      accessToken: "expired-access",
      mailboxEmail: "other@example.com",
      tokenExpiresAt: Date.now() - 10 * 60 * 1000,
    });

    let releaseUser: (response: Response) => void = () => {};
    const userGate = new Promise<Response>((resolve) => {
      releaseUser = resolve;
    });
    const tokenCalls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (requestUrl(input) !== TOKEN_URL) {
          const authorization = new Headers(init?.headers).get("authorization") ?? "";
          const mail = authorization.includes("access-other")
            ? "other@example.com"
            : "inflight@example.com";
          return jsonResponse({ mail });
        }
        const refreshToken = refreshTokenFrom(init);
        tokenCalls.push(refreshToken ?? "");
        if (refreshToken === "refresh-case-7") return userGate;
        return jsonResponse({
          access_token: "access-other",
          refresh_token: "refresh-other-next",
          expires_in: 3600,
        });
      }),
    );

    const first = getUserMailboxSession(userId);
    await vi.waitFor(() => {
      expect(tokenCalls).toEqual(["refresh-case-7"]);
    });

    const second = getUserMailboxSession(userId);
    await Promise.resolve();
    await Promise.resolve();
    expect(tokenCalls).toEqual(["refresh-case-7"]);

    const other = getUserMailboxSession(otherUserId);
    await vi.waitFor(() => {
      expect(tokenCalls).toEqual(["refresh-case-7", "refresh-case-7-other"]);
    });

    releaseUser(
      jsonResponse({
        access_token: "access-case-7",
        refresh_token: "refresh-case-7-next",
        expires_in: 3600,
      }),
    );

    await expect(first).resolves.toMatchObject({ accessToken: "access-case-7" });
    await expect(second).resolves.toMatchObject({ accessToken: "access-case-7" });
    await expect(other).resolves.toMatchObject({
      accessToken: "access-other",
      mailboxEmail: "other@example.com",
    });
    expect(tokenCalls.filter((token) => token === "refresh-case-7")).toHaveLength(1);
    expect(state.rows.get(userId)?.refreshToken).toBe("refresh-case-7-next");
    expect(state.rows.get(otherUserId)?.refreshToken).toBe("refresh-other-next");
  });

  it("throws MailboxNotConnectedError for a revoked mailbox or a row with no refresh token", async () => {
    const revokedUserId = "user-m365-revoked";
    const missingUserId = "user-m365-no-refresh";
    seedMailbox({
      userId: revokedUserId,
      refreshToken: "revoked-refresh",
      accessToken: "revoked-access",
      tokenExpiresAt: Date.now() + 10 * 60 * 1000,
      revokedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    seedMailbox({
      userId: missingUserId,
      refreshToken: null,
      accessToken: "orphan-access",
      tokenExpiresAt: Date.now() + 10 * 60 * 1000,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUserMailboxSession(revokedUserId)).rejects.toBeInstanceOf(
      MailboxNotConnectedError,
    );
    await expect(getUserMailboxSession(missingUserId)).rejects.toBeInstanceOf(
      MailboxNotConnectedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionWritesFor(revokedUserId)).toEqual([]);
    expect(sessionWritesFor(missingUserId)).toEqual([]);
  });
});
