import { db, bullhornTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

const BULLHORN_LOGIN_INFO_URL =
  "https://rest.bullhornstaffing.com/rest-services/loginInfo";

const CONNECTION_ID = "default";

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

/**
 * Thrown when no Bullhorn refresh token is available yet. The user must
 * complete the one-time browser authorization at /api/auth/bullhorn/login.
 */
export class BullhornNotAuthorizedError extends Error {
  constructor() {
    super(
      "Bullhorn is not connected yet. An administrator must complete the " +
        "one-time authorization by visiting /api/auth/bullhorn/login in a browser.",
    );
    this.name = "BullhornNotAuthorizedError";
  }
}

let session: Session | null = null;
let authInProgress: Promise<Session> | null = null;
let endpoints: Endpoints | null = null;

// Headless direct-login circuit breaker. After a failed direct login we refuse
// further attempts for a cooldown window: a wrong password retried rapidly can
// trip Bullhorn's failedLoginLockoutThreshold and lock the API user.
const DIRECT_LOGIN_COOLDOWN_MS = 60_000;
let directLoginBlockedUntil = 0;

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

async function loadRefreshToken(): Promise<string | null> {
  const rows = await db
    .select()
    .from(bullhornTokensTable)
    .where(eq(bullhornTokensTable.id, CONNECTION_ID))
    .limit(1);
  return rows[0]?.refreshToken ?? null;
}

async function saveRefreshToken(refreshToken: string): Promise<void> {
  await db
    .insert(bullhornTokensTable)
    .values({ id: CONNECTION_ID, refreshToken, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: bullhornTokensTable.id,
      set: { refreshToken, updatedAt: new Date() },
    });
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
 */
export async function getAuthorizeUrl(state: string): Promise<string> {
  const { oauthUrl } = await discoverEndpoints();
  const url = new URL(`${oauthUrl}/authorize`);
  url.searchParams.set("client_id", getEnv("BULLHORN_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", getEnv("BULLHORN_REDIRECT_URI"));
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Headless authorization-code retrieval. Sends username/password/action=Login to
 * the OAuth /authorize endpoint and reads the code out of the 302 Location
 * header WITHOUT following the redirect (so Bullhorn never calls our callback).
 * This is the server-to-server flow for a Bullhorn "Webservice API User" — no
 * browser and no interactive consent screen. A missing code means bad
 * credentials (Bullhorn returns the HTML login page) or an un-whitelisted
 * redirect_uri.
 */
async function fetchAuthCodeHeadless(oauthUrl: string): Promise<string> {
  const url = new URL(`${oauthUrl}/authorize`);
  url.searchParams.set("client_id", getEnv("BULLHORN_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", getEnv("BULLHORN_REDIRECT_URI"));
  url.searchParams.set("username", getEnv("BULLHORN_USERNAME"));
  url.searchParams.set("password", getEnv("BULLHORN_PASSWORD"));
  url.searchParams.set("action", "Login");

  const res = await fetch(url.toString(), { redirect: "manual" });
  const location = res.headers.get("location") ?? "";

  if (location) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(location);
    } catch {
      parsed = null;
    }
    if (parsed) {
      const code = parsed.searchParams.get("code");
      if (code) {
        return code;
      }
      const errCode = parsed.searchParams.get("error");
      if (errCode) {
        const desc = parsed.searchParams.get("error_description") ?? "";
        throw new Error(
          `Bullhorn headless authorize returned an error: ${errCode} ${desc}`.trim(),
        );
      }
    }
  }

  const bodyPreview = (await res.text().catch(() => "")).slice(0, 200);
  throw new Error(
    `Bullhorn headless authorize did not return an authorization code ` +
      `(status=${res.status}). This usually means BULLHORN_USERNAME/BULLHORN_PASSWORD ` +
      `are incorrect, or the redirect_uri is not whitelisted for this client_id. ` +
      `Response start: ${bodyPreview}`,
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
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: getEnv("BULLHORN_CLIENT_ID"),
    client_secret: getEnv("BULLHORN_CLIENT_SECRET"),
  });

  const res = await fetch(`${oauthUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Bullhorn refresh token request failed (${res.status}): ${text.slice(0, 200)}`,
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
export async function completeAuthorization(code: string): Promise<void> {
  const { oauthUrl, loginUrl } = await discoverEndpoints();
  const tokens = await exchangeCodeForToken(oauthUrl, code);
  const loginData = await login(tokens.access_token, loginUrl);
  const sessionExpiresAt = await resolveSessionExpiry(loginData);
  session = buildSession(tokens, loginData, sessionExpiresAt);
  await saveRefreshToken(tokens.refresh_token);
  logger.info({ restUrl: session.restUrl }, "Bullhorn: authorization complete, session established");
}

/**
 * Builds a fresh session from a stored refresh token, rotating and persisting
 * the new refresh token Bullhorn returns.
 */
async function sessionFromRefreshToken(refreshToken: string): Promise<Session> {
  const { oauthUrl, loginUrl } = await discoverEndpoints();
  const tokens = await fetchTokenWithRefresh(oauthUrl, refreshToken);
  const loginData = await login(tokens.access_token, loginUrl);
  const sessionExpiresAt = await resolveSessionExpiry(loginData);
  const s = buildSession(tokens, loginData, sessionExpiresAt);
  await saveRefreshToken(tokens.refresh_token);
  return s;
}

/**
 * Headless ("direct") login: gets an authorization code by sending credentials
 * straight to /authorize, then runs the standard token + REST-login exchange and
 * persists the rotating refresh token. No browser, no consent screen. Guarded by
 * a cooldown so a wrong password cannot be retried fast enough to lock the API
 * user.
 */
async function directLogin(): Promise<Session> {
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
    const { oauthUrl, loginUrl } = await discoverEndpoints();
    const code = await fetchAuthCodeHeadless(oauthUrl);
    const tokens = await exchangeCodeForToken(oauthUrl, code);
    const loginData = await login(tokens.access_token, loginUrl);
    const sessionExpiresAt = await resolveSessionExpiry(loginData);
    const s = buildSession(tokens, loginData, sessionExpiresAt);
    await saveRefreshToken(tokens.refresh_token);
    logger.info({ restUrl: s.restUrl }, "Bullhorn: headless direct login complete");
    return s;
  } catch (err) {
    directLoginBlockedUntil = Date.now() + DIRECT_LOGIN_COOLDOWN_MS;
    logger.error(
      { err },
      "Bullhorn: headless direct login failed; cooling down to protect against account lockout",
    );
    throw err;
  }
}

/**
 * Establishes a session via headless direct login and caches it. Used by the
 * /api/auth/bullhorn/connect endpoint to bootstrap the connection with no
 * browser interaction. Single-flighted so concurrent callers share one attempt.
 */
export async function connectHeadless(): Promise<{ restUrl: string }> {
  if (authInProgress) {
    const existing = await authInProgress;
    return { restUrl: existing.restUrl };
  }
  authInProgress = directLogin()
    .then((s) => {
      session = s;
      logger.info({ restUrl: s.restUrl }, "Bullhorn: session established (headless)");
      return s;
    })
    .finally(() => {
      authInProgress = null;
    });
  const s = await authInProgress;
  return { restUrl: s.restUrl };
}

async function reauthenticate(): Promise<Session> {
  // The DB row is the source of truth: every refresh rotates and re-persists
  // the token, so the stored value is at least as fresh as anything held in
  // memory. Prefer it, falling back to the in-memory token only if the DB has
  // none (e.g. immediately after authorization before the first reload).
  const stored = await loadRefreshToken();
  const refreshToken = stored ?? session?.refreshToken ?? null;
  if (refreshToken) {
    try {
      logger.info("Bullhorn: establishing session from refresh token");
      return await sessionFromRefreshToken(refreshToken);
    } catch (err) {
      logger.warn(
        { err },
        "Bullhorn: refresh token failed; falling back to headless direct login",
      );
    }
  }
  logger.info("Bullhorn: no usable refresh token; performing headless direct login");
  return directLogin();
}

export async function getSession(): Promise<Session> {
  if (authInProgress) {
    return authInProgress;
  }

  if (session) {
    const tokenExpired = Date.now() >= session.tokenExpiresAt;
    const sessionExpired = Date.now() >= session.sessionExpiresAt;

    if (!tokenExpired && !sessionExpired) {
      return session;
    }

    if (sessionExpired && !tokenExpired) {
      logger.info("Bullhorn: BhRestToken session expired, re-validating via ping");
      const stillValid = await pingSession(session);
      if (stillValid) {
        session.sessionExpiresAt = Date.now() + 10 * 60 * 1000;
        return session;
      }
    }
  }

  logger.info("Bullhorn: session invalid or missing, (re)authenticating");
  authInProgress = reauthenticate()
    .then((s) => {
      session = s;
      logger.info({ restUrl: s.restUrl }, "Bullhorn: session established");
      return s;
    })
    .finally(() => {
      authInProgress = null;
    });
  return authInProgress;
}

export async function invalidateSession(): Promise<void> {
  session = null;
  authInProgress = null;
}

/** Returns true if a refresh token is persisted (i.e. Bullhorn is connected). */
export async function isConnected(): Promise<boolean> {
  if (session) {
    return true;
  }
  return (await loadRefreshToken()) !== null;
}
