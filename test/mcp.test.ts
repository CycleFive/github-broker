// Conformance against the official MCP clients: @modelcontextprotocol/client 2.4
// (2026-07-28 and legacy eras) and @modelcontextprotocol/sdk 1.x (legacy only).

import { Client as Client2, StreamableHTTPClientTransport as Transport2 } from "@modelcontextprotocol/client";
import { Client as Client1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as Transport1 } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { MODERN_VERSION, SUPPORTED_VERSIONS, handleMcp } from "../src/mcp";
import { TOOLS } from "../src/tools";
import { fakeGitHub, toolContext } from "./fake-github";

vi.spyOn(console, "log").mockImplementation(() => {});

const URL_ = "https://broker.test/mcp";
const opts = { serverInfo: { name: "github-broker", version: "0.0.0-test" }, instructions: "test" };

function serverFetch(seen: { method: string; headers: Headers; body?: any }[] = []) {
  const gh = fakeGitHub();
  const ctx = toolContext(gh.fetchImpl);
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const clone = req.clone();
    let body: any;
    try {
      body = await clone.json();
    } catch {}
    seen.push({ method: req.method, headers: req.headers, body });
    return handleMcp(req, () => ctx, opts);
  };
  return f as typeof fetch;
}

async function exercise(client: { listTools: () => Promise<any>; callTool: (p: any) => Promise<any> }) {
  const tools = await client.listTools();
  expect(tools.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
  const res = await client.callTool({ name: "installation_info", arguments: {} });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toContain("workflows");
  const bad = await client.callTool({ name: "list_prs", arguments: {} });
  expect(bad.isError).toBe(true);
}

describe("MCP over Streamable HTTP", () => {
  it("2026-07-28: client 2.4 in auto mode discovers and uses the modern era", async () => {
    const seen: any[] = [];
    const client = new Client2({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new Transport2(new URL(URL_), { fetch: serverFetch(seen) }));
    await exercise(client as any);
    const methods = seen.filter((s) => s.body).map((s) => s.body.method);
    expect(methods[0]).toBe("server/discover");
    expect(methods).not.toContain("initialize");
    const call = seen.find((s) => s.body?.method === "tools/call");
    expect(call.headers.get("mcp-protocol-version")).toBe(MODERN_VERSION);
    expect(call.body.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(MODERN_VERSION);
    await client.close();
  });

  it("2026-07-28: pinned client works too", async () => {
    const client = new Client2({ name: "t", version: "1" }, { versionNegotiation: { mode: { pin: MODERN_VERSION } } });
    await client.connect(new Transport2(new URL(URL_), { fetch: serverFetch() }));
    await exercise(client as any);
    await client.close();
  });

  it("legacy: client 2.4 default mode uses initialize", async () => {
    const seen: any[] = [];
    const client = new Client2({ name: "t", version: "1" });
    await client.connect(new Transport2(new URL(URL_), { fetch: serverFetch(seen) }));
    await exercise(client as any);
    expect(seen.find((s) => s.body)?.body.method).toBe("initialize");
    await client.close();
  });

  it("legacy: SDK 1.x client", async () => {
    const client = new Client1({ name: "t", version: "1" });
    await client.connect(new Transport1(new URL(URL_), { fetch: serverFetch() }));
    await exercise(client as any);
    await client.close();
  });
});

describe("transport edges", () => {
  const ctx = () => toolContext(fakeGitHub().fetchImpl);
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handleMcp(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      ctx,
      { ...opts, allowedOrigins: ["https://claude.ai"] },
    );

  it("GET and DELETE are 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await handleMcp(new Request(URL_, { method }), ctx, opts);
      expect(r.status).toBe(405);
    }
  });

  it("notifications get 202 with no body", async () => {
    const r = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("parse errors and batches are 400", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
  });

  it("an unsupported modern version gets 400 -32022 with the supported list", async () => {
    const r = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } },
      { "mcp-protocol-version": "2099-01-01" },
    );
    expect(r.status).toBe(400);
    const b: any = await r.json();
    expect(b.error.code).toBe(-32022);
    expect(b.error.data.supported).toEqual(SUPPORTED_VERSIONS);
  });

  it("header and _meta version mismatch is 400 -32020", async () => {
    const r = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } } },
      { "mcp-protocol-version": "2025-11-25" },
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe(-32020);
  });

  it("modern results carry resultType, cache hints and serverInfo", async () => {
    const r = await post(
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } } },
      { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "tools/list" },
    );
    const b: any = await r.json();
    expect(b.result.resultType).toBe("complete");
    expect(b.result.cacheScope).toBe("private");
    expect(b.result.ttlMs).toBeGreaterThan(0);
    expect(b.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("github-broker");
    expect(r.headers.get("mcp-session-id")).toBeNull();
  });

  it("unknown methods: 404 in the modern era, JSON-RPC error in legacy", async () => {
    const modern = await post(
      { jsonrpc: "2.0", id: 1, method: "nope", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } } },
      { "mcp-protocol-version": MODERN_VERSION },
    );
    expect(modern.status).toBe(404);
    const legacy = await post({ jsonrpc: "2.0", id: 1, method: "nope" });
    expect(legacy.status).toBe(200);
    expect(((await legacy.json()) as any).error.code).toBe(-32601);
  });

  it("unknown tool is -32602", async () => {
    const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } });
    expect(((await r.json()) as any).error.code).toBe(-32602);
  });

  it("a foreign Origin is 403 when an allowlist is set", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://claude.ai" })).status).toBe(200);
  });

  it("initialize answers the client's legacy version, or the newest legacy one", async () => {
    const ask = async (v: string) =>
      ((await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "x", version: "1" } } })).json()) as any).result
        .protocolVersion;
    expect(await ask("2025-06-18")).toBe("2025-06-18");
    expect(await ask("2024-11-05")).toBe("2025-11-25");
  });
});
