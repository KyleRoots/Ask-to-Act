import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { decryptToken, encryptToken } from "./token-crypto.js";

const PREFIX = "enc:v1:";
const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const PLAINTEXT = "synthetic-refresh-token";

const originalKey = process.env["TOKEN_ENCRYPTION_KEY"];

afterEach(() => {
  if (originalKey === undefined) delete process.env["TOKEN_ENCRYPTION_KEY"];
  else process.env["TOKEN_ENCRYPTION_KEY"] = originalKey;
});

function withKey(key: string | undefined): void {
  if (key === undefined) delete process.env["TOKEN_ENCRYPTION_KEY"];
  else process.env["TOKEN_ENCRYPTION_KEY"] = key;
}

describe("token encryption", () => {
  it("round-trips refresh tokens and never stores the plaintext", () => {
    withKey(KEY_A);
    const first = encryptToken(PLAINTEXT);
    const second = encryptToken(PLAINTEXT);

    expect(first.startsWith(PREFIX)).toBe(true);
    expect(first).not.toContain(PLAINTEXT);
    expect(second).not.toBe(first);
    expect(decryptToken(first)).toBe(PLAINTEXT);
    expect(decryptToken(second)).toBe(PLAINTEXT);
    expect(decryptToken(encryptToken("réfresh token"))).toBe("réfresh token");
    expect(decryptToken(encryptToken(""))).toBe("");
  });

  it("leaves legacy plaintext rows readable after a key is configured", () => {
    withKey(KEY_A);
    expect(decryptToken(PLAINTEXT)).toBe(PLAINTEXT);
  });

  it("stores plaintext when the key is missing or not 32 bytes", () => {
    withKey(undefined);
    expect(encryptToken(PLAINTEXT)).toBe(PLAINTEXT);

    withKey(Buffer.alloc(16, 1).toString("base64"));
    expect(encryptToken(PLAINTEXT)).toBe(PLAINTEXT);

    withKey(Buffer.alloc(31, 1).toString("base64"));
    expect(encryptToken(PLAINTEXT)).toBe(PLAINTEXT);

    withKey(Buffer.alloc(33, 1).toString("base64"));
    expect(encryptToken(PLAINTEXT)).toBe(PLAINTEXT);

    withKey("not-base64-32-bytes");
    expect(encryptToken(PLAINTEXT)).toBe(PLAINTEXT);
  });

  it("refuses to decrypt ciphertext without the key", () => {
    withKey(KEY_A);
    const stored = encryptToken(PLAINTEXT);
    withKey(undefined);
    expect(() => decryptToken(stored)).toThrow(/TOKEN_ENCRYPTION_KEY is required/);
    expect(decryptToken(PLAINTEXT)).toBe(PLAINTEXT);
  });

  it("rejects a ciphertext encrypted under a different key", () => {
    withKey(KEY_A);
    const stored = encryptToken(PLAINTEXT);
    withKey(KEY_B);
    expect(() => decryptToken(stored)).toThrow();
  });

  it("rejects tampered ciphertext, tags, and malformed envelopes", () => {
    withKey(KEY_A);
    const stored = encryptToken(PLAINTEXT);
    const [iv, tag, ct] = stored.slice(PREFIX.length).split(":");
    const flipped = Buffer.from(ct!, "hex");
    flipped[0] ^= 0xff;

    expect(() => decryptToken(`${PREFIX}${iv}:${tag}:${flipped.toString("hex")}`)).toThrow();

    const flippedTag = Buffer.from(tag!, "hex");
    flippedTag[0] ^= 0xff;
    expect(() => decryptToken(`${PREFIX}${iv}:${flippedTag.toString("hex")}:${ct}`)).toThrow();

    expect(() => decryptToken(`${PREFIX}only-one-part`)).toThrow(/Malformed encrypted token/);
    expect(() => decryptToken(`${PREFIX}aa:bb`)).toThrow(/Malformed encrypted token/);
    expect(() => decryptToken(`${PREFIX}00:abcd:00`)).toThrow(/invalid auth tag length/);
  });
});
