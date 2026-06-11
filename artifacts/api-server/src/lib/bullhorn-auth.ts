import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";

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

let session: Session | null = null;
let authInProgress: Promise<Session> | null = null;
let endpoints: Endpoints | null = null;

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
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
 * Performs the headless OAuth Authorization Code request. Bullhorn responds
 * with a 302 whose Location header carries the auth code. We must read that
 * header WITHOUT following the redirect, which the global fetch cannot do
 * reliably (manual redirects become opaque), so we use node:https directly.
 */
function fetchAuthCode(oauthUrl: string): Promise<string> {
  const authorizeUrl = new URL(`${oauthUrl}/authorize`);
  authorizeUrl.searchParams.set("client_id", getEnv("BULLHORN_CLIENT_ID"));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("action", "Login");
  authorizeUrl.searchParams.set("username", getEnv("BULLHORN_USERNAME"));
  authorizeUrl.searchParams.set("password", getEnv("BULLHORN_PASSWORD"));
  authorizeUrl.searchParams.set("redirect_uri", getEnv("BULLHORN_REDIRECT_URI"));
  authorizeUrl.searchParams.set("state", randomBytes(12).toString("hex"));

  return new Promise<string>((resolve, reject) => {
    const req = httpsRequest(
      authorizeUrl.toString(),
      { method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          if (body.length < 2000) {
            body += chunk;
          }
        });
        res.on("end", () => {
          const location = res.headers.location;
          if (!location) {
            reject(
              new Error(
                `Bullhorn authorize did not redirect (status ${res.statusCode}). ` +
                  `This usually means an invalid redirect_uri, client_id, or credentials. ` +
                  `Response: ${body.slice(0, 300)}`,
              ),
            );
            return;
          }
          try {
            const loc = new URL(location);
            const code = loc.searchParams.get("code");
            if (!code) {
              const err = loc.searchParams.get("error_description") ?? location;
              reject(new Error(`Bullhorn authorize returned no code: ${err}`));
              return;
            }
            resolve(code);
          } catch {
            reject(new Error(`Bullhorn authorize returned malformed Location`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
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
    throw new Error(`Bullhorn refresh token request failed (${res.status})`);
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

async function createSession(): Promise<Session> {
  logger.info("Bullhorn: initiating new session via authorization_code grant");
  const { oauthUrl, loginUrl } = await discoverEndpoints();
  const code = await fetchAuthCode(oauthUrl);
  const tokens = await exchangeCodeForToken(oauthUrl, code);
  const loginData = await login(tokens.access_token, loginUrl);
  const sessionExpiresAt = await resolveSessionExpiry(loginData);

  return {
    BhRestToken: loginData.BhRestToken,
    restUrl: loginData.restUrl,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
    sessionExpiresAt,
  };
}

async function refreshSession(current: Session): Promise<Session> {
  logger.info("Bullhorn: refreshing session with refresh token");
  try {
    const { oauthUrl, loginUrl } = await discoverEndpoints();
    const tokens = await fetchTokenWithRefresh(oauthUrl, current.refreshToken);
    const loginData = await login(tokens.access_token, loginUrl);
    const sessionExpiresAt = await resolveSessionExpiry(loginData);

    return {
      BhRestToken: loginData.BhRestToken,
      restUrl: loginData.restUrl,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
      sessionExpiresAt,
    };
  } catch (err) {
    logger.warn({ err }, "Bullhorn: refresh failed, falling back to full re-auth");
    return createSession();
  }
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

    if (sessionExpired) {
      logger.info("Bullhorn: BhRestToken session expired, re-validating via ping");
      const stillValid = await pingSession(session);
      if (stillValid) {
        session.sessionExpiresAt = Date.now() + 10 * 60 * 1000;
        return session;
      }
    }

    logger.info("Bullhorn: session invalid, refreshing");
    authInProgress = refreshSession(session)
      .then((s) => {
        session = s;
        return s;
      })
      .finally(() => {
        authInProgress = null;
      });
    return authInProgress;
  }

  authInProgress = createSession()
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
