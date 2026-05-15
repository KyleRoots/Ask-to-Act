import { logger } from "./logger.js";

const BULLHORN_AUTH_URL = "https://auth.bullhornstaffing.com/oauth/token";
const BULLHORN_LOGIN_URL =
  "https://rest.bullhornstaffing.com/rest-services/login";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface LoginResponse {
  BhRestToken: string;
  restUrl: string;
}

interface Session {
  BhRestToken: string;
  restUrl: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
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

async function login(accessToken: string): Promise<LoginResponse> {
  const url = new URL(BULLHORN_LOGIN_URL);
  url.searchParams.set("version", "*");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bullhorn /login failed (${res.status}): ${text}`);
  }

  return (await res.json()) as LoginResponse;
}

async function createSession(): Promise<Session> {
  logger.info("Bullhorn: initiating new session with password grant");
  const tokens = await fetchTokenWithPassword();
  const loginData = await login(tokens.access_token);
  return {
    BhRestToken: loginData.BhRestToken,
    restUrl: loginData.restUrl,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
  };
}

async function refreshSession(current: Session): Promise<Session> {
  logger.info("Bullhorn: refreshing session with refresh token");
  try {
    const tokens = await fetchTokenWithRefresh(current.refreshToken);
    const loginData = await login(tokens.access_token);
    return {
      BhRestToken: loginData.BhRestToken,
      restUrl: loginData.restUrl,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
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
    if (Date.now() < session.tokenExpiresAt) {
      return session;
    }
    logger.info("Bullhorn: access token expired, refreshing");
    authInProgress = refreshSession(session).then((s) => {
      session = s;
      authInProgress = null;
      return s;
    });
    return authInProgress;
  }

  authInProgress = createSession().then((s) => {
    session = s;
    authInProgress = null;
    logger.info(
      { restUrl: s.restUrl },
      "Bullhorn: session established",
    );
    return s;
  });
  return authInProgress;
}

export async function invalidateSession(): Promise<void> {
  session = null;
  authInProgress = null;
}
