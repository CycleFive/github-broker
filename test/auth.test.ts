import { describe, expect, it } from "vitest";
import { escapeHtml, isAllowed, parseAllowlist } from "../src/auth";

describe("allowlist", () => {
  it("matches numeric IDs exactly and logins case-insensitively", () => {
    const raw = "12345, Lothrop  other";
    expect(parseAllowlist(raw).ids).toEqual(new Set(["12345"]));
    expect(isAllowed(raw, { id: 12345, login: "someone-renamed" })).toBe(true);
    expect(isAllowed(raw, { id: 9, login: "lothrop" })).toBe(true);
    expect(isAllowed(raw, { id: 9, login: "lothrop2" })).toBe(false);
    expect(isAllowed(raw, { id: 123456, login: "x" })).toBe(false);
  });

  it("an empty allowlist lets nobody in", () => {
    expect(isAllowed("", { id: 1, login: "a" })).toBe(false);
    expect(isAllowed(undefined, { id: 1, login: "a" })).toBe(false);
  });
});

it("escapes client-supplied strings for the consent page", () => {
  expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
});
