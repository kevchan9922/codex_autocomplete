const PKCE_VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

function toBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function createVerifier(): string {
  return toBase64Url(randomBytes(PKCE_VERIFIER_BYTES));
}

export async function createChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return toBase64Url(new Uint8Array(hash));
}

export function createState(): string {
  return toBase64Url(randomBytes(STATE_BYTES));
}
