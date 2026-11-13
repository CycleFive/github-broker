// GitHub App authentication: PEM import, RS256 app JWT, installation token cache.
//
// The private key only ever lives in the Worker's secret store. Nothing here logs it,
// returns it, or puts it in an error message.

const RSA_ENCRYPTION_ALG_ID = new Uint8Array([
  // SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function derTag(tag: number, body: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), derLength(body.length), body);
}

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo, which is all WebCrypto imports. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octet = derTag(0x04, pkcs1);
  return derTag(0x30, concat(version, RSA_ENCRYPTION_ALG_ID, octet));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Parse a PEM private key into PKCS#8 DER. Accepts GitHub's PKCS#1
 * ("BEGIN RSA PRIVATE KEY") and PKCS#8 ("BEGIN PRIVATE KEY"). Tolerates the
 * literal "\n" sequences you get when a multi-line PEM is pasted as one line.
 */
export function pemToPkcs8(pem: string): Uint8Array {
  const text = pem.replace(/\\n/g, "\n").trim();
  const m = text.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM block");
  const label = m[1];
  const der = base64ToBytes(m[2].replace(/\s+/g, ""));
  if (label === "RSA PRIVATE KEY") return pkcs1ToPkcs8(der);
  if (label === "PRIVATE KEY") return der;
  throw new Error(`Unsupported PEM type: ${label}`);
}

export async function importAppKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = pemToPkcs8(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Sign a GitHub App JWT. `iss` is the app's client ID (GitHub's recommendation) or app ID.
 * iat is backdated 60 s for clock drift; GitHub caps exp at 10 minutes.
 */
export async function signAppJwt(key: CryptoKey, iss: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss }));
  const input = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: number; // ms since epoch
  permissions: Record<string, string>;
  repositorySelection?: string;
}

export interface AppCredentials {
  /** Client ID (preferred) or numeric App ID, used as the JWT issuer. */
  issuer: string;
  installationId: string;
  privateKeyPem: string;
  apiBase?: string;
  userAgent?: string;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Mints and caches one installation token per isolate. Tokens last an hour; a new one
 * is minted when less than five minutes remain. Concurrent callers share one mint.
 */
export class InstallationTokenCache {
  #key?: Promise<CryptoKey>;
  #keyPem?: string;
  #cached?: InstallationToken;
  #inflight?: Promise<InstallationToken>;

  constructor(private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  async get(creds: AppCredentials, now = Date.now()): Promise<InstallationToken> {
    if (this.#cached && this.#cached.expiresAt - REFRESH_MARGIN_MS > now) return this.#cached;
    if (!this.#inflight) {
      this.#inflight = this.#mint(creds).finally(() => {
        this.#inflight = undefined;
      });
    }
    return this.#inflight;
  }

  /** Drop the cached token, e.g. after GitHub answers 401 with it. */
  invalidate(): void {
    this.#cached = undefined;
  }

  async #mint(creds: AppCredentials): Promise<InstallationToken> {
    if (!this.#key || this.#keyPem !== creds.privateKeyPem) {
      this.#keyPem = creds.privateKeyPem;
      this.#key = importAppKey(creds.privateKeyPem);
    }
    const jwt = await signAppJwt(await this.#key, creds.issuer);
    const base = creds.apiBase ?? "https://api.github.com";
    const res = await this.fetchImpl(
      `${base}/app/installations/${encodeURIComponent(creds.installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": creds.userAgent ?? "github-broker-worker",
        },
      },
    );
    if (!res.ok) {
      // GitHub's error body carries no secrets; keep it short.
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Installation token request failed: HTTP ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      token: string;
      expires_at: string;
      permissions?: Record<string, string>;
      repository_selection?: string;
    };
    this.#cached = {
      token: data.token,
      expiresAt: Date.parse(data.expires_at),
      permissions: data.permissions ?? {},
      repositorySelection: data.repository_selection,
    };
    return this.#cached;
  }
}
