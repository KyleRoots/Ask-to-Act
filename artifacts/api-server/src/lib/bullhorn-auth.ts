import { logger } from "./logger.js";

const BULLHORN_AUTH_URL = "https://auth.bullhornstaffing.com/oauth/token";
const BULLHORN_LOGIN_INFO_URL =
  "https://rest.bullhornstaffing.com/rest-services/loginInfo";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface LoginInfoResponse {
  loginUrl?: string;
  apiUrl?: string;
}

interface LoginResponse {
  BhRestToken: string;
  restUrl: string;
}

interface PingResponse {
  sessionExpires?: number;
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

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

async function discoverSwimlanLoginUrl(): Promise<string> {
  const username = getEnv("BULLHORN_USERNAME");
  const url = new URL(BULLHORN_LOGIN_INFO_URL);
  url.searchParams.set("username", username);

  logger.info({ url: url.toString() }, "Bullhorn: discovering swimlane via loginInfo");

  const res = await fetch(url.toString());
  if (!res.ok) {
    logger.warn(
      { status: res.status },
      "Bullhorn: loginInfo failed, falling back to default login URL",
    );
    return "https://rest.bullhornstaffing.com/rest-services/login";
  }

  const data = (await res.json()) as LoginInfoResponse;
  if (data.apiUrl) {
    const loginUrl = `${data.apiUrl.replace(/\/$/, "")}/rest-services/login`;
    logger.info({ apiUrl: data.apiUrl, loginUrl }, "Bullhorn: swimlane discovered");
    return loginUrl;
  }

  logger.warn("Bullhorn: loginInfo did not return apiUrl, using default");
  return "https://rest.bullhornstaffing.com/rest-services/login";
}

async function fetchTokenWithPassword(): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: getEnv("BULLHORN_CLIENT_ID"),
    client_secret: getEnv("BULLHORN_CLIENT_SECRET"),
    username: getEnv("BULLHORN_USERNAME"),
    password: getEnv("BULLHORN_PASSWORD"),
  });

  const res = await fetch(BULLHORN_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Bullhorn OAuth token request failed (${res.status}): ${text}`,
    );
  }

  return (await res.json()) as TokenResponse;
}

async function fetchTokenWithRefresh(
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: getEnv("BULLHORN_CLIENT_ID"),
    client_secret: getEnv("BULLHORN_CLIENT_SECRET"),
  });

  const res = await fetch(BULLHORN_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(
      `Bullhorn refresh token request failed (${res.status})`,
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
    throw new Error(`Bullhorn /login failed (${res.status}): ${text}`);
  }

  return (await res.json()) as LoginResponse;
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
    if (data.sessionExpires) {
      const expiresAt = data.sessionExpires;
      if (expiresAt <= Date.now()) {
        logger.info("Bullhorn: ping reports session already expired");
        return false;
      }
    }
    return true;
  } catch (err) {
    logger.warn({ err }, "Bullhorn: ping failed, treating session as invalid");
    return false;
  }
}

async function createSession(): Promise<Session> {
  logger.info("Bullhorn: initiating new session with password grant");
  const [tokens, loginUrl] = await Promise.all([
    fetchTokenWithPassword(),
    discoverSwimlanLoginUrl(),
  ]);
  const loginData = await login(tokens.access_token, loginUrl);

  const pingUrl = new URL("ping", loginData.restUrl);
  pingUrl.searchParams.set("BhRestToken", loginData.BhRestToken);
  let sessionExpiresAt = Date.now() + 10 * 60 * 1000;
  try {
    const pingRes = await fetch(pingUrl.toString(), { redirect: "follow" });
    if (pingRes.ok) {
      const pingData = (await pingRes.json()) as PingResponse;
      if (pingData.sessionExpires) {
        sessionExpiresAt = pingData.sessionExpires - 30_000;
      }
    }
  } catch {
  }

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
    const loginUrl = await discoverSwimlanLoginUrl();
    const tokens = await fetchTokenWithRefresh(current.refreshToken);
    const loginData = await login(tokens.access_token, loginUrl);

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
    }

    return {
      BhRestToken: loginData.BhRestToken,
      restUrl: loginData.restUrl,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
      sessionExpiresAt,
    };
  } catch (err) {
    logger.warn({ err }, "Bullhorn: refresh failed, falling back to password grant");
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
      logger.info("Bullhorn: BhRestToken session expired, re-authenticating via ping check");
      const still_valid = await pingSession(session);
      if (still_valid) {
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
