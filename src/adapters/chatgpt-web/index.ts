import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import { releaseLauncherRetainedConversation } from "../../launcher-browser-host";
import { getCodexHome } from "../../codex-integration-shared";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexOutputTextAnnotation, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage, type CodexUserMessage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptSteeringUnavailableError, ChatGptTurnInterruptedError, ChatGptWebAdapterError, chatGptBrowserTabClosedError, chatGptTurnSupersededError } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";
import { chatGptRawEnvironmentContextIdentity, chatGptTurnUserRevisionHistory, extractChatGptRootThreadMetadata, extractChatGptThreadSpawnLineage, extractChatGptTurnEnvironment, extractChatGptTurnIdentity, hasRawChatGptEnvironmentContext } from "./environment";
import { createCodexRolloutControlTail, type CodexTurnControlEvent } from "./codex-rollout-control";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptCompactionSourceExecutionKey, chatGptInstructionLineage, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnRoundKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import {
  CHATGPT_TOOL_BOUNDARY_OBSERVATION_TIMEOUT_MS,
  ChatGptExternalTurnProgress,
} from "./turn-progress";
import {
  canonicalizeCompactionHandoff,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
} from "./compaction-handoff";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "./conversation-key";

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ChatGptWebAdapterError) return signal.reason;
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function emitToolLoopMetric(
  session: ChatGptTurnSession,
  event: string,
  values: Record<string, number | string | undefined>,
): void {
  console.info(`[chatgpt-web-tool-loop] ${JSON.stringify({
    version: 1,
    traceId: session.traceId ?? "unknown",
    event,
    ...values,
  })}`);
}

function cancellableBrowserTurn(
  run: Promise<string>,
  controller: AbortController,
): { browser: Promise<string>; physicalSettlement: Promise<void>; cancel: (reason?: Error) => void } {
  let rejectBrowser!: (error: Error) => void;
  let browserSettled = false;
  const browser = new Promise<string>((resolve, reject) => {
    rejectBrowser = reject;
    run.then(
      answer => {
        if (browserSettled) return;
        browserSettled = true;
        resolve(answer);
      },
      error => {
        if (browserSettled) return;
        browserSettled = true;
        reject(error);
      },
    );
  });
  return {
    // Cancellation wins immediately even while the detached Playwright helper is still unwinding.
    // The helper keeps the same abort signal and remains responsible for its normal end/cleanup
    // handshake, but the Codex Responses turn no longer waits on that process cleanup.
    browser,
    // `browser` is the fast client-facing result. Replacement ownership must wait for the actual
    // worker promise, whose finally block completes the launcher /turn/end handshake.
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      // Explicit targeted cancellation ends the Codex Responses turn immediately. Generic
      // retirement (client disconnect or compaction replacement) still waits for the helper's
      // cleanup handshake before a replacement browser may start.
      if (reason && !browserSettled) {
        browserSettled = true;
        rejectBrowser(reason);
      }
    },
  };
}

export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  return createHash("sha256")
    .update(`${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(parsed)}`)
    .digest("hex")
    .slice(0, 12);
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(
  outcome: ChatGptBrowserOutcome,
  usage: CodexUsage,
  emit: (event: AdapterEvent) => void,
  annotations: readonly CodexOutputTextAnnotation[] = [],
): void {
  if (outcome.type === "error") throw outcome.error;
  emit({
    type: "done",
    stopReason: "stop",
    endTurn: true,
    usage,
    ...(annotations.length > 0 ? { annotations: annotations.map(annotation => ({ ...annotation })) } : {}),
  });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const phase = session.runtime.submission?.phase;
  if (!phase || phase === "prepared") return normalized;
  // A deterministic non-retryable adapter error is already safe to replay from this session.
  // A *retryable* error is different once Send activation has crossed the ambiguity boundary:
  // forwarding retryable=true would retire this exact browser session and authorize the next
  // canonical request to open a fresh surface and submit the prompt again. Normalize every such
  // post-activation failure into the existing no-resend terminal contract instead.
  if (normalized instanceof ChatGptWebAdapterError && !normalized.retryable) return normalized;
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? `ChatGPT Send was activated, but acceptance could not be proven; the prompt will not be resent: ${normalized.message}`
      : `ChatGPT failed after accepting the Web prompt; the prompt will not be resent: ${normalized.message}`,
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
    },
  );
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function steeringRevisionContent(value: unknown): string | CodexContentPart[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error("ChatGPT steering revision has unsupported user content");
  const parts: CodexContentPart[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("ChatGPT steering revision contains an invalid content block");
    }
    const block = candidate as Record<string, unknown>;
    if ((block.type === "input_text" || block.type === "text") && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "input_image" && typeof block.image_url === "string" && block.image_url) {
      parts.push({
        type: "image",
        imageUrl: block.image_url,
        ...(typeof block.detail === "string" ? { detail: block.detail } : {}),
      });
      continue;
    }
    if (block.type === "input_file") {
      const ref = typeof block.file_id === "string"
        ? block.file_id
        : typeof block.filename === "string" ? block.filename : "?";
      parts.push({ type: "text", text: `[file: ${ref}]` });
      continue;
    }
    throw new Error(`ChatGPT steering revision contains unsupported content type: ${String(block.type)}`);
  }
  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text;
  return parts;
}

function appendAuthenticatedSteeringRevision(
  parsed: CodexParsedRequest,
  revision: Extract<CodexTurnControlEvent, { type: "steer" }>,
  turnId: string,
): CodexParsedRequest {
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Array.isArray((body as { input?: unknown }).input)) {
    throw new Error("ChatGPT rollout steering requires the complete native Codex input history");
  }
  const user: CodexUserMessage = {
    role: "user",
    content: steeringRevisionContent(revision.content),
    timestamp: Date.now(),
  };
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: [...parsed.context.messages, user],
    },
    _rawBody: {
      ...(body as Record<string, unknown>),
      input: [
        ...(body as { input: unknown[] }).input,
        {
          type: "message",
          id: revision.itemId,
          role: "user",
          content: revision.content,
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    },
  };
}

/**
 * Build the suffix submitted only when the launcher proves it reused the superseded Temporary Chat.
 * The original prompt/system history is already present in that conversation and must not be
 * replayed. Matching outer tool results are retained as fresh evidence before the newest user
 * revision so stop-and-steer keeps the canonical Codex ordering.
 */
function retainedSteeringResumeRequest(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
): CodexParsedRequest {
  const revision = chatGptTurnUserRevisionHistory(parsed).at(-1);
  if (!revision) throw new Error("ChatGPT steering requires a latest canonical user revision");
  const user: CodexUserMessage = {
    role: "user",
    content: steeringRevisionContent(revision.content),
    timestamp: Date.now(),
  };
  const results = currentToolResults(parsed, source);
  return {
    ...parsed,
    context: {
      ...parsed.context,
      systemPrompt: [],
      messages: [...results, user],
    },
  };
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: { broker?: TurnBrokerOwner } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
    ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
    : undefined;
  const environmentStore = new ChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const lunaCheckpointStore = new ChatGptLunaCheckpointStore(
    provider.chatgptWeb?.lunaCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
      : undefined,
  );
  const currentUsageInput = (parsed: CodexParsedRequest): CodexParsedRequest => (
    parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID && !parsed._compactionRequest
      ? lunaCheckpointStore.apply(parsed).parsed
      : parsed
  );

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    steeringSource?: ChatGptTurnSession,
  ): ChatGptTurnRuntime => {
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const checkpointInput = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const conversationKey = !parsed._compactionRequest
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && retainedLauncherDescriptor
      ? chatGptConversationKey(checkpointInput.parsed, executionNamespace)
      : undefined;
    const steeringResumeInput = steeringSource && conversationKey
      ? retainedSteeringResumeRequest(checkpointInput.parsed, steeringSource)
      : undefined;
    const resumeInput = steeringResumeInput ?? (conversationKey && mode.localTools
      ? retainedConversationResumeRequest(checkpointInput.parsed)
      : undefined);
    const retainConversation = conversationKey !== undefined && mode.localTools;
    const releaseRetainedConversation = conversationKey && mode.localTools && retainedLauncherDescriptor
      ? async () => {
        await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
      }
      : undefined;
    const compileOptionsFor = (input: CodexParsedRequest, retainedSteering = false) => {
      const experimentalMultipartParts = experimentalBiggerContext
        ? resolveBiggerContextMultipartParts(input, turnCapabilities)
        : undefined;
      return {
        captureLunaCheckpoint,
        ...(retainedSteering ? { retainedContinuation: "steering" as const } : {}),
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
      };
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      return answer;
    });
    const browserAbort = new AbortController();
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    let outputAnnotations: CodexOutputTextAnnotation[] = [];
    const captureOutputAnnotations = (annotations: readonly CodexOutputTextAnnotation[]): void => {
      outputAnnotations = annotations.map(annotation => ({ ...annotation }));
    };
    const readOutputAnnotations = (): readonly CodexOutputTextAnnotation[] =>
      outputAnnotations.map(annotation => ({ ...annotation }));
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    // A canonical compaction request is side-effect free and remains safe to rebuild after an
    // ambiguous browser send. Normal task prompts must never be replayed after Send activation.
    const submissionLifecycle = parsed._compactionRequest ? {} : {
      onSendActivated: () => { submission.phase = "send_activated" as const; },
      onSubmitted: () => { submission.phase = "accepted" as const; },
    };
    if (!mode.localTools) {
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            compileOptionsFor(checkpointInput.parsed),
          ),
          release: () => {},
        }),
        ...(steeringResumeInput ? {
          prepareResume: async () => ({
            ...compileChatGptWebPrompt(
              steeringResumeInput,
              turnCapabilities,
              undefined,
              compileOptionsFor(steeringResumeInput, true),
            ),
            release: () => {},
          }),
        } : {}),
        ...(conversationKey ? { conversationKey } : {}),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        onOutputAnnotations: captureOutputAnnotations,
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        outputAnnotations: readOutputAnnotations,
        usageInput: checkpointInput.parsed,
        ...(conversationKey ? { conversationKey } : {}),
        submission,
        cancel: browserTurn.cancel,
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    // A cancellation can win before browser preparation registers a capability. Tool-mode callers
    // only await this token after ChatGPT emits a tool request, so an early supersession otherwise
    // leaves the deferred rejection temporarily ownerless and Bun treats it as process-fatal.
    // Keep the canonical promise rejected for real consumers while attaching an immediate observer.
    void token.promise.catch(() => {});
    const externalProgress = new ChatGptExternalTurnProgress();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const prepareWith = async (input: CodexParsedRequest, retainedSteering = false) => {
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
      );
      activeToken = turnToken;
      if (!tokenSettled) {
        tokenSettled = true;
        token.resolve(turnToken);
      }
      try {
        const compiled = compileChatGptWebPrompt(
          input,
          turnCapabilities,
          turnToken,
          compileOptionsFor(input, retainedSteering),
        );
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities: turnCapabilities,
      prepare: () => prepareWith(checkpointInput.parsed),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput, steeringResumeInput !== undefined) } : {}),
      ...(retainConversation ? { retainConversation: true } : {}),
      ...(conversationKey ? { conversationKey } : {}),
      abortSignal: browserAbort.signal,
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      ...submissionLifecycle,
      onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => text.push(delta),
      onOutputAnnotations: captureOutputAnnotations,
      externalProgress,
      completionFence: {
        begin: async () => broker.beginCompletionFence(await token.promise),
        commit: async revision => broker.commitCompletionFence(await token.promise, revision),
      },
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
    })), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      externalProgress,
      browser: browserTurn.browser,
      physicalSettlement: browserTurn.physicalSettlement,
      trace,
      text,
      outputAnnotations: readOutputAnnotations,
      usageInput: checkpointInput.parsed,
      ...(conversationKey ? { conversationKey } : {}),
      ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
      retireCapability: async () => {
        if (activeToken) await broker.revoke(activeToken);
      },
      submission,
      cancel: (reason?: Error) => {
        browserTurn.cancel(reason);
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const runChatGptWebTurn = async (): Promise<void> => {
        const turnCapabilities = parsed._compactionRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const logicalOwnerKey = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const incomingInstruction = parsed._compactionRequest
          ? undefined
          : chatGptInstructionLineage(parsed);
        let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
        if (mode.localTools) {
          const activeLogicalTurn = nativeIdentity.threadId && nativeIdentity.turnId
            ? chatGptTurnSessions.findNativeTurn(nativeIdentity.threadId, nativeIdentity.turnId, logicalOwnerKey)
            : undefined;
          try {
            let authenticatedReplay = activeLogicalTurn
              && incomingInstruction
              && (activeLogicalTurn.hasObservedInstruction(incomingInstruction.current)
                || activeLogicalTurn.absorbDirectSteerAlias(
                  incomingInstruction.current,
                  chatGptTurnUserRevisionHistory(parsed).at(-1)?.content,
                ))
              && activeLogicalTurn.matchesEnvironmentContext(chatGptRawEnvironmentContextIdentity(parsed));
            if (!authenticatedReplay) {
              try {
                environment = environmentStore.resolve(parsed);
              } catch (initialError) {
                // The provider replay can race the filesystem watcher by a few milliseconds.
                // Poll only the already-authenticated exact turn, then permit reuse solely when
                // that poll claimed this exact instruction and the replay carries no environment
                // block (a malformed/current block must never fall back to cached authority).
                if (!activeLogicalTurn || !incomingInstruction
                  || !activeLogicalTurn.matchesEnvironmentContext(chatGptRawEnvironmentContextIdentity(parsed))) {
                  throw initialError;
                }
                activeLogicalTurn.pollControlNow();
                authenticatedReplay = activeLogicalTurn.hasObservedInstruction(incomingInstruction.current)
                  || activeLogicalTurn.absorbDirectSteerAlias(
                    incomingInstruction.current,
                    chatGptTurnUserRevisionHistory(parsed).at(-1)?.content,
                  );
                if (!authenticatedReplay) throw initialError;
              }
            }
            if (authenticatedReplay) environment = activeLogicalTurn!.trustedEnvironment();
            if (!environment) throw new Error("Active ChatGPT logical turn lost its trusted environment");
          } catch (error) {
            console.warn(
              `[chatgpt-web] trusted environment unavailable (thread_id=${nativeIdentity.threadId ? "present" : "missing"}, turn_id=${nativeIdentity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
            );
            throw error;
          }
        }
        if (parsed._compactionRequest) {
          const structuredCompactionRequired = parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
            && configuredCapabilities.localToolsEnabled;
          if (structuredCompactionRequired && (!retainedLauncherDescriptor || !structuredBroker)) {
            emit({
              type: "error",
              message: "Full-mode ChatGPT compaction requires the launcher retained-conversation lease and its local one-shot control broker; the bridge will not replace it with a read-only summarizer.",
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_control_unavailable",
              retryable: false,
            });
            return;
          }
          if (structuredCompactionRequired) {
            const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
            const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
            const handoffTraceId = createHash("sha256")
              .update(`${compactionExecutionKey}:handoff`)
              .digest("hex")
              .slice(0, 12);
            const compactionTraceId = createHash("sha256").update(compactionExecutionKey).digest("hex").slice(0, 12);
            const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
            let sharedSummary = existingStructuredCompactionRun(compactionExecutionKey);
            if (!sharedSummary) {
              const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
              const source = sourceConversationKey
                ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
                : undefined;
              sharedSummary = runStructuredCompactionOnce(
                compactionExecutionKey,
                {
                  ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                  traceIds: [compactionTraceId, handoffTraceId, `${handoffTraceId}_fallback`],
                  ...(compactionNativeIdentity.threadId ? { nativeThreadId: compactionNativeIdentity.threadId } : {}),
                  ...(compactionNativeIdentity.turnId ? { nativeTurnId: compactionNativeIdentity.turnId } : {}),
                },
                async (operatorSignal, retainOwnershipUntil) => {
                  const handoffTimeoutMs = Math.min(
                    timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                    MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                  );
                  const handoffDeadline = new AbortController();
                  const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
                  const handoffTimeoutError = new ChatGptWebAdapterError(
                    `ChatGPT compaction did not fully settle within ${handoffTimeoutMs}ms`,
                    {
                      status: 409,
                      errorType: "invalid_request_error",
                      code: "compaction_handoff_timeout",
                      retryable: false,
                    },
                  );
                  const handoffTimer = setTimeout(
                    () => handoffDeadline.abort(handoffTimeoutError),
                    handoffTimeoutMs,
                  );
                  handoffTimer.unref?.();
                  const runFreshCompactionFallback = async (reason: string): Promise<string> => {
                    console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
                    const fallbackRuntime = startRuntime(
                      parsed,
                      undefined,
                      `${handoffTraceId}_fallback`,
                      turnCapabilities,
                    );
                    retainOwnershipUntil(fallbackRuntime.physicalSettlement);
                    try {
                      const rawSummary = await withAbort(fallbackRuntime.browser, handoffDeadline.signal);
                      await withAbort(fallbackRuntime.physicalSettlement, handoffDeadline.signal);
                      return canonicalizeCompactionHandoff(parsed, rawSummary);
                    } catch (error) {
                      fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                      await withAbort(
                        fallbackRuntime.physicalSettlement,
                        operationSignal,
                      ).catch(() => {});
                      throw error;
                    }
                  };
                  let preserveFinalResponse = !source?.isActive()
                    && source?.settledOutcome()?.type === "final";
                  try {
                    const retainedKey = source?.conversationKey();
                    if (!source || !retainedKey) {
                      return await runFreshCompactionFallback("source_unavailable_before_handoff");
                    }
                    let rawSummary: string;
                    if (source.isActive() && source.runtime.mode === "tools") {
                      const settlement = await settleActiveCompactionSource(
                        parsed,
                        source,
                        structuredBroker!,
                        operationSignal,
                      );
                      preserveFinalResponse = !settlement.compactionInstructionDelivered;
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    } else {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, handoffDeadline.signal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, handoffDeadline.signal);
                        preserveFinalResponse = true;
                      }
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                      );
                    }
                    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
                    await withAbort(
                      preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                      operationSignal,
                    );
                    return summary;
                  } catch (error) {
                    const retainedKey = source?.conversationKey();
                    if (!retainedKey) throw error;
                    let handoffError = error instanceof Error ? error : new Error(String(error));
                    try {
                      await withAbort(
                        preserveFinalResponse
                          ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                            retainedKey,
                            source!,
                            compactedSourceExecutionKey,
                          )
                          : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                        operationSignal,
                      );
                    } catch (retirementError) {
                      if (!handoffDeadline.signal.aborted
                        || retirementError !== handoffDeadline.signal.reason) {
                        handoffError = new AggregateError(
                          [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                          "Structured compaction failed and its retained conversation could not be retired",
                        );
                      }
                    }
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_source_unavailable") {
                      return await runFreshCompactionFallback("source_disappeared_before_handoff");
                    }
                    throw handoffError;
                  } finally {
                    clearTimeout(handoffTimer);
                  }
                },
              );
            }
            emit({ type: "heartbeat" });
            let summary: string;
            try {
              summary = await withAbort(sharedSummary, incoming.abortSignal);
            } catch (error) {
              if (incoming.abortSignal?.aborted
                && error instanceof DOMException
                && error.name === "AbortError") {
                // The observer detached; the shared exact compaction round continues and remains
                // available to a canonical reconnect without a second browser submission.
                throw error;
              }
              const handoffError = error instanceof Error ? error : new Error(String(error));
              emit({
                type: "error",
                message: `The retained ChatGPT agent did not complete the structured context handoff: ${handoffError.message}`,
                status: 409,
                errorType: "invalid_request_error",
                code: "compaction_handoff_failed",
                retryable: false,
              });
              return;
            }
            emit({ type: "text_delta", text: summary, phase: "final_answer" });
            emitBrowserCompletion(
              { type: "final", answer: summary },
              estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities),
              emit,
            );
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }
          const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
          await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
        }
        const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const ownerKey = logicalOwnerKey;
        const traceId = createHash("sha256").update(executionKey).digest("hex").slice(0, 12);
        let steeringSource: ChatGptTurnSession | undefined;
        const session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
          executionKey,
          ownerKey,
          () => startRuntime(parsed, environment, traceId, turnCapabilities, steeringSource),
          traceId,
          incoming.abortSignal,
          nativeIdentity.turnId,
          nativeIdentity.threadId,
          chatGptInstructionLineage(parsed),
          source => { steeringSource = source; },
          environment,
          chatGptRawEnvironmentContextIdentity(parsed),
        );
        if (!parsed._compactionRequest && nativeIdentity.turnId && nativeIdentity.threadId) {
          const rolloutLineage = extractChatGptThreadSpawnLineage(parsed)
            ?? extractChatGptRootThreadMetadata(parsed);
          if (rolloutLineage) {
            let controlledParsed = parsed;
            const handleControlEvent = (event: CodexTurnControlEvent, source: "rollout" | "direct"): void => {
              if (event.type === "turn_complete") {
                session.closeControlTail();
                return;
              }
              if (event.type === "interrupt") {
                const reason = new ChatGptTurnInterruptedError();
                session.enqueueControl(async () => {}, reason);
                return;
              }
              const nextParsed = appendAuthenticatedSteeringRevision(
                controlledParsed,
                event,
                nativeIdentity.turnId!,
              );
              const nextInstruction = chatGptInstructionLineage(nextParsed).current;
              // The stdio control bridge observes turn/steer immediately. The canonical rollout
              // records the same revision later at the sampling boundary; treat that second signal
              // as acknowledgement rather than submitting it to ChatGPT twice.
              if (session.hasObservedInstruction(nextInstruction)) return;
              if (source === "rollout" && session.absorbDirectSteerAlias(nextInstruction, event.content)) {
                controlledParsed = nextParsed;
                return;
              }
              controlledParsed = nextParsed;
              // Claim synchronously with the authenticated control event. Codex may immediately
              // replay this revision through /responses without its original environment block;
              // that request must attach to this logical turn instead of failing before dedupe.
              if (source === "direct") {
                if (!session.claimDirectSteer(event.itemId, nextInstruction, event.content)) return;
              } else {
                session.claimInstruction(nextInstruction);
              }
              session.enqueueControl(async () => {
                let transitionStarted = false;
                try {
                  await session.waitForOutstandingResults();
                  if (session.isInterrupted()) return;

                  // ChatGPT does not reliably expose a second Send action while one response is
                  // generating. Treat steering as a browser-epoch replacement instead: stop the
                  // exact old generation, wait for the launcher to finish retaining/releasing its
                  // surface, then start the successor with the canonical retained-steering delta.
                  // If the retained lease cannot be reused, startRuntime falls back to a fresh
                  // surface with the full canonical context only after this proven stop boundary.
                  const sourceRuntime = session.beginRuntimeTransition();
                  transitionStarted = true;
                  const superseded = chatGptTurnSupersededError();
                  sourceRuntime.cancel(superseded);
                  try {
                    await sourceRuntime.physicalSettlement;
                  } catch (error) {
                    if (error !== superseded) throw error;
                  }
                  if (session.isInterrupted()) {
                    const interrupted = session.cancellationReason() ?? new ChatGptTurnInterruptedError();
                    session.failRuntimeTransition(interrupted);
                    transitionStarted = false;
                    return;
                  }

                  const replacement = startRuntime(
                    nextParsed,
                    session.trustedEnvironment(),
                    traceId,
                    turnCapabilities,
                    session,
                  );
                  session.installRuntime(replacement, nextInstruction);
                  transitionStarted = false;
                  session.completeInstruction(nextInstruction);
                } catch (error) {
                  const normalized = error instanceof Error ? error : new Error(String(error));
                  session.failInstruction(nextInstruction);
                  if (transitionStarted && session.isRuntimeTransitioning()) {
                    session.failRuntimeTransition(normalized);
                  }
                  throw normalized;
                }
              });
            };
            session.attachDirectSteer((itemId, content) => handleControlEvent({
              type: "steer",
              itemId,
              content,
              sequence: session.nextDirectSteerSequence(),
            }, "direct"));
            let controlTail = createCodexRolloutControlTail({
              codexHome: getCodexHome(),
              lineage: rolloutLineage,
              turnId: nativeIdentity.turnId,
              initialRevisions: chatGptTurnUserRevisionHistory(parsed),
              onEvent: event => handleControlEvent(event, "rollout"),
              onError: error => session.enqueueControl(async () => {}, error),
            });
            if (controlTail) {
              if (session.attachControl(() => controlTail?.close(), () => controlTail?.poll())) controlTail.start();
              else controlTail.close();
            }
          }
        }
        const roundKey = chatGptTurnRoundKey(parsed);
        const canonicalDirectSteerReplay = incomingInstruction
          ? session.isCanonicalDirectSteerAlias(incomingInstruction.current)
          : false;
        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {
          // Journal the complete synchronous event batch before touching the HTTP observer. If the
          // observer disconnects midway through emission, an exact reconnect can replay the entire
          // canonical batch instead of losing the already-drained tail.
          session.appendRoundEvents(roundKey, events);
          for (const event of events) emit(event);
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events);
        };
        const emitRoundEvent = (event: AdapterEvent): void => emitRoundEvents([event]);
        try {
          await session.runExclusive(async () => {
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            // A rejected steering request is journaled as one terminal provider error below. On an
            // exact reconnect, replay that completed round before consulting instruction state;
            // otherwise the same rejection tries to append a second error to a completed journal.
            const steeringFailure = incomingInstruction && session.instructionFailure(incomingInstruction.current);
            if (steeringFailure) throw steeringFailure;
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            if (settled) {
              if (settled.type === "error") throw settled.error;
              if (canonicalDirectSteerReplay) {
                // The original provider observer stayed attached while the direct control path
                // steered the same browser turn, so it already delivered this final answer. Codex
                // later opens a canonical provider request for the accepted steer item; terminate
                // that request without replaying the same text/commentary into the native turn.
                structuredOutputValidator?.(settled.answer);
                emitRoundBatch(buffer => emitBrowserCompletion(
                  settled,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { answer: "", reasoning: [] }, turnCapabilities),
                  buffer,
                ));
                session.completeRound(roundKey);
                chatGptWebTurnRetryPolicy.clear(retryKey);
                return;
              }
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drain();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                if (replay.length === 0 && !parsed._compactionRequest) {
                  emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
                }
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
                if (!bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas(completedTextDeltas, buffer));
                }
              }
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(currentUsageInput(parsed), { answer: settled.answer, reasoning }, turnCapabilities),
                buffer,
                session.runtime.outputAnnotations?.() ?? [],
              ));
              session.completeRound(roundKey);
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            runtimeLoop: for (;;) {
            if (session.outstanding().length === 0) await session.waitForControlIdle();
            if (session.isRuntimeTransitioning()) {
              const transitioningRevision = session.runtimeEpoch();
              await withAbort(session.waitForRuntimeChange(transitioningRevision), incoming.abortSignal);
              continue runtimeLoop;
            }
            const runtimeEpoch = session.runtimeEpoch();
            const runtime = session.runtime;
            let turnToken: string | undefined;
            if (runtime.mode === "tools") {
              const tokenWaitAbort = new AbortController();
              try {
                let tokenOrRuntime;
                try {
                  tokenOrRuntime = await withAbort(Promise.race([
                    runtime.token.then(token => ({ type: "token" as const, token })),
                    session.waitForRuntimeChange(runtimeEpoch, tokenWaitAbort.signal)
                      .then(() => ({ type: "runtime" as const })),
                  ]), incoming.abortSignal);
                } catch (error) {
                  // Direct steering cancels the old browser epoch and advances the runtime
                  // revision synchronously. Its token promise may reject one microtask before the
                  // runtime-change branch wins Promise.race; that rejection is a transition signal,
                  // not a failed native response that Codex should retry as another HTTP request.
                  if (session.runtimeEpoch() !== runtimeEpoch) {
                    await session.waitForControlIdle();
                    continue runtimeLoop;
                  }
                  throw error;
                }
                if (tokenOrRuntime.type === "runtime") {
                  await session.waitForControlIdle();
                  continue runtimeLoop;
                }
                turnToken = tokenOrRuntime.token;
              } finally {
                tokenWaitAbort.abort();
              }
              // Capability revocation is intentionally immediate. If a targeted cancel landed while
              // the token await was resuming, surface that canonical reason before touching the now
              // revoked broker channel. There is no await between this check and the synchronous
              // update, so a later cancel cannot interleave with it on the JS event loop.
              const cancellation = session.cancellationReason();
              if (cancellation) throw cancellation;
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
              await broker.updateEnvironment(turnToken, environment);

              const outstanding = session.outstanding();
              if (outstanding.length > 0) {
                const results = currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning, toolRequests: outstanding }, turnCapabilities),
                    buffer,
                  ));
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                for (const message of results) {
                  await broker.completeTool(turnToken, message.toolCallId, brokerResult(message));
                  runtime.externalProgress.recordToolResult();
                  session.markResultDelivered(message.toolCallId);
                }
                const timing = session.finishOutstandingToolBatch();
                emitToolLoopMetric(session, "tool_results_settled", {
                  batchSequence: timing.sequence,
                  toolCount: timing.toolCount,
                  outerToolRoundtripMs: Math.round(timing.outerToolRoundtripMs),
                });
                await session.waitForControlIdle();
                if (session.runtimeEpoch() !== runtimeEpoch) continue runtimeLoop;
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              const emitNewText = (deltas: string[]) => {
                if (!bufferStructuredOutput) emitRoundBatch(buffer => emitTextDeltas(deltas, buffer));
              };
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(runtime.trace.drain());
              emitNewText(runtime.text.drain());
              const externalProgress = runtime.mode === "tools"
                ? runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    const batchReadyAt = performance.now();
                    const batchSequence = session.nextToolBatchSequence();
                    const postResultToNextBatchMs = session.postToolContinuationMs(batchReadyAt);
                    emitToolLoopMetric(session, "tool_batch_ready", {
                      batchSequence,
                      toolCount: requests.length,
                      postResultToNextBatchMs: postResultToNextBatchMs === undefined
                        ? undefined
                        : Math.round(postResultToNextBatchMs),
                    });
                    const revision = externalProgress.recordToolBatch(requests.length);
                    const boundaryStartedAt = performance.now();
                    const observationTimeout = new AbortController();
                    const timer = setTimeout(
                      () => observationTimeout.abort(),
                      CHATGPT_TOOL_BOUNDARY_OBSERVATION_TIMEOUT_MS,
                    );
                    try {
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        AbortSignal.any([toolWaitAbort.signal, observationTimeout.signal]),
                      );
                      emitToolLoopMetric(session, "tool_boundary_observed", {
                        batchSequence,
                        toolCount: requests.length,
                        boundaryObservationMs: Math.round(performance.now() - boundaryStartedAt),
                      });
                    } catch (error) {
                      if (observationTimeout.signal.aborted && !toolWaitAbort.signal.aborted) {
                        throw new Error(
                          `ChatGPT browser did not acknowledge Codex tool batch ${revision}`
                          + ` within ${CHATGPT_TOOL_BOUNDARY_OBSERVATION_TIMEOUT_MS}ms`,
                          { cause: error },
                        );
                      }
                      throw error;
                    } finally {
                      clearTimeout(timer);
                    }
                  }
                  return { type: "tools" as const, requests };
                })
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              const runtimeChange = session.waitForRuntimeChange(runtimeEpoch, toolWaitAbort.signal)
                .then(() => ({ type: "runtime" as const }));
              let nextTrace = runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
              let nextText = runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
              for (;;) {
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    runtimeChange,
                    nextTrace,
                    nextText,
                  ]),
                  incoming.abortSignal,
                );
                if (next.type === "trace") {
                  emitNewTrace(runtime.trace.drain());
                  nextTrace = runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
                  continue;
                }
                if (next.type === "text") {
                  emitNewText(runtime.text.drain());
                  nextText = runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
                  continue;
                }
                emitNewTrace(runtime.trace.drain());
                emitNewText(runtime.text.drain());
                if (next.type === "runtime") {
                  await session.waitForControlIdle();
                  continue runtimeLoop;
                }
                if (next.type === "browser") {
                  if (session.runtimeEpoch() !== runtimeEpoch) continue runtimeLoop;
                  const completedOutcome = next.outcome;
                  if (completedOutcome.type === "error") throw completedOutcome.error;
                  const postResultToFinalMs = session.postToolContinuationMs();
                  if (postResultToFinalMs !== undefined) {
                    emitToolLoopMetric(session, "post_tool_final", {
                      completedBatches: session.nextToolBatchSequence() - 1,
                      postResultToFinalMs: Math.round(postResultToFinalMs),
                    });
                  }
                  session.setFinalReasoning(roundReasoning);
                  session.setFinalEvents(session.roundEvents(roundKey));
                  if (turnToken) await broker.revoke(turnToken);
                  if (runtime.text.value() !== completedOutcome.answer) {
                    throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                  }
                  structuredOutputValidator?.(completedOutcome.answer);
                  if (bufferStructuredOutput) {
                    emitRoundBatch(buffer => emitTextDeltas([completedOutcome.answer], buffer));
                  }
                  emitRoundBatch(buffer => emitBrowserCompletion(
                    completedOutcome,
                    estimateChatGptWebUsage(currentUsageInput(parsed), { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities),
                    buffer,
                    runtime.outputAnnotations?.() ?? [],
                  ));
                  session.completeRound(roundKey);
                  chatGptWebTurnRetryPolicy.clear(retryKey);
                  return;
                }
                if (!turnToken || runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
                validateBatchTools(parsed, next.requests);
                const startedBatch = session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                emitToolLoopMetric(session, "tool_batch_emitted", {
                  batchSequence: startedBatch.sequence,
                  toolCount: startedBatch.toolCount,
                });
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(currentUsageInput(parsed), { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities),
                  buffer,
                ));
                session.completeRound(roundKey);
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
            }
          });
        } catch (error) {
          if (error instanceof ChatGptSteeringUnavailableError) {
            emitRoundEvent({ type: "error", message: error.message, status: error.status,
              errorType: error.errorType, code: error.code, retryable: false });
            session.completeRound(roundKey);
            return;
          }
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            // The HTTP observer detached. Keep the exact browser execution and its round journal so
            // the same canonical request can reconnect without another ChatGPT submission.
            throw error;
          }
          const turnError = submittedTurnFailure(session, error);
          const handledError = turnError instanceof ChatGptWebAdapterError && turnError.retryable
            ? chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError)
            : turnError;
          if (!(turnError instanceof ChatGptWebAdapterError && turnError.retryable)) {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
            // A deterministic request failure remains replayable so a native reconnect cannot burn
            // another browser attempt. Every other failure retires the browser session: client
            // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
            // instead of replaying one rejected browser outcome for the registry's full TTL.
            session.cancel();
          } else {
            chatGptTurnSessions.retire(executionKey, session);
          }
          if (session.runtime.mode === "tools") {
            void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
          }
          if (handledError instanceof ChatGptWebAdapterError) {
            emitRoundEvent({
              type: "error",
              message: handledError.message,
              status: handledError.status,
              errorType: handledError.errorType,
              code: handledError.code,
              retryable: handledError.retryable,
            });
            session.completeRound(roundKey);
            return;
          }
          session.failRound(roundKey, turnError);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        }
      };

      // Arm this before any awaited work, including environment lookup and owner retirement.
      const heartbeat = setInterval(
        () => emit({ type: "heartbeat" }),
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      try {
        emit({ type: "heartbeat" });
        await runChatGptWebTurn();
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
