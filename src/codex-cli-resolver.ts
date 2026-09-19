import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CodexCliCandidate {
  path: string;
  modifiedMs: number;
}

export interface CodexCliResolverOptions {
  explicitPath?: string;
  localAppData?: string;
  managedRoot?: string;
  selfPath?: string;
  validateVersion?: (candidate: string) => boolean;
}

const REQUIRED_MANAGED_CODEX_SIBLINGS = [
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
] as const;

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== ""
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

function canonicalRegularFile(path: string): string {
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error(`Codex CLI candidate is a symbolic link or junction: ${path}`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) throw new Error(`Codex CLI candidate is not a regular file: ${path}`);
  return canonical;
}

function hasRequiredManagedSiblings(versionDirectory: string): boolean {
  for (const name of REQUIRED_MANAGED_CODEX_SIBLINGS) {
    try {
      const sibling = canonicalRegularFile(join(versionDirectory, name));
      if (dirname(sibling) !== versionDirectory || basename(sibling).toLowerCase() !== name) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function defaultManagedCodexBinRoot(localAppData = process.env.LOCALAPPDATA): string {
  const root = localAppData?.trim();
  if (!root || !isAbsolute(root)) throw new Error("LOCALAPPDATA is missing or is not absolute");
  return join(resolve(root), "OpenAI", "Codex", "bin");
}

export function discoverManagedCodexCliCandidates(
  managedRoot: string,
  selfPath = process.execPath,
): CodexCliCandidate[] {
  const requestedRoot = resolve(managedRoot);
  const rootLink = lstatSync(requestedRoot);
  if (rootLink.isSymbolicLink()) throw new Error(`Managed Codex binary root is a symbolic link or junction: ${requestedRoot}`);
  const canonicalRoot = realpathSync(requestedRoot);
  if (!statSync(canonicalRoot).isDirectory()) throw new Error(`Managed Codex binary root is not a directory: ${requestedRoot}`);
  const canonicalSelf = realpathSync(resolve(selfPath));
  const candidates: CodexCliCandidate[] = [];

  for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const versionDirectory = join(canonicalRoot, entry.name);
    const versionLink = lstatSync(versionDirectory);
    if (versionLink.isSymbolicLink()) continue;
    const canonicalVersion = realpathSync(versionDirectory);
    if (dirname(canonicalVersion) !== canonicalRoot) continue;
    if (!hasRequiredManagedSiblings(canonicalVersion)) continue;
    const requestedCandidate = join(canonicalVersion, "codex.exe");
    let canonicalCandidate: string;
    try {
      canonicalCandidate = canonicalRegularFile(requestedCandidate);
    } catch {
      continue;
    }
    if (!isInside(canonicalRoot, canonicalCandidate)
      || dirname(canonicalCandidate) !== canonicalVersion
      || basename(canonicalCandidate).toLowerCase() !== "codex.exe"
      || samePath(canonicalCandidate, canonicalSelf)) {
      continue;
    }
    const metadata = statSync(canonicalCandidate);
    candidates.push({ path: canonicalCandidate, modifiedMs: Math.max(metadata.mtimeMs, statSync(canonicalVersion).mtimeMs) });
  }

  return candidates.sort((left, right) => right.modifiedMs - left.modifiedMs
    || left.path.localeCompare(right.path, "en", { sensitivity: "base" }));
}

export function codexCliVersionIsValid(candidate: string): boolean {
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: { ...process.env, CODEX_CLI_PATH: undefined },
  });
  return !result.error && result.status === 0 && /^codex-cli\s+\S+\s*$/.test(result.stdout);
}

export function resolveOriginalCodexCli(options: CodexCliResolverOptions = {}): string {
  const self = realpathSync(resolve(options.selfPath ?? process.execPath));
  const validate = options.validateVersion ?? codexCliVersionIsValid;
  const explicit = options.explicitPath?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error("CODEX_WEBGPT_REAL_CODEX must be an absolute path");
    const candidate = canonicalRegularFile(resolve(explicit));
    if (samePath(candidate, self)) throw new Error("Original Codex executable resolves to the WebGPT proxy itself");
    if (!validate(candidate)) throw new Error(`Original Codex executable failed version validation: ${candidate}`);
    return candidate;
  }

  const managedRoot = options.managedRoot ?? defaultManagedCodexBinRoot(options.localAppData);
  const candidates = discoverManagedCodexCliCandidates(managedRoot, self);
  for (const candidate of candidates) {
    if (validate(candidate.path)) return candidate.path;
  }
  throw new Error(`No validated original Codex CLI was found under the managed root: ${resolve(managedRoot)}`);
}
