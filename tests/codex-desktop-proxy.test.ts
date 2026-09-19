import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexDesktopProxyJournalPath,
  decodeUserEnvironmentValue,
  inspectCodexDesktopProxy,
  installCodexDesktopProxy,
  stableCodexDesktopProxyPath,
  uninstallCodexDesktopProxy,
  type UserEnvironmentStore,
  type UserEnvironmentValue,
} from "../src/codex-desktop-proxy";

const roots: string[] = [];

class MemoryEnvironment implements UserEnvironmentStore {
  constructor(public current: UserEnvironmentValue = { exists: false }) {}
  read(): UserEnvironmentValue { return { ...this.current }; }
  write(value: string | undefined): void {
    this.current = value === undefined ? { exists: false } : { exists: true, value };
  }
}

function fixture(): { home: string; source: string } {
  const root = join(tmpdir(), `codex-desktop-proxy-${crypto.randomUUID()}`);
  roots.push(root);
  const home = join(root, "home");
  const source = join(root, "runtime", "bin", "codex-webgpt-proxy.exe");
  mkdirSync(join(root, "runtime", "bin"), { recursive: true });
  writeFileSync(source, "proxy-v1");
  return { home, source };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex Desktop stable proxy integration", () => {
  test("installs a stable proxy and journals the absent prior override", () => {
    if (process.platform !== "win32") return;
    const { home, source } = fixture();
    const environment = new MemoryEnvironment();
    const status = installCodexDesktopProxy({
      home,
      sourceProxyPath: source,
      environment,
      versionSmoke: () => true,
      now: () => new Date("2026-09-17T00:00:00Z"),
    });
    expect(status.installed).toBeTrue();
    expect(status.activeOverride).toBeTrue();
    expect(environment.current.value).toBe(stableCodexDesktopProxyPath(home));
    expect(readFileSync(stableCodexDesktopProxyPath(home), "utf8")).toBe("proxy-v1");
    expect(JSON.parse(readFileSync(codexDesktopProxyJournalPath(home), "utf8"))).toMatchObject({
      version: 1,
      previous: { exists: false },
      installedAt: "2026-09-17T00:00:00.000Z",
    });
  });

  test("updates the stable proxy without losing the original environment baseline", () => {
    if (process.platform !== "win32") return;
    const { home, source } = fixture();
    const environment = new MemoryEnvironment();
    installCodexDesktopProxy({ home, sourceProxyPath: source, environment, versionSmoke: () => true });
    writeFileSync(source, "proxy-v2");
    installCodexDesktopProxy({ home, sourceProxyPath: source, environment, versionSmoke: () => true });
    expect(readFileSync(stableCodexDesktopProxyPath(home), "utf8")).toBe("proxy-v2");
    expect(JSON.parse(readFileSync(codexDesktopProxyJournalPath(home), "utf8"))).toMatchObject({
      previous: { exists: false },
    });
  });

  test("refuses an unrelated override before mutating stable state", () => {
    if (process.platform !== "win32") return;
    const { home, source } = fixture();
    const environment = new MemoryEnvironment({ exists: true, value: "C:\\Other\\codex.exe" });
    expect(() => installCodexDesktopProxy({
      home,
      sourceProxyPath: source,
      environment,
      versionSmoke: () => true,
    })).toThrow("Refusing to overwrite");
    expect(existsSync(stableCodexDesktopProxyPath(home))).toBeFalse();
    expect(existsSync(codexDesktopProxyJournalPath(home))).toBeFalse();
  });

  test("rollback restores the prior value only while the managed override still owns it", () => {
    if (process.platform !== "win32") return;
    const first = fixture();
    const prior = "C:\\Prior\\codex.exe";
    const environment = new MemoryEnvironment({ exists: true, value: prior });
    const stable = stableCodexDesktopProxyPath(first.home);
    environment.current = { exists: true, value: stable };
    mkdirSync(join(first.home, "codex"), { recursive: true });
    mkdirSync(join(first.home, "bin"), { recursive: true });
    writeFileSync(stable, "proxy-v1");
    writeFileSync(codexDesktopProxyJournalPath(first.home), `${JSON.stringify({
      version: 1,
      stableProxyPath: stable,
      proxySha256: "ee445d56c8d9c91f3c436f2285f9d279f012bbf799bcc0c70220503b3a9bfebb",
      previous: { exists: true, value: prior },
      installedAt: "2026-09-17T00:00:00.000Z",
    })}\n`);
    expect(uninstallCodexDesktopProxy({ home: first.home, environment })).toEqual({
      changed: true,
      preservedExternalOverride: false,
    });
    expect(environment.current).toEqual({ exists: true, value: prior });

    const second = fixture();
    const environment2 = new MemoryEnvironment();
    installCodexDesktopProxy({ home: second.home, sourceProxyPath: second.source, environment: environment2, versionSmoke: () => true });
    environment2.current = { exists: true, value: "C:\\UserChanged\\codex.exe" };
    expect(uninstallCodexDesktopProxy({ home: second.home, environment: environment2 })).toEqual({
      changed: false,
      preservedExternalOverride: true,
    });
    expect(environment2.current.value).toBe("C:\\UserChanged\\codex.exe");
    expect(existsSync(codexDesktopProxyJournalPath(second.home))).toBeTrue();
  });

  test("doctor reports hash drift and a missing active override", () => {
    if (process.platform !== "win32") return;
    const { home, source } = fixture();
    const environment = new MemoryEnvironment();
    installCodexDesktopProxy({ home, sourceProxyPath: source, environment, versionSmoke: () => true });
    writeFileSync(stableCodexDesktopProxyPath(home), "tampered");
    environment.current = { exists: false };
    const status = inspectCodexDesktopProxy({ home, environment, versionSmoke: () => true });
    expect(status.installed).toBeFalse();
    expect(status.activeOverride).toBeFalse();
    expect(status.errors).toContain("Stable proxy hash differs from the integration journal");
  });

  test("registry decoding treats empty and whitespace-only overrides as absent", () => {
    expect(decodeUserEnvironmentValue('{"exists":true,"value":""}')).toEqual({ exists: false });
    expect(decodeUserEnvironmentValue('{"exists":true,"value":"  "}')).toEqual({ exists: false });
    expect(decodeUserEnvironmentValue('{"exists":false}')).toEqual({ exists: false });
  });
});
