import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { logger } from "./logger.js";

const ENC_PREFIX = "enc:v1:";

function getTokenEncryptionKey(): Buffer | null {
  const raw = process.env["TOKEN_ENCRYPTION_KEY"];
  if (!raw) {
    logger.warn("TOKEN_ENCRYPTION_KEY not set — refresh tokens stored in plaintext");
    return null;
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    logger.warn(
      { keyByteLength: key.length },
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes — token encryption disabled",
    );
    return null;
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const key = getTokenEncryptionKey();
  if (!key) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

export function decryptToken(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) {
    return stored;
  }
  const key = getTokenEncryptionKey();
  if (!key) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is required to decrypt stored tokens but is not set.",
    );
  }
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted token.");
  const [ivHex, tagHex, ctHex] = parts;
  const tag = Buffer.from(tagHex, "hex");
  if (tag.length !== 16) {
    throw new Error("Malformed encrypted token: invalid auth tag length.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(tag);
  return (
    decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") +
    decipher.final("utf8")
  );
}
