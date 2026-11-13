// A small, stateless MCP server over Streamable HTTP. Every POST gets one
// application/json answer; there are no sessions and no SSE streams.
//
// It speaks both protocol eras:
//   - 2026-07-28: no handshake; server/discover; version in params._meta and the
//     MCP-Protocol-Version header; results carry resultType and serverInfo in _meta.
//   - 2025-11-25 / 2025-06-18 / 2025-03-26: initialize + notifications/initialized.

import { TOOLS, ToolContext, callTool } from "./tools";

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
};

export interface McpOptions {
  serverInfo: { name: string; version: string; title?: string };
  instructions?: string;
  /** If set, requests with an Origin header outside this list get 403. */
  allowedOrigins?: string[];
  /** How long clients may cache tools/list and server/discover (2026-07-28). */
  listTtlMs?: number;
}

type Id = string | number | null;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function rpcError(id: Id, code: number, message: string, data?: unknown, status = 200): Response {
  return json({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } }, status);
}

function isNewer(v: string): boolean {
  // Revision ids are dates, so string order is chronological.
  return v >= MODERN_VERSION;
}

export async function handleMcp(
  request: Request,
  getContext: () => ToolContext | Promise<ToolContext>,
  opts: McpOptions,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && opts.allowedOrigins && opts.allowedOrigins.length && !opts.allowedOrigins.includes(origin)) {
    return rpcError(null, ERR.invalidRequest, "Origin not allowed", undefined, 403);
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  let msg: any;
  try {
    msg = await request.json();
  } catch {
    return rpcError(null, ERR.parse, "Parse error", undefined, 400);
  }
  if (Array.isArray(msg)) return rpcError(null, ERR.invalidRequest, "Batch requests are not supported", undefined, 400);
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return rpcError(null, ERR.invalidRequest, "Invalid Request", undefined, 400);
  }

  // Responses from the client and notifications need no answer.
  if (typeof msg.method !== "string") return new Response(null, { status: 202 });
  if (msg.id === undefined) return new Response(null, { status: 202 });

  const id: Id = msg.id;
  const method: string = msg.method;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  const headerVersion = request.headers.get("mcp-protocol-version") ?? undefined;
  const metaVersion: string | undefined = params._meta?.[META_VERSION];
  const modern = method === "server/discover" || metaVersion !== undefined || (headerVersion !== undefined && isNewer(headerVersion));

  if (headerVersion && metaVersion && headerVersion !== metaVersion) {
    return rpcError(id, ERR.headerMismatch, "MCP-Protocol-Version header does not match _meta protocol version", undefined, 400);
  }
  const mcpMethod = request.headers.get("mcp-method");
  if (mcpMethod && mcpMethod !== method) {
    return rpcError(id, ERR.headerMismatch, "Mcp-Method header does not match the request method", undefined, 400);
  }
  const requested = metaVersion ?? headerVersion;
  if (requested && !SUPPORTED_VERSIONS.includes(requested) && method !== "initialize" && method !== "server/discover") {
    return rpcError(
      id,
      ERR.unsupportedVersion,
      "Unsupported protocol version",
      { supported: SUPPORTED_VERSIONS, requested },
      400,
    );
  }

  const ok = (result: Record<string, unknown>) =>
    json({
      jsonrpc: "2.0",
      id,
      result: modern ? { resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: opts.serverInfo } } : result,
    });
  const ttlMs = opts.listTtlMs ?? 5 * 60 * 1000;

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0];
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: opts.serverInfo,
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
        },
      });
    }
    case "server/discover":
      return ok({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
        ttlMs,
        cacheScope: "private",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
        ...(modern ? { ttlMs, cacheScope: "private" } : {}),
      });
    case "tools/call": {
      if (typeof params.name !== "string") return rpcError(id, ERR.invalidParams, "params.name is required");
      let ctx: ToolContext;
      try {
        ctx = await getContext();
      } catch (e) {
        return rpcError(id, ERR.internal, `Server not configured: ${(e as Error).message}`);
      }
      const result = await callTool(params.name, params.arguments ?? {}, ctx);
      if (!result) return rpcError(id, ERR.invalidParams, `Unknown tool: ${params.name}`);
      return ok({ ...result });
    }
    default:
      return rpcError(id, ERR.methodNotFound, `Method not found: ${method}`, undefined, modern ? 404 : 200);
  }
}
