// github-broker: a remote MCP server that lends Claude a GitHub App installation
// without ever handing over the app's private key.
//
//   /mcp                                   MCP endpoint (OAuth bearer required)
//   /.well-known/oauth-protected-resource  RFC 9728 metadata (resource server)
//   /.well-known/oauth-authorization-server, /oauth/token, /oauth/register  (library)
//   /authorize, /callback                  consent page + Sign in with GitHub

import {
  OAuthAuthorizationServer,
  OAuthResourceServer,
  insufficientScope,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { AuthProps, SCOPE, handleAuthorize, handleCallback, isAllowed, publicUrl } from "./auth";
import type { Env } from "./env";
import { InstallationTokenCache } from "./github/app";
import { GitHubClient } from "./github/client";
import { handleMcp } from "./mcp";

const VERSION = "0.1.0";

const INSTRUCTIONS =
  "Tools act as a GitHub App installation, with whatever permissions the app was granted (installation_info shows them). " +
  'Pass repositories as "OWNER/NAME" (or NAME when a default owner is configured). ' +
  "commit_files makes one commit with any number of file changes and never force-pushes. " +
  "github_request reaches any other REST endpoint.";

// One token cache per isolate; installation tokens last an hour.
const tokens = new InstallationTokenCache();

interface Roles {
  url: string;
  as: OAuthAuthorizationServer<Env>;
  rs: OAuthResourceServer<Env, AuthProps>;
}
let roles: Roles | undefined;

function getRoles(env: Env): Roles {
  const url = publicUrl(env);
  if (roles && roles.url === url) return roles;
  const resource = `${url}/mcp`;

  const as = new OAuthAuthorizationServer<Env>({
    issuer: url,
    resources: [resource],
    scopesSupported: [SCOPE, "offline_access"],
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
  });

  const rs = new OAuthResourceServer<Env, AuthProps>({
    resourceMetadata: { resource, authorization_servers: [url], resource_name: "GitHub broker" },
    requiredScopes: [SCOPE],
    validateToken: (e) => (res, token) => as.validateToken<AuthProps>(res, token, e),
    handler: {
      async fetch(request: Request, env: Env, ctx: OAuthResourceContext<AuthProps>) {
        if (!ctx.auth.scope.includes(SCOPE)) return insufficientScope(ctx.auth, [SCOPE]);
        const props = ctx.props;
        // Re-check on every request, so removing someone from the allowlist takes effect at once.
        if (!props || !isAllowed(env.ALLOWED_GITHUB_USERS, props)) {
          return new Response("Forbidden", { status: 403 });
        }
        return handleMcp(
          request,
          () => ({
            gh: new GitHubClient(
              {
                issuer: required(env, "GITHUB_APP_CLIENT_ID"),
                installationId: required(env, "GITHUB_INSTALLATION_ID"),
                privateKeyPem: required(env, "GITHUB_APP_PRIVATE_KEY"),
              },
              tokens,
            ),
            defaultOwner: env.GITHUB_DEFAULT_OWNER || undefined,
            user: props,
          }),
          {
            serverInfo: { name: "github-broker", title: "GitHub broker", version: VERSION },
            instructions: INSTRUCTIONS,
            allowedOrigins: env.ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
          },
        );
      },
    },
  });

  roles = { url, as, rs };
  return roles;
}

function required(env: Env, key: keyof Env): string {
  const v = env[key];
  if (typeof v !== "string" || !v) throw new Error(`${key} is not set`);
  return v;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { as, rs } = getRoles(env);

    if (pathname === "/authorize") return handleAuthorize(request, env, as.getOAuthApi(env));
    if (pathname === "/callback") return handleCallback(request, env, as.getOAuthApi(env), ctx);
    if (pathname === "/mcp" || pathname.startsWith("/mcp/") || pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return rs.fetch(request, env, ctx);
    }
    if (pathname === "/" && request.method === "GET") {
      return new Response(`github-broker ${VERSION}: MCP endpoint at ${publicUrl(env)}/mcp\n`, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return as.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
