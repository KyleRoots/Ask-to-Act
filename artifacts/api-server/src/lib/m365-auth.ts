import { randomBytes } from "node:crypto";
import { db, firmsTable, userMailboxesTable, usersTable } from "@workspace/db";
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
  id_token?: string;
}

/** Microsoft Entra tenant id (GUID). "organizations" and "common" are not tenants. */
export const MICROSOFT_TENANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMicrosoftTenantId(value: string): boolean {
  return MICROSOFT_TENANT_ID.test(value.trim());
}

export class MailboxTenantMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxTenantMismatchError";
  }
}

export class MailboxEmailDomainMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxEmailDomainMismatchError";
  }
}

interface ResolvedMicrosoftTenant {
  /** Tenant segment used in the Microsoft authorize and token URLs. */
  tenant: string;
  /**
   * Set only when the firm row stores a tenant id. Null means this call is
   * using the platform fallback (M365_TENANT_ID, or "organizations").
   */
  firmTenantId: string | null;
  userEmail: string | null;
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

function fallbackMicrosoftTenant(): string {
  const fromEnv = process.env["M365_TENANT_ID"]?.trim();
  return fromEnv || "organizations";
}

function oauthBaseUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}

/**
 * Firm tenant when one is stored. Otherwise the platform tenant in
 * M365_TENANT_ID, then "organizations" when that env var is unset.
 */
async function resolveMicrosoftTenant(userId: string): Promise<ResolvedMicrosoftTenant> {
  const [user] = await db
    .select({ firmId: usersTable.firmId, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const userEmail = user?.email?.trim() || null;
  if (!user?.firmId) {
    return { tenant: fallbackMicrosoftTenant(), firmTenantId: null, userEmail };
  }
  const [firm] = await db
    .select({ microsoftTenantId: firmsTable.microsoftTenantId })
    .from(firmsTable)
    .where(eq(firmsTable.id, user.firmId))
    .limit(1);
  const stored = firm?.microsoftTenantId?.trim() || "";
  if (!stored) {
    return { tenant: fallbackMicrosoftTenant(), firmTenantId: null, userEmail };
  }
  if (!isMicrosoftTenantId(stored)) {
    throw new Error(
      "This firm's Microsoft tenant id is not a valid GUID. Ask an administrator to correct it. No mailbox was saved.",
    );
  }
  return { tenant: stored, firmTenantId: stored, userEmail };
}

function tidFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { tid?: unknown };
    return typeof payload.tid === "string" && payload.tid.trim()
      ? payload.tid.trim()
      : null;
  } catch {
    return null;
  }
}

async function graphOrganizationId(accessToken: string): Promise<string | null> {
  const res = await fetch(
    "https://graph.microsoft.com/v1.0/organization?$select=id",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { value?: Array<{ id?: unknown }> };
  const id = body.value?.[0]?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Tenant of the account that just signed in. Graph organization id wins when
 * the app can read it. id_token tid is accepted when Graph does not return one.
 * The two must agree when both are present.
 */
async function readSignedInTenant(tokens: TokenResponse): Promise<string | null> {
  const fromToken = tidFromIdToken(tokens.id_token);
  const fromGraph = await graphOrganizationId(tokens.access_token);
  if (
    fromToken &&
    fromGraph &&
    fromToken.toLowerCase() !== fromGraph.toLowerCase()
  ) {
    throw new MailboxTenantMismatchError(
      "Microsoft returned two different tenant ids for this sign-in. No mailbox was saved.",
    );
  }
  return fromGraph ?? fromToken;
}

function assertTenantMatches(expected: ResolvedMicrosoftTenant, actual: string | null): void {
  if (!isMicrosoftTenantId(expected.tenant)) return;
  if (!actual || !isMicrosoftTenantId(actual)) {
    throw new MailboxTenantMismatchError(
      "Microsoft did not confirm which tenant this account belongs to. No mailbox was saved.",
    );
  }
  if (actual.toLowerCase() !== expected.tenant.toLowerCase()) {
    throw new MailboxTenantMismatchError(
      `This Microsoft account belongs to tenant ${actual}, which is not this firm's Microsoft tenant (${expected.tenant}). No mailbox was saved. Sign in with an account in your firm's Microsoft 365 tenant.`,
    );
  }
}

/**
 * Mailbox address vs the AskToAct user email.
 * Enforced only after a firm has its own tenant id (Myticas stays on the
 * platform tenant and is not subject to this check):
 *  - no AskToAct email on the user: tenant match is the only check
 *  - both addresses present: the mailbox domain must equal the user's domain
 * Exact local-part equality is not required. Aliases on the firm domain
 * can still connect. A mailbox on another firm's domain in the same tenant
 * is refused and nothing is stored.
 */
function assertMailboxEmailAllowed(
  resolved: ResolvedMicrosoftTenant,
  mailboxEmail: string,
): void {
  if (!resolved.firmTenantId) return;
  const userEmail = resolved.userEmail?.trim().toLowerCase() || "";
  if (!userEmail) return;
  const userDomain = emailDomain(userEmail);
  const mailboxDomain = emailDomain(mailboxEmail);
  if (!userDomain || !mailboxDomain || userDomain !== mailboxDomain) {
    throw new MailboxEmailDomainMismatchError(
      `This Microsoft mailbox (${mailboxEmail}) is not on the same email domain as your AskToAct account (${userEmail}). No mailbox was saved. Connect the mailbox for your own firm's email domain.`,
    );
  }
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

async function exchangeCodeForTokens(code: string, tenant: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: getEnv("M365_CLIENT_ID"),
    client_secret: getEnv("M365_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: getEnv("M365_REDIRECT_URI"),
    scope: configuredScope(),
  });
  const res = await fetch(`${oauthBaseUrl(tenant)}/token`, {
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

async function refreshTokens(refreshToken: string, tenant: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: getEnv("M365_CLIENT_ID"),
    client_secret: getEnv("M365_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    redirect_uri: getEnv("M365_REDIRECT_URI"),
    scope: configuredScope(),
  });
  const res = await fetch(`${oauthBaseUrl(tenant)}/token`, {
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

export async function getMicrosoftAuthorizeUrl(state: string, userId: string): Promise<string> {
  const resolved = await resolveMicrosoftTenant(userId);
  const url = new URL(`${oauthBaseUrl(resolved.tenant)}/authorize`);
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
  const resolved = await resolveMicrosoftTenant(userId);
  const tokens = await exchangeCodeForTokens(code, resolved.tenant);
  const actualTenant = await readSignedInTenant(tokens);
  assertTenantMatches(resolved, actualTenant);
  const profile = await fetchMailboxProfile(tokens.access_token);
  const mailboxEmail = normalizeMailboxEmail(profile);
  assertMailboxEmailAllowed(resolved, mailboxEmail);
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
      const resolved = await resolveMicrosoftTenant(userId);
      const tokens = await refreshTokens(row.refreshToken!, resolved.tenant);
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
