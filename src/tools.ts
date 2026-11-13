// MCP tool definitions. Each tool is a small wrapper over the GitHub REST API, plus
// github_request, a passthrough for everything the named tools don't cover.

import { GitHubClient, GitHubError } from "./github/client";

export interface ToolContext {
  gh: GitHubClient;
  defaultOwner?: string;
  user: { login: string; id: string };
}

type JsonSchema = {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  run(args: Record<string, any>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

const DEFAULT_MAX_CHARS = 200_000;

// ---------- helpers ----------

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function splitRepo(repo: string, defaultOwner?: string): { owner: string; name: string } {
  const parts = repo.split("/");
  let owner: string, name: string;
  if (parts.length === 2) [owner, name] = parts;
  else if (parts.length === 1 && defaultOwner) [owner, name] = [defaultOwner, parts[0]];
  else throw new ToolInputError(`repo must be "OWNER/NAME"${defaultOwner ? " or NAME" : ""}, got "${repo}"`);
  const bad = (s: string) => !NAME_RE.test(s) || s === "." || s === "..";
  if (bad(owner) || bad(name)) throw new ToolInputError(`invalid repo "${repo}"`);
  return { owner, name };
}

function repoPath(args: Record<string, any>, ctx: ToolContext): string {
  const { owner, name } = splitRepo(String(args.repo), ctx.defaultOwner);
  return `/repos/${owner}/${name}`;
}

function encodePath(p: string): string {
  return p
    .replace(/^\/+/, "")
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export class ToolInputError extends Error {}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: ${text.length - max} more characters; raise max_chars or narrow the request]`;
}

async function defaultBranch(gh: GitHubClient, rp: string): Promise<string> {
  const repo = await gh.call<{ default_branch: string }>({ path: rp });
  return repo.default_branch;
}

async function resolveSha(gh: GitHubClient, rp: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
  const c = await gh.call<{ sha: string }>({ path: `${rp}/commits/${encodeURIComponent(ref)}` });
  return c.sha;
}

/** Minimal JSON-schema check: required keys, primitive types, enums. Unknown keys are rejected. */
export function validateArgs(schema: JsonSchema, args: unknown): string | null {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const a = args as Record<string, unknown>;
  for (const r of schema.required ?? []) {
    if (a[r] === undefined || a[r] === null) return `missing required argument "${r}"`;
  }
  for (const [k, v] of Object.entries(a)) {
    const prop = schema.properties[k];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown argument "${k}"`;
      continue;
    }
    if (v === undefined || v === null) continue;
    const t = prop.type;
    const ok =
      t === undefined ||
      (t === "string" && typeof v === "string") ||
      (t === "integer" && Number.isInteger(v)) ||
      (t === "number" && typeof v === "number") ||
      (t === "boolean" && typeof v === "boolean") ||
      (t === "array" && Array.isArray(v)) ||
      (t === "object" && typeof v === "object" && !Array.isArray(v));
    if (!ok) return `argument "${k}" must be ${t}`;
    if (prop.enum && !prop.enum.includes(v)) return `argument "${k}" must be one of ${prop.enum.join(", ")}`;
  }
  return null;
}

const repoProp = {
  type: "string",
  description: 'Repository as "OWNER/NAME", or just NAME to use the default owner.',
};
const pageProps = {
  per_page: { type: "integer", description: "Results per page (max 100). Default 30." },
  page: { type: "integer", description: "Page number, from 1." },
};

// ---------- tools ----------

export const TOOLS: ToolDef[] = [
  {
    name: "installation_info",
    title: "Installation info",
    description:
      "Show what this GitHub App installation can do: its granted permissions, whether it covers all or selected repositories, and when the current token expires. Never returns the token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(_args, ctx) {
      const inst = await ctx.gh.installation();
      return {
        permissions: inst.permissions,
        repository_selection: inst.repositorySelection,
        token_expires_at: new Date(inst.expiresAt).toISOString(),
        default_owner: ctx.defaultOwner ?? null,
        signed_in_as: ctx.user.login,
      };
    },
  },
  {
    name: "list_repos",
    title: "List repositories",
    description: "List the repositories this installation can access.",
    inputSchema: { type: "object", properties: { ...pageProps }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const r = await ctx.gh.call<{ total_count: number; repositories: any[] }>({
        path: "/installation/repositories",
        query: { per_page: args.per_page ?? 100, page: args.page },
      });
      return {
        total_count: r.total_count,
        repositories: r.repositories.map((x) => ({
          full_name: x.full_name,
          private: x.private,
          default_branch: x.default_branch,
          archived: x.archived,
          pushed_at: x.pushed_at,
          description: x.description,
        })),
      };
    },
  },
  {
    name: "get_file",
    title: "Get file",
    description:
      "Read a file's contents at a ref (branch, tag or commit; default branch if omitted). For a directory, returns its listing.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        path: { type: "string", description: "File path in the repository." },
        ref: { type: "string", description: "Branch, tag or commit SHA." },
        max_chars: { type: "integer", description: `Truncate the text after this many characters. Default ${DEFAULT_MAX_CHARS}.` },
      },
      required: ["repo", "path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const rp = repoPath(args, ctx);
      const path = `${rp}/contents/${encodePath(args.path)}`;
      const meta = await ctx.gh.call<any>({ path, query: { ref: args.ref } });
      if (Array.isArray(meta)) {
        return { type: "dir", entries: meta.map((e: any) => ({ type: e.type, path: e.path, size: e.size })) };
      }
      if (meta.type !== "file") return { type: meta.type, path: meta.path, sha: meta.sha, target: meta.target, submodule_git_url: meta.submodule_git_url };
      let text: string;
      if (meta.encoding === "base64" && typeof meta.content === "string" && meta.content.length > 0) {
        text = decodeBase64Utf8(meta.content);
      } else {
        // Files over 1 MB come back without content; fetch the raw bytes instead.
        const raw = await ctx.gh.request({ path, query: { ref: args.ref }, accept: "application/vnd.github.raw+json", raw: true });
        if (!raw.ok) throw new GitHubError(raw.status, `get_file ${args.path} -> ${raw.status}`, raw.data);
        text = String(raw.data);
      }
      if (text.includes("\u0000")) return { type: "binary", path: meta.path, size: meta.size, sha: meta.sha };
      return truncate(text, args.max_chars ?? DEFAULT_MAX_CHARS);
    },
  },
  {
    name: "list_tree",
    title: "List tree",
    description: "List files in a repository at a ref, recursively by default. One line per entry: type, size, path.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        ref: { type: "string", description: "Branch, tag or commit SHA. Default: the default branch." },
        path_prefix: { type: "string", description: "Only entries under this path." },
        recursive: { type: "boolean", description: "Default true." },
        max_entries: { type: "integer", description: "Default 5000." },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const rp = repoPath(args, ctx);
      const ref = args.ref ?? "HEAD";
      const r = await ctx.gh.call<{ sha: string; truncated: boolean; tree: any[] }>({
        path: `${rp}/git/trees/${encodeURIComponent(ref)}`,
        query: { recursive: args.recursive === false ? undefined : 1 },
      });
      const prefix = args.path_prefix ? String(args.path_prefix).replace(/^\/+/, "") : "";
      const max = args.max_entries ?? 5000;
      const rows = r.tree.filter((e) => !prefix || e.path === prefix || e.path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
      const lines = rows.slice(0, max).map((e) => `${e.type}\t${e.size ?? "-"}\t${e.path}`);
      const notes = [];
      if (rows.length > max) notes.push(`[${rows.length - max} more entries; raise max_entries or use path_prefix]`);
      if (r.truncated) notes.push("[GitHub truncated this tree; list a subdirectory with path_prefix and recursive=false, or a subtree SHA]");
      return [`tree ${r.sha}`, ...lines, ...notes].join("\n");
    },
  },
  {
    name: "create_branch",
    title: "Create branch",
    description: "Create a branch from another branch, tag or commit (default: the default branch).",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        branch: { type: "string", description: "New branch name." },
        from: { type: "string", description: "Branch, tag or SHA to start from." },
      },
      required: ["repo", "branch"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const rp = repoPath(args, ctx);
      const sha = await resolveSha(ctx.gh, rp, args.from ?? (await defaultBranch(ctx.gh, rp)));
      const ref = await ctx.gh.call({ method: "POST", path: `${rp}/git/refs`, body: { ref: `refs/heads/${args.branch}`, sha } });
      return { ref: (ref as any).ref, sha };
    },
  },
  {
    name: "commit_files",
    title: "Commit files",
    description:
      "Create one commit on a branch that adds, changes or deletes any number of files (workflow files included, if the app has the workflows permission). Never force-pushes: fails if the branch moved past expected_head_sha. Creates the branch from create_branch_from if it doesn't exist.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        branch: { type: "string" },
        message: { type: "string", description: "Commit message." },
        files: {
          type: "array",
          description: "Changes to make.",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string", description: "New file content. Omit with delete=true." },
              encoding: { type: "string", enum: ["utf-8", "base64"], description: "Default utf-8." },
              delete: { type: "boolean", description: "Delete this path." },
              executable: { type: "boolean", description: "Mode 100755 instead of 100644." },
            },
            required: ["path"],
          },
        },
        create_branch_from: {
          type: "string",
          description: 'If the branch does not exist, create it from this branch, tag or SHA ("" or "default" for the default branch).',
        },
        expected_head_sha: { type: "string", description: "Refuse to commit unless the branch head is this SHA." },
      },
      required: ["repo", "branch", "message", "files"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const rp = repoPath(args, ctx);
      const gh = ctx.gh;
      const files = args.files as any[];
      if (!files.length) throw new ToolInputError("files is empty");
      for (const f of files) {
        if (typeof f?.path !== "string" || !f.path) throw new ToolInputError("every file needs a path");
        if (!f.delete && typeof f.content !== "string") throw new ToolInputError(`file ${f.path}: content is required unless delete=true`);
      }

      const branchRef = `${rp}/git/ref/heads/${encodePath(args.branch)}`;
      const refRes = await gh.request({ path: branchRef });
      let parent: string;
      let isNew = false;
      if (refRes.ok) {
        parent = (refRes.data as any).object.sha;
      } else if (refRes.status === 404 && args.create_branch_from !== undefined) {
        const from = args.create_branch_from && args.create_branch_from !== "default" ? args.create_branch_from : await defaultBranch(gh, rp);
        parent = await resolveSha(gh, rp, from);
        isNew = true;
      } else {
        throw new GitHubError(refRes.status, `branch ${args.branch}: ${refRes.status} ${msgOf(refRes.data)}`, refRes.data);
      }
      if (args.expected_head_sha && !isNew && parent !== args.expected_head_sha) {
        throw new ToolInputError(`branch ${args.branch} is at ${parent}, not expected_head_sha ${args.expected_head_sha}`);
      }

      const parentCommit = await gh.call<{ tree: { sha: string } }>({ path: `${rp}/git/commits/${parent}` });
      const tree = [];
      for (const f of files) {
        const path = String(f.path).replace(/^\/+/, "");
        const mode = f.executable ? "100755" : "100644";
        if (f.delete) {
          tree.push({ path, mode, type: "blob", sha: null });
        } else if (f.encoding === "base64") {
          const blob = await gh.call<{ sha: string }>({ method: "POST", path: `${rp}/git/blobs`, body: { content: f.content, encoding: "base64" } });
          tree.push({ path, mode, type: "blob", sha: blob.sha });
        } else {
          tree.push({ path, mode, type: "blob", content: f.content });
        }
      }
      const newTree = await gh.call<{ sha: string }>({ method: "POST", path: `${rp}/git/trees`, body: { base_tree: parentCommit.tree.sha, tree } });
      const commit = await gh.call<{ sha: string; html_url: string }>({
        method: "POST",
        path: `${rp}/git/commits`,
        body: { message: args.message, tree: newTree.sha, parents: [parent] },
      });
      if (isNew) {
        await gh.call({ method: "POST", path: `${rp}/git/refs`, body: { ref: `refs/heads/${args.branch}`, sha: commit.sha } });
      } else {
        await gh.call({ method: "PATCH", path: `${rp}/git/refs/heads/${encodePath(args.branch)}`, body: { sha: commit.sha, force: false } });
      }
      return { branch: args.branch, created_branch: isNew, commit: commit.sha, parent, html_url: commit.html_url };
    },
  },
  {
    name: "open_pr",
    title: "Open pull request",
    description: "Open a pull request from head into base (default: the default branch).",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        head: { type: "string", description: "Branch with the changes." },
        base: { type: "string", description: "Target branch. Default: the default branch." },
        title: { type: "string" },
        body: { type: "string" },
        draft: { type: "boolean" },
      },
      required: ["repo", "head", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const rp = repoPath(args, ctx);
      const base = args.base ?? (await defaultBranch(ctx.gh, rp));
      const pr = await ctx.gh.call<any>({
        method: "POST",
        path: `${rp}/pulls`,
        body: { head: args.head, base, title: args.title, body: args.body, draft: args.draft ?? false },
      });
      return { number: pr.number, html_url: pr.html_url, state: pr.state, draft: pr.draft };
    },
  },
  {
    name: "comment",
    title: "Comment on issue or PR",
    description: "Add a comment to an issue or pull request conversation.",
    inputSchema: {
      type: "object",
      properties: { repo: repoProp, number: { type: "integer" }, body: { type: "string" } },
      required: ["repo", "number", "body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const rp = repoPath(args, ctx);
      const c = await ctx.gh.call<any>({ method: "POST", path: `${rp}/issues/${args.number}/comments`, body: { body: args.body } });
      return { id: c.id, html_url: c.html_url };
    },
  },
  {
    name: "list_prs",
    title: "List pull requests",
    description: "List pull requests in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        state: { type: "string", enum: ["open", "closed", "all"], description: "Default open." },
        head: { type: "string", description: 'Filter by head, as "OWNER:BRANCH".' },
        base: { type: "string" },
        ...pageProps,
      },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const rp = repoPath(args, ctx);
      const prs = await ctx.gh.call<any[]>({
        path: `${rp}/pulls`,
        query: { state: args.state, head: args.head, base: args.base, per_page: args.per_page, page: args.page },
      });
      return prs.map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        draft: p.draft,
        head: p.head?.ref,
        base: p.base?.ref,
        author: p.user?.login,
        updated_at: p.updated_at,
        html_url: p.html_url,
      }));
    },
  },
  {
    name: "get_pr",
    title: "Get pull request",
    description: "Get one pull request with its changed files and the check runs on its head commit.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        number: { type: "integer" },
        include_files: { type: "boolean", description: "Default true." },
        include_checks: { type: "boolean", description: "Default true." },
      },
      required: ["repo", "number"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const rp = repoPath(args, ctx);
      const p = await ctx.gh.call<any>({ path: `${rp}/pulls/${args.number}` });
      const out: Record<string, unknown> = {
        number: p.number,
        title: p.title,
        body: p.body,
        state: p.state,
        draft: p.draft,
        merged: p.merged,
        mergeable: p.mergeable,
        mergeable_state: p.mergeable_state,
        head: { ref: p.head?.ref, sha: p.head?.sha },
        base: { ref: p.base?.ref, sha: p.base?.sha },
        author: p.user?.login,
        additions: p.additions,
        deletions: p.deletions,
        changed_files: p.changed_files,
        html_url: p.html_url,
      };
      if (args.include_files !== false) {
        const files = await ctx.gh.call<any[]>({ path: `${rp}/pulls/${args.number}/files`, query: { per_page: 100 } });
        out.files = files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
      }
      if (args.include_checks !== false && p.head?.sha) {
        const checks = await ctx.gh.call<{ check_runs: any[] }>({ path: `${rp}/commits/${p.head.sha}/check-runs`, query: { per_page: 100 } });
        out.checks = checks.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, html_url: c.html_url }));
      }
      return out;
    },
  },
  {
    name: "list_workflow_runs",
    title: "List workflow runs",
    description: "List GitHub Actions workflow runs, optionally for one workflow (ID or file name such as ci.yml).",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        workflow: { type: "string", description: "Workflow ID or file name." },
        branch: { type: "string" },
        status: { type: "string", description: "e.g. completed, in_progress, queued, failure, success." },
        event: { type: "string" },
        head_sha: { type: "string" },
        ...pageProps,
      },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(args, ctx) {
      const rp = repoPath(args, ctx);
      const path = args.workflow ? `${rp}/actions/workflows/${encodeURIComponent(args.workflow)}/runs` : `${rp}/actions/runs`;
      const r = await ctx.gh.call<{ total_count: number; workflow_runs: any[] }>({
        path,
        query: {
          branch: args.branch,
          status: args.status,
          event: args.event,
          head_sha: args.head_sha,
          per_page: args.per_page ?? 20,
          page: args.page,
        },
      });
      return {
        total_count: r.total_count,
        runs: r.workflow_runs.map((w) => ({
          id: w.id,
          name: w.name,
          title: w.display_title,
          status: w.status,
          conclusion: w.conclusion,
          branch: w.head_branch,
          sha: w.head_sha,
          event: w.event,
          created_at: w.created_at,
          html_url: w.html_url,
        })),
      };
    },
  },
  {
    name: "github_request",
    title: "GitHub API request",
    description:
      "Call any GitHub REST API endpoint as the app installation, for anything the other tools don't cover (workflow dispatch, job logs, releases, labels, merges, ...). path is relative to https://api.github.com, e.g. /repos/OWNER/REPO/actions/runs/123/logs. Download redirects are followed without the token.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "API path starting with /." },
        query: { type: "object", description: "Query parameters." },
        body: { type: "object", description: "JSON request body." },
        accept: { type: "string", description: "Accept header. Default application/vnd.github+json." },
        max_chars: { type: "integer", description: `Truncate the response body text. Default ${DEFAULT_MAX_CHARS}.` },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const res = await ctx.gh.request({
        method: args.method,
        path: args.path,
        query: args.query,
        body: args.body,
        accept: args.accept,
      });
      const keep = ["link", "location", "x-ratelimit-remaining", "x-ratelimit-reset", "content-type"];
      const headers: Record<string, string> = {};
      for (const k of keep) {
        const v = res.headers.get(k);
        if (v) headers[k] = v;
      }
      const bodyText = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
      return `HTTP ${res.status}\n${JSON.stringify(headers)}\n\n${truncate(bodyText ?? "", args.max_chars ?? DEFAULT_MAX_CHARS)}`;
    },
  },
];

export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function msgOf(data: unknown): string {
  if (data && typeof data === "object" && "message" in data) return String((data as any).message);
  return typeof data === "string" ? data.slice(0, 200) : "";
}

export async function callTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult | null> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  const err = validateArgs(tool.inputSchema, args);
  if (err) return { content: [{ type: "text", text: `Invalid arguments: ${err}` }], isError: true };
  const a = (args ?? {}) as Record<string, any>;
  const started = Date.now();
  let ok = false;
  try {
    const out = await tool.run(a, ctx);
    ok = true;
    const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    return { content: [{ type: "text", text }], isError: false };
  } catch (e) {
    if (e instanceof GitHubError || e instanceof ToolInputError) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
    // Unexpected errors: report the message only. Nothing here holds a secret.
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  } finally {
    // Audit line for `wrangler tail` / Workers Logs. No arguments beyond the repo and path.
    console.log(
      JSON.stringify({
        event: "tool_call",
        tool: name,
        user: ctx.user.login,
        repo: typeof a.repo === "string" ? a.repo : undefined,
        path: name === "github_request" ? `${a.method} ${a.path}` : undefined,
        ok,
        ms: Date.now() - started,
      }),
    );
  }
}
