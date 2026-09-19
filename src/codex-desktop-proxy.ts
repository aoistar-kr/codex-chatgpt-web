import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir } from "./config";

const OVERRIDE_NAME = "CODEX_CLI_PATH";
const JOURNAL_VERSION = 1;

export interface UserEnvironmentValue {
  exists: boolean;
  value?: string;
}

export interface UserEnvironmentStore {
  read(): UserEnvironmentValue;
  write(value: string | undefined): void;
}

export function decodeUserEnvironmentValue(output: string): UserEnvironmentValue {
  const parsed = JSON.parse(output) as UserEnvironmentValue;
  const value = typeof parsed.value === "string" ? parsed.value : undefined;
  if (typeof parsed.exists !== "boolean" || (parsed.exists && value === undefined)) {
    throw new Error("The user Codex CLI override registry value could not be decoded safely");
  }
  return parsed.exists && value?.trim() ? { exists: true, value } : { exists: false };
}

export interface CodexDesktopProxyJournal {
  version: 1;
  stableProxyPath: string;
  proxySha256: string;
  previous: UserEnvironmentValue;
  installedAt: string;
}

export interface CodexDesktopProxyStatus {
  platformSupported: boolean;
  installed: boolean;
  activeOverride: boolean;
  stableProxyPath: string;
  stableProxyExists: boolean;
  stableProxySha256?: string;
  currentOverride: UserEnvironmentValue;
  journal?: CodexDesktopProxyJournal;
  versionSmokeOk: boolean;
  errors: string[];
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function powershell(script: string, extraEnvironment: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, ...extraEnvironment },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not update the user Codex CLI override: ${result.error?.message ?? result.stderr.trim() ?? "unknown error"}`);
  }
  return result.stdout.trim();
}

export class WindowsUserCodexCliEnvironment implements UserEnvironmentStore {
  read(): UserEnvironmentValue {
    const output = powershell(`
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
if ($null -eq $key -or -not ($key.GetValueNames() -contains '${OVERRIDE_NAME}')) {
  [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress
} else {
  $value = $key.GetValue('${OVERRIDE_NAME}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ([string]::IsNullOrWhiteSpace([string]$value)) {
    [pscustomobject]@{ exists = $false } | ConvertTo-Json -Compress
  } else {
    [pscustomobject]@{ exists = $true; value = [string]$value } | ConvertTo-Json -Compress
  }
}
`);
    return decodeUserEnvironmentValue(output);
  }

  write(value: string | undefined): void {
    powershell(
      value === undefined
        ? `
[Environment]::SetEnvironmentVariable('${OVERRIDE_NAME}', $null, 'User')
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -ne $key) {
  try { $key.DeleteValue('${OVERRIDE_NAME}', $false) } finally { $key.Dispose() }
}
`
        : `[Environment]::SetEnvironmentVariable('${OVERRIDE_NAME}', $env:CODEX_WEBGPT_OVERRIDE_VALUE, 'User')`,
      value === undefined ? {} : { CODEX_WEBGPT_OVERRIDE_VALUE: value },
    );
  }
}

export function codexDesktopProxyJournalPath(home = getConfigDir()): string {
  return join(home, "codex", "desktop-proxy-journal.json");
}

export function stableCodexDesktopProxyPath(home = getConfigDir()): string {
  return join(home, "bin", "codex-webgpt-proxy.exe");
}

export function bundledCodexDesktopProxyPath(entrypoint = process.argv[1]): string {
  if (!entrypoint || !isAbsolute(entrypoint)) {
    throw new Error("The WebGPT runtime entrypoint is not an absolute installed path");
  }
  return join(dirname(dirname(realpathSync(entrypoint))), "bin", "codex-webgpt-proxy.exe");
}

function readJournal(path: string): CodexDesktopProxyJournal | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexDesktopProxyJournal>;
  if (parsed.version !== JOURNAL_VERSION
    || typeof parsed.stableProxyPath !== "string" || !isAbsolute(parsed.stableProxyPath)
    || typeof parsed.proxySha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.proxySha256)
    || typeof parsed.installedAt !== "string"
    || !parsed.previous || typeof parsed.previous.exists !== "boolean"
    || (parsed.previous.exists && typeof parsed.previous.value !== "string")) {
    throw new Error(`Codex Desktop proxy journal is invalid: ${path}`);
  }
  return parsed as CodexDesktopProxyJournal;
}

function validateProxySource(path: string): Uint8Array {
  const requested = resolve(path);
  if (lstatSync(requested).isSymbolicLink()) throw new Error(`Proxy source is a symbolic link: ${requested}`);
  const canonical = realpathSync(requested);
  if (!statSync(canonical).isFile()) throw new Error(`Proxy source is not a regular file: ${canonical}`);
  return readFileSync(canonical);
}

export function proxyVersionSmoke(path: string): boolean {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, CODEX_CLI_PATH: undefined, CODEX_WEBGPT_REAL_CODEX: undefined },
  });
  return !result.error && result.status === 0 && /^codex-cli\s+\S+\s*$/.test(result.stdout);
}

export function inspectCodexDesktopProxy(options: {
  home?: string;
  environment?: UserEnvironmentStore;
  versionSmoke?: (path: string) => boolean;
} = {}): CodexDesktopProxyStatus {
  const home = resolve(options.home ?? getConfigDir());
  const stableProxyPath = stableCodexDesktopProxyPath(home);
  const environment = options.environment ?? new WindowsUserCodexCliEnvironment();
  const errors: string[] = [];
  let currentOverride: UserEnvironmentValue = { exists: false };
  let journal: CodexDesktopProxyJournal | undefined;
  let stableProxySha256: string | undefined;
  let versionSmokeOk = false;
  try { currentOverride = environment.read(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  try { journal = readJournal(codexDesktopProxyJournalPath(home)); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const stableProxyExists = existsSync(stableProxyPath);
  if (stableProxyExists) {
    try {
      stableProxySha256 = sha256(validateProxySource(stableProxyPath));
      versionSmokeOk = (options.versionSmoke ?? proxyVersionSmoke)(stableProxyPath);
      if (!versionSmokeOk) errors.push("Stable Codex Desktop proxy failed its original-CLI version smoke");
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (journal && !samePath(journal.stableProxyPath, stableProxyPath)) errors.push("Desktop proxy journal targets a different stable path");
  if (journal && stableProxySha256 && journal.proxySha256 !== stableProxySha256) errors.push("Stable proxy hash differs from the integration journal");
  const activeOverride = currentOverride.exists
    && typeof currentOverride.value === "string"
    && samePath(currentOverride.value, stableProxyPath);
  return {
    platformSupported: process.platform === "win32",
    installed: Boolean(journal && stableProxyExists && stableProxySha256 === journal.proxySha256),
    activeOverride,
    stableProxyPath,
    stableProxyExists,
    ...(stableProxySha256 ? { stableProxySha256 } : {}),
    currentOverride,
    ...(journal ? { journal } : {}),
    versionSmokeOk,
    errors,
  };
}

export function installCodexDesktopProxy(options: {
  home?: string;
  sourceProxyPath?: string;
  environment?: UserEnvironmentStore;
  versionSmoke?: (path: string) => boolean;
  now?: () => Date;
} = {}): CodexDesktopProxyStatus {
  if (process.platform !== "win32") throw new Error("Codex Desktop proxy activation is supported only on Windows");
  const home = resolve(options.home ?? getConfigDir());
  const stableProxyPath = stableCodexDesktopProxyPath(home);
  const journalPath = codexDesktopProxyJournalPath(home);
  const sourcePath = options.sourceProxyPath ?? bundledCodexDesktopProxyPath();
  const environment = options.environment ?? new WindowsUserCodexCliEnvironment();
  const versionSmoke = options.versionSmoke ?? proxyVersionSmoke;
  const source = validateProxySource(sourcePath);
  const existingJournal = readJournal(journalPath);
  const current = environment.read();
  if (existingJournal && !samePath(existingJournal.stableProxyPath, stableProxyPath)) {
    throw new Error("Existing Desktop proxy journal belongs to a different stable path");
  }
  if (current.exists && (!current.value || !samePath(current.value, stableProxyPath))) {
    throw new Error(`Refusing to overwrite an unrelated user ${OVERRIDE_NAME} value`);
  }
  const previous = existingJournal?.previous ?? current;
  atomicWriteFile(stableProxyPath, source, { mode: 0o700 });
  if (!versionSmoke(stableProxyPath)) {
    throw new Error("Installed stable Codex Desktop proxy failed its original-CLI version smoke");
  }
  const journal: CodexDesktopProxyJournal = {
    version: JOURNAL_VERSION,
    stableProxyPath,
    proxySha256: sha256(source),
    previous,
    installedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  let changedEnvironment = false;
  try {
    if (!current.exists || !current.value || !samePath(current.value, stableProxyPath)) {
      environment.write(stableProxyPath);
      changedEnvironment = true;
    }
    atomicWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  } catch (error) {
    if (changedEnvironment) {
      try { environment.write(current.exists ? current.value : undefined); } catch {}
    }
    throw error;
  }
  const status = inspectCodexDesktopProxy({ home, environment, versionSmoke });
  if (!status.installed || !status.activeOverride || status.errors.length > 0) {
    throw new Error(`Codex Desktop proxy activation did not verify: ${status.errors.join("; ") || "unknown mismatch"}`);
  }
  return status;
}

export function uninstallCodexDesktopProxy(options: {
  home?: string;
  environment?: UserEnvironmentStore;
} = {}): { changed: boolean; preservedExternalOverride: boolean } {
  const home = resolve(options.home ?? getConfigDir());
  const environment = options.environment ?? new WindowsUserCodexCliEnvironment();
  const journalPath = codexDesktopProxyJournalPath(home);
  const journal = readJournal(journalPath);
  if (!journal) return { changed: false, preservedExternalOverride: false };
  const current = environment.read();
  if (!current.exists || !current.value || !samePath(current.value, journal.stableProxyPath)) {
    return { changed: false, preservedExternalOverride: true };
  }
  environment.write(journal.previous.exists ? journal.previous.value : undefined);
  rmSync(journalPath, { force: true });
  try { rmSync(journal.stableProxyPath, { force: true }); } catch {}
  return { changed: true, preservedExternalOverride: false };
}
