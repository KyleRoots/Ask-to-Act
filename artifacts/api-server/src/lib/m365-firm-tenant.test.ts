import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MYTICAS_TENANT = "8c6e8479-fc78-4bb8-ab9b-db3fc22fbcf6";
const QUALIFIED_TENANT = "9a416927-1992-4366-9314-d85dd684a3d1";

const state = vi.hoisted(() => {
  const users = new Map<string, { id: string; firmId: string | null; email: string | null }>();
  const firms = new Map<string, { id: string; microsoftTenantId: string | null }>();
  const mailboxes = new Map<string, Record<string, unknown>>();
  const writes: Array<{ userId: string; set: Record<string, unknown> }> = [];

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
      select() {
        const query: {
          table?: string;
          where?: Array<{ column: string; value: unknown }>;
        } = {};
        const builder = {
          from(table: { _name?: string }) {
            query.table = table._name;
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
          limit() {
            const valueOf = (name: string) =>
              query.where?.find((part) => part.column === name)?.value;
            if (query.table === "users") {
              const id = valueOf("id");
              const user = typeof id === "string" ? users.get(id) : undefined;
              return Promise.resolve(user ? [{ ...user }] : []);
            }
            if (query.table === "firms") {
              const id = valueOf("id");
              const firm = typeof id === "string" ? firms.get(id) : undefined;
              return Promise.resolve(firm ? [{ ...firm }] : []);
            }
            const userId = valueOf("userId");
            if (typeof userId !== "string") return Promise.resolve([]);
            const row = mailboxes.get(userId);
            return Promise.resolve(row ? [{ ...row }] : []);
          },
        };
        return builder;
      },
      insert() {
        let values: Record<string, unknown> = {};
        const builder = {
          values(next: Record<string, unknown>) {
            values = next;
            return builder;
          },
          onConflictDoUpdate(config: { set: Record<string, unknown> }) {
            const userId = String(values.userId);
            const existing = mailboxes.get(userId);
            mailboxes.set(userId, existing ? { ...existing, ...config.set } : { ...values });
            writes.push({ userId, set: { ...config.set } });
            return Promise.resolve();
          },
        };
        return builder;
      },
    };
  }

  return { users, firms, mailboxes, writes, eq, and, createDb };
});

vi.mock("@workspace/db", () => ({
  db: state.createDb(),
  userMailboxesTable: {
    _name: "user_mailboxes",
    userId: { name: "userId" },
    provider: { name: "provider" },
  },
  usersTable: {
    _name: "users",
    id: { name: "id" },
    firmId: { name: "firmId" },
    email: { name: "email" },
  },
  firmsTable: {
    _name: "firms",
    id: { name: "id" },
    microsoftTenantId: { name: "microsoftTenantId" },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: state.eq,
  and: state.and,
}));

const {
  completeMailboxConnection,
  getMicrosoftAuthorizeUrl,
  getUserMailboxSession,
  MailboxEmailDomainMismatchError,
  MailboxTenantMismatchError,
} = await import("./m365-auth.js");

function idToken(tid: string): string {
  const payload = Buffer.from(JSON.stringify({ tid })).toString("base64url");
  return `header.${payload}.sig`;
}

function seedFirm(id: string, microsoftTenantId: string | null) {
  state.firms.set(id, { id, microsoftTenantId });
}

function seedUser(id: string, firmId: string, email: string | null) {
  state.users.set(id, { id, firmId, email });
}

function seedMailbox(userId: string) {
  state.mailboxes.set(userId, {
    userId,
    provider: "microsoft365",
    mailboxEmail: "recruiter@example.com",
    refreshToken: "stored-refresh",
    accessToken: null,
    tokenExpiresAt: Date.now() - 60_000,
    revokedAt: null,
  });
}

function tokenWrites(userId: string) {
  return state.writes.filter(
    (write) => write.userId === userId && "accessToken" in write.set,
  );
}

beforeEach(() => {
  state.users.clear();
  state.firms.clear();
  state.mailboxes.clear();
  state.writes.length = 0;
  process.env["M365_CLIENT_ID"] = "7cd2e573-test-client";
  process.env["M365_CLIENT_SECRET"] = "test-client-secret";
  process.env["M365_REDIRECT_URI"] = "https://example.test/m365/callback";
  process.env["M365_TENANT_ID"] = MYTICAS_TENANT;
  process.env["LOG_LEVEL"] = "silent";
  delete process.env["TOKEN_ENCRYPTION_KEY"];
  delete process.env["M365_SCOPE"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("per-firm Microsoft tenant", () => {
  it("keeps a firm with no tenant on M365_TENANT_ID", async () => {
    seedFirm("firm-myticas", null);
    seedUser("user-myticas", "firm-myticas", "rae@myticas.com");

    const url = await getMicrosoftAuthorizeUrl("mailbox:user-myticas:abc", "user-myticas");
    expect(url.startsWith(
      `https://login.microsoftonline.com/${MYTICAS_TENANT}/oauth2/v2.0/authorize`,
    )).toBe(true);
    expect(url).not.toContain(QUALIFIED_TENANT);
    expect(state.firms.get("firm-myticas")?.microsoftTenantId).toBeNull();
  });

  it("authorizes a Qualified user against the firm's tenant", async () => {
    seedFirm("firm-qualified", QUALIFIED_TENANT);
    seedUser("user-qualified", "firm-qualified", "rae@q-staffing.com");

    const url = await getMicrosoftAuthorizeUrl("mailbox:user-qualified:abc", "user-qualified");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      `https://login.microsoftonline.com/${QUALIFIED_TENANT}/oauth2/v2.0/authorize`,
    );
    expect(parsed.searchParams.get("client_id")).toBe("7cd2e573-test-client");
  });

  it("refuses a callback whose tenant is not the firm's and stores nothing", async () => {
    seedFirm("firm-qualified", QUALIFIED_TENANT);
    seedUser("user-qualified-bad", "firm-qualified", "rae@q-staffing.com");
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          id_token: idToken(MYTICAS_TENANT),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("/organization")) {
        return new Response(JSON.stringify({ value: [{ id: MYTICAS_TENANT }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeMailboxConnection("user-qualified-bad", "auth-code"),
    ).rejects.toBeInstanceOf(MailboxTenantMismatchError);
    expect(tokenWrites("user-qualified-bad")).toEqual([]);
    expect(state.mailboxes.has("user-qualified-bad")).toBe(false);
    const tokenCall = String(fetchMock.mock.calls[0]?.[0]);
    expect(tokenCall).toContain(QUALIFIED_TENANT);
    expect(tokenCall).not.toContain(MYTICAS_TENANT);
  });

  it("refuses a mailbox on another firm's domain in the same tenant and stores nothing", async () => {
    seedFirm("firm-qualified", QUALIFIED_TENANT);
    seedUser("user-qualified-domain", "firm-qualified", "rae@q-staffing.com");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          id_token: idToken(QUALIFIED_TENANT),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("/organization")) {
        return new Response(JSON.stringify({ value: [{ id: QUALIFIED_TENANT }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).includes("/me")) {
        return new Response(JSON.stringify({ mail: "rae@stsigroup.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    await expect(
      completeMailboxConnection("user-qualified-domain", "auth-code"),
    ).rejects.toBeInstanceOf(MailboxEmailDomainMismatchError);
    expect(tokenWrites("user-qualified-domain")).toEqual([]);
  });

  it("connects a same-domain mailbox and does not require the local-part to match", async () => {
    seedFirm("firm-qualified", QUALIFIED_TENANT);
    seedUser("user-qualified-ok", "firm-qualified", "rae@q-staffing.com");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          id_token: idToken(QUALIFIED_TENANT),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("/organization")) {
        return new Response("{}", { status: 403 });
      }
      if (String(url).includes("/me")) {
        return new Response(JSON.stringify({ mail: "rae.alias@q-staffing.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const connected = await completeMailboxConnection("user-qualified-ok", "auth-code");
    expect(connected.mailboxEmail).toBe("rae.alias@q-staffing.com");
    expect(tokenWrites("user-qualified-ok")).toHaveLength(1);
  });

  it("refreshes a Qualified mailbox against the firm tenant, not M365_TENANT_ID", async () => {
    seedFirm("firm-qualified", QUALIFIED_TENANT);
    seedUser("user-qualified-refresh", "firm-qualified", "rae@q-staffing.com");
    seedMailbox("user-qualified-refresh");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("/token")) {
        return new Response(JSON.stringify({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("/me")) {
        return new Response(JSON.stringify({ mail: "rae@q-staffing.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const session = await getUserMailboxSession("user-qualified-refresh");
    expect(session.mailboxEmail).toBe("rae@q-staffing.com");
    expect(urls[0]).toBe(
      `https://login.microsoftonline.com/${QUALIFIED_TENANT}/oauth2/v2.0/token`,
    );
    expect(urls.join("\n")).not.toContain(MYTICAS_TENANT);
  });
});
