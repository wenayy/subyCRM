import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;    // 96-bit IV recommended for GCM
const TAG_LEN = 16;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: openssl rand -hex 32");
  }
  return Buffer.from(hex, "hex");
}

// Returns "enc:iv:authTag:ciphertext" (all hex)
export function encrypt(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

// Returns original plaintext. Passes through non-encrypted values (backward compat).
export function decrypt(stored: string): string {
  if (!stored || !stored.startsWith("enc:")) return stored;
  const parts = stored.split(":");
  if (parts.length !== 4) return stored;
  const [, ivHex, tagHex, dataHex] = parts;
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex")) as crypto.DecipherGCM;
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(dataHex, "hex")).toString("utf8") + decipher.final("utf8");
}
