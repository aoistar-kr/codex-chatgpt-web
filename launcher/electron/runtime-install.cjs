const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { renameAtomicFile } = require("./atomic-file.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");

const DEFAULT_SOURCE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_SOURCE_WAIT_INTERVAL_MS = 50;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIME_INSTALL_WORKER_PATH = path.join(__dirname, "runtime-install-worker.cjs");
const RUNTIME_VERIFY_CONCURRENCY = 16;

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bundleIdFor(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function validateManifestPath(relativePath) {
  if (typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath === "manifest.json"
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Runtime manifest contains an unsafe file path: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

function readRuntimeManifest(runtimeRoot, { version, platform, arch, bundleId }) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Runtime manifest is invalid: ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedLauncher = `bin/${platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`;
  if (manifest?.schemaVersion !== 2
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch
    || manifest.launcher !== expectedLauncher
    || manifest.entrypoint !== "app/cli.js"
    || typeof manifest.bunVersion !== "string"
    || typeof manifest.playwright !== "string"
    || !SHA256_PATTERN.test(manifest.bundleId)
    || (bundleId && manifest.bundleId !== bundleId)
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0) {
    const received = manifest && typeof manifest === "object" ? {
      schemaVersion: manifest.schemaVersion,
      appVersion: manifest.appVersion,
      bundleId: manifest.bundleId,
      bunVersion: manifest.bunVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      launcher: manifest.launcher,
      entrypoint: manifest.entrypoint,
      playwright: manifest.playwright,
      fileCount: Array.isArray(manifest.files) ? manifest.files.length : null,
    } : manifest;
    throw new Error(
      `Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}, received ${JSON.stringify(received)}`,
    );
  }

  let previousPath = null;
  const files = manifest.files.map((file, index) => {
    if (!file || typeof file !== "object"
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Runtime manifest contains an invalid file record at index ${index}`);
    }
    const relativePath = validateManifestPath(file.path);
    if (previousPath !== null && comparePaths(previousPath, relativePath) >= 0) {
      throw new Error(`Runtime manifest file paths are not unique and sorted: ${relativePath}`);
    }
    previousPath = relativePath;
    return { path: relativePath, size: file.size, sha256: file.sha256 };
  });
  if (bundleIdFor(files) !== manifest.bundleId) {
    throw new Error(`Runtime manifest bundleId does not match its file records: ${manifestPath}`);
  }
  return { ...manifest, files };
}

function runtimeFilePaths(runtimeRoot) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(runtimeRoot, absolutePath).split(path.sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      paths.push(relativePath);
    }
  };
  visit(runtimeRoot);
  return paths.sort(comparePaths);
}

function validateRuntimeFile(runtimeRoot, canonicalRoot, file) {
  const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
  let metadata;
  try {
    metadata = fs.statSync(absolutePath);
  } catch {
    throw new Error(`Runtime bundle file is missing: ${absolutePath}`);
  }
  if (!metadata.isFile()) throw new Error(`Runtime bundle entry is not a file: ${absolutePath}`);
  if (fs.lstatSync(absolutePath).isSymbolicLink()) {
    const target = fs.realpathSync(absolutePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`Runtime bundle symlink escapes the bundle: ${absolutePath}`);
    }
  }
  if (metadata.size !== file.size) {
    throw new Error(`Runtime bundle file size mismatch: ${absolutePath}`);
  }
  const sha256 = createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  if (sha256 !== file.sha256) {
    throw new Error(`Runtime bundle file checksum mismatch: ${absolutePath}`);
  }
}

async function validateRuntimeFileConcurrent(runtimeRoot, canonicalRoot, file) {
  const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
  let metadata;
  try {
    metadata = await fs.promises.stat(absolutePath);
  } catch {
    throw new Error(`Runtime bundle file is missing: ${absolutePath}`);
  }
  if (!metadata.isFile()) throw new Error(`Runtime bundle entry is not a file: ${absolutePath}`);
  const linkMetadata = await fs.promises.lstat(absolutePath);
  if (linkMetadata.isSymbolicLink()) {
    const target = await fs.promises.realpath(absolutePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`Runtime bundle symlink escapes the bundle: ${absolutePath}`);
    }
  }
  if (metadata.size !== file.size) {
    throw new Error(`Runtime bundle file size mismatch: ${absolutePath}`);
  }
  const sha256 = createHash("sha256").update(await fs.promises.readFile(absolutePath)).digest("hex");
  if (sha256 !== file.sha256) {
    throw new Error(`Runtime bundle file checksum mismatch: ${absolutePath}`);
  }
}

function runtimeBundleValidationContext(runtimeRoot, identity) {
  const manifest = readRuntimeManifest(runtimeRoot, identity);
  const expectedPaths = manifest.files.map(file => file.path);
  const expectedSet = new Set(expectedPaths);
  const paths = runtimeBundlePaths(runtimeRoot, identity.platform);
  for (const required of [
    paths.executable,
    paths.entrypoint,
    path.join(runtimeRoot, "app", "browser-helper.cjs"),
    path.join(runtimeRoot, ...manifest.launcher.split("/")),
  ]) {
    const relativePath = path.relative(runtimeRoot, required).split(path.sep).join("/");
    if (!expectedSet.has(relativePath)) {
      throw new Error(`Runtime manifest does not declare required file: ${required}`);
    }
  }

  const actualPaths = runtimeFilePaths(runtimeRoot);
  const actualSet = new Set(actualPaths);
  const missing = expectedPaths.find(relativePath => !actualSet.has(relativePath));
  if (missing) throw new Error(`Runtime bundle file is missing: ${path.join(runtimeRoot, ...missing.split("/"))}`);
  const unexpected = actualPaths.find(relativePath => !expectedSet.has(relativePath));
  if (unexpected) {
    throw new Error(`Runtime bundle contains an unmanifested file: ${path.join(runtimeRoot, ...unexpected.split("/"))}`);
  }
  if (actualPaths.length !== expectedPaths.length) {
    throw new Error(`Runtime bundle file count mismatch: expected ${expectedPaths.length}, received ${actualPaths.length}`);
  }

  return {
    manifest,
    paths,
    canonicalRoot: fs.realpathSync(runtimeRoot),
  };
}

function inspectRuntimeBundle(runtimeRoot, identity) {
  const { manifest, paths, canonicalRoot } = runtimeBundleValidationContext(runtimeRoot, identity);
  for (const file of manifest.files) validateRuntimeFile(runtimeRoot, canonicalRoot, file);
  if (identity.platform !== "win32" && (fs.statSync(paths.executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }
  return { manifest, runtimeRoot: paths.runtimeRoot };
}

async function inspectRuntimeBundleConcurrent(runtimeRoot, identity) {
  const { manifest, paths, canonicalRoot } = runtimeBundleValidationContext(runtimeRoot, identity);
  let nextIndex = 0;
  let firstError;
  const workerCount = Math.min(RUNTIME_VERIFY_CONCURRENCY, manifest.files.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (firstError) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= manifest.files.length) return;
      try {
        await validateRuntimeFileConcurrent(runtimeRoot, canonicalRoot, manifest.files[index]);
      } catch (error) {
        firstError ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  if (identity.platform !== "win32" && (fs.statSync(paths.executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }
  return { manifest, runtimeRoot: paths.runtimeRoot };
}

function validateRuntimeBundle(runtimeRoot, identity) {
  return inspectRuntimeBundle(runtimeRoot, identity).runtimeRoot;
}

async function validateRuntimeBundleConcurrent(runtimeRoot, identity) {
  return (await inspectRuntimeBundleConcurrent(runtimeRoot, identity)).runtimeRoot;
}

function runRuntimeInstallWorker(action, payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(RUNTIME_INSTALL_WORKER_PATH, {
      workerData: { action, payload },
    });
    let settled = false;
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    worker.once("message", finish((message) => {
      if (message?.ok === true) {
        resolve(message.result);
        return;
      }
      reject(new Error(typeof message?.message === "string" ? message.message : "Runtime verification worker failed"));
    }));
    worker.once("error", finish(reject));
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Runtime verification worker exited before returning a result (code=${code})`));
    });
  });
}

/**
 * Healthy packaged startups execute only from the durable runtime. Verify that exact runtime
 * against the packaged manifest before use, but defer the expensive source-tree content walk until
 * the source is actually needed for a repair. This keeps every executed runtime file behind the
 * same full SHA-256 validation while avoiding a second 5k+ file walk on ordinary launches.
 *
 * If the durable runtime is missing/corrupt, the source is fully verified before the existing
 * bounded/transactional repair path is allowed to consume it. Manifest parsing remains eager so a
 * package identity mismatch still fails closed before any durable runtime is accepted.
 */
async function preparePackagedRuntimeConcurrent({
  app,
  coreHome,
  resourcesPath,
  timeoutMs = DEFAULT_SOURCE_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_SOURCE_WAIT_INTERVAL_MS,
}) {
  if (!app.isPackaged) return null;
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const source = path.join(resourcesPath, "runtime");

  let manifest;
  try {
    // This validates the manifest structure and its bundle-id derivation only. File contents are
    // still verified below by the source worker before any durable runtime is accepted.
    manifest = readRuntimeManifest(source, identity);
  } catch {
    return runRuntimeInstallWorker("prepare", {
      coreHome,
      resourcesPath,
      identity,
      timeoutMs,
      intervalMs,
    });
  }

  const expectedIdentity = { ...identity, bundleId: manifest.bundleId };
  const sourceBrowserHelper = manifest.files.find(file => file.path === "app/browser-helper.cjs");
  if (!sourceBrowserHelper) {
    throw new Error(`Runtime manifest does not declare required file: ${path.join(source, "app", "browser-helper.cjs")}`);
  }
  // The packaged Electron host launches browser-helper.cjs directly from resources/runtime even
  // when the CLI/runtime itself comes from the durable copy. Keep that one source-side executable
  // script behind a full checksum on every startup; the rest of the source tree is repair material
  // and can be validated lazily if the durable runtime ever needs replacement.
  validateRuntimeFile(source, fs.realpathSync(source), sourceBrowserHelper);
  const destination = path.join(
    coreHome,
    "versions",
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );
  if (fs.existsSync(destination)) {
    try {
      return await runRuntimeInstallWorker("validate", {
        runtimeRoot: destination,
        identity: expectedIdentity,
      });
    } catch {
      // A damaged durable copy must never be executed. Fall through to source verification and the
      // existing transactional repair path below.
    }
  }

  try {
    await runRuntimeInstallWorker("validate", {
      runtimeRoot: source,
      identity: expectedIdentity,
    });
  } catch {
    // Preserve the historical bounded source-materialization retry semantics. A genuinely corrupt
    // source still fails closed after that bound; a package that is only finishing extraction can
    // become valid without forcing a launcher restart.
    return runRuntimeInstallWorker("prepare", {
      coreHome,
      resourcesPath,
      identity,
      timeoutMs,
      intervalMs,
    });
  }

  // The source has passed a full content verification because it is now needed as repair material.
  // Reuse the existing transactional repair path; it intentionally revalidates its inputs rather
  // than weakening exceptional repair semantics for the sake of a rare startup.
  return runRuntimeInstallWorker("ensure", {
    coreHome,
    resourcesPath,
    identity,
  });
}

async function waitForPackagedRuntimeSourceBundle({
  app,
  resourcesPath,
  timeoutMs = DEFAULT_SOURCE_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_SOURCE_WAIT_INTERVAL_MS,
}) {
  if (!app.isPackaged) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Packaged runtime source wait requires non-negative timeoutMs and positive intervalMs");
  }
  const source = path.join(resourcesPath, "runtime");
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      return { source, identity, sourceBundle: inspectRuntimeBundle(source, identity) };
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Packaged runtime did not fully materialize within ${timeoutMs}ms: ${detail}`);
}

async function waitForPackagedRuntimeSource(options) {
  const prepared = await waitForPackagedRuntimeSourceBundle(options);
  return prepared?.sourceBundle.runtimeRoot ?? null;
}

function installPackagedRuntimeFromValidatedSource({ coreHome, source, identity, sourceBundle }) {
  const expectedIdentity = { ...identity, bundleId: sourceBundle.manifest.bundleId };
  const versionsRoot = path.join(coreHome, "versions");
  const destination = path.join(
    versionsRoot,
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );
  if (fs.existsSync(destination)) {
    try {
      return validateRuntimeBundle(destination, expectedIdentity);
    } catch {
      // A terminated installer or external cleanup can leave a version directory present but
      // incomplete. Rebuild the launcher-owned bundle transactionally from the signed package.
    }
  }

  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  try {
    fs.cpSync(source, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    validateRuntimeBundle(temporary, expectedIdentity);
    if (fs.existsSync(destination)) {
      renameAtomicFile(destination, previous);
      previousMoved = true;
    }
    try {
      renameAtomicFile(temporary, destination);
      validateRuntimeBundle(destination, expectedIdentity);
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      if (previousMoved) {
        try {
          renameAtomicFile(previous, destination);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(
            `Runtime replacement failed: ${error instanceof Error ? error.message : String(error)}`
            + `; previous runtime restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
      }
      throw error;
    }
    if (previousMoved) {
      previousMoved = false;
      try {
        fs.rmSync(previous, { recursive: true, force: true });
      } catch {
        // The validated replacement is authoritative now. A locked old runtime is cleanup residue,
        // not a failed installation; retry cleanup on a later successful startup.
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (previousMoved && fs.existsSync(previous) && !fs.existsSync(destination)) {
      renameAtomicFile(previous, destination);
      previousMoved = false;
    }
  }
  try { fs.chmodSync(destination, 0o700); } catch {}
  return validateRuntimeBundle(destination, expectedIdentity);
}

function ensurePackagedRuntime({ app, coreHome, resourcesPath }) {
  if (!app.isPackaged) return null;
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const source = path.join(resourcesPath, "runtime");
  const sourceBundle = inspectRuntimeBundle(source, identity);
  return installPackagedRuntimeFromValidatedSource({ coreHome, source, identity, sourceBundle });
}

async function preparePackagedRuntime({
  app,
  coreHome,
  resourcesPath,
  timeoutMs = DEFAULT_SOURCE_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_SOURCE_WAIT_INTERVAL_MS,
}) {
  if (!app.isPackaged) return null;
  const prepared = await waitForPackagedRuntimeSourceBundle({
    app,
    resourcesPath,
    timeoutMs,
    intervalMs,
  });
  return installPackagedRuntimeFromValidatedSource({ coreHome, ...prepared });
}

module.exports = {
  ensurePackagedRuntime,
  preparePackagedRuntime,
  preparePackagedRuntimeConcurrent,
  validateRuntimeBundle,
  validateRuntimeBundleConcurrent,
  waitForPackagedRuntimeSource,
};
