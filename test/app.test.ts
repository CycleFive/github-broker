import { generateKeyPairSync, createVerify, createPublicKey } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InstallationTokenCache, importAppKey, pemToPkcs8, signAppJwt } from "../src/github/app";

// Throwaway keys generated per test run; nothing real is ever used here.
function freshKey(bits = 2048) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return {
    pkcs1Pem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    pkcs8Der: new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" })),
    pkcs8Pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
  };
}

function decodeSegment(s: string) {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

describe("PEM handling", () => {
  it.each([1024, 2048, 4096])("wraps PKCS#1 into the same DER Node exports as PKCS#8 (%i-bit)", (bits) => {
    const k = freshKey(bits);
    expect(Buffer.from(pemToPkcs8(k.pkcs1Pem)).equals(Buffer.from(k.pkcs8Der))).toBe(true);
  });

  it("passes PKCS#8 through and accepts one-line PEMs with literal \\n", () => {
    const k = freshKey();
    expect(Buffer.from(pemToPkcs8(k.pkcs8Pem)).equals(Buffer.from(k.pkcs8Der))).toBe(true);
    const oneLine = k.pkcs1Pem.trim().split("\n").join("\\n");
    expect(Buffer.from(pemToPkcs8(oneLine)).equals(Buffer.from(k.pkcs8Der))).toBe(true);
  });

  it("rejects things that are not RSA private keys", () => {
    expect(() => pemToPkcs8("not a key")).toThrow(/not a PEM/);
    expect(() => pemToPkcs8("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")).toThrow(/Unsupported/);
  });
});

describe("app JWT", () => {
  it("is RS256, verifies with the public key, and carries GitHub's claims", async () => {
    const k = freshKey();
    const key = await importAppKey(k.pkcs1Pem);
    const now = 1_800_000_000;
    const jwt = await signAppJwt(key, "Iv23liTestClient", now);
    const [h, p, s] = jwt.split(".");
    expect(decodeSegment(h)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(p)).toEqual({ iat: now - 60, exp: now + 540, iss: "Iv23liTestClient" });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(k.publicPem, Buffer.from(s, "base64url"))).toBe(true);
    // GitHub rejects exp more than 10 minutes after iat... relative to now.
    expect(decodeSegment(p).exp - now).toBeLessThanOrEqual(600);
  });
});

describe("installation token cache", () => {
  const k = freshKey();
  const creds = { issuer: "Iv23liTestClient", installationId: "42", privateKeyPem: k.pkcs1Pem };

  function mockGitHub(expiresInMs: number) {
    let n = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      n++;
      expect(url).toBe("https://api.github.com/app/installations/42/access_tokens");
      expect(init.method).toBe("POST");
      const auth = (init.headers as Record<string, string>).Authorization;
      const [, jwt] = auth.split(" ");
      const [h, p, s] = jwt.split(".");
      const v = createVerify("RSA-SHA256");
      v.update(`${h}.${p}`);
      expect(v.verify(k.publicPem, Buffer.from(s, "base64url"))).toBe(true);
      return new Response(
        JSON.stringify({
          token: `ghs_test_${n}`,
          expires_at: new Date(Date.now() + expiresInMs).toISOString(),
          permissions: { contents: "write", workflows: "write" },
          repository_selection: "selected",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    return fetchImpl;
  }

  it("mints once, shares concurrent callers, and reuses the token", async () => {
    const f = mockGitHub(60 * 60 * 1000);
    const cache = new InstallationTokenCache(f as unknown as typeof fetch);
    const [a, b] = await Promise.all([cache.get(creds), cache.get(creds)]);
    const c = await cache.get(creds);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a.token).toBe("ghs_test_1");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a.permissions.workflows).toBe("write");
  });

  it("re-mints inside the five-minute margin and after invalidate()", async () => {
    const f = mockGitHub(4 * 60 * 1000);
    const cache = new InstallationTokenCache(f as unknown as typeof fetch);
    await cache.get(creds);
    await cache.get(creds);
    expect(f).toHaveBeenCalledTimes(2);
    const g = mockGitHub(60 * 60 * 1000);
    const cache2 = new InstallationTokenCache(g as unknown as typeof fetch);
    await cache2.get(creds);
    cache2.invalidate();
    await cache2.get(creds);
    expect(g).toHaveBeenCalledTimes(2);
  });

  it("surfaces GitHub's error without leaking the key", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: "A JSON web token could not be decoded" }), { status: 401 }));
    const cache = new InstallationTokenCache(f as unknown as typeof fetch);
    const err = await cache.get(creds).catch((e) => e as Error);
    expect(err.message).toMatch(/HTTP 401/);
    expect(err.message).not.toContain("PRIVATE KEY");
  });
});
