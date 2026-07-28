import { randomBytes } from "node:crypto";
import { db, userMailboxesTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { decryptToken, encryptToken } from "./token-crypto.js";
import { getBaseUrl } from "./getBaseUrl.js";

const PROVIDER = "microsoft365";
const CONNECT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

interface MailboxProfile {
  mail?: string | null;
  userPrincipalName?: string | null;
}

export interface MailboxSession {
  provider: typeof PROVIDER;
  accessToken: string;
  mailboxEmail: string;
  tokenExpiresAt: number;
}

export class MailboxNotConnectedError extends Error {
  constructor(public readonly connectUrl: string) {
    super(
      "Your Microsoft 365 mailbox is not connected yet. Open the connect link, finish sign-in, then retry the email send.",
    );
    this.name = "MailboxNotConnectedError";
  }
}

export class MailboxReconnectRequiredError extends Error {
  constructor(public readonly connectUrl: string) {
    super(
      "Your Microsoft 365 mailbox connection needs to be refreshed. Open the reconnect link, finish sign-in, then retry the email send.",
    );
    this.name = "MailboxReconnectRequiredError";
  }
}

const sessions = new Map<string, MailboxSession>();
const authInProgress = new Map<string, Promise<MailboxSession>>();

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function oauthBaseUrl(): string {
  const tenant = process.env["M365_TENANT_ID"] ?? "organizations";
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
}

function configuredScope(): string {
  return (
    process.env["M365_SCOPE"] ??
    "offline_access openid profile email User.Read Mail.Send"
  );
}

function normalizeMailboxEmail(profile: MailboxProfile): string {
  const raw = profile.mail?.trim() || profile.userPrincipalName?.trim() || "";
  if (!raw) {
    throw new Error(
      "Microsoft 365 did not return a mailbox email address for this account.",
    );
  }
  return raw.toLowerCase();
}

async function loadMailboxRow(userId: string) {
  const rows = await db
    .select()
    .from(userMailboxesTable)
    .where(
      and(
        eq(userMailboxesTable.userId, userId),
        eq(userMailboxesTable.provider, PROVIDER),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    refreshToken: row.refreshToken ? decryptToken(row.refreshToken) : null,
    accessToken: row.accessToken ? decryptToken(row.accessToken) : null,
  };
}

async function saveMailboxSession(
  userId: string,
  tokens: TokenResponse,
  mailboxEmail: string,
): Promise<MailboxSession> {
  const now = Date.now();
  const tokenExpiresAt = now + tokens.expires_in * 1000 - 60_000;
  const nextRefreshToken = tokens.refresh_token;
  const current = await loadMailboxRow(userId);
  const refreshToken = nextRefreshToken ?? current?.refreshToken ?? null;
  if (!refreshToken) {
    throw new Error("Microsoft 365 did not return a refresh token for this mailbox.");
  }
  const session: MailboxSession = {
    provider: PROVIDER,
    accessToken: tokens.access_token,
    mailboxEmail,
    tokenExpiresAt,
  };

  const nowDate = new Date(now);
  await db
    .insert(userMailboxesTable)
    .values({
      userId,
      provider: PROVIDER,
      mailboxEmail,
      refreshToken: encryptToken(refreshToken),
      accessToken: encryptToken(tokens.access_token),
      tokenExpiresAt,
      scope: tokens.scope ?? configuredScope(),
      connectToken: null,
      connectTokenExpiresAt: null,
      connectedAt: current?.connectedAt ?? nowDate,
      revokedAt: null,
      lastError: null,
      lastErrorAt: null,
      updatedAt: nowDate,
    })
    .onConflictDoUpdate({
      target: [userMailboxesTable.userId, userMailboxesTable.provider],
      set: {
        mailboxEmail,
        refreshToken: encryptToken(refreshToken),
        accessToken: encryptToken(tokens.access_token),
        tokenExpiresAt,
        scope: tokens.scope ?? configuredScope(),
        connectToken: null,
        connectTokenExpiresAt: null,
        connectedAt: current?.connectedAt ?? nowDate,
        revokedAt: null,
        lastError: null,
        lastErrorAt: null,
        updatedAt: nowDate,
      },
    });

  sessions.set(userId, session);
  return session;
}

async function saveMailboxError(userId: string, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  await db
    .insert(userMailboxesTable)
    .values({
      userId,
      provider: PROVIDER,
      lastError: message,
      lastErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userMailboxesTable.userId, userMailboxesTable.provider],
      set: {
        lastError: message,
        lastErrorAt: new Date(),
        updatedAt: new Date(),
      },
    });
}

async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: getEnv("M365_CLIENT_ID"),
    client_secret: getEnv("M365_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: getEnv("M365_REDIRECT_URI"),
    scope: configuredScope(),
  });
  const res = await fetch(`${oauthBaseUrl()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Microsoft 365 token exchange failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: getEnv("M365_CLIENT_ID"),
    client_secret: getEnv("M365_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    redirect_uri: getEnv("M365_REDIRECT_URI"),
    scope: configuredScope(),
  });
  const res = await fetch(`${oauthBaseUrl()}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Microsoft 365 refresh failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

async function fetchMailboxProfile(accessToken: string): Promise<MailboxProfile> {
  const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Microsoft Graph profile lookup failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as MailboxProfile;
}

export async function issueMailboxConnectToken(userId: string): Promise<string> {
  const [user] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) throw new Error(`User ${userId} not found.`);

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + CONNECT_TOKEN_TTL_MS);
  await db
    .insert(userMailboxesTable)
    .values({
      userId,
      provider: PROVIDER,
      connectToken: token,
      connectTokenExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [userMailboxesTable.userId, userMailboxesTable.provider],
      set: {
        connectToken: token,
        connectTokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      },
    });
  return token;
}

export async function getMailboxConnectUrlForUser(userId: string): Promise<string> {
  const token = await issueMailboxConnectToken(userId);
  return `${getBaseUrl()}/api/auth/m365/start?token=${token}`;
}

export async function getUserMailboxStatus(userId: string): Promise<{
  connected: boolean;
  mailboxEmail: string | null;
}> {
  const row = await loadMailboxRow(userId);
  return {
    connected: !!row?.refreshToken && !row?.revokedAt,
    mailboxEmail: row?.mailboxEmail ?? null,
  };
}

export async function getMicrosoftAuthorizeUrl(state: string): Promise<string> {
  const url = new URL(`${oauthBaseUrl()}/authorize`);
  url.searchParams.set("client_id", getEnv("M365_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", getEnv("M365_REDIRECT_URI"));
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", configuredScope());
  url.searchParams.set("state", state);
  return url.toString();
}

export async function resolveUserIdFromMailboxConnectToken(
  token: string,
): Promise<{ userId: string; name: string } | null> {
  const rows = await db
    .select({
      userId: userMailboxesTable.userId,
      name: usersTable.name,
      connectTokenExpiresAt: userMailboxesTable.connectTokenExpiresAt,
    })
    .from(userMailboxesTable)
    .innerJoin(usersTable, eq(usersTable.id, userMailboxesTable.userId))
    .where(
      and(
        eq(userMailboxesTable.provider, PROVIDER),
        eq(userMailboxesTable.connectToken, token),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row?.connectTokenExpiresAt || row.connectTokenExpiresAt < new Date()) {
    return null;
  }
  return { userId: row.userId, name: row.name };
}

export async function completeMailboxConnection(
  userId: string,
  code: string,
): Promise<{ mailboxEmail: string }> {
  const tokens = await exchangeCodeForTokens(code);
  const profile = await fetchMailboxProfile(tokens.access_token);
  const mailboxEmail = normalizeMailboxEmail(profile);
  await saveMailboxSession(userId, tokens, mailboxEmail);
  logger.info({ userId, mailboxEmail }, "Microsoft 365 mailbox connected");
  return { mailboxEmail };
}

export async function getUserMailboxSession(userId: string): Promise<MailboxSession> {
  const inProgress = authInProgress.get(userId);
  if (inProgress) return inProgress;

  const cached = sessions.get(userId);
  if (cached && Date.now() < cached.tokenExpiresAt) {
    return cached;
  }

  const row = await loadMailboxRow(userId);
  if (!row?.refreshToken || row.revokedAt) {
    throw new MailboxNotConnectedError(await getMailboxConnectUrlForUser(userId));
  }

  if (
    row.accessToken &&
    row.mailboxEmail &&
    row.tokenExpiresAt &&
    Date.now() < row.tokenExpiresAt
  ) {
    const session: MailboxSession = {
      provider: PROVIDER,
      accessToken: row.accessToken,
      mailboxEmail: row.mailboxEmail,
      tokenExpiresAt: row.tokenExpiresAt,
    };
    sessions.set(userId, session);
    return session;
  }

  const work = (async (): Promise<MailboxSession> => {
    try {
      const tokens = await refreshTokens(row.refreshToken!);
      const accessToken = tokens.access_token;
      const profile = await fetchMailboxProfile(accessToken);
      const mailboxEmail = normalizeMailboxEmail(profile);
      return await saveMailboxSession(userId, tokens, mailboxEmail);
    } catch (err) {
      sessions.delete(userId);
      await saveMailboxError(userId, err).catch(() => {});
      logger.error({ userId, err }, "Microsoft 365 mailbox refresh failed");
      throw new MailboxReconnectRequiredError(
        await getMailboxConnectUrlForUser(userId),
      );
    }
  })().finally(() => {
    authInProgress.delete(userId);
  });

  authInProgress.set(userId, work);
  return work;
}

export async function disconnectUserMailbox(userId: string): Promise<void> {
  sessions.delete(userId);
  authInProgress.delete(userId);
  await db
    .delete(userMailboxesTable)
    .where(
      and(
        eq(userMailboxesTable.userId, userId),
        eq(userMailboxesTable.provider, PROVIDER),
      ),
    );
}
