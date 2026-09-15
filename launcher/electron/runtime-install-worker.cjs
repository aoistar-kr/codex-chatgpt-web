const { parentPort, workerData } = require("node:worker_threads");
const {
  ensurePackagedRuntime,
  preparePackagedRuntime,
  validateRuntimeBundleConcurrent,
} = require("./runtime-install.cjs");

function workerApp(identity) {
  return {
    isPackaged: true,
    getVersion: () => identity.version,
  };
}

async function run() {
  const action = workerData?.action;
  const payload = workerData?.payload;
  if (!payload || typeof payload !== "object") throw new Error("Runtime verification worker payload is invalid");
  if (action === "validate") {
    return validateRuntimeBundleConcurrent(payload.runtimeRoot, payload.identity);
  }
  if (action === "ensure") {
    return ensurePackagedRuntime({
      app: workerApp(payload.identity),
      coreHome: payload.coreHome,
      resourcesPath: payload.resourcesPath,
    });
  }
  if (action === "prepare") {
    return preparePackagedRuntime({
      app: workerApp(payload.identity),
      coreHome: payload.coreHome,
      resourcesPath: payload.resourcesPath,
      timeoutMs: payload.timeoutMs,
      intervalMs: payload.intervalMs,
    });
  }
  throw new Error(`Unknown runtime verification worker action: ${String(action)}`);
}

void run().then(
  result => parentPort.postMessage({ ok: true, result }),
  error => parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }),
);
