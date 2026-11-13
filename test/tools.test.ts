import { describe, expect, it, vi } from "vitest";
import { normalizePath } from "../src/github/client";
import { TOOLS, callTool, splitRepo, validateArgs } from "../src/tools";
import { SHA_MAIN, fakeGitHub, jsonRes, toolContext } from "./fake-github";

vi.spyOn(console, "log").mockImplementation(() => {});

const text = (r: any) => r.content[0].text as string;

describe("argument handling", () => {
  it("splits repos with and without the default owner", () => {
    expect(splitRepo("a/b")).toEqual({ owner: "a", name: "b" });
    expect(splitRepo("b", "a")).toEqual({ owner: "a", name: "b" });
    expect(() => splitRepo("b")).toThrow();
    expect(() => splitRepo("a/b/c")).toThrow();
    expect(() => splitRepo("../b", "a")).toThrow();
  });

  it("validates required keys, types, enums and unknown keys", () => {
    const s = TOOLS.find((t) => t.name === "list_prs")!.inputSchema;
    expect(validateArgs(s, {})).toMatch(/missing required argument "repo"/);
    expect(validateArgs(s, { repo: 1 })).toMatch(/must be string/);
    expect(validateArgs(s, { repo: "a/b", state: "merged" })).toMatch(/one of/);
    expect(validateArgs(s, { repo: "a/b", nope: 1 })).toMatch(/unknown argument/);
    expect(validateArgs(s, { repo: "a/b", state: "all", per_page: 5 })).toBeNull();
  });

  it("keeps github_request on the API host", () => {
    expect(normalizePath("repos/o/r")).toBe("/repos/o/r");
    for (const bad of ["https://evil.example/x", "//evil.example/x", "/https://evil.example", "/repos/../../x"]) {
      expect(() => normalizePath(bad)).toThrow();
    }
  });

  it("every tool has a valid object input schema and annotations", () => {
    const names = new Set<string>();
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      expect(t.annotations.openWorldHint).toBe(true);
    }
  });
});

describe("tools against a fake GitHub", () => {
  it("installation_info reports permissions, never the token", async () => {
    const gh = fakeGitHub();
    const r = await callTool("installation_info", {}, toolContext(gh.fetchImpl));
    expect(r!.isError).toBe(false);
    expect(text(r)).toContain('"workflows": "write"');
    expect(text(r)).not.toContain("ghs_");
  });

  it("get_file decodes base64 content and lists directories", async () => {
    const gh = fakeGitHub({
      "GET /repos/o/r/contents/README.md": () =>
        jsonRes({ type: "file", path: "README.md", encoding: "base64", content: Buffer.from("héllo\n").toString("base64") }),
      "GET /repos/o/r/contents/src": () => jsonRes([{ type: "file", path: "src/a.ts", size: 3 }]),
    });
    const ctx = toolContext(gh.fetchImpl);
    expect(text(await callTool("get_file", { repo: "r", path: "README.md" }, ctx))).toBe("héllo\n");
    expect(text(await callTool("get_file", { repo: "o/r", path: "src" }, ctx))).toContain("src/a.ts");
  });

  it("commit_files builds one commit on an existing branch, workflow file included", async () => {
    const gh = fakeGitHub();
    const r = await callTool(
      "commit_files",
      {
        repo: "o/r",
        branch: "main",
        message: "ci: add workflow",
        files: [
          { path: ".github/workflows/ci.yml", content: "on: push\n" },
          { path: "img.png", content: "iVBORw0K", encoding: "base64" },
          { path: "old.txt", delete: true },
          { path: "run.sh", content: "#!/bin/sh\n", executable: true },
        ],
      },
      toolContext(gh.fetchImpl),
    );
    expect(r!.isError, text(r)).toBe(false);
    const calls = gh.log.filter((c) => c.url.startsWith("https://api.github.com/repos")).map((c) => `${c.method} ${c.path}`);
    expect(calls).toEqual([
      "GET /repos/o/r/git/ref/heads/main",
      `GET /repos/o/r/git/commits/${SHA_MAIN}`,
      "POST /repos/o/r/git/blobs",
      "POST /repos/o/r/git/trees",
      "POST /repos/o/r/git/commits",
      "PATCH /repos/o/r/git/refs/heads/main",
    ]);
    const tree = gh.log.find((c) => c.path === "/repos/o/r/git/trees")!.body;
    expect(tree.base_tree).toBe("tree0");
    expect(tree.tree).toEqual([
      { path: ".github/workflows/ci.yml", mode: "100644", type: "blob", content: "on: push\n" },
      { path: "img.png", mode: "100644", type: "blob", sha: "blob1" },
      { path: "old.txt", mode: "100644", type: "blob", sha: null },
      { path: "run.sh", mode: "100755", type: "blob", content: "#!/bin/sh\n" },
    ]);
    const commit = gh.log.find((c) => c.path === "/repos/o/r/git/commits" && c.method === "POST")!.body;
    expect(commit.parents).toEqual([SHA_MAIN]);
    const patch = gh.log.find((c) => c.method === "PATCH")!.body;
    expect(patch.force).toBe(false);
    // Every API call carried the installation token, never the JWT.
    for (const c of gh.log.filter((c) => c.path.startsWith("/repos"))) expect(c.auth).toMatch(/^Bearer ghs_fake_/);
  });

  it("commit_files creates a missing branch from the default branch", async () => {
    const gh = fakeGitHub();
    const r = await callTool(
      "commit_files",
      { repo: "o/r", branch: "feature/x", message: "m", files: [{ path: "a", content: "b" }], create_branch_from: "" },
      toolContext(gh.fetchImpl),
    );
    expect(r!.isError, text(r)).toBe(false);
    const ref = gh.log.find((c) => c.method === "POST" && c.path === "/repos/o/r/git/refs")!.body;
    expect(ref).toEqual({ ref: "refs/heads/feature/x", sha: "c".repeat(40) });
    expect(gh.log.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("commit_files refuses when the branch moved", async () => {
    const gh = fakeGitHub();
    const r = await callTool(
      "commit_files",
      { repo: "o/r", branch: "main", message: "m", files: [{ path: "a", content: "b" }], expected_head_sha: "b".repeat(40) },
      toolContext(gh.fetchImpl),
    );
    expect(r!.isError).toBe(true);
    expect(text(r)).toMatch(/not expected_head_sha/);
    expect(gh.log.some((c) => c.method === "POST" && c.path.includes("/git/"))).toBe(false);
  });

  it("returns GitHub errors as tool errors", async () => {
    const gh = fakeGitHub({ "POST /repos/o/r/pulls": () => jsonRes({ message: "Validation Failed" }, 422) });
    const r = await callTool("open_pr", { repo: "o/r", head: "x", title: "t" }, toolContext(gh.fetchImpl));
    expect(r!.isError).toBe(true);
    expect(text(r)).toMatch(/422 Validation Failed/);
  });

  it("github_request follows download redirects without the token", async () => {
    const logsUrl = "https://pipelinesghubeus1.actions.githubusercontent.com/logs/1?sig=abc";
    const gh = fakeGitHub({
      "GET /repos/o/r/actions/runs/1/logs": () => new Response(null, { status: 302, headers: { location: logsUrl } }),
      [`GET ${logsUrl}`]: () => new Response("log line\n", { status: 200, headers: { "content-type": "text/plain" } }),
    });
    const r = await callTool("github_request", { method: "GET", path: "/repos/o/r/actions/runs/1/logs" }, toolContext(gh.fetchImpl));
    expect(text(r)).toContain("HTTP 200");
    expect(text(r)).toContain("log line");
    const dl = gh.log.find((c) => c.url === logsUrl)!;
    expect(dl.auth).toBeNull();
  });

  it("github_request does not follow redirects to other hosts", async () => {
    const gh = fakeGitHub({
      "GET /x": () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    });
    const r = await callTool("github_request", { method: "GET", path: "/x" }, toolContext(gh.fetchImpl));
    expect(text(r)).toContain("HTTP 302");
    expect(gh.log.some((c) => c.url.startsWith("https://evil.example"))).toBe(false);
  });

  it("retries once with a fresh token after a 401", async () => {
    let first = true;
    const gh = fakeGitHub({
      "GET /repos/o/r/pulls": () => {
        if (first) {
          first = false;
          return jsonRes({ message: "Bad credentials" }, 401);
        }
        return jsonRes([]);
      },
    });
    const r = await callTool("list_prs", { repo: "o/r" }, toolContext(gh.fetchImpl));
    expect(r!.isError).toBe(false);
    const mints = gh.log.filter((c) => c.path === "/app/installations/1/access_tokens");
    expect(mints).toHaveLength(2);
  });

  it("unknown tools return null so the server can answer -32602", async () => {
    expect(await callTool("nope", {}, toolContext(fakeGitHub().fetchImpl))).toBeNull();
  });
});
