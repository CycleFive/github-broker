// Thin GitHub REST client that authenticates as the app installation.

import { AppCredentials, InstallationTokenCache } from "./app";

export interface GhResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON when the response is JSON, otherwise text. */
  data: unknown;
}

export interface GhRequest {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  accept?: string;
  /** Return the body as text even when the content type says JSON. */
  raw?: boolean;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
  }
}

/** Hosts GitHub redirects to for downloads (logs, archives, artifacts). Followed without our token. */
const REDIRECT_HOST_SUFFIXES = [
  ".githubusercontent.com",
  ".github.com",
  ".blob.core.windows.net",
  ".actions.githubusercontent.com",
];

export function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  // Only paths on the API host: no scheme, no host, no protocol-relative URL, no traversal.
  if (path.startsWith("//") || /^\/*[a-z][a-z0-9+.-]*:/i.test(path.slice(1)) || /(^|\/)\.\.(\/|$)/.test(path)) {
    throw new Error("path must be an API path such as /repos/OWNER/REPO, not a URL");
  }
  return path;
}

export class GitHubClient {
  constructor(
    private readonly creds: AppCredentials,
    private readonly tokens: InstallationTokenCache,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  get apiBase(): string {
    return this.creds.apiBase ?? "https://api.github.com";
  }

  async installation() {
    return this.tokens.get(this.creds);
  }

  async request(req: GhRequest): Promise<GhResponse> {
    const res = await this.#send(req, false);
    if (res.status === 401) {
      this.tokens.invalidate();
      return this.#send(req, true);
    }
    return res;
  }

  /** Like request(), but throws GitHubError on a non-2xx answer. */
  async call<T = any>(req: GhRequest): Promise<T> {
    const res = await this.request(req);
    if (!res.ok) {
      const msg =
        res.data && typeof res.data === "object" && "message" in res.data
          ? String((res.data as { message: unknown }).message)
          : typeof res.data === "string"
            ? res.data.slice(0, 300)
            : "";
      throw new GitHubError(res.status, `GitHub ${req.method ?? "GET"} ${req.path} -> ${res.status} ${msg}`, res.data);
    }
    return res.data as T;
  }

  async #send(req: GhRequest, retried: boolean): Promise<GhResponse> {
    const { token } = await this.tokens.get(this.creds);
    const url = new URL(this.apiBase + normalizePath(req.path));
    if (url.origin !== new URL(this.apiBase).origin) throw new Error("path resolved outside the GitHub API");
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: req.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.creds.userAgent ?? "github-broker-worker",
    };
    let body: string | undefined;
    if (req.body !== undefined && req.body !== null) {
      headers["Content-Type"] = "application/json";
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }
    let res = await this.fetchImpl(url.toString(), {
      method: (req.method ?? "GET").toUpperCase(),
      headers,
      body,
      redirect: "manual",
    });

    // Follow one download redirect without sending the installation token along.
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (loc) {
        const target = new URL(loc, url);
        const sameApi = target.origin === new URL(this.apiBase).origin;
        if (sameApi) {
          return this.#send({ ...req, path: target.pathname, query: Object.fromEntries(target.searchParams) }, retried);
        }
        if (target.protocol === "https:" && REDIRECT_HOST_SUFFIXES.some((s) => target.hostname.endsWith(s))) {
          res = await this.fetchImpl(target.toString(), { headers: { "User-Agent": headers["User-Agent"] } });
        }
      }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, data: await readBody(res, req.raw && res.ok) };
  }
}

async function readBody(res: Response, raw = false): Promise<unknown> {
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!raw && ct.includes("json") && text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
