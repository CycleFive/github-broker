// Feed: a read-only internal entrypoint for other Workers in the same account (mailroom).
// Reached through a service binding, never from the public internet: only the default
// export is public. Fetch-style; the host name is meaningless, only the path matters.
//
//   GET /identity       the app's bot identity ({id, login, name})
//   GET /api/repos/...  a GET passed to GitHub as the installation, answer unchanged

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { importAppKey, signAppJwt, tokens } from "./github/app";
import { GitHubClient, normalizePath } from "./github/client";

export interface FeedDeps {
  gh: GitHubClient;
  appJwt: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

interface Identity {
  id: string;
  login: string;
  name: string;
}

// The app's identity never changes; keep it for the isolate's life.
let identity: Identity | undefined;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function getIdentity(deps: FeedDeps): Promise<Identity> {
  if (identity) return identity;
  const doFetch = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const res = await doFetch(`${deps.gh.apiBase}/app`, {
    headers: {
      Authorization: `Bearer ${await deps.appJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-broker-worker",
    },
  });
  if (!res.ok) throw new Error(`GET /app failed: HTTP ${res.status}`);
  const app = (await res.json()) as { id: number; slug: string; name: string };
  identity = { id: String(app.id), login: `${app.slug}[bot]`, name: app.name };
  return identity;
}

async function route(request: Request, deps: FeedDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/identity") {
    if (request.method !== "GET") return json({ error: "feed is read-only" }, 405);
    return json(await getIdentity(deps), 200);
  }

  if (path === "/api" || path.startsWith("/api/")) {
    if (request.method !== "GET") return json({ error: "feed is read-only" }, 405);
    let target: string;
    try {
      target = normalizePath(path.slice("/api".length) || "/");
    } catch {
      return json({ error: "bad path" }, 400);
    }
    // Test the path as GitHub will resolve it, so encoded dot segments cannot slip out of /repos/.
    const resolved = new URL(deps.gh.apiBase + target).pathname;
    if (!target.startsWith("/repos/") || !resolved.startsWith("/repos/")) {
      return json({ error: "feed reads /repos/ paths only" }, 403);
    }
    const res = await deps.gh.request({ path: target, query: Object.fromEntries(url.searchParams) });
    if (res.status === 204 || res.status === 304) return new Response(null, { status: res.status });
    if (typeof res.data === "string") {
      return new Response(res.data, { status: res.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return json(res.data, res.status);
  }

  return json({ error: "not found" }, 404);
}

export async function handleFeed(request: Request, _env: Env, deps: FeedDeps): Promise<Response> {
  let res: Response;
  try {
    res = await route(request, deps);
  } catch {
    // Never echo the error: it may carry upstream detail.
    res = json({ error: "upstream unavailable" }, 502);
  }
  console.log(JSON.stringify({ event: "feed", method: request.method, path: new URL(request.url).pathname, status: res.status }));
  return res;
}

let appKey: { pem: string; key: Promise<CryptoKey> } | undefined;

export class Feed extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const env = this.env;
    const pem = env.GITHUB_APP_PRIVATE_KEY;
    const gh = new GitHubClient(
      { issuer: env.GITHUB_APP_CLIENT_ID, installationId: env.GITHUB_INSTALLATION_ID, privateKeyPem: pem },
      tokens,
    );
    const appJwt = async () => {
      if (!appKey || appKey.pem !== pem) appKey = { pem, key: importAppKey(pem) };
      return signAppJwt(await appKey.key, env.GITHUB_APP_CLIENT_ID);
    };
    return handleFeed(request, env, { gh, appJwt });
  }
}
