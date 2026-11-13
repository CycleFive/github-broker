// Sign-in for the MCP endpoint: a consent page, then "Sign in with GitHub" through the
// same GitHub App's user authorization, then an allowlist check on the GitHub account.
// The GitHub user token is used once to read /user and then revoked; it is never stored.

import {
  AuthorizationError,
  authorizationErrorRedirect,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { base64url } from "./github/app";
import type { Env } from "./env";

export const SCOPE = "github";

export interface AuthProps {
  login: string;
  id: string;
}

/**
 * ALLOWED_GITHUB_USERS is a comma- or space-separated list. Numeric entries match the
 * GitHub user ID (stable across renames, preferred); other entries match the login,
 * case-insensitively.
 */
export function parseAllowlist(raw: string | undefined): { ids: Set<string>; logins: Set<string> } {
  const ids = new Set<string>();
  const logins = new Set<string>();
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (/^\d+$/.test(entry)) ids.add(entry);
    else logins.add(entry.toLowerCase());
  }
  return { ids, logins };
}

export function isAllowed(raw: string | undefined, user: { id: string | number; login: string }): boolean {
  const { ids, logins } = parseAllowlist(raw);
  return ids.has(String(user.id)) || logins.has(user.login.toLowerCase());
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string, headers?: Headers, status = 200): Response {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#e8e8e8;background:#161616}}
code{font-size:.95em}.warn{border-left:3px solid #c80;padding-left:.8rem}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style></head>
<body>${body}</body></html>`,
    { status, headers: h },
  );
}

export function consentPage(d: ConsentDescription, handle: string, headers: Headers): Response {
  const who = d.clientDomain ? `${escapeHtml(d.clientName)} (verified domain ${escapeHtml(d.clientDomain)})` : escapeHtml(d.clientName);
  return page(
    "Connect GitHub broker",
    `<h1>Connect GitHub broker</h1>
<p><strong>${who}</strong> wants to use this server's GitHub App installation: everything the app is permitted to do on its repositories.</p>
<p>Access will be sent to <code>${escapeHtml(d.redirectHost)}</code>${d.redirectIsLoopback ? " (an app on this computer)" : ""}.</p>
<p class="warn">Only continue if you started this yourself, from Claude, and that host is <code>claude.ai</code> (or <code>localhost</code> for Claude Code).</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve">Continue to GitHub</button>
<button name="decision" value="deny">Deny</button>
</form>`,
    headers,
  );
}

export function errorPage(message: string, status = 400): Response {
  return page("Sign-in failed", `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>`, undefined, status);
}

async function sha256b64url(s: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

function randomVerifier(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base64url(b);
}

function redirect(location: string, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set("Location", location);
  return new Response(null, { status: 302, headers: h });
}

function renderAuthError(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    if (e.redirectTo) return redirect(e.redirectTo);
    return errorPage(e.description, 400);
  }
  throw e;
}

/** GET and POST /authorize. */
export async function handleAuthorize(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  try {
    if (request.method === "GET") {
      const authReq = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      return consentPage(details, consent.handle, consent.headers);
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // One scope covers everything; offline_access lets the client refresh without a new sign-in.
    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE, "offline_access"] });

    const verifier = randomVerifier();
    const up = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
    gh.searchParams.set("redirect_uri", `${publicUrl(env)}/callback`);
    gh.searchParams.set("state", up.state);
    gh.searchParams.set("allow_signup", "false");
    gh.searchParams.set("code_challenge", await sha256b64url(verifier));
    gh.searchParams.set("code_challenge_method", "S256");
    return redirect(gh.toString(), up.headers);
  } catch (e) {
    return renderAuthError(e);
  }
}

/** GET /callback from GitHub. */
export async function handleCallback(
  request: Request,
  env: Env,
  oauth: OAuthHelpers,
  ctx: ExecutionContext,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<Response> {
  let resumed;
  try {
    resumed = await oauth.finishUpstream<{ verifier: string }>(request);
  } catch (e) {
    return renderAuthError(e);
  }
  const { request: authReq, data, headers } = resumed;
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    return redirect(authorizationErrorRedirect(authReq, "access_denied", "GitHub sign-in was cancelled"), headers);
  }

  const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "github-broker-worker" },
    body: JSON.stringify({
      client_id: env.GITHUB_APP_CLIENT_ID,
      client_secret: env.GITHUB_APP_CLIENT_SECRET,
      code,
      redirect_uri: `${publicUrl(env)}/callback`,
      code_verifier: data.verifier,
    }),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!tok.access_token) return errorPage(`GitHub did not return a token (${tok.error ?? tokenRes.status}).`, 502);

  const userRes = await fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "github-broker-worker",
    },
  });
  const user = (await userRes.json().catch(() => ({}))) as { id?: number; login?: string };

  // The user token was only needed for /user. Revoke it so nothing lingers.
  ctx.waitUntil(
    fetchImpl(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_APP_CLIENT_ID)}/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${btoa(`${env.GITHUB_APP_CLIENT_ID}:${env.GITHUB_APP_CLIENT_SECRET}`)}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "github-broker-worker",
      },
      body: JSON.stringify({ access_token: tok.access_token }),
    }).then(
      () => undefined,
      () => undefined,
    ),
  );

  if (!user.id || !user.login) return errorPage("Could not read your GitHub account.", 502);
  if (!isAllowed(env.ALLOWED_GITHUB_USERS, { id: user.id, login: user.login })) {
    console.log(JSON.stringify({ event: "sign_in_refused", login: user.login, id: user.id }));
    return errorPage(`GitHub account ${user.login} is not allowed on this server.`, 403);
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: authReq,
    userId: String(user.id),
    metadata: { login: user.login },
    scope: authReq.scope,
    props: { login: user.login, id: String(user.id) } satisfies AuthProps,
  });
  console.log(JSON.stringify({ event: "sign_in", login: user.login, id: user.id, client: authReq.clientId }));
  return redirect(redirectTo, headers);
}

export function publicUrl(env: Env): string {
  if (!env.PUBLIC_URL) throw new Error("PUBLIC_URL is not set");
  return env.PUBLIC_URL.replace(/\/+$/, "");
}
