export function chatGptNetworkStreamShadowEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CODEX_CHATGPT_WEB_NETWORK_STREAM_SHADOW !== "0";
}

export function chatGptNetworkStreamPrimaryEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  // Production default is ON for every selectable Sol/Pro effort inside the TurnPlan boundary.
  // Luna-checkpoint turns still stay on DOM/shadow authority. Keep an explicit kill switch for rollback.
  return env.CODEX_CHATGPT_WEB_NETWORK_STREAM_PRIMARY !== "0";
}

export function chatGptStreamProtocolDiagnosticsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CODEX_CHATGPT_WEB_STREAM_PROTOCOL_DIAGNOSTICS === "1";
}

export function chatGptIncompleteCaptureRecoveryEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  // Production default is ON after the H5 same-buffer recovery path passed strict Plus/High live
  // fault-injection and no-duplicate submission gates. Keep an explicit kill switch for rollback.
  return env.CODEX_CHATGPT_WEB_INCOMPLETE_CAPTURE_RECOVERY !== "0";
}

export function chatGptRecoveryProofDiagnosticsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CODEX_CHATGPT_WEB_RECOVERY_PROOF_DIAGNOSTICS === "1";
}

export function chatGptCompletedRebindDiagnosticsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CODEX_CHATGPT_WEB_COMPLETED_REBIND_DIAGNOSTICS === "1";
}

export function chatGptRequestInjectionShadowEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CODEX_CHATGPT_WEB_REQUEST_INJECTION_SHADOW === "1";
}

export function chatGptRequestInjectionPrimaryEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  // Production default is ON only where TurnPlan already permits the proven one-use page-fetch
  // writer. Multipart, files, local tools, retained conversations, and compaction remain on the
  // existing DOM path. Keep an explicit kill switch for rollback.
  return env.CODEX_CHATGPT_WEB_REQUEST_INJECTION_PRIMARY !== "0";
}

export function chatGptRequestInjectionCdpShadowEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CODEX_CHATGPT_WEB_REQUEST_INJECTION_CDP_SHADOW === "1";
}

export function chatGptRequestInjectionCdpPrimaryEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CODEX_CHATGPT_WEB_REQUEST_INJECTION_CDP_PRIMARY === "1";
}
