import { generateKeyPairSync } from "node:crypto";
import { InstallationTokenCache } from "../src/github/app";
import { GitHubClient } from "../src/github/client";
import type { ToolContext } from "../src/tools";

export interface Recorded {
  method: string;
  url: string;
  path: string;
  auth: string | null;
  body: any;
}

type Handler = (req: Recorded) => Response | Promise<Response>;

export const SHA_MAIN = "a".repeat(40);

export function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

/** A tiny in-memory GitHub API. Routes are "METHOD /path"; unknown routes 404. */
export function fakeGitHub(extra: Record<string, Handler> = {}) {
  const log: Recorded[] = [];
  let tokenN = 0;
  const routes: Record<string, Handler> = {
    "POST /app/installations/1/access_tokens": () =>
      jsonRes(
        {
          token: `ghs_fake_${++tokenN}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: { contents: "write", pull_requests: "write", workflows: "write", actions: "read" },
          repository_selection: "selected",
        },
        201,
      ),
    "GET /repos/o/r": () => jsonRes({ full_name: "o/r", default_branch: "main" }),
    "GET /repos/o/r/git/ref/heads/main": () => jsonRes({ ref: "refs/heads/main", object: { sha: SHA_MAIN } }),
    "GET /repos/o/r/git/ref/heads/feature/x": () => jsonRes({ message: "Not Found" }, 404),
    "GET /repos/o/r/commits/main": () => jsonRes({ sha: SHA_MAIN }),
    [`GET /repos/o/r/git/commits/${SHA_MAIN}`]: () => jsonRes({ sha: SHA_MAIN, tree: { sha: "tree0" } }),
    "POST /repos/o/r/git/blobs": () => jsonRes({ sha: "blob1" }, 201),
    "POST /repos/o/r/git/trees": () => jsonRes({ sha: "tree1" }, 201),
    "POST /repos/o/r/git/commits": () => jsonRes({ sha: "c".repeat(40), html_url: "https://github.com/o/r/commit/ccc" }, 201),
    "PATCH /repos/o/r/git/refs/heads/main": () => jsonRes({ ref: "refs/heads/main" }),
    "POST /repos/o/r/git/refs": (r) => jsonRes({ ref: r.body.ref }, 201),
    ...extra,
  };

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init.headers);
    const rec: Recorded = {
      method: (init.method ?? "GET").toUpperCase(),
      url: url.toString(),
      path: url.hostname === "api.github.com" ? url.pathname : url.toString(),
      auth: headers.get("authorization"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    log.push(rec);
    const h = routes[`${rec.method} ${rec.path}`];
    return h ? h(rec) : jsonRes({ message: "Not Found" }, 404);
  };

  return { fetchImpl: fetchImpl as typeof fetch, log };
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const TEST_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

export function toolContext(fetchImpl: typeof fetch, defaultOwner = "o"): ToolContext {
  const creds = { issuer: "Iv23liTest", installationId: "1", privateKeyPem: TEST_PEM };
  return {
    gh: new GitHubClient(creds, new InstallationTokenCache(fetchImpl), fetchImpl),
    defaultOwner,
    user: { login: "tester", id: "1" },
  };
}
