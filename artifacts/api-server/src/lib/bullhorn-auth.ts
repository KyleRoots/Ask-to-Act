import { db, bullhornTokensTable, usersTable, firmsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger.js";
import { decryptToken, encryptToken } from "./token-crypto.js";
import { getBaseUrl } from "./getBaseUrl.js";
import {
  claimRefreshAttempt,
  currentRefreshGeneration,
  persistDefinitiveInvalidGrant,
  persistReconnectTokenBeforeLogin,
  persistRefreshTokenSuccess,
  persistRefreshUncertain,
  refreshFlightKey,
  runInProcessRefreshFlight,
  updateFirmSessionAfterRefresh,
  updateUserSessionAfterRefresh,
} from "./bullhorn-refresh-coordinator.js";
import { BULLHORN_REFRESH_HTTP_TIMEOUT_MS } from "./bullhorn-refresh-limits.js";

const USER_ENROLL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Thrown when a recruiter's personal Bullhorn session is missing or can no
 * longer be refreshed. Carries a one-time absolute reconnect URL so MCP
 * clients can show a working link (never /enroll?id=…).
 */
export class BullhornReconnectRequiredError extends Error {
  constructor(public readonly connectUrl: string) {
    super(
      "Your Bullhorn session needs a quick reconnect before this action can continue. " +
        "Open the reconnect link, sign in with your Bullhorn credentials, then retry. " +
        "Your existing AI connector URL stays the same — you do not need to reinstall it.",
    );
    this.name = "BullhornReconnectRequiredError";
  }
}

/**
 * Issues a fresh one-time enrollment/reconnect token for an existing user and
 * returns the absolute browser URL GPT/clients should present.
 *
 * Clears the stale Bullhorn refresh session first. Without that, the enroll
 * page short-circuits to "already connected" and never replaces the dead token.
 */
export async function getBullhornReconnectUrlForUser(
  userId: string,
  expectedGeneration?: number,
): Promise<string> {
  const enrollToken = randomBytes(32).toString("hex");
  const enrollTokenExpiresAt = new Date(Date.now() + USER_ENROLL_TOKEN_TTL_MS);
  invalidateUserSession(userId);
  const updated = await db
    .update(usersTable)
    .set({
      enrollToken,
      enrollTokenExpiresAt,
      refreshToken: null,
      bhRestToken: null,
      restUrl: null,
      tokenExpiresAt: null,
      sessionExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      expectedGeneration === undefined
        ? eq(usersTable.id, userId)
        : sql`${usersTable.id} = ${userId}
            AND bullhorn_refresh_generation = ${expectedGeneration}`,
    )
    .returning({ id: usersTable.id });
  if (updated.length !== 1) {
    throw new Error("Bullhorn reconnect URL request was superseded by a newer user generation.");
  }
  // force=1 skips the "already connected" short-circuit; manual=1 opens the
  // credential form so the recruiter actually re-auths Bullhorn.
  return `${getBaseUrl()}/api/auth/user/enroll?token=${enrollToken}&force=1&manual=1`;
}

const BULLHORN_LOGIN_INFO_URL =
  "https://rest.bullhornstaffing.com/rest-services/loginInfo";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface LoginInfoResponse {
  oauthUrl?: string;
  restUrl?: string;
}

interface LoginResponse {
  BhRestToken: string;
  restUrl: string;
}

interface PingResponse {
  sessionExpires?: number;
}

interface Endpoints {
  oauthUrl: string;
  loginUrl: string;
}

interface Session {
  BhRestToken: string;
  restUrl: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  sessionExpiresAt: number;
}

class BullhornRefreshTokenError extends Error {
  constructor(
    message: string,
    public readonly kind: "invalid_grant" | "ambiguous",
  ) {
    super(message);
    this.name = "BullhornRefreshTokenError";
  }
}

/**
 * Thrown when no Bullhorn refresh token is available yet. The user must
 * complete the one-time browser authorization at /api/auth/bullhorn/login.
 */
export class BullhornNotAuthorizedError extends Error {
  constructor() {
    super(
      "Your organization's Bullhorn connection needs to be refreshed by an AskToAct administrator. " +
        "Our team has been notified — please try again after Bullhorn is reconnected, or email support@asktoact.ai.",
    );
    this.name = "BullhornNotAuthorizedError";
  }
}

/**
 * Request-scoped firm context. The MCP route (and any service flow that knows
 * the firm) wraps work in firmContext.run({ firmId }) so the deep Bullhorn read
 * path — getSession() and the read cache — resolves the right tenant WITHOUT
 * threading firmId through every client function. getSession(firmId?) prefers an
 * explicit firmId and otherwise reads this context; with NEITHER set it FAILS
 * CLOSED (throws) rather than silently using a shared connection. This is the
 * core tenant-isolation guarantee.
 */
export const firmContext = new AsyncLocalStorage<{ firmId: string }>();

/** The firmId for the current operation: explicit arg first, then ALS context. */
function currentFirmId(explicit?: string): string {
  const firmId = explicit ?? firmContext.getStore()?.firmId;
  if (!firmId) {
    throw new Error(
      "No Bullhorn firm context: getSession requires a firmId (passed explicitly " +
        "or set via firmContext.run). This guards against cross-tenant data access.",
    );
  }
  return firmId;
}

/** The ALS firm context id if present (used to scope read cache keys), else null. */
export function currentFirmContextId(): string | null {
  return firmContext.getStore()?.firmId ?? null;
}

// Per-firm service sessions. Each customer firm has its own Bullhorn connection,
// so live sessions and in-flight (re)auth promises are keyed by firmId and never
// shared across tenants.
const sessions = new Map<string, Session>();
const authInProgress = new Map<string, Promise<Session>>();
let endpoints: Endpoints | null = null;

// Headless direct-login circuit breaker. After a failed direct login we refuse
// further attempts for a cooldown window: a wrong password retried rapidly can
// trip Bullhorn's failedLoginLockoutThreshold and lock the API user.
const DIRECT_LOGIN_COOLDOWN_MS = 60_000;
let directLoginBlockedUntil = 0;
let beforeUserReconnectUrlForTests:
  | ((opts: { userId: string; expectedGeneration: number }) => Promise<void> | void)
  | null = null;

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

interface FirmTokenRow {
  refreshToken: string | null;
  encryptedRefreshToken: string | null;
  oauthUrl: string | null;
  restUrl: string | null;
  loginUrl: string | null;
  authMode: string;
  authHealthy: boolean;
  refreshGeneration: number;
}

/** Loads a firm's stored connection row (decrypting the refresh token). */
async function loadTokenRow(firmId: string): Promise<FirmTokenRow | null> {
  const rows = await db
    .select({
      refreshToken: bullhornTokensTable.refreshToken,
      oauthUrl: bullhornTokensTable.oauthUrl,
      restUrl: bullhornTokensTable.restUrl,
      loginUrl: bullhornTokensTable.loginUrl,
      authMode: bullhornTokensTable.authMode,
      authHealthy: bullhornTokensTable.authHealthy,
      refreshGeneration: sql<number>`refresh_generation`,
    })
    .from(bullhornTokensTable)
    .where(eq(bullhornTokensTable.firmId, firmId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    refreshToken: row.refreshToken ? decryptToken(row.refreshToken) : null,
    encryptedRefreshToken: row.refreshToken ?? null,
    oauthUrl: row.oauthUrl ?? null,
    restUrl: row.restUrl ?? null,
    loginUrl: row.loginUrl ?? null,
    authMode: row.authMode ?? "oauth",
    authHealthy: row.authHealthy,
    refreshGeneration: (row as { refreshGeneration?: number }).refreshGeneration ?? 0,
  };
}

async function markFirmAuthHealthy(firmId: string): Promise<void> {
  await db
    .update(bullhornTokensTable)
    .set({
      authHealthy: true,
      lastAuthErrorAt: null,
      lastAuthError: null,
      updatedAt: new Date(),
    })
    .where(eq(bullhornTokensTable.firmId, firmId));
}

async function markFirmAuthUnhealthy(firmId: string, err: unknown): Promise<void> {
  const errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  const [existing] = await db
    .select({ authHealthy: bullhornTokensTable.authHealthy })
    .from(bullhornTokensTable)
    .where(eq(bullhornTokensTable.firmId, firmId))
    .limit(1);
  const wasHealthy = existing?.authHealthy !== false;

  await db
    .update(bullhornTokensTable)
    .set({
      authHealthy: false,
      lastAuthErrorAt: new Date(),
      lastAuthError: errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(bullhornTokensTable.firmId, firmId));

  if (!wasHealthy) return;

  try {
    const [firm] = await db
      .select({ name: firmsTable.name })
      .from(firmsTable)
      .where(eq(firmsTable.id, firmId))
      .limit(1);
    const { sendFirmAuthFailureAlert } = await import("./emailService.js");
    await sendFirmAuthFailureAlert({
      firmId,
      firmName: firm?.name ?? firmId,
      errorMessage,
    });
    logger.warn({ firmId }, "Bullhorn auth failure alert emailed to support");
  } catch (alertErr) {
    logger.error({ firmId, err: alertErr }, "Failed to send Bullhorn auth failure alert");
  }
}

async function notifyFirmAuthFailure(opts: {
  firmId: string;
  expectedGeneration: number;
  errorMessage: string;
}): Promise<void> {
  const { maybeSendFirmAuthFailureAlert } = await import("./firm-auth-failure-notify.js");
  await maybeSendFirmAuthFailureAlert(opts);
}

export type FirmBullhornHealthStatus = {
  connected: boolean;
  healthy: boolean;
  needsReauthorization: boolean;
  lastAuthErrorAt: string | null;
  lastAuthError: string | null;
};

function healthFromTokenRow(row: {
  refreshToken: string | null;
  authHealthy: boolean;
  authMode: string;
  lastAuthErrorAt: Date | null;
  lastAuthError: string | null;
} | undefined): FirmBullhornHealthStatus {
  if (!row?.refreshToken) {
    return {
      connected: false,
      healthy: false,
      needsReauthorization: false,
      lastAuthErrorAt: null,
      lastAuthError: null,
    };
  }
  const healthy = row.authHealthy;
  return {
    connected: true,
    healthy,
    needsReauthorization: row.authMode === "oauth" && !healthy,
    lastAuthErrorAt: row.lastAuthErrorAt?.toISOString() ?? null,
    lastAuthError: row.lastAuthError ?? null,
  };
}

/** Admin-facing Bullhorn connection health for a firm. */
export async function getFirmBullhornHealthStatus(firmId: string): Promise<FirmBullhornHealthStatus> {
  const rows = await db
    .select({
      refreshToken: bullhornTokensTable.refreshToken,
      authHealthy: bullhornTokensTable.authHealthy,
      authMode: bullhornTokensTable.authMode,
      lastAuthErrorAt: bullhornTokensTable.lastAuthErrorAt,
      lastAuthError: bullhornTokensTable.lastAuthError,
    })
    .from(bullhornTokensTable)
    .where(eq(bullhornTokensTable.firmId, firmId))
    .limit(1);

  return healthFromTokenRow(rows[0]);
}

/**
 * Batch Bullhorn health for the admin firms list (one query, keyed by firmId).
 * Firms with no token row are omitted from the map — callers treat missing as
 * not connected via healthFromTokenRow(undefined).
 */
export async function listFirmBullhornHealthStatuses(): Promise<
  Map<string, FirmBullhornHealthStatus>
> {
  const rows = await db
    .select({
      firmId: bullhornTokensTable.firmId,
      refreshToken: bullhornTokensTable.refreshToken,
      authHealthy: bullhornTokensTable.authHealthy,
      authMode: bullhornTokensTable.authMode,
      lastAuthErrorAt: bullhornTokensTable.lastAuthErrorAt,
      lastAuthError: bullhornTokensTable.lastAuthError,
    })
    .from(bullhornTokensTable);

  const map = new Map<string, FirmBullhornHealthStatus>();
  for (const row of rows) {
    if (!row.firmId) continue;
    map.set(row.firmId, healthFromTokenRow(row));
  }
  return map;
}

/**
 * Returns a firm's auth_mode ("service" | "oauth"), or null if the firm has no
 * Bullhorn token row. The "service" firm (Myticas) is the env-credential
 * headless account whose custom-field config is managed by the platform — it
 * intentionally has NO firm_config row and must stay byte-identical, so callers
 * use this to refuse discovery writes against it.
 */
export async function getFirmAuthMode(firmId: string): Promise<string | null> {
  const rows = await db
    .select({ authMode: bullhornTokensTable.authMode })
    .from(bullhornTokensTable)
    .where(eq(bullhornTokensTable.firmId, firmId))
    .limit(1);
  return rows[0]?.authMode ?? null;
}

/**
 * Updates ONLY the rotating refresh token for a firm (the hot path on every
 * session refresh). The row already exists, so this is a plain UPDATE keyed by
 * firmId — it never creates a row or changes auth_mode/endpoints.
 */
async function saveRotatedRefreshToken(firmId: string, refreshToken: string): Promise<void> {
  await db
    .update(bullhornTokensTable)
    .set({
      refreshToken: encryptToken(refreshToken),
      authHealthy: true,
      lastAuthErrorAt: null,
      lastAuthError: null,
      updatedAt: new Date(),
    })
    .where(eq(bullhornTokensTable.firmId, firmId));
}

interface FirmConnectionFields {
  refreshToken: string;
  oauthUrl: string;
  restUrl: string;
  loginUrl: string | null;
  authMode: "service" | "oauth";
}

/**
 * Upserts a firm's full connection material after a successful authorization or
 * headless login — refresh token PLUS the firm's own OAuth/REST/login endpoints,
 * so future refreshes use the firm's own swimlane and never another tenant's.
 * Conflict is on firm_id; the legacy "default" row keeps its id. auth_mode is
 * NOT overwritten on conflict, so a "service" firm stays service across reconnects.
 */
async function saveFirmConnection(firmId: string, fields: FirmConnectionFields): Promise<void> {
  const now = new Date();
  const enc = encryptToken(fields.refreshToken);
  await db
    .insert(bullhornTokensTable)
    .values({
      id: firmId,
      firmId,
      refreshToken: enc,
      oauthUrl: fields.oauthUrl,
      restUrl: fields.restUrl,
      loginUrl: fields.loginUrl,
      authMode: fields.authMode,
      authHealthy: true,
      connectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: bullhornTokensTable.firmId,
      set: {
        refreshToken: enc,
        oauthUrl: fields.oauthUrl,
        restUrl: fields.restUrl,
        loginUrl: fields.loginUrl,
        authHealthy: true,
        lastAuthErrorAt: null,
        lastAuthError: null,
        connectedAt: now,
        updatedAt: now,
      },
    });
}

/** Derives a firm's REST /login endpoint from its authenticated restUrl. */
function deriveLoginUrl(restUrl: string): string | null {
  const marker = "/rest-services/";
  const i = restUrl.indexOf(marker);
  if (i < 0) return null;
  return restUrl.slice(0, i + marker.length) + "login";
}

/**
 * Resolves the OAuth/login endpoints for a firm. Prefers the firm's own stored
 * endpoints (captured at connect time) so we never reuse one tenant's swimlane
 * for another; falls back to the global region-discovered endpoints only when a
 * firm has none stored yet (e.g. the service firm before its first capture).
 */
async function resolveFirmEndpoints(row: FirmTokenRow | null): Promise<Endpoints> {
  if (row?.oauthUrl && row?.loginUrl) {
    return { oauthUrl: row.oauthUrl, loginUrl: row.loginUrl };
  }
  return discoverEndpoints();
}

async function discoverEndpoints(): Promise<Endpoints> {
  if (endpoints) {
    return endpoints;
  }

  const username = getEnv("BULLHORN_USERNAME");
  const url = new URL(BULLHORN_LOGIN_INFO_URL);
  url.searchParams.set("username", username);

  logger.info("Bullhorn: resolving data-center endpoints via loginInfo");
  const res = await fetch(url.toString(), { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Bullhorn loginInfo failed (${res.status})`);
  }

  const data = (await res.json()) as LoginInfoResponse;
  if (!data.oauthUrl || !data.restUrl) {
    throw new Error("Bullhorn loginInfo did not return oauthUrl/restUrl");
  }

  endpoints = {
    oauthUrl: data.oauthUrl.replace(/\/$/, ""),
    loginUrl: `${data.restUrl.replace(/\/$/, "")}/login`,
  };
  logger.info({ oauthUrl: endpoints.oauthUrl }, "Bullhorn: endpoints resolved");
  return endpoints;
}

/**
 * Builds the Bullhorn authorize URL for the interactive (browser) flow. The
 * user logs in on Bullhorn's own page and approves consent; Bullhorn then
 * redirects back to our callback with an authorization code. No username or
 * password is sent from the server.
 *
 * When `firmId` is known, prefer that firm's stored oauthUrl so authorize and
 * the later code exchange hit the same swimlane (avoids multi-tenant / second-
 * instance mismatches). Falls back to service discoverEndpoints otherwise.
 */
export async function getAuthorizeUrl(state: string, firmId?: string): Promise<string> {
  const row = firmId ? await loadTokenRow(firmId) : null;
  const { oauthUrl } = await resolveFirmEndpoints(row);
  const url = new URL(`${oauthUrl}/authorize`);
  url.searchParams.set("client_id", getEnv("BULLHORN_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", getEnv("BULLHORN_REDIRECT_URI"));
  url.searchParams.set("state", state);
  return url.toString();
}

/** Reads the `code` query param out of an OAuth redirect Location header. */
function codeFromLocation(location: string): string | null {
  if (!location) return null;
  try {
    return new URL(location).searchParams.get("code");
  } catch {
    return null;
  }
}

/** Reads an `error`/`error_description` out of an OAuth redirect Location header. */
function errorFromLocation(location: string): string | null {
  if (!location) return null;
  try {
    const u = new URL(location);
    const err = u.searchParams.get("error");
    if (!err) return null;
    return `${err} ${u.searchParams.get("error_description") ?? ""}`.trim();
  } catch {
    return null;
  }
}

/** Extracts the hidden form inputs from Bullhorn's consent HTML page. */
function parseHiddenInputs(html: string): Record<string, string> {
  const hidden: Record<string, string> = {};
  for (const m of html.matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)) {
    const tag = m[0];
    const name = /name=["']([^"']+)["']/i.exec(tag)?.[1];
    if (name) {
      hidden[name] = /value=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    }
  }
  return hidden;
}

/**
 * Submits the "Agree" consent approval server-side. Bullhorn's consent form has
 * no action attribute, so it POSTs back to the same authorize URL, carrying the
 * JSESSIONID from the login response plus the form's hidden fields. This is the
 * exact request a human clicking "Agree" would make — done headlessly here.
 */
async function approveConsent(
  authorizeUrl: string,
  html: string,
  sessionCookie: string | null,
): Promise<string> {
  const body = new URLSearchParams({
    ...parseHiddenInputs(html),
    action: "Agree",
  });
  const res = await fetch(authorizeUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: body.toString(),
  });
  const location = res.headers.get("location") ?? "";
  const code = codeFromLocation(location);
  if (code) return code;
  const errInfo = errorFromLocation(location);
  if (errInfo) {
    throw new Error(`Bullhorn consent approval returned an error: ${errInfo}`);
  }
  const preview = (await res.text().catch(() => ""))
    .replace(/\s+/g, " ")
    .slice(0, 200);
  throw new Error(
    `Bullhorn consent approval did not return an authorization code ` +
      `(status=${res.status}). Response start: ${preview}`,
  );
}

/**
 * Headless authorization-code retrieval. Sends username/password/action=Login to
 * the OAuth /authorize endpoint and reads the code out of the 302 Location
 * header WITHOUT following the redirect (so Bullhorn never calls our callback).
 * This is the server-to-server flow for a Bullhorn "Webservice API User" — no
 * browser. The first time a user authorizes this client_id, Bullhorn returns its
 * "Get Consent" HTML page instead of a code; we submit the "Agree" approval
 * server-side (carrying the session cookie) to obtain the code, exactly as a
 * human clicking Agree would. Once consent is recorded, future logins return the
 * code directly.
 */
async function fetchAuthCodeHeadless(oauthUrl: string): Promise<string> {
  const url = new URL(`${oauthUrl}/authorize`);
  url.searchParams.set("client_id", getEnv("BULLHORN_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", getEnv("BULLHORN_REDIRECT_URI"));
  url.searchParams.set("username", getEnv("BULLHORN_USERNAME"));
  url.searchParams.set("password", getEnv("BULLHORN_PASSWORD"));
  url.searchParams.set("action", "Login");
  const authorizeUrl = url.toString();

  const res = await fetch(authorizeUrl, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";

  // Consent already granted: the code comes straight back in the 302.
  const directCode = codeFromLocation(location);
  if (directCode) return directCode;
  const directErr = errorFromLocation(location);
  if (directErr) {
    throw new Error(`Bullhorn headless authorize returned an error: ${directErr}`);
  }

  // First-time authorization: Bullhorn returns the "Get Consent" HTML form.
  if (res.status === 200) {
    const html = await res.text();
    if (/consentForm|Get Consent/i.test(html)) {
      // undici exposes getSetCookie(); fall back to the combined header for
      // runtimes/proxies that don't split Set-Cookie into an array.
      const setCookies =
        res.headers.getSetCookie?.() ??
        (res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie") as string]
          : []);
      const jsession =
        setCookies
          .map((c) => c.split(";")[0])
          .find((c) => c.startsWith("JSESSIONID=")) ?? null;
      logger.info("Bullhorn: consent screen returned; submitting approval headlessly");
      return approveConsent(authorizeUrl, html, jsession);
    }
    const preview = html.replace(/\s+/g, " ").slice(0, 200);
    if (/invalid redirect uri/i.test(html)) {
      throw new Error(
        `Bullhorn rejected the redirect_uri — it is not whitelisted for this ` +
          `client_id (authorize returned the "Invalid Redirect URI" page). ` +
          `Response start: ${preview}`,
      );
    }
    throw new Error(
      `Bullhorn headless authorize returned an unexpected HTML page (status=200). ` +
        `This usually means BULLHORN_USERNAME/BULLHORN_PASSWORD are incorrect. ` +
        `Response start: ${preview}`,
    );
  }

  throw new Error(
    `Bullhorn headless authorize did not return an authorization code ` +
      `(status=${res.status}) and no consent form was found. Check that the ` +
      `redirect_uri is whitelisted for this client_id.`,
  );
}

async function exchangeCodeForToken(
  oauthUrl: string,
  code: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: getEnv("BULLHORN_CLIENT_ID"),
    client_secret: getEnv("BULLHORN_CLIENT_SECRET"),
    redirect_uri: getEnv("BULLHORN_REDIRECT_URI"),
  });

  const res = await fetch(`${oauthUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Bullhorn token exchange failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  return (await res.json()) as TokenResponse;
}

async function fetchTokenWithRefresh(
  oauthUrl: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BULLHORN_REFRESH_HTTP_TIMEOUT_MS);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: getEnv("BULLHORN_CLIENT_ID"),
    client_secret: getEnv("BULLHORN_CLIENT_SECRET"),
  });

  let res: Response;
  try {
    res = await fetch(`${oauthUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    throw new BullhornRefreshTokenError(
      aborted
        ? "Bullhorn refresh token request timed out; provider processing may still complete."
        : `Bullhorn refresh token request failed ambiguously: ${
            err instanceof Error ? err.message : String(err)
          }`,
      "ambiguous",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text();
    const invalidGrant = res.status === 400 && /invalid_grant/i.test(text);
    throw new BullhornRefreshTokenError(
      `Bullhorn refresh token request failed (${res.status}): ${text.slice(0, 200)}`,
      invalidGrant ? "invalid_grant" : "ambiguous",
    );
  }

  return (await res.json()) as TokenResponse;
}

async function login(
  accessToken: string,
  loginUrl: string,
): Promise<LoginResponse> {
  const url = new URL(loginUrl);
  url.searchParams.set("version", "*");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bullhorn /login failed (${res.status}): ${text.slice(0, 300)}`);
  }

  return (await res.json()) as LoginResponse;
}

async function resolveSessionExpiry(loginData: LoginResponse): Promise<number> {
  let sessionExpiresAt = Date.now() + 10 * 60 * 1000;
  try {
    const pingUrl = new URL("ping", loginData.restUrl);
    pingUrl.searchParams.set("BhRestToken", loginData.BhRestToken);
    const pingRes = await fetch(pingUrl.toString(), { redirect: "follow" });
    if (pingRes.ok) {
      const pingData = (await pingRes.json()) as PingResponse;
      if (pingData.sessionExpires) {
        sessionExpiresAt = pingData.sessionExpires - 30_000;
      }
    }
  } catch {
    // Keep the conservative default expiry.
  }
  return sessionExpiresAt;
}

async function pingSession(s: Session): Promise<boolean> {
  try {
    const url = new URL("ping", s.restUrl);
    url.searchParams.set("BhRestToken", s.BhRestToken);
    const res = await fetch(url.toString(), { redirect: "follow" });
    if (!res.ok) {
      logger.info({ status: res.status }, "Bullhorn: ping returned non-ok, session invalid");
      return false;
    }
    const data = (await res.json()) as PingResponse;
    if (data.sessionExpires && data.sessionExpires <= Date.now()) {
      logger.info("Bullhorn: ping reports session already expired");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, "Bullhorn: ping failed, treating session as invalid");
    return false;
  }
}

function buildSession(tokens: TokenResponse, loginData: LoginResponse, sessionExpiresAt: number): Session {
  return {
    BhRestToken: loginData.BhRestToken,
    restUrl: loginData.restUrl,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
    sessionExpiresAt,
  };
}

/**
 * Completes the interactive authorization: exchanges the authorization code for
 * tokens, establishes a Bullhorn REST session, and persists the refresh token
 * so future sessions can be created headlessly. Called by the OAuth callback.
 */
export async function completeAuthorization(
  code: string,
  firmId?: string,
  expectedGeneration?: number,
  claimedState?: { state: string; attemptId: string },
): Promise<void> {
  const fid = currentFirmId(firmId);
  const existing = await loadTokenRow(fid);
  const ep = await resolveFirmEndpoints(existing);
  const generation = expectedGeneration ?? existing?.refreshGeneration ?? 0;
  if (existing && existing.refreshGeneration !== generation) {
    throw new Error("Bullhorn reconnect callback is stale for this firm generation.");
  }
  if (!existing && generation !== 0) {
    throw new Error("Bullhorn reconnect callback is stale for a missing firm connection.");
  }
  const tokens = await exchangeCodeForToken(ep.oauthUrl, code);
  const saved = await persistReconnectTokenBeforeLogin({
    kind: "firm",
    id: fid,
    expectedGeneration: generation,
    encryptedRefreshToken: encryptToken(tokens.refresh_token),
    claimedState,
    firm: {
      oauthUrl: ep.oauthUrl,
      loginUrl: ep.loginUrl,
      authMode: existing?.authMode === "service" ? "service" : "oauth",
      allowInsert: !existing,
    },
  });
  if (!saved.saved) {
    throw new Error("Bullhorn reconnect was superseded before token persistence.");
  }
  const loginData = await login(tokens.access_token, ep.loginUrl);
  const sessionExpiresAt = await resolveSessionExpiry(loginData);
  const s = buildSession(tokens, loginData, sessionExpiresAt);
  const sessionUpdated = await updateFirmSessionAfterRefresh({
    firmId: fid,
    generation: saved.generation,
    restUrl: loginData.restUrl,
    loginUrl: deriveLoginUrl(loginData.restUrl) ?? ep.loginUrl,
  });
  if (!sessionUpdated) {
    throw new Error("Bullhorn reconnect was superseded before session publication.");
  }
  sessions.set(fid, s);
  logger.info({ restUrl: s.restUrl, firmId: fid }, "Bullhorn: authorization complete, session established");
}

/**
 * Builds a fresh session for a firm from its stored refresh token, rotating and
 * persisting the new refresh token Bullhorn returns. Uses the firm's OWN stored
 * endpoints so a refresh never touches another tenant's swimlane.
 */
async function sessionFromRefreshToken(
  firmId: string,
  row: FirmTokenRow,
  ep: Endpoints,
): Promise<Session> {
  if (!row.encryptedRefreshToken || !row.refreshToken) {
    throw new Error("No Bullhorn refresh token available for firm refresh.");
  }
  const attemptId = randomUUID();
  const claimed = await claimRefreshAttempt({
    kind: "firm",
    id: firmId,
    attemptId,
    expectedGeneration: row.refreshGeneration,
    expectedEncryptedRefreshToken: row.encryptedRefreshToken,
  });
  if (!claimed) {
    throw new Error("Bullhorn firm refresh was not claimed; another attempt or uncertainty exists.");
  }

  let tokens: TokenResponse;
  let persistedGeneration: number | null = null;
  try {
    tokens = await fetchTokenWithRefresh(ep.oauthUrl, row.refreshToken);
  } catch (err) {
    if (err instanceof BullhornRefreshTokenError && err.kind === "invalid_grant") {
      const persisted = await persistDefinitiveInvalidGrant({
        kind: "firm",
        id: firmId,
        attemptId,
        expectedGeneration: row.refreshGeneration,
        error: err.message,
      });
      if (persisted && row.authMode !== "service") {
        await notifyFirmAuthFailure({
          firmId,
          expectedGeneration: row.refreshGeneration,
          errorMessage: err.message,
        });
      }
    } else {
      const persisted = await persistRefreshUncertain({
        kind: "firm",
        id: firmId,
        attemptId,
        expectedGeneration: row.refreshGeneration,
        error: err instanceof Error ? err.message : String(err),
      });
      if (persisted && row.authMode !== "service") {
        await notifyFirmAuthFailure({
          firmId,
          expectedGeneration: row.refreshGeneration,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw err;
  }

  const replacementCiphertext = encryptToken(tokens.refresh_token);
  const saved = await persistRefreshTokenSuccess({
    kind: "firm",
    id: firmId,
    attemptId,
    expectedGeneration: row.refreshGeneration,
    expectedEncryptedRefreshToken: row.encryptedRefreshToken,
    replacementEncryptedRefreshToken: replacementCiphertext,
  });
  if (!saved.saved) {
    if (row.authMode !== "service") {
      await notifyFirmAuthFailure({
        firmId,
        expectedGeneration: row.refreshGeneration,
        errorMessage: "conditional refresh-token save exhausted retry budget",
      });
    }
    throw new Error("Bullhorn firm refresh token save is uncertain; refusing REST login.");
  }
  persistedGeneration = saved.generation;

  const loginData = await login(tokens.access_token, ep.loginUrl);
  const sessionExpiresAt = await resolveSessionExpiry(loginData);
  const s = buildSession(tokens, loginData, sessionExpiresAt);
  const sessionUpdated = await updateFirmSessionAfterRefresh({
    firmId,
    generation: persistedGeneration,
    restUrl: loginData.restUrl,
    loginUrl: deriveLoginUrl(loginData.restUrl) ?? ep.loginUrl,
  });
  if (!sessionUpdated) {
    throw new Error("Bullhorn firm refresh was superseded before session publication.");
  }
  return s;
}

/**
 * Headless ("direct") login for the SERVICE firm only: gets an authorization
 * code by sending the env-var credentials straight to /authorize, then runs the
 * standard token + REST-login exchange and persists the firm's connection. No
 * browser, no consent screen. Guarded by a cooldown so a wrong password cannot
 * be retried fast enough to lock the API user.
 */
async function directLogin(firmId: string): Promise<Session> {
  const now = Date.now();
  if (now < directLoginBlockedUntil) {
    const secs = Math.ceil((directLoginBlockedUntil - now) / 1000);
    throw new Error(
      `Bullhorn headless login is cooling down for ${secs}s after a recent ` +
        `failure (account-lockout protection). Verify BULLHORN_USERNAME and ` +
        `BULLHORN_PASSWORD before retrying.`,
    );
  }
  try {
    const existing = await loadTokenRow(firmId);
    const { oauthUrl, loginUrl } = await discoverEndpoints();
    const code = await fetchAuthCodeHeadless(oauthUrl);
    const tokens = await exchangeCodeForToken(oauthUrl, code);
    const saved = await persistReconnectTokenBeforeLogin({
      kind: "firm",
      id: firmId,
      expectedGeneration: existing?.refreshGeneration ?? 0,
      encryptedRefreshToken: encryptToken(tokens.refresh_token),
      firm: {
        oauthUrl,
        loginUrl,
        authMode: "service",
        allowInsert: !existing,
      },
    });
    if (!saved.saved) {
      throw new Error("Bullhorn headless login was superseded before token persistence.");
    }
    const loginData = await login(tokens.access_token, loginUrl);
    const sessionExpiresAt = await resolveSessionExpiry(loginData);
    const s = buildSession(tokens, loginData, sessionExpiresAt);
    const sessionUpdated = await updateFirmSessionAfterRefresh({
      firmId,
      generation: saved.generation,
      restUrl: loginData.restUrl,
      loginUrl: deriveLoginUrl(loginData.restUrl) ?? loginUrl,
    });
    if (!sessionUpdated) {
      throw new Error("Bullhorn headless login was superseded before session publication.");
    }
    logger.info({ restUrl: s.restUrl, firmId }, "Bullhorn: headless direct login complete");
    return s;
  } catch (err) {
    directLoginBlockedUntil = Date.now() + DIRECT_LOGIN_COOLDOWN_MS;
    logger.error(
      { err, firmId },
      "Bullhorn: headless direct login failed; cooling down to protect against account lockout",
    );
    throw err;
  }
}

/**
 * Establishes a session via headless direct login and caches it. Used by the
 * /api/auth/bullhorn/connect endpoint to bootstrap the SERVICE firm's connection
 * with no browser interaction. Single-flighted per firm so concurrent callers
 * share one attempt.
 */
export async function connectHeadless(firmId?: string): Promise<{ restUrl: string }> {
  const fid = currentFirmId(firmId);
  const s = await runInProcessRefreshFlight(refreshFlightKey("firm", fid), async () => {
    const session = await directLogin(fid);
    sessions.set(fid, session);
    logger.info(
      { restUrl: session.restUrl, firmId: fid },
      "Bullhorn: session established (headless)",
    );
    return session;
  });
  return { restUrl: s.restUrl };
}

/** True if the given firm has a Bullhorn service connection (token row exists). */
export async function isFirmConnected(firmId: string): Promise<boolean> {
  const rows = await db
    .select({ id: bullhornTokensTable.id })
    .from(bullhornTokensTable)
    .where(eq(bullhornTokensTable.firmId, firmId))
    .limit(1);
  return rows.length > 0;
}

async function reauthenticate(firmId: string): Promise<Session> {
  // The DB row is the source of truth: every refresh rotates and re-persists
  // the token, so the stored value is at least as fresh as anything held in
  // memory. Prefer it, falling back to the in-memory token only if the DB has
  // none (e.g. immediately after authorization before the first reload).
  const row = await loadTokenRow(firmId);
  const refreshToken = row?.refreshToken ?? sessions.get(firmId)?.refreshToken ?? null;
  const ep = await resolveFirmEndpoints(row);
  if (refreshToken) {
    try {
      logger.info({ firmId }, "Bullhorn: establishing session from refresh token");
      if (!row) throw new Error("No Bullhorn token row found for firm refresh.");
      return await sessionFromRefreshToken(firmId, row, ep);
    } catch (err) {
      // Only the env-credential service firm can self-heal via headless login;
      // customer (oauth) firms must re-authorize interactively.
      if (row?.authMode === "service") {
        logger.warn(
          { firmId, err },
          "Bullhorn: refresh token failed; falling back to headless direct login (service firm)",
        );
        return directLogin(firmId);
      }
      logger.error(
        { firmId, err },
        "Bullhorn: refresh token failed for oauth firm",
      );
      if (err instanceof BullhornRefreshTokenError && err.kind !== "invalid_grant") {
        throw err;
      }
      throw new BullhornNotAuthorizedError();
    }
  }
  if (row?.authMode === "service") {
    logger.info({ firmId }, "Bullhorn: no usable refresh token; performing headless direct login (service firm)");
    return directLogin(firmId);
  }
  await markFirmAuthUnhealthy(firmId, new Error("No Bullhorn refresh token"));
  throw new BullhornNotAuthorizedError();
}

export async function getSession(firmId?: string): Promise<Session> {
  const fid = currentFirmId(firmId);

  const cached = sessions.get(fid);
  if (cached) {
    const tokenExpired = Date.now() >= cached.tokenExpiresAt;
    const sessionExpired = Date.now() >= cached.sessionExpiresAt;

    if (!tokenExpired && !sessionExpired) {
      return cached;
    }

    if (sessionExpired && !tokenExpired) {
      logger.info({ firmId: fid }, "Bullhorn: BhRestToken session expired, re-validating via ping");
      const stillValid = await pingSession(cached);
      if (stillValid) {
        cached.sessionExpiresAt = Date.now() + 10 * 60 * 1000;
        return cached;
      }
    }
  }

  logger.info({ firmId: fid }, "Bullhorn: session invalid or missing, (re)authenticating");
  return runInProcessRefreshFlight(refreshFlightKey("firm", fid), async () => {
    const s = await reauthenticate(fid);
    sessions.set(fid, s);
    logger.info({ firmId: fid, restUrl: s.restUrl }, "Bullhorn: session established");
    return s;
  });
}

/**
 * Drops a firm's in-memory session (forces re-auth on next call). Tolerant of a
 * missing firm context because it runs inside error-handling paths where
 * throwing would mask the original error; with no firmId it is a no-op.
 */
export async function invalidateSession(firmId?: string): Promise<void> {
  const fid = firmId ?? firmContext.getStore()?.firmId;
  if (!fid) return;
  sessions.delete(fid);
  authInProgress.delete(fid);
}

/** Returns true if a refresh token is persisted and auth is healthy for the firm. */
export async function isConnected(firmId?: string): Promise<boolean> {
  const fid = currentFirmId(firmId);
  if (sessions.has(fid)) {
    return true;
  }
  const status = await getFirmBullhornHealthStatus(fid);
  return status.connected && status.healthy;
}

// ── Per-user Bullhorn auth ─────────────────────────────────────────────────
//
// Each enrolled recruiter has their own Bullhorn OAuth session so Bullhorn
// enforces THEIR permission gates on every write operation. Read tools
// continue to use the shared service-account session.

const userSessions = new Map<string, Session>();
const userAuthInProgress = new Map<string, Promise<Session>>();

/** Look up a user row by their API key (our side). Returns null if not found. */
export async function getUserByApiKey(apiKey: string) {
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.apiKey, apiKey))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Returns a live Bullhorn session for the given enrolled user. Refreshes and
 * persists the rotating refresh token when the session is stale. Throws if the
 * user has never enrolled or if the refresh token has expired (re-enrollment
 * required).
 */
export async function getUserSession(userId: string): Promise<Session> {
  const cached = userSessions.get(userId);
  if (cached) {
    const tokenOk = Date.now() < cached.tokenExpiresAt;
    const sessionOk = Date.now() < cached.sessionExpiresAt;
    if (tokenOk && sessionOk) return cached;
  }

  return runInProcessRefreshFlight(refreshFlightKey("user", userId), async () => {
    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    const user = rows[0];
    if (!user) throw new Error(`User ${userId} not found.`);
    const expectedGeneration =
      (user as { bullhornRefreshGeneration?: number }).bullhornRefreshGeneration ?? 0;
    if (!user.refreshToken) {
      const connectUrl = await getBullhornReconnectUrlForUser(userId, expectedGeneration);
      throw new BullhornReconnectRequiredError(connectUrl);
    }
    // Use the firm's own stored endpoints (captured at connect time) so a user
    // at a firm on a different Bullhorn data-center gets the right OAuth/login
    // URLs, not Myticas's. Falls back to discoverEndpoints() only when no firm
    // row exists (shouldn't happen for an enrolled user, but degrades safely).
    const firmTokenRow = user.firmId ? await loadTokenRow(user.firmId) : null;
    const { oauthUrl, loginUrl } = await resolveFirmEndpoints(firmTokenRow);
    const attemptId = randomUUID();
    const claimed = await claimRefreshAttempt({
      kind: "user",
      id: userId,
      attemptId,
      expectedGeneration,
      expectedEncryptedRefreshToken: user.refreshToken,
    });
    if (!claimed) {
      throw new Error("Bullhorn user refresh was not claimed; another attempt or uncertainty exists.");
    }

    let tokenPersisted = false;
    let persistedGeneration = expectedGeneration;
    try {
      const tokens = await fetchTokenWithRefresh(oauthUrl, decryptToken(user.refreshToken!));
      const sPreview = buildSession(
        tokens,
        { BhRestToken: "", restUrl: "" },
        Date.now(),
      );
      const replacementCiphertext = encryptToken(tokens.refresh_token);
      const saved = await persistRefreshTokenSuccess({
        kind: "user",
        id: userId,
        attemptId,
        expectedGeneration,
        expectedEncryptedRefreshToken: user.refreshToken!,
        replacementEncryptedRefreshToken: replacementCiphertext,
      });
      if (!saved.saved) {
        throw new Error("Bullhorn user refresh token save is uncertain; refusing REST login.");
      }
      tokenPersisted = true;
      persistedGeneration = saved.generation;
      const loginData = await login(tokens.access_token, loginUrl);
      const sessionExpiresAt = await resolveSessionExpiry(loginData);
      const s = {
        ...sPreview,
        BhRestToken: loginData.BhRestToken,
        restUrl: loginData.restUrl,
        sessionExpiresAt,
      };
      const sessionUpdated = await updateUserSessionAfterRefresh({
        userId,
        generation: persistedGeneration,
        bhRestToken: loginData.BhRestToken,
        restUrl: loginData.restUrl,
        tokenExpiresAt: s.tokenExpiresAt,
        sessionExpiresAt,
      });
      if (!sessionUpdated) {
        throw new Error("Bullhorn user refresh was superseded before session publication.");
      }
      userSessions.set(userId, s);
      logger.info({ userId, restUrl: s.restUrl }, "Bullhorn: user session established");
      return s;
    } catch (err) {
      userSessions.delete(userId);
      logger.error({ userId, err }, "Bullhorn: user session refresh failed — re-enrollment may be required");
      if (tokenPersisted) {
        throw err;
      }
      if (!tokenPersisted) {
        if (err instanceof BullhornRefreshTokenError && err.kind === "invalid_grant") {
          await persistDefinitiveInvalidGrant({
            kind: "user",
            id: userId,
            attemptId,
            expectedGeneration,
            error: err.message,
          });
        } else {
          await persistRefreshUncertain({
            kind: "user",
            id: userId,
            attemptId,
            expectedGeneration,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
      await beforeUserReconnectUrlForTests?.({ userId, expectedGeneration });
      const connectUrl = await getBullhornReconnectUrlForUser(userId, expectedGeneration);
      // Fire-and-forget notify: recruiter gets a one-click email without waiting
      // for Kyle/admin to notice. Cooldown lives in maybeSendUserReconnectEmail.
      void import("./user-reconnect-notify.js").then(({ maybeSendUserReconnectEmail }) =>
        maybeSendUserReconnectEmail({ userId, connectUrl, expectedGeneration }),
      );
      throw new BullhornReconnectRequiredError(connectUrl);
    }
  });
}

/** Drop the in-memory session cache for a user (forces re-auth on next call). */
export function invalidateUserSession(userId: string): void {
  userSessions.delete(userId);
  userAuthInProgress.delete(userId);
}

/**
 * Headless authorization-code retrieval for a specific user's credentials.
 * Identical logic to fetchAuthCodeHeadless but parameterised — handles the
 * "Get Consent" bounce server-side exactly as the service-account flow does.
 */
async function fetchAuthCodeHeadlessForUser(
  oauthUrl: string,
  username: string,
  password: string,
): Promise<string> {
  const url = new URL(`${oauthUrl}/authorize`);
  url.searchParams.set("client_id", getEnv("BULLHORN_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", getEnv("BULLHORN_REDIRECT_URI"));
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  url.searchParams.set("action", "Login");
  const authorizeUrl = url.toString();

  const res = await fetch(authorizeUrl, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";

  const directCode = codeFromLocation(location);
  if (directCode) return directCode;
  const directErr = errorFromLocation(location);
  if (directErr) throw new Error(`Bullhorn authorization returned an error: ${directErr}`);

  if (res.status === 200) {
    const html = await res.text();
    if (/consentForm|Get Consent/i.test(html)) {
      const setCookies =
        res.headers.getSetCookie?.() ??
        (res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie") as string]
          : []);
      const jsession =
        setCookies
          .map((c) => c.split(";")[0])
          .find((c) => c.startsWith("JSESSIONID=")) ?? null;
      logger.info("Bullhorn: consent screen returned for per-user enrollment; approving headlessly");
      return approveConsent(authorizeUrl, html, jsession);
    }
    const preview = html.replace(/\s+/g, " ").slice(0, 200);
    if (/invalid.*credential|incorrect.*password|login.*fail/i.test(html)) {
      throw new Error("Bullhorn credentials are incorrect. Check your username and password and try again.");
    }
    throw new Error(
      `Bullhorn enrollment returned an unexpected page. ` +
        `Verify your Bullhorn username and password. Details: ${preview}`,
    );
  }

  throw new Error(
    `Bullhorn enrollment did not return an authorization code (status=${res.status}). ` +
      `Check that the redirect URI is whitelisted for this client.`,
  );
}

/**
 * Fully headless per-user enrollment. Sends the user's Bullhorn credentials
 * to /authorize server-side (handling any consent form automatically), then
 * exchanges the code for tokens and persists them. After this call,
 * getUserSession(userId) will succeed without any browser interaction.
 *
 * This avoids the browser "Agree" bounce Bullhorn exhibits when a user clicks
 * the consent form in a real browser — the same issue the service-account flow
 * solves with fetchAuthCodeHeadless.
 */
export async function enrollUserHeadless(
  userId: string,
  bhUsername: string,
  bhPassword: string,
): Promise<void> {
  // Look up the user's firm so we can use the firm's stored endpoints rather
  // than the service-account's data-center (which may differ for a second tenant).
  const userRows = await db
    .select({ firmId: usersTable.firmId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const firmId = userRows[0]?.firmId ?? null;
  const expectedGeneration = await currentRefreshGeneration("user", userId);
  if (expectedGeneration === null) throw new Error(`User ${userId} not found.`);
  if (!firmId) {
    throw new Error("Bullhorn user enrollment requires an active firm membership.");
  }
  const firmTokenRow = firmId ? await loadTokenRow(firmId) : null;
  const { oauthUrl, loginUrl } = await resolveFirmEndpoints(firmTokenRow);

  const code = await fetchAuthCodeHeadlessForUser(oauthUrl, bhUsername, bhPassword);
  const tokens = await exchangeCodeForToken(oauthUrl, code);
  const saved = await persistReconnectTokenBeforeLogin({
    kind: "user",
    id: userId,
    expectedGeneration,
    encryptedRefreshToken: encryptToken(tokens.refresh_token),
    expectedFirmId: firmId,
  });
  if (!saved.saved) {
    throw new Error("Bullhorn user enrollment was superseded before token persistence.");
  }
  const loginData = await login(tokens.access_token, loginUrl);
  const sessionExpiresAt = await resolveSessionExpiry(loginData);
  const s = buildSession(tokens, loginData, sessionExpiresAt);
  const sessionUpdated = await updateUserSessionAfterRefresh({
    userId,
    generation: saved.generation,
    bhRestToken: loginData.BhRestToken,
    restUrl: loginData.restUrl,
    tokenExpiresAt: s.tokenExpiresAt,
    sessionExpiresAt,
  });
  if (!sessionUpdated) {
    throw new Error("Bullhorn user enrollment was superseded before session publication.");
  }
  userSessions.set(userId, s);
  logger.info({ userId, restUrl: s.restUrl }, "Bullhorn: per-user headless enrollment complete");
}

/**
 * Completes a user's Bullhorn enrollment via the browser-based OAuth callback
 * (kept for compatibility; headless enrollment is now preferred via enrollUserHeadless).
 */
export async function completeUserEnrollment(
  userId: string,
  code: string,
  expectedGeneration?: number,
  claimedState?: { state: string; attemptId: string; expectedFirmId?: string | null },
): Promise<void> {
  // Use the user's firm's stored endpoints so a second tenant on a different
  // Bullhorn data-center gets the correct token exchange and login URLs.
  const userRows = await db
    .select({ firmId: usersTable.firmId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const firmId = userRows[0]?.firmId ?? null;
  const currentGeneration = await currentRefreshGeneration("user", userId);
  if (currentGeneration === null) throw new Error(`User ${userId} not found.`);
  const generation = expectedGeneration ?? currentGeneration;
  if (currentGeneration !== generation) {
    throw new Error("Bullhorn user enrollment callback is stale for this generation.");
  }
  if (!firmId) {
    throw new Error("Bullhorn user enrollment callback requires an active firm membership.");
  }
  if (claimedState?.expectedFirmId !== undefined && firmId !== claimedState.expectedFirmId) {
    throw new Error("Bullhorn user enrollment callback is stale for this firm membership.");
  }
  const firmTokenRow = firmId ? await loadTokenRow(firmId) : null;
  const { oauthUrl, loginUrl } = await resolveFirmEndpoints(firmTokenRow);

  const tokens = await exchangeCodeForToken(oauthUrl, code);
  const saved = await persistReconnectTokenBeforeLogin({
    kind: "user",
    id: userId,
    expectedGeneration: generation,
    encryptedRefreshToken: encryptToken(tokens.refresh_token),
    expectedFirmId: firmId,
    claimedState,
  });
  if (!saved.saved) {
    throw new Error("Bullhorn user enrollment was superseded before token persistence.");
  }
  const loginData = await login(tokens.access_token, loginUrl);
  const sessionExpiresAt = await resolveSessionExpiry(loginData);
  const s = buildSession(tokens, loginData, sessionExpiresAt);
  const sessionUpdated = await updateUserSessionAfterRefresh({
    userId,
    generation: saved.generation,
    bhRestToken: loginData.BhRestToken,
    restUrl: loginData.restUrl,
    tokenExpiresAt: s.tokenExpiresAt,
    sessionExpiresAt,
  });
  if (!sessionUpdated) {
    throw new Error("Bullhorn user enrollment was superseded before session publication.");
  }
  userSessions.set(userId, s);
  logger.info({ userId, restUrl: s.restUrl }, "Bullhorn: user enrollment complete (browser callback)");
}

export const __bullhornAuthTestHooks = {
  fetchTokenWithRefresh,
  setBeforeUserReconnectUrl(
    hook:
      | ((opts: { userId: string; expectedGeneration: number }) => Promise<void> | void)
      | null,
  ) {
    beforeUserReconnectUrlForTests = hook;
  },
  resetAuthState() {
    sessions.clear();
    authInProgress.clear();
    userSessions.clear();
    userAuthInProgress.clear();
    endpoints = null;
    directLoginBlockedUntil = 0;
    beforeUserReconnectUrlForTests = null;
  },
};
