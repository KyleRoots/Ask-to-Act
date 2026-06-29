#!/usr/bin/env tsx
/**
 * Read-only Bullhorn REST diagnostic CLI for local troubleshooting.
 *
 * Auth (pick one):
 *   A) Refresh token: BH_REFRESH_TOKEN (+ BH_CLIENT_ID, BH_CLIENT_SECRET)
 *   B) Service API user: BH_USERNAME, BH_PASSWORD, BH_CLIENT_ID, BH_CLIENT_SECRET,
 *      BH_REDIRECT_URI (same values as Railway BULLHORN_* vars)
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run bh -- ping
 *   pnpm --filter @workspace/scripts run bh -- meta Candidate
 *   pnpm --filter @workspace/scripts run bh -- search Candidate "status:Active" --count 3
 *   pnpm --filter @workspace/scripts run bh -- get Candidate 12345
 *   pnpm --filter @workspace/scripts run bh -- raw query/Candidate?where=id>0&count=1
 */

const LOGIN_INFO_URL =
  "https://rest.bullhornstaffing.com/rest-services/loginInfo";

type Endpoints = { oauthUrl: string; loginUrl: string; restUrl: string };
type Session = { BhRestToken: string; restUrl: string };

function env(...keys: string[]): string {
  for (const key of keys) {
    const val = process.env[key];
    if (val) return val;
  }
  throw new Error(`Missing env var (tried: ${keys.join(", ")})`);
}

function optionalEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const val = process.env[key];
    if (val) return val;
  }
  return undefined;
}

function codeFromLocation(location: string): string | null {
  if (!location) return null;
  try {
    return new URL(location).searchParams.get("code");
  } catch {
    return null;
  }
}

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

async function discoverEndpoints(username: string): Promise<Endpoints> {
  const url = new URL(LOGIN_INFO_URL);
  url.searchParams.set("username", username);
  const res = await fetch(url.toString(), { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`loginInfo failed (${res.status})`);
  }
  const data = (await res.json()) as { oauthUrl?: string; restUrl?: string };
  if (!data.oauthUrl || !data.restUrl) {
    throw new Error("loginInfo did not return oauthUrl/restUrl");
  }
  const restUrl = data.restUrl.replace(/\/$/, "");
  return {
    oauthUrl: data.oauthUrl.replace(/\/$/, ""),
    restUrl,
    loginUrl: `${restUrl}/login`,
  };
}

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
    body,
  });
  const location = res.headers.get("location") ?? "";
  const code = codeFromLocation(location);
  if (code) return code;
  throw new Error(`Consent approval did not return a code (status=${res.status})`);
}

async function fetchAuthCodeHeadless(ep: Endpoints): Promise<string> {
  const clientId = env("BH_CLIENT_ID", "BULLHORN_CLIENT_ID");
  const redirectUri = env("BH_REDIRECT_URI", "BULLHORN_REDIRECT_URI");
  const username = env("BH_USERNAME", "BULLHORN_USERNAME");
  const password = env("BH_PASSWORD", "BULLHORN_PASSWORD");

  const url = new URL(`${ep.oauthUrl}/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  url.searchParams.set("action", "Login");
  const authorizeUrl = url.toString();

  const res = await fetch(authorizeUrl, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  const directCode = codeFromLocation(location);
  if (directCode) return directCode;

  if (res.status === 200) {
    const html = await res.text();
    if (/consentForm|Get Consent/i.test(html)) {
      const setCookies =
        res.headers.getSetCookie?.() ??
        (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
      const jsession =
        setCookies
          .map((c) => c.split(";")[0])
          .find((c) => c.startsWith("JSESSIONID=")) ?? null;
      return approveConsent(authorizeUrl, html, jsession);
    }
    throw new Error(
      "Headless authorize returned unexpected HTML — check BH_USERNAME/BH_PASSWORD.",
    );
  }

  throw new Error(`Headless authorize failed (status=${res.status})`);
}

async function exchangeCode(oauthUrl: string, code: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: env("BH_CLIENT_ID", "BULLHORN_CLIENT_ID"),
    client_secret: env("BH_CLIENT_SECRET", "BULLHORN_CLIENT_SECRET"),
    redirect_uri: env("BH_REDIRECT_URI", "BULLHORN_REDIRECT_URI"),
  });
  const res = await fetch(`${oauthUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function refreshAccessToken(oauthUrl: string, refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env("BH_CLIENT_ID", "BULLHORN_CLIENT_ID"),
    client_secret: env("BH_CLIENT_SECRET", "BULLHORN_CLIENT_SECRET"),
  });
  const res = await fetch(`${oauthUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function restLogin(accessToken: string, loginUrl: string): Promise<Session> {
  const url = new URL(loginUrl);
  url.searchParams.set("version", "*");
  url.searchParams.set("access_token", accessToken);
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`REST /login failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { BhRestToken: string; restUrl: string };
  return { BhRestToken: data.BhRestToken, restUrl: data.restUrl };
}

async function authenticate(): Promise<Session> {
  const refreshToken = optionalEnv("BH_REFRESH_TOKEN");
  const username = optionalEnv("BH_USERNAME", "BULLHORN_USERNAME");
  if (!refreshToken && !username) {
    throw new Error(
      "Set BH_REFRESH_TOKEN or BH_USERNAME/BH_PASSWORD (or BULLHORN_* equivalents).",
    );
  }

  const ep = await discoverEndpoints(
    username ?? env("BH_USERNAME", "BULLHORN_USERNAME"),
  );

  const accessToken = refreshToken
    ? await refreshAccessToken(ep.oauthUrl, refreshToken)
    : await exchangeCode(ep.oauthUrl, await fetchAuthCodeHeadless(ep));

  return restLogin(accessToken, ep.loginUrl);
}

async function bhFetch(
  session: Session,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const base = session.restUrl.replace(/\/$/, "");
  const normalized = path.replace(/^\//, "");
  const url = new URL(normalized, `${base}/`);
  url.searchParams.set("BhRestToken", session.BhRestToken);
  const res = await fetch(url.toString(), init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bullhorn ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function printHelp(): void {
  console.log(`Bullhorn direct diagnostic CLI (read-only)

Commands:
  ping                         Verify session
  meta <Entity>                Entity metadata (configured custom fields)
  search <Entity> <lucene>     Lucene search (--count N, default 5)
  get <Entity> <id>            Fetch one record by id
  raw <path>                   Raw GET under REST base (e.g. query/Candidate?where=id>0)

Env (BH_* or BULLHORN_*):
  BH_CLIENT_ID, BH_CLIENT_SECRET
  BH_USERNAME, BH_PASSWORD, BH_REDIRECT_URI   (headless service user)
  BH_REFRESH_TOKEN                            (optional, skips password login)
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  const [cmd, ...rest] = args;
  const session = await authenticate();

  switch (cmd) {
    case "ping": {
      const data = await bhFetch(session, "ping");
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    case "meta": {
      const entity = rest[0];
      if (!entity) throw new Error("Usage: meta <Entity>");
      const data = await bhFetch(session, `meta/${entity}?meta=basic`, {
        headers: { Accept: "application/json" },
      });
      const fields = (data as { fields?: unknown[] })?.fields ?? [];
      const configured = fields.filter(
        (f) =>
          f &&
          typeof f === "object" &&
          "label" in f &&
          typeof (f as { label?: string }).label === "string" &&
          /custom/i.test(String((f as { name?: string }).name ?? "")),
      );
      console.log(JSON.stringify({ entity, fieldCount: fields.length, configuredCustomFields: configured }, null, 2));
      return;
    }
    case "search": {
      const entity = rest[0];
      const query = rest[1];
      if (!entity || !query) throw new Error('Usage: search <Entity> "<lucene>" [--count N]');
      let count = 5;
      const countIdx = rest.indexOf("--count");
      if (countIdx >= 0 && rest[countIdx + 1]) {
        count = Number(rest[countIdx + 1]);
      }
      const data = await bhFetch(
        session,
        `search/${entity}?query=${encodeURIComponent(query)}&count=${count}&fields=id,name,status`,
      );
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    case "get": {
      const entity = rest[0];
      const id = rest[1];
      if (!entity || !id) throw new Error("Usage: get <Entity> <id>");
      const data = await bhFetch(session, `entity/${entity}/${id}`);
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    case "raw": {
      const path = rest.join(" ");
      if (!path) throw new Error("Usage: raw <path>");
      const data = await bhFetch(session, path);
      console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
      return;
    }
    default:
      throw new Error(`Unknown command: ${cmd}. Run with --help.`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});
