import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { handleFeed } from "../src/feed";
import { fakeGitHub, jsonRes, toolContext } from "./fake-github";

const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

function feed(extra: Parameters<typeof fakeGitHub>[0] = {}) {
  const { fetchImpl, log } = fakeGitHub({
    "GET /app": () => jsonRes({ id: 42, slug: "claudeduet", name: "Claude Duet" }),
    "GET /repos/o/r/issues": () => jsonRes([{ number: 1 }]),
    ...extra,
  });
  const { gh } = toolContext(fetchImpl);
  const appJwt = vi.fn(async () => "app.jwt.token");
  const call = (path: string, init?: RequestInit) =>
    handleFeed(new Request(`https://feed${path}`, init), {} as Env, { gh, appJwt, fetchImpl });
  return { call, log, appJwt };
}

describe("feed entrypoint", () => {
  it("identity returns the app's bot login", async () => {
    const { call, log, appJwt } = feed();
    const res = await call("/identity");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42", login: "claudeduet[bot]", name: "Claude Duet" });
    expect(log.find((r) => r.path === "/app")?.auth).toBe("Bearer app.jwt.token");
    await call("/identity");
    expect(appJwt).toHaveBeenCalledTimes(1); // cached for the isolate
  });

  it("passes a GET under /repos through with status and body", async () => {
    const res = await feed().call("/api/repos/o/r");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ full_name: "o/r", default_branch: "main" });
  });

  it("forwards the query string", async () => {
    const { call, log } = feed();
    await call("/api/repos/o/r/issues?state=open&per_page=5");
    const sent = log.find((r) => r.path === "/repos/o/r/issues")!;
    const q = new URL(sent.url).searchParams;
    expect(q.get("state")).toBe("open");
    expect(q.get("per_page")).toBe("5");
  });

  it("refuses paths outside /repos with 403", async () => {
    const { call, log } = feed();
    for (const p of ["/api/user", "/api/app/installations", "/api", "/api/"]) {
      const res = await call(p);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "feed reads /repos/ paths only" });
    }
    expect(log).toEqual([]);
  });

  it("refuses path traversal out of /repos", async () => {
    const { call, log } = feed();
    for (const p of ["/api/repos/../user", "/api/repos/%2e%2e/user", "/api/repos/o/r/%2E%2E/%2E%2E/%2E%2E/user"]) {
      const res = await call(p);
      expect([400, 403]).toContain(res.status);
    }
    expect(log).toEqual([]);
  });

  it("refuses non-GET with 405", async () => {
    const { call, log } = feed();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await call("/api/repos/o/r", { method });
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "feed is read-only" });
    }
    expect(log).toEqual([]);
  });

  it("passes an upstream 404 through as 404", async () => {
    const res = await feed().call("/api/repos/o/missing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Not Found" });
  });

  it("unknown route is 404", async () => {
    const res = await feed().call("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("writes one audit line per call, with no body or query", async () => {
    logSpy.mockClear();
    await feed().call("/api/repos/o/r/issues?state=open&access_token=secret");
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(Object.keys(line).sort()).toEqual(["event", "ms", "method", "path", "status"]);
    expect(line).toMatchObject({ event: "feed", method: "GET", path: "/api/repos/o/r/issues", status: 200 });
    expect(typeof line.ms).toBe("number");
    expect(line.ms).toBeGreaterThanOrEqual(0);
  });
});
