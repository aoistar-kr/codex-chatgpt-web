import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverManagedCodexCliCandidates,
  resolveOriginalCodexCli,
} from "../src/codex-cli-resolver";
import { parseCodexProxyControlFrame } from "../src/codex-stdio-proxy";

const threadId = "01a0a9e1-5e11-7453-8b94-87d7a7857831";
const turnId = "01a0aace-2eb6-74c0-bb6c-ec6fd37ab6a7";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function resolverFixture(): { root: string; self: string; older: string; newer: string } {
  const fixture = join(tmpdir(), `codex-cli-resolver-${crypto.randomUUID()}`);
  temporaryRoots.push(fixture);
  const root = join(fixture, "OpenAI", "Codex", "bin");
  const self = join(fixture, "proxy.exe");
  const older = join(root, "old", "codex.exe");
  const newer = join(root, "new", "codex.exe");
  mkdirSync(join(root, "old"), { recursive: true });
  mkdirSync(join(root, "new"), { recursive: true });
  writeFileSync(self, "proxy");
  for (const [directory, content] of [[join(root, "old"), "old"], [join(root, "new"), "new"]] as const) {
    writeFileSync(join(directory, "codex.exe"), content);
    writeFileSync(join(directory, "codex-code-mode-host.exe"), `${content}-host`);
    writeFileSync(join(directory, "codex-command-runner.exe"), `${content}-runner`);
    writeFileSync(join(directory, "codex-windows-sandbox-setup.exe"), `${content}-sandbox`);
  }
  const oldTime = new Date("2025-01-01T00:00:00Z");
  const newTime = new Date("2026-01-01T00:00:00Z");
  utimesSync(older, oldTime, oldTime);
  utimesSync(join(root, "old"), oldTime, oldTime);
  utimesSync(newer, newTime, newTime);
  utimesSync(join(root, "new"), newTime, newTime);
  return { root, self, older, newer };
}

describe("Codex stdio active-turn control proxy", () => {
  test("selects the newest validated immediate managed Codex CLI candidate", () => {
    const fixture = resolverFixture();
    expect(discoverManagedCodexCliCandidates(fixture.root, fixture.self).map(item => item.path))
      .toEqual([fixture.newer, fixture.older]);
    expect(resolveOriginalCodexCli({
      managedRoot: fixture.root,
      selfPath: fixture.self,
      validateVersion: candidate => candidate === fixture.older,
    })).toBe(fixture.older);
  });

  test("rejects relative explicit overrides, self recursion, and invalid versions", () => {
    const fixture = resolverFixture();
    expect(() => resolveOriginalCodexCli({ explicitPath: "codex.exe", selfPath: fixture.self }))
      .toThrow("must be an absolute path");
    expect(() => resolveOriginalCodexCli({
      explicitPath: fixture.self,
      selfPath: fixture.self,
      validateVersion: () => true,
    })).toThrow("proxy itself");
    expect(() => resolveOriginalCodexCli({
      explicitPath: fixture.older,
      selfPath: fixture.self,
      validateVersion: () => false,
    })).toThrow("failed version validation");
  });

  test("ignores a newer managed CLI directory when a required Desktop companion is missing", () => {
    const fixture = resolverFixture();
    unlinkSync(join(dirname(fixture.newer), "codex-code-mode-host.exe"));
    expect(discoverManagedCodexCliCandidates(fixture.root, fixture.self).map(item => item.path))
      .toEqual([fixture.older]);
    expect(resolveOriginalCodexCli({
      managedRoot: fixture.root,
      selfPath: fixture.self,
      validateVersion: () => true,
    })).toBe(fixture.older);
  });

  test("does not follow linked version directories out of the managed root", () => {
    const fixture = resolverFixture();
    const outside = join(dirname(fixture.root), "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "codex.exe"), "outside");
    try {
      symlinkSync(outside, join(fixture.root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }
    expect(discoverManagedCodexCliCandidates(fixture.root, fixture.self).map(item => item.path))
      .toEqual([fixture.newer, fixture.older]);
  });

  test("copies a bounded turn/steer frame into exact-turn WebGPT input", () => {
    const frame = parseCodexProxyControlFrame(JSON.stringify({
      id: 7,
      method: "turn/steer",
      params: {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: "message_steer_123",
        input: [{ type: "text", text: "steer now", text_elements: [] }],
      },
    }));
    expect(frame).toEqual({
      kind: "steer",
      payload: {
        threadId,
        turnId,
        itemId: "message_steer_123",
        content: [{ type: "text", text: "steer now" }],
      },
    });
  });

  test("derives a stable non-content item id when Codex omits a client id", () => {
    const line = JSON.stringify({
      id: "request-1",
      method: "turn/steer",
      params: { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "same" }] },
    });
    const first = parseCodexProxyControlFrame(line);
    const second = parseCodexProxyControlFrame(line);
    expect(first).toEqual(second);
    expect(first?.kind === "steer" && first.payload.itemId).toMatch(/^steer_[a-f0-9]{24}$/);
  });

  test("copies exact turn/interrupt and ignores malformed or unrelated frames", () => {
    expect(parseCodexProxyControlFrame(JSON.stringify({
      id: 9,
      method: "turn/interrupt",
      params: { threadId, turnId },
    }))).toEqual({ kind: "interrupt", payload: { threadId, turnId } });
    expect(parseCodexProxyControlFrame(JSON.stringify({ method: "turn/start", params: {} }))).toBeUndefined();
    expect(parseCodexProxyControlFrame(JSON.stringify({
      method: "turn/steer",
      params: { threadId, expectedTurnId: turnId, input: [{ type: "localImage", path: "x" }] },
    }))).toBeUndefined();
  });
});
