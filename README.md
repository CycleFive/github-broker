# github-broker

A remote MCP server on Cloudflare Workers that lends an MCP client (Claude) a GitHub App
installation. The app's private key lives only in the Worker's secret store. The client
never sees the key or the installation token, only tool results.

```
Claude ──OAuth bearer──▶ /mcp ──▶ tools ──installation token──▶ api.github.com
                          │
                          └─ private key (Wrangler secret) → RS256 app JWT → token, cached ~1 h
```

## What you get

| Tool | What it does |
| --- | --- |
| `installation_info` | The installation's granted permissions and repo selection. Never returns the token. |
| `list_repos` | Repositories the installation can reach. |
| `get_file` | File contents at a ref (base64 decoded; raw fetch for files over 1 MB), or a directory listing. |
| `list_tree` | Recursive tree at a ref, optionally under a path prefix. |
| `create_branch` | Branch from a branch, tag or SHA (default branch by default). |
| `commit_files` | One commit with any number of adds, edits, deletes, executable bits and base64 blobs. Uses the Git Data API, so `.github/workflows/*` works when the app has `workflows: write`. Never force-pushes; `expected_head_sha` guards against races; `create_branch_from` makes the branch if missing. |
| `open_pr` | Open a PR (draft optional). |
| `comment` | Comment on an issue or PR. |
| `list_prs` / `get_pr` | PR list; one PR with changed files and check runs. |
| `list_workflow_runs` | Actions runs, filterable by workflow, branch, status, event, SHA. |
| `github_request` | Any REST endpoint: method, path, query, body, accept. Download redirects (logs, artifacts) are followed without the token; redirects anywhere else are not followed. |

Repos are `"OWNER/NAME"`, or `"NAME"` when `GITHUB_DEFAULT_OWNER` is set. Every tool call
writes one audit line (tool, signed-in GitHub login, repo or path, ok, ms) to Workers Logs.
GitHub attributes everything to `<your-app>[bot]`.

## Auth

The connector URL alone grants nothing. `/mcp` is an OAuth 2.1 protected resource, and
the Worker is its own authorization server
([`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
1.2.4, the one runtime dependency):

1. Claude finds the server from the `401` challenge and registers itself (Client ID
   Metadata Document, or Dynamic Client Registration as a fallback). PKCE S256 throughout.
2. `/authorize` shows a consent page naming the client and the host the grant goes to.
   Approve only when it says `claude.ai` (or `localhost` for Claude Code).
3. You sign in with GitHub, through **the same GitHub App's** user authorization. The
   Worker reads `/user` once, revokes that user token, and checks your account against
   `ALLOWED_GITHUB_USERS`.
4. Claude gets a 1-hour access token plus a rotating refresh token, both bound to
   `PUBLIC_URL/mcp`. The allowlist is checked again on every MCP request, so removing an
   ID cuts off existing tokens immediately.

This is what claude.ai custom connectors support without special setup (authless, OAuth
with CIMD, or OAuth with DCR; static headers are a limited beta). A secret in the URL
would have worked but leaks through logs and anywhere the URL is pasted.

## Protocol

Hand-written Streamable HTTP, stateless, JSON responses only (no SSE, no sessions). It
speaks MCP **2026-07-28** (`server/discover`, per-request `_meta` version, `resultType`,
cache hints) and the older handshake versions **2025-11-25 / 2025-06-18 / 2025-03-26**
(`initialize`). `GET`/`DELETE` on `/mcp` answer `405`.

## Setup

You need Node 20+, a Cloudflare account, and admin on the GitHub App.

### 1. GitHub App settings

On the app's settings page (Developer settings → GitHub Apps → your app):

- **Callback URL**: `https://<your-worker-host>/callback`. You get the host in step 3;
  come back and set it then.
- Leave "Request user authorization (OAuth) during installation" off. Sign-in needs no
  extra permissions.
- **Client secrets → Generate a new client secret.** Keep it for step 4.
- Note the **Client ID** (`Iv23…`).
- **Permissions**: whatever you want Claude to have. For workflow files you need
  Repository → Workflows: Read and write (plus Contents: Read and write).

Installation ID: org Settings → GitHub Apps → Configure; it's the number at the end of
the URL. Your user ID: `gh api users/<login> --jq .id` (IDs survive renames; logins work
too but can be re-registered by someone else after a rename).

### 2. Configure

```sh
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```

`wrangler.jsonc` is git-ignored: it holds your own IDs and URL, no secrets. Paste the KV
id into it, then fill in `vars`: `GITHUB_APP_CLIENT_ID`,
`GITHUB_INSTALLATION_ID`, `ALLOWED_GITHUB_USERS`, optionally `GITHUB_DEFAULT_OWNER`.

### 3. First deploy, to learn the URL

```sh
npx wrangler deploy
```

It prints `https://github-broker.<subdomain>.workers.dev`. Put that in `PUBLIC_URL` (no
trailing slash), and set the GitHub App's Callback URL to `<PUBLIC_URL>/callback`.

### 4. Secrets

Pipe them in so they never land in shell history:

```sh
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/Downloads/your-app.2026-11-04.private-key.pem
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
```

The PEM can be GitHub's PKCS#1 (`BEGIN RSA PRIVATE KEY`) as downloaded; the Worker
converts it. PKCS#8 works too. You can delete the local `.pem` afterwards.

### 5. Deploy and smoke test

```sh
npx wrangler deploy
curl -si -X POST "$PUBLIC_URL/mcp" -d '{}' | grep -i www-authenticate   # 401 + resource_metadata
curl -s "$PUBLIC_URL/.well-known/oauth-authorization-server" | jq .issuer
```

### 6. Connect

- **claude.ai**: Settings → Connectors → Add custom connector. URL: `<PUBLIC_URL>/mcp`
  exactly, since the resource metadata must match it. Keep the default OAuth sign-in. You'll
  see the consent page (check it says `claude.ai`), then GitHub.
- **Claude Code**: `claude mcp add --transport http github-broker <PUBLIC_URL>/mcp`.

Then ask for `installation_info` to confirm the permissions you expect, `workflows`
included.

## Operating it

- **Logs**: `npx wrangler tail`, or Workers Logs in the dashboard (`observability` is on).
- **Cut someone off**: remove them from `ALLOWED_GITHUB_USERS` and deploy. Takes effect on
  the next request.
- **Rotate the key**: generate a new key on the app, `wrangler secret put
  GITHUB_APP_PRIVATE_KEY`, then delete the old key on GitHub. The token cache picks up a
  changed PEM on its next mint.
- **Kill switch**: suspend the installation on GitHub, or delete the app key.
- **Guardrails that don't depend on this code**: rulesets on the org's repos (protect
  `master`, require PR review, block force-push and branch deletion) still apply to the
  bot. `github_request` is deliberately unrestricted, so those rules are the real limit.

## Development

```sh
npm test            # vitest: PEM/JWT, token cache, tools, MCP conformance, full OAuth flow
npm run typecheck
cp .dev.vars.example .dev.vars && npm run dev   # local workerd on :8787
```

The tests run the server against the official MCP clients (`@modelcontextprotocol/client`
2.4 in 2026-07-28 and legacy modes, `@modelcontextprotocol/sdk` 1.32), and walk the whole
sign-in: registration → consent → GitHub (faked) → token → MCP calls, with and without the
`resource` parameter. GitHub's API is faked at the fetch layer; no test touches a real key.

Layout: `src/index.ts` (routing, OAuth roles), `src/auth.ts` (consent, GitHub sign-in,
allowlist), `src/mcp.ts` (transport), `src/tools.ts`, `src/github/app.ts` (PEM, JWT, token
cache), `src/github/client.ts` (REST client).

## License

MIT — see [LICENSE](LICENSE).
