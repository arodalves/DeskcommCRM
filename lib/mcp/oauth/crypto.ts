/**
 * Utilitários criptográficos seguros para OAuth 2.1 e PKCE S256.
 */
import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

export function sha256Base64Url(str: string): string {
  return createHash("sha256").update(str).digest("base64url");
}

export function randomToken(prefix: string, byteLength = 32): string {
  const bytes = randomBytes(byteLength).toString("hex");
  return `${prefix}_${bytes}`;
}

export function randomCode(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/**
 * Validação de PKCE S256 (RFC 7636).
 * code_challenge = BASE64URL(SHA256(code_verifier))
 */
export function verifyPkce(
  verifier: string,
  challenge: string,
  method = "S256",
): boolean {
  if (!verifier || !challenge) return false;
  if (method !== "S256") return false;

  const computed = sha256Base64Url(verifier);
  return computed === challenge;
}
