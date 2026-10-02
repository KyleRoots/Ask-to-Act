import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.fn();

vi.mock("@workspace/db", () => ({
  pool: { query },
}));

const {
  BULLHORN_REFRESH_HTTP_TIMEOUT_MS,
  BULLHORN_REFRESH_LEASE_MS,
  BULLHORN_REFRESH_SAVE_BACKOFF_MS,
  BULLHORN_REFRESH_SAVE_BUDGET_MS,
  BULLHORN_REFRESH_TOKEN_REPLAY_ALLOWLIST,
} = await import("./bullhorn-refresh-limits.js");
const {
  claimRefreshAttempt,
  persistRefreshTokenSuccess,
  runInProcessRefreshFlight,
} = await import("./bullhorn-refresh-coordinator.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  query.mockReset();
});

describe("bullhorn refresh limits", () => {
  it("keeps the agreed bounded constants", () => {
    expect(BULLHORN_REFRESH_HTTP_TIMEOUT_MS).toBe(15_000);
    expect(BULLHORN_REFRESH_LEASE_MS).toBe(45_000);
    expect(BULLHORN_REFRESH_SAVE_BACKOFF_MS).toEqual([0, 100, 200, 400, 800]);
    expect(BULLHORN_REFRESH_SAVE_BUDGET_MS).toBe(2_500);
    expect(BULLHORN_REFRESH_TOKEN_REPLAY_ALLOWLIST).toEqual([]);
  });
});

describe("runInProcessRefreshFlight", () => {
  it("registers before work awaits and shares the same promise", async () => {
    const gate = deferred<string>();
    let starts = 0;

    const first = runInProcessRefreshFlight("firm:f1", async () => {
      starts += 1;
      return gate.promise;
    });
    const second = runInProcessRefreshFlight("firm:f1", async () => {
      starts += 1;
      return "duplicate";
    });

    expect(starts).toBe(0);
    await Promise.resolve();
    expect(starts).toBe(1);
    expect(second).toBe(first);

    gate.resolve("ok");
    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
  });
});

describe("refresh DB guards", () => {
  it("claims only after marking expired leases uncertain", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(
      claimRefreshAttempt({
        kind: "firm",
        id: "firm-1",
        attemptId: "attempt-1",
        expectedGeneration: 3,
        expectedEncryptedRefreshToken: "old-ciphertext",
        now: new Date("2026-10-02T00:00:00Z"),
      }),
    ).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![1]).toEqual([
      "firm-1",
      "attempt-1",
      "old-ciphertext",
      new Date("2026-10-02T00:00:00Z"),
      new Date("2026-10-02T00:00:45Z"),
      3,
    ]);
  });

  it("recognizes an identical committed conditional save", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ok: 1 }] });

    await expect(
      persistRefreshTokenSuccess({
        kind: "user",
        id: "user-1",
        attemptId: "attempt-1",
        expectedGeneration: 7,
        expectedEncryptedRefreshToken: "old-ciphertext",
        replacementEncryptedRefreshToken: "new-ciphertext",
        now: new Date("2026-10-02T00:00:00Z"),
      }),
    ).resolves.toEqual({
      saved: true,
      generation: 8,
      identicalCommitted: true,
    });

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("persists firm save uncertainty as unhealthy after bounded retries", async () => {
    for (let i = 0; i < BULLHORN_REFRESH_SAVE_BACKOFF_MS.length; i += 1) {
      query
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    }
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(
      persistRefreshTokenSuccess({
        kind: "firm",
        id: "firm-save-uncertain",
        attemptId: "attempt-save-uncertain",
        expectedGeneration: 4,
        expectedEncryptedRefreshToken: "old-ciphertext",
        replacementEncryptedRefreshToken: "new-ciphertext",
        now: new Date("2026-10-02T00:00:00Z"),
      }),
    ).resolves.toEqual({
      saved: false,
      generation: 4,
      identicalCommitted: false,
    });

    const finalQuery = query.mock.calls.at(-1)![0] as string;
    expect(finalQuery).toContain("auth_healthy = false");
    expect(finalQuery).toContain("last_auth_error_at");
    expect(query.mock.calls.at(-1)![1]).toEqual([
      "firm-save-uncertain",
      "attempt-save-uncertain",
      4,
      new Date("2026-10-02T00:00:00Z"),
      "conditional refresh-token save exhausted retry budget",
    ]);
  });
});
