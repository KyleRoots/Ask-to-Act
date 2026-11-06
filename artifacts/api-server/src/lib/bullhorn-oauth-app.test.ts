import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BullhornOAuthAppMissingError,
  BullhornOAuthClientStoreError,
  assertOAuthClientMaterial,
  encryptOAuthClientMaterial,
  resolveBullhornOAuthApp,
} from "./bullhorn-oauth-app.js";

const originalEnv = { ...process.env };
const key = randomBytes(32).toString("base64");

beforeEach(() => {
  process.env["BULLHORN_CLIENT_ID"] = "myticas-client-id";
  process.env["BULLHORN_CLIENT_SECRET"] = "myticas-client-secret";
  process.env["TOKEN_ENCRYPTION_KEY"] = key;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("resolveBullhornOAuthApp", () => {
  it("uses the env pair for a service firm and ignores stored columns", () => {
    const stored = encryptOAuthClientMaterial("other-client-id", "other-client-secret");
    const app = resolveBullhornOAuthApp({
      authMode: "service",
      encryptedClientId: stored.encryptedClientId,
      encryptedClientSecret: stored.encryptedClientSecret,
    });
    expect(app).toEqual({
      clientId: "myticas-client-id",
      clientSecret: "myticas-client-secret",
    });
  });

  it("uses the env pair for an oauth firm that already uses the platform client", () => {
    const app = resolveBullhornOAuthApp({
      authMode: "oauth",
      usesPlatformClient: true,
      encryptedClientId: null,
      encryptedClientSecret: null,
    });
    expect(app).toEqual({
      clientId: "myticas-client-id",
      clientSecret: "myticas-client-secret",
    });
  });

  it("fails closed for an oauth firm with no stored client", () => {
    expect(() =>
      resolveBullhornOAuthApp({
        authMode: "oauth",
        usesPlatformClient: false,
        encryptedClientId: null,
        encryptedClientSecret: null,
      }),
    ).toThrow(BullhornOAuthAppMissingError);
    expect(() =>
      resolveBullhornOAuthApp({ authMode: null }),
    ).toThrow(BullhornOAuthAppMissingError);
  });

  it("fails closed when only one of the two stored values is present", () => {
    const stored = encryptOAuthClientMaterial("qualified-client-id", "qualified-client-secret");
    expect(() =>
      resolveBullhornOAuthApp({
        authMode: "oauth",
        encryptedClientId: stored.encryptedClientId,
        encryptedClientSecret: null,
      }),
    ).toThrow(BullhornOAuthAppMissingError);
  });

  it("decrypts a complete oauth client and does not use the env pair", () => {
    const stored = encryptOAuthClientMaterial("qualified-client-id", "qualified-client-secret");
    expect(
      resolveBullhornOAuthApp({
        authMode: "oauth",
        encryptedClientId: stored.encryptedClientId,
        encryptedClientSecret: stored.encryptedClientSecret,
      }),
    ).toEqual({
      clientId: "qualified-client-id",
      clientSecret: "qualified-client-secret",
    });
  });
});

describe("encryptOAuthClientMaterial", () => {
  it("refuses to return plaintext when the encryption key is missing", () => {
    delete process.env["TOKEN_ENCRYPTION_KEY"];
    expect(() =>
      encryptOAuthClientMaterial("qualified-client-id", "qualified-client-secret"),
    ).toThrow(BullhornOAuthClientStoreError);
  });
});

describe("assertOAuthClientMaterial", () => {
  it("rejects blank and multi-line values without echoing them", () => {
    expect(() => assertOAuthClientMaterial("  ", "secret-value")).toThrow(
      /required strings/,
    );
    expect(() => assertOAuthClientMaterial("id\nmore", "secret-value")).toThrow(
      /single-line/,
    );
  });
});
