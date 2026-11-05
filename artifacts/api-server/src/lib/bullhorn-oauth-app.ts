import { decryptToken, encryptToken } from "./token-crypto.js";

/** Bullhorn OAuth client material sent on authorize, code exchange, and refresh. */
export type BullhornOAuthApp = {
  clientId: string;
  clientSecret: string;
};

const CLIENT_MATERIAL_MAX_CHARS = 500;
const ENC_PREFIX = "enc:v1:";

/**
 * Customer firm has no stored client, or only one of the two values.
 * Callers must not fall through to the platform env client.
 */
export class BullhornOAuthAppMissingError extends Error {
  constructor() {
    super(
      "Bullhorn OAuth client credentials are not stored for this firm. " +
        "An administrator must save this firm's client id and secret before connecting. " +
        "The platform service client is not used for customer firms.",
    );
    this.name = "BullhornOAuthAppMissingError";
  }
}

/** Customer firm has no swimlane yet. Do not discover one with the service username. */
export class BullhornDataCenterUnknownError extends Error {
  constructor() {
    super(
      "This firm's Bullhorn data center is not stored yet. " +
        "Connect must resolve loginInfo for this firm's own API user before authorize or refresh.",
    );
    this.name = "BullhornDataCenterUnknownError";
  }
}

export class BullhornOAuthClientStoreError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409 | 500,
  ) {
    super(message);
    this.name = "BullhornOAuthClientStoreError";
  }
}

function envClient(env: NodeJS.ProcessEnv): BullhornOAuthApp {
  const clientId = env["BULLHORN_CLIENT_ID"];
  const clientSecret = env["BULLHORN_CLIENT_SECRET"];
  if (!clientId) {
    throw new Error("Missing required environment variable: BULLHORN_CLIENT_ID");
  }
  if (!clientSecret) {
    throw new Error("Missing required environment variable: BULLHORN_CLIENT_SECRET");
  }
  return { clientId, clientSecret };
}

/**
 * Service firms always use the platform env pair, even if a row has stored
 * values. Any other firm uses its encrypted columns, or fails closed.
 */
export function resolveBullhornOAuthApp(
  args: {
    authMode: string | null;
    encryptedClientId?: string | null;
    encryptedClientSecret?: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): BullhornOAuthApp {
  if (args.authMode === "service") {
    return envClient(env);
  }
  const encryptedClientId = args.encryptedClientId ?? null;
  const encryptedClientSecret = args.encryptedClientSecret ?? null;
  if (!encryptedClientId || !encryptedClientSecret) {
    throw new BullhornOAuthAppMissingError();
  }
  const clientId = decryptToken(encryptedClientId).trim();
  const clientSecret = decryptToken(encryptedClientSecret).trim();
  if (!clientId || !clientSecret) {
    throw new BullhornOAuthAppMissingError();
  }
  return { clientId, clientSecret };
}

/** Rejects blank, overlong, or multi-line material. Does not echo the values. */
export function assertOAuthClientMaterial(
  clientId: unknown,
  clientSecret: unknown,
): { clientId: string; clientSecret: string } {
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new BullhornOAuthClientStoreError(
      "clientId and clientSecret are required strings.",
      400,
    );
  }
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!id || !secret) {
    throw new BullhornOAuthClientStoreError(
      "clientId and clientSecret are required strings.",
      400,
    );
  }
  if (id.length > CLIENT_MATERIAL_MAX_CHARS || secret.length > CLIENT_MATERIAL_MAX_CHARS) {
    throw new BullhornOAuthClientStoreError(
      "clientId or clientSecret is too long.",
      400,
    );
  }
  if (/[\u0000-\u001F\u007F]/.test(id) || /[\u0000-\u001F\u007F]/.test(secret)) {
    throw new BullhornOAuthClientStoreError(
      "clientId and clientSecret must be single-line values.",
      400,
    );
  }
  return { clientId: id, clientSecret: secret };
}

/**
 * Encrypts both values. Refuses to return plaintext when TOKEN_ENCRYPTION_KEY
 * is missing or invalid, so a client secret is never written in the clear.
 */
export function encryptOAuthClientMaterial(
  clientId: string,
  clientSecret: string,
): { encryptedClientId: string; encryptedClientSecret: string } {
  const encryptedClientId = encryptToken(clientId);
  const encryptedClientSecret = encryptToken(clientSecret);
  if (
    !encryptedClientId.startsWith(ENC_PREFIX) ||
    !encryptedClientSecret.startsWith(ENC_PREFIX)
  ) {
    throw new BullhornOAuthClientStoreError(
      "TOKEN_ENCRYPTION_KEY must be configured before storing a Bullhorn OAuth client.",
      500,
    );
  }
  return { encryptedClientId, encryptedClientSecret };
}
