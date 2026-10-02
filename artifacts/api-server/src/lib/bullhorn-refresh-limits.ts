export const BULLHORN_REFRESH_HTTP_TIMEOUT_MS = 15_000;
export const BULLHORN_REFRESH_LEASE_MS = 45_000;
export const BULLHORN_REFRESH_SAVE_BACKOFF_MS = [0, 100, 200, 400, 800] as const;
export const BULLHORN_REFRESH_SAVE_BUDGET_MS = 2_500;

// Empty by design: a timed-out/ambiguous provider exchange may still be running,
// so automatic refresh-token replay is not allowed.
export const BULLHORN_REFRESH_TOKEN_REPLAY_ALLOWLIST: readonly string[] = [];

