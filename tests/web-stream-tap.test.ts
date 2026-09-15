import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";

import {
  ChatGptCdpRequestInjector,
  ChatGptCdpRequestInjectionShadow,
  ChatGptConversationSseAccumulator,
  ChatGptRequestInjectionFallbackError,
  ChatGptRequestInjector,
  ChatGptRequestInjectionShadow,
  ChatGptWebStreamTap,
  ChatGptWireCapture,
  chatGptNetworkStreamPrimaryEnabled,
  chatGptNetworkStreamShadowEnabled,
  chatGptIncompleteCaptureRecoveryEnabled,
  chatGptRecoveryProofDiagnosticsEnabled,
  chatGptStreamProtocolDiagnosticsEnabled,
  chatGptRequestInjectionShadowEnabled,
  chatGptStreamHandoffTopic,
  chatGptWebSocketEncodedItems,
  countExactJsonStringValues,
  chatGptRequestInjectionPrimaryEnabled,
  chatGptRequestInjectionCdpShadowEnabled,
  chatGptRequestInjectionCdpPrimaryEnabled,
  createChatGptRequestInjectionPlaceholder,
  inspectChatGptRequestJsonBody,
  isChatGptRequestInjectionPlaceholder,
  isChatGptConversationPostUrl,
  rewriteChatGptRequestJsonBody,
} from "../src/adapters/chatgpt-web/web-stream-tap";

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function provenanceMessage(id: unknown = "wire-message-original") {
  return { id, author: { role: "assistant" }, recipient: "all", channel: "final",
    content: { content_type: "text", parts: ["answer"] }, status: "in_progress" };
}

test("wire message provenance pairs explicit full-message IDs without leaking into protocol diagnostics", () => {
  const parser = new ChatGptConversationSseAccumulator(true);
  const event = { conversation_id: "wire-conversation-original", message: provenanceMessage() };
  parser.feed(sse(event) + sse(event)); // Repeated updates for the same ID are not two identities.
  const snapshot = parser.snapshot();
  expect(snapshot.assistantMessageId).toBe("wire-message-original");
  expect(snapshot.assistantMessageConversationId).toBe("wire-conversation-original");
  expect(snapshot.assistantMessageIdentityConflict).toBeUndefined();
  expect(snapshot.assistantMessageIdentityUnknown).toBeUndefined();
  const diagnostics = JSON.stringify({ trace: snapshot.protocolTrace, summary: snapshot.protocolSummary });
  expect(diagnostics).not.toContain("wire-message-original");
  expect(diagnostics).not.toContain("wire-conversation-original");
});

test("root-add full message establishes provenance while ordinary content and completion patches preserve it", () => {
  const parser = new ChatGptConversationSseAccumulator();
  parser.feed(sse({ o: "add", v: { conversation_id: "conversation-a", message: provenanceMessage() } }));
  parser.feed(sse({ p: "/message/content/parts/0", o: "append", v: "!" }));
  parser.feed(sse({ o: "patch", v: [
    { p: "/message/content/parts/0", o: "replace", v: "final" },
    { p: "/message/end_turn", o: "replace", v: true },
  ] }));
  expect(parser.snapshot().assistantMessageId).toBe("wire-message-original");
  expect(parser.snapshot().assistantMessageIdentityUnknown).toBeUndefined();
  expect(parser.snapshot().text).toBe("final");
  expect(parser.snapshot().complete).toBeTrue();
});

test("reasoning tool recipient and non-assistant IDs never establish final-message provenance", () => {
  const parser = new ChatGptConversationSseAccumulator();
  for (const message of [
    { ...provenanceMessage("analysis-id"), channel: "analysis" },
    { ...provenanceMessage("tool-call-id"), recipient: "python" },
    { ...provenanceMessage("tool-result-id"), author: { role: "tool" } },
  ]) parser.feed(sse({ conversation_id: "conversation-a", message }));
  expect(parser.snapshot().assistantMessageId).toBeUndefined();
  parser.feed(sse({ conversation_id: "conversation-a", message: provenanceMessage() }));
  expect(parser.snapshot().assistantMessageId).toBe("wire-message-original");
  expect(parser.snapshot().assistantMessageIdentityUnknown).toBeUndefined();
});

test("missing or invalid explicit IDs and missing paired conversation remain unknown without backfill", () => {
  for (const message of [provenanceMessage(null), provenanceMessage(""), provenanceMessage(42)]) {
    const parser = new ChatGptConversationSseAccumulator();
    parser.feed(sse({ conversation_id: "conversation-a", message }));
    expect(parser.snapshot().assistantMessageId).toBeUndefined();
    parser.feed(sse({ conversation_id: "conversation-a", message: provenanceMessage() }));
    expect(parser.snapshot().assistantMessageIdentityUnknown).toBeTrue();
  }
  const parser = new ChatGptConversationSseAccumulator();
  parser.feed(sse({ type: "message_stream_complete", conversation_id: "conversation-a" }));
  parser.feed(sse({ message: provenanceMessage() }));
  expect(parser.snapshot().assistantMessageId).toBeUndefined();
  parser.feed(sse({ p: "/message/id", o: "replace", v: "patch-id" }));
  expect(parser.snapshot().assistantMessageId).toBeUndefined();
});

test("multiple final message identities preserve the original pair and permanently conflict", () => {
  const parser = new ChatGptConversationSseAccumulator();
  for (const id of ["first-id", "second-id", "first-id"]) {
    parser.feed(sse({ conversation_id: "conversation-a", message: provenanceMessage(id) }));
  }
  expect(parser.snapshot().assistantMessageId).toBe("first-id");
  expect(parser.snapshot().assistantMessageIdentityConflict).toBeTrue();
});

test("conversation changes and contradictory nested conversation poison original message mapping", () => {
  for (const next of [
    { type: "message_stream_complete", conversation_id: "conversation-b" },
    { conversation_id: "conversation-b", message: provenanceMessage() },
    { conversation_id: "conversation-a", message: { ...provenanceMessage(), conversation_id: "conversation-b" } },
  ]) {
    const parser = new ChatGptConversationSseAccumulator();
    parser.feed(sse({ conversation_id: "conversation-a", message: provenanceMessage() }));
    parser.feed(sse(next));
    parser.feed(sse({ conversation_id: "conversation-a", message: provenanceMessage() }));
    expect(parser.snapshot().assistantMessageConversationId).toBe("conversation-a");
    expect(parser.snapshot().assistantMessageIdentityConflict).toBeTrue();
  }
});

test("unsupported direct batch and root identity patches never manufacture or silently refresh provenance", () => {
  for (const patch of [
    { p: "/message/id", o: "replace", v: "new-id" },
    { o: "patch", v: [{ p: "/message/author/role", o: "replace", v: "tool" }] },
    { o: "patch", v: [{ p: "/message", o: "replace", v: provenanceMessage("new-id") }] },
    { o: "replace", v: { conversation_id: "conversation-a", message: provenanceMessage("new-id") } },
  ]) {
    const parser = new ChatGptConversationSseAccumulator();
    parser.feed(sse({ conversation_id: "conversation-a", message: provenanceMessage() }));
    parser.feed(sse(patch));
    parser.feed(sse({ conversation_id: "conversation-a", message: provenanceMessage() }));
    expect(parser.snapshot().assistantMessageId).toBe("wire-message-original");
    expect(parser.snapshot().assistantMessageIdentityUnknown).toBeTrue();
  }
});

test("conversation stream URL matching is exact and same-origin", () => {
  expect(isChatGptConversationPostUrl("https://chatgpt.com/backend-api/f/conversation")).toBeTrue();
  expect(isChatGptConversationPostUrl("https://chatgpt.com/backend-api/conversation")).toBeTrue();
  expect(isChatGptConversationPostUrl("https://chatgpt.com/backend-api/f/conversation/prepare")).toBeFalse();
  expect(isChatGptConversationPostUrl("https://example.com/backend-api/f/conversation")).toBeFalse();
});

test("patch SSE is decoded incrementally across arbitrary chunk boundaries", () => {
  const accumulator = new ChatGptConversationSseAccumulator();
  const first = sse({
    o: "add",
    v: {
      conversation_id: "conversation-1",
      message: {
        author: { role: "assistant" },
        recipient: "all",
        channel: "final",
        content: { content_type: "text", parts: ["Hel"] },
        status: "in_progress",
      },
    },
  });
  const rest = sse({ v: "lo" })
    + sse({ o: "patch", v: [{ p: "/message/content/parts/0", o: "append", v: " world" }] })
    + sse({ type: "message_stream_complete", conversation_id: "conversation-1" });
  const wire = first + rest;
  accumulator.feed(wire.slice(0, 17));
  accumulator.feed(wire.slice(17, 63));
  accumulator.feed(wire.slice(63));
  accumulator.end();

  expect(accumulator.snapshot()).toEqual({
    conversationId: "conversation-1",
    text: "Hello world",
    complete: true,
  });
});

test("replace patches reset the current final-answer text instead of being appended", () => {
  const accumulator = new ChatGptConversationSseAccumulator();
  accumulator.feed(sse({
    message: {
      author: { role: "assistant" },
      recipient: "all",
      channel: "final",
      content: { content_type: "text", parts: ["broken link prefix"] },
      status: "in_progress",
    },
    conversation_id: "conversation-replace",
  }));
  accumulator.feed(sse({
    p: "/message/content/parts/0",
    o: "replace",
    v: "fixed link",
  }));
  accumulator.feed(sse({
    o: "patch",
    v: [
      { p: "/message/content/parts/0", o: "append", v: " and text" },
      { p: "/message/content/parts/0", o: "replace", v: "final canonical text" },
    ],
  }));
  accumulator.feed(sse({ type: "message_stream_complete", conversation_id: "conversation-replace" }));

  expect(accumulator.snapshot()).toEqual({
    conversationId: "conversation-replace",
    text: "final canonical text",
    complete: true,
    handoffTopicId: undefined,
  });
});

test("reasoning and tool streams never contaminate the final assistant answer", () => {
  const accumulator = new ChatGptConversationSseAccumulator();
  accumulator.feed(sse({
    message: {
      author: { role: "assistant" },
      recipient: "all",
      channel: "analysis",
      content: { content_type: "thoughts", parts: ["private reasoning"] },
    },
  }));
  accumulator.feed(sse({ v: " must stay hidden" }));
  accumulator.feed(sse({
    message: {
      author: { role: "assistant" },
      recipient: "all",
      channel: "final",
      content: { content_type: "text", parts: ["Visible"] },
      status: "in_progress",
    },
    conversation_id: "conversation-2",
  }));
  accumulator.feed(sse({ v: " answer" }));
  accumulator.feed("data: [DONE]\n\n");

  expect(accumulator.snapshot()).toEqual({
    conversationId: "conversation-2",
    text: "Visible answer",
    complete: true,
  });
});

test("legacy full-message events use monotonic replace semantics", () => {
  const accumulator = new ChatGptConversationSseAccumulator();
  for (const text of ["A", "AB", "", "ABC"]) {
    accumulator.feed(sse({
      message: {
        author: { role: "assistant" },
        content: { content_type: "text", parts: [text] },
        status: text === "ABC" ? "finished_successfully" : "in_progress",
      },
    }));
  }
  expect(accumulator.snapshot().text).toBe("ABC");
  expect(accumulator.snapshot().complete).toBeTrue();
});

test("wire capture binds exactly one response stream", () => {
  const capture = new ChatGptWireCapture();
  capture.accept({
    type: "start",
    streamId: "first",
    url: "https://chatgpt.com/backend-api/f/conversation",
    status: 200,
    contentType: "text/event-stream",
  });
  capture.accept({
    type: "start",
    streamId: "second",
    url: "https://chatgpt.com/backend-api/f/conversation",
    status: 200,
    contentType: "text/event-stream",
  });
  capture.accept({ type: "chunk", streamId: "second", chunk: "data: [DONE]\n\n" });
  capture.accept({ type: "chunk", streamId: "first", chunk: "data: [DONE]\n\n" });
  capture.accept({ type: "end", streamId: "first" });

  const snapshot = capture.snapshot();
  expect(snapshot.streamId).toBe("first");
  expect(snapshot.status).toBe(200);
  expect(snapshot.complete).toBeTrue();
  expect(snapshot.failed).toBeFalse();
});

test("network shadow mode is enabled by default and explicitly disableable", () => {
  expect(chatGptNetworkStreamShadowEnabled({})).toBeTrue();
  expect(chatGptNetworkStreamShadowEnabled({ CODEX_CHATGPT_WEB_NETWORK_STREAM_SHADOW: "0" })).toBeFalse();
  expect(chatGptNetworkStreamShadowEnabled({ CODEX_CHATGPT_WEB_NETWORK_STREAM_SHADOW: "1" })).toBeTrue();
});

test("network primary mode is default-on with an explicit kill switch", () => {
  expect(chatGptNetworkStreamPrimaryEnabled({})).toBeTrue();
  expect(chatGptNetworkStreamPrimaryEnabled({ CODEX_CHATGPT_WEB_NETWORK_STREAM_PRIMARY: "0" })).toBeFalse();
  expect(chatGptNetworkStreamPrimaryEnabled({ CODEX_CHATGPT_WEB_NETWORK_STREAM_PRIMARY: "1" })).toBeTrue();
});

test("protocol shape diagnostics require an explicit opt-in", () => {
  expect(chatGptStreamProtocolDiagnosticsEnabled({})).toBeFalse();
  expect(chatGptStreamProtocolDiagnosticsEnabled({ CODEX_CHATGPT_WEB_STREAM_PROTOCOL_DIAGNOSTICS: "1" })).toBeTrue();
});

test("incomplete-capture recovery policy is default-on with an explicit kill switch", () => {
  expect(chatGptIncompleteCaptureRecoveryEnabled({})).toBeTrue();
  expect(chatGptIncompleteCaptureRecoveryEnabled({ CODEX_CHATGPT_WEB_INCOMPLETE_CAPTURE_RECOVERY: "0" })).toBeFalse();
  expect(chatGptIncompleteCaptureRecoveryEnabled({ CODEX_CHATGPT_WEB_INCOMPLETE_CAPTURE_RECOVERY: "1" })).toBeTrue();
});

test("recovery proof DOM diagnostics require an explicit opt-in", () => {
  expect(chatGptRecoveryProofDiagnosticsEnabled({})).toBeFalse();
  expect(chatGptRecoveryProofDiagnosticsEnabled({ CODEX_CHATGPT_WEB_RECOVERY_PROOF_DIAGNOSTICS: "0" })).toBeFalse();
  expect(chatGptRecoveryProofDiagnosticsEnabled({ CODEX_CHATGPT_WEB_RECOVERY_PROOF_DIAGNOSTICS: "1" })).toBeTrue();
});

test("protocol diagnostics record bounded content-free message and patch shapes", () => {
  const accumulator = new ChatGptConversationSseAccumulator(true);
  accumulator.feed(sse({
    message: {
      author: { role: "assistant" },
      recipient: "all",
      channel: "final",
      content: { content_type: "text", parts: ["secret"] },
      status: "in_progress",
    },
  }));
  accumulator.feed(sse({ p: "/message/content/parts/0", o: "append", v: " delta" }));
  accumulator.feed(sse({ v: " plain" }));
  accumulator.feed(sse({
    o: "patch",
    v: [{
      p: "/message/metadata/content_references",
      o: "append",
      v: [{ matched_text: "must stay hidden" }],
    }],
  }));
  const trace = accumulator.snapshot().protocolTrace;
  expect(trace).toEqual([
    {
      kind: "message",
      role: "assistant",
      channel: "final",
      contentType: "text",
      finalAssistant: true,
      textChars: 6,
      privateUseChars: 0,
      contentReferences: 0,
      safeUrls: 0,
      citations: 0,
      refs: 0,
    },
    {
      kind: "content-op",
      source: "direct",
      operation: "append",
      partIndex: 0,
      nestedPath: false,
      valueType: "string",
      valueChars: 6,
      privateUseChars: 0,
      trackingFinalAssistant: true,
    },
    {
      kind: "content-op",
      source: "plain",
      operation: "plain",
      nestedPath: false,
      valueType: "string",
      valueChars: 6,
      privateUseChars: 0,
      trackingFinalAssistant: true,
    },
    {
      kind: "metadata-op",
      source: "batch",
      category: "content-references",
      operation: "append",
      nestedPath: false,
      valueType: "array",
      itemCount: 1,
      trackingFinalAssistant: true,
    },
  ]);
  expect(JSON.stringify(trace)).not.toContain("secret");
  expect(JSON.stringify(trace)).not.toContain("delta");
});

test("protocol aggregate survives trace starvation and recursively counts late metadata", () => {
  const accumulator = new ChatGptConversationSseAccumulator(true);
  accumulator.feed(sse({
    message: {
      author: { role: "assistant" },
      recipient: "all",
      channel: "final",
      content: { content_type: "text", parts: [""] },
      status: "in_progress",
      metadata: {
        content_references: [{ safe_urls: ["private-url"], refs: ["private-ref"] }],
      },
    },
  }));
  for (let index = 0; index < 120; index += 1) {
    accumulator.feed(sse({ p: "/message/content/parts/0", o: "append", v: "x" }));
  }
  accumulator.feed(sse({
    o: "patch",
    v: [{
      p: "/message/metadata/content_references/0/safe_urls",
      o: "replace",
      v: ["late-private-url", "later-private-url"],
    }],
  }));
  accumulator.handleEventObject({
    type: "stream_handoff",
    options: [{ type: "subscribe_ws_topic", topic_id: "conversation-turn-safe-topic" }],
  });

  const snapshot = accumulator.snapshot();
  expect(snapshot.protocolTrace?.length).toBe(96);
  expect(snapshot.protocolTraceDropped).toBeGreaterThan(0);
  expect(snapshot.protocolSummary).toEqual({
    messageEvents: 1,
    finalAssistantMessages: 1,
    contentOps: 120,
    appendOps: 120,
    replaceOps: 0,
    metadataOps: 1,
    metadataRootOps: 0,
    handoffEvents: 1,
    unsupportedHandoffEvents: 0,
    unknownTypedEvents: 0,
    privateUseChars: 0,
    maxContentReferences: 1,
    maxSafeUrls: 2,
    maxCitations: 0,
    maxRefs: 1,
  });
  const serialized = JSON.stringify(snapshot.protocolSummary);
  expect(serialized).not.toContain("private-url");
  expect(serialized).not.toContain("private-ref");
});

test("protocol diagnostics distinguish unsupported handoff shape from no handoff without leaking values", () => {
  const accumulator = new ChatGptConversationSseAccumulator(true);
  accumulator.feed(sse({
    type: "stream_handoff",
    conversation_id: "private-conversation-id",
    options: [
      {
        type: "subscribe_ws_topic",
        topic_id: "private-unrecognized-topic-shape",
        payload: "private-option-payload",
      },
    ],
  }));

  const snapshot = accumulator.snapshot();
  expect(snapshot.handoffTopicId).toBeUndefined();
  expect(snapshot.protocolSummary).toMatchObject({
    handoffEvents: 0,
    unsupportedHandoffEvents: 1,
    unknownTypedEvents: 0,
  });
  expect(snapshot.protocolTrace).toContainEqual({
    kind: "event-shape",
    category: "handoff-unsupported",
    hasOptions: true,
    optionCount: 1,
  });
  const serialized = JSON.stringify({
    trace: snapshot.protocolTrace,
    summary: snapshot.protocolSummary,
  });
  expect(serialized).not.toContain("private-conversation-id");
  expect(serialized).not.toContain("private-unrecognized-topic-shape");
  expect(serialized).not.toContain("private-option-payload");
});

test("protocol diagnostics count unknown typed events without recording their type or payload", () => {
  const accumulator = new ChatGptConversationSseAccumulator(true);
  accumulator.feed(sse({
    type: "private_future_transport_event",
    options: [{ secret: "private-option" }, { secret: "private-option-2" }],
    payload: "private-event-payload",
  }));

  const snapshot = accumulator.snapshot();
  expect(snapshot.protocolSummary).toMatchObject({
    handoffEvents: 0,
    unsupportedHandoffEvents: 0,
    unknownTypedEvents: 1,
  });
  expect(snapshot.protocolTrace).toContainEqual({
    kind: "event-shape",
    category: "unknown-typed",
    hasOptions: true,
    optionCount: 2,
  });
  const serialized = JSON.stringify({
    trace: snapshot.protocolTrace,
    summary: snapshot.protocolSummary,
  });
  expect(serialized).not.toContain("private_future_transport_event");
  expect(serialized).not.toContain("private-option");
  expect(serialized).not.toContain("private-event-payload");
});

test("protocol diagnostics count private-use sentinels and nested metadata without leaking values", () => {
  const accumulator = new ChatGptConversationSseAccumulator(true);
  accumulator.feed(sse({
    message: {
      author: { role: "assistant" },
      recipient: "all",
      channel: "final",
      content: { content_type: "text", parts: ["alpha\uE200cite\uE201"] },
      metadata: {
        content_references: [{ safe_urls: ["https://secret.example/"], refs: ["turn-secret"] }],
      },
    },
  }));
  accumulator.feed(sse({
    o: "patch",
    v: [
      { p: "/message/metadata/content_references/0/safe_urls", o: "replace", v: ["https://hidden.example/"] },
      { p: "/message/metadata/content_references/0/refs", o: "append", v: ["hidden-ref"] },
      { p: "/message/metadata/content_references/0/start_idx", o: "replace", v: 5 },
    ],
  }));
  accumulator.feed(sse({
    p: "/message/metadata",
    o: "replace",
    v: {
      content_references: [{ safe_urls: ["https://root-hidden.example/"], refs: ["root-ref"] }],
      citations: [{ refs: ["citation-ref"] }],
    },
  }));

  const trace = accumulator.snapshot().protocolTrace ?? [];
  expect(trace.some(event => event.kind === "message" && event.privateUseChars === 2)).toBeTrue();
  expect(trace.some(event => event.kind === "metadata-op" && event.category === "safe-urls")).toBeTrue();
  expect(trace.some(event => event.kind === "metadata-op" && event.category === "refs")).toBeTrue();
  expect(trace.some(event => event.kind === "metadata-op" && event.category === "indices")).toBeTrue();
  expect(trace.some(event => event.kind === "metadata-root"
    && event.contentReferences === 1
    && event.safeUrls === 1
    && event.citations === 1
    && event.refs === 2)).toBeTrue();
  const encoded = JSON.stringify(trace);
  expect(encoded).not.toContain("secret.example");
  expect(encoded).not.toContain("hidden.example");
  expect(encoded).not.toContain("turn-secret");
  expect(encoded).not.toContain("hidden-ref");
});

test("request injection shadow is opt-in only", () => {
  expect(chatGptRequestInjectionShadowEnabled({})).toBeFalse();
  expect(chatGptRequestInjectionShadowEnabled({ CODEX_CHATGPT_WEB_REQUEST_INJECTION_SHADOW: "0" })).toBeFalse();
  expect(chatGptRequestInjectionShadowEnabled({ CODEX_CHATGPT_WEB_REQUEST_INJECTION_SHADOW: "1" })).toBeTrue();
});

test("request injection primary is default-on with an explicit kill switch", () => {
  expect(chatGptRequestInjectionPrimaryEnabled({})).toBeTrue();
  expect(chatGptRequestInjectionPrimaryEnabled({ CODEX_CHATGPT_WEB_REQUEST_INJECTION_PRIMARY: "0" })).toBeFalse();
  expect(chatGptRequestInjectionPrimaryEnabled({ CODEX_CHATGPT_WEB_REQUEST_INJECTION_PRIMARY: "1" })).toBeTrue();
});

test("CDP request injection shadow is opt-in only", () => {
  expect(chatGptRequestInjectionCdpShadowEnabled({})).toBeFalse();
  expect(chatGptRequestInjectionCdpShadowEnabled({ CODEX_CHATGPT_WEB_REQUEST_INJECTION_CDP_SHADOW: "0" })).toBeFalse();
  expect(chatGptRequestInjectionCdpShadowEnabled({ CODEX_CHATGPT_WEB_REQUEST_INJECTION_CDP_SHADOW: "1" })).toBeTrue();
});

test("CDP request injection primary canary is opt-in only", () => {
  expect(chatGptRequestInjectionCdpPrimaryEnabled({})).toBeFalse();
  expect(chatGptRequestInjectionCdpPrimaryEnabled({ CODEX_CHATGPT_WEB_REQUEST_INJECTION_CDP_PRIMARY: "0" })).toBeFalse();
  expect(chatGptRequestInjectionCdpPrimaryEnabled({ CODEX_CHATGPT_WEB_REQUEST_INJECTION_CDP_PRIMARY: "1" })).toBeTrue();
});

function pageRequestInjectorFixture() {
  const sent: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fakeWindow: Record<string, unknown> & {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  } = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ input, init });
      return new Response("", { status: 200 });
    },
  };
  const runInPage = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const globals = globalThis as any;
    const hadWindow = Object.prototype.hasOwnProperty.call(globals, "window");
    const hadLocation = Object.prototype.hasOwnProperty.call(globals, "location");
    const previousWindow = globals.window;
    const previousLocation = globals.location;
    globals.window = fakeWindow;
    globals.location = { origin: "https://chatgpt.com" };
    try {
      return await operation();
    } finally {
      if (hadWindow) globals.window = previousWindow;
      else delete globals.window;
      if (hadLocation) globals.location = previousLocation;
      else delete globals.location;
    }
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    isClosed: () => false,
    exposeFunction: async (name: string, callback: (payload: string) => unknown) => {
      fakeWindow[name] = callback;
    },
    removeExposedFunction: async (name: string) => { delete fakeWindow[name]; },
    evaluate: async (operation: (...args: any[]) => unknown, arg?: unknown) => (
      runInPage(() => operation(arg))
    ),
  } as unknown as Page;
  return {
    page,
    sent,
    fetchConversation: async (body: string) => runInPage(() => fakeWindow.fetch(
      "https://chatgpt.com/backend-api/f/conversation",
      { method: "POST", headers: { "content-type": "application/json" }, body },
    )),
  };
}

function cdpRequestInjectorFixture(options: {
  failContinue?: boolean;
  failBlock?: boolean;
} = {}) {
  let listener: ((event: unknown) => void) | undefined;
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const session = {
    on(_event: string, next: (payload: unknown) => void) { listener = next; },
    off() {},
    async send(method: string, params?: Record<string, unknown>) {
      sent.push({ method, params });
      if (method === "Fetch.continueRequest" && params?.postData && options.failContinue) {
        throw new Error("continue failed");
      }
      if (method === "Fetch.failRequest" && options.failBlock) throw new Error("block failed");
      return {};
    },
    async detach() {},
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    context: () => ({ newCDPSession: async () => session }),
  } as unknown as Page;
  return { page, sent, emit: (event: unknown) => listener?.(event) };
}

test("page request injector directly synthesizes the observed High plus connector wire metadata", async () => {
  const fixture = pageRequestInjectorFixture();
  const placeholder = "__PLACEHOLDER__";
  const prompt = "actual prompt";
  const pluginId = "plugin:0123456789abcdef";
  const injector = await ChatGptRequestInjector.install(
    fixture.page,
    "trace_direct_metadata",
    placeholder,
    prompt,
    {
      mode: { model: "gpt-5-6-thinking", thinkingEffort: "extended" },
      connector: { pluginId, appName: "Codex Native2" },
    },
  );
  const original = {
    model: "placeholder-model",
    thinking_effort: "placeholder-effort",
    system_hints: [],
    client_prepare_state: "pending",
    keep: { untouched: true },
    messages: [{
      content: { parts: [placeholder] },
      metadata: { system_hints: [], serialization_metadata: { custom_symbol_offsets: [] } },
    }],
  };

  await fixture.fetchConversation(JSON.stringify(original));
  await injector.assertRewriteAttempt(1_000);
  expect(fixture.sent).toHaveLength(1);
  const rawRewritten = fixture.sent[0]?.init?.body;
  expect(typeof rawRewritten).toBe("string");
  const rewritten = JSON.parse(String(rawRewritten));
  expect(rewritten.model).toBe("gpt-5-6-thinking");
  expect(rewritten.thinking_effort).toBe("extended");
  expect(rewritten.system_hints).toEqual([pluginId]);
  expect(rewritten.client_prepare_state).toBe("success");
  expect(rewritten.keep).toEqual({ untouched: true });
  expect(rewritten.messages[0].content.parts).toEqual(["@Codex Native2  actual prompt"]);
  expect(rewritten.messages[0].metadata.system_hints).toEqual([pluginId]);
  expect(rewritten.messages[0].metadata.serialization_metadata.custom_symbol_offsets).toEqual([{
    id: pluginId,
    symbol: "ecosystemMention",
    startIndex: 0,
    endIndex: 14,
  }]);
  expect(injector.snapshot()).toMatchObject({
    observed: true, rewritten: true, exactValueMatches: 1, literalMatches: 1,
  });
  await injector.close();
});

test("page request injector removes stale thinking effort for the Instant direct lane", async () => {
  const fixture = pageRequestInjectorFixture();
  const placeholder = "__PLACEHOLDER__";
  const injector = await ChatGptRequestInjector.install(
    fixture.page,
    "trace_direct_instant",
    placeholder,
    "actual prompt",
    { mode: { model: "gpt-5-6" } },
  );
  await fixture.fetchConversation(JSON.stringify({
    model: "gpt-5-6-thinking",
    thinking_effort: "max",
    messages: [{ content: { parts: [placeholder] }, metadata: {} }],
  }));
  await injector.assertRewriteAttempt(1_000);
  const rewritten = JSON.parse(String(fixture.sent[0]?.init?.body));
  expect(rewritten.model).toBe("gpt-5-6");
  expect(rewritten).not.toHaveProperty("thinking_effort");
  expect(rewritten.messages[0].content.parts).toEqual(["actual prompt"]);
  await injector.close();
});

test("page request injector refuses to overwrite conflicting connector metadata", async () => {
  const fixture = pageRequestInjectorFixture();
  const placeholder = "__PLACEHOLDER__";
  const pluginId = "plugin:0123456789abcdef";
  const injector = await ChatGptRequestInjector.install(
    fixture.page,
    "trace_direct_conflict",
    placeholder,
    "actual prompt",
    { connector: { pluginId, appName: "Codex Native2" } },
  );
  const conflicting = JSON.stringify({
    model: "gpt-5-6-thinking",
    thinking_effort: "extended",
    system_hints: ["plugin:fedcba9876543210"],
    messages: [{
      content: { parts: [placeholder] },
      metadata: { system_hints: [], serialization_metadata: { custom_symbol_offsets: [] } },
    }],
  });

  await expect(fixture.fetchConversation(conflicting)).rejects.toThrow(/request-shape/);
  await expect(injector.assertRewriteAttempt(1_000)).rejects.toBeInstanceOf(ChatGptRequestInjectionFallbackError);
  expect(fixture.sent).toHaveLength(0);
  expect(injector.snapshot()).toMatchObject({ observed: true, rewritten: false, failureCode: "request-shape" });
  await injector.close();
});

test("CDP request injector rewrites exactly one placeholder as base64 postData", async () => {
  const fixture = cdpRequestInjectorFixture();
  const prompt = "real prompt Ω";
  const placeholder = "__PLACEHOLDER__";
  const injector = await ChatGptCdpRequestInjector.install(fixture.page, placeholder, prompt);
  const rawBody = `{"message":{"content":{"parts":[${JSON.stringify(placeholder)}]}},"keep":1}`;
  fixture.emit({
    requestId: "write-1",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: rawBody,
    },
  });
  await injector.assertRewriteAttempt(1_000);

  const rewritten = rewriteChatGptRequestJsonBody(rawBody, placeholder, prompt);
  expect(rewritten.ok).toBeTrue();
  const write = fixture.sent.find(entry => entry.method === "Fetch.continueRequest" && entry.params?.postData);
  expect(write).toEqual({
    method: "Fetch.continueRequest",
    params: {
      requestId: "write-1",
      postData: Buffer.from(rewritten.ok ? rewritten.body : "", "utf8").toString("base64"),
    },
  });
  expect(injector.snapshot()).toMatchObject({
    observed: true,
    rewritten: true,
    exactValueMatches: 1,
    literalMatches: 1,
    originalBodyChars: rawBody.length,
  });
  await injector.close();
});

test("CDP request injector ignores unrelated conversation posts before consuming the placeholder slot", async () => {
  const fixture = cdpRequestInjectorFixture();
  const placeholder = "__PLACEHOLDER__";
  const injector = await ChatGptCdpRequestInjector.install(fixture.page, placeholder, "real prompt");

  fixture.emit({
    requestId: "connector-preflight",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: JSON.stringify({ action: "connector-preflight", keep: 1 }),
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(injector.snapshot()).toEqual({ observed: false, rewritten: false });
  expect(fixture.sent).toContainEqual({
    method: "Fetch.continueRequest",
    params: { requestId: "connector-preflight" },
  });

  const rawBody = JSON.stringify({ message: { content: { parts: [placeholder] } }, keep: 2 });
  fixture.emit({
    requestId: "user-send",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: rawBody,
    },
  });
  await injector.assertRewriteAttempt(1_000);
  expect(injector.snapshot()).toMatchObject({ observed: true, rewritten: true, exactValueMatches: 1, literalMatches: 1 });
  expect(fixture.sent.filter(entry => entry.method === "Fetch.continueRequest" && entry.params?.postData)).toHaveLength(1);
  await injector.close();
});

test("page request injector does not consume unrelated conversation posts before placeholder traffic", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/web-stream/request-injection.ts", import.meta.url), "utf8");
  const wrappedFetch = source.indexOf("const wrappedFetch = async");
  const placeholderGuard = source.indexOf("if (!rawBody.includes(placeholderValue))", wrappedFetch);
  const consumed = source.indexOf("consumed = true;", wrappedFetch);
  expect(wrappedFetch).toBeGreaterThanOrEqual(0);
  expect(placeholderGuard).toBeGreaterThan(wrappedFetch);
  expect(consumed).toBeGreaterThan(placeholderGuard);
});
test("page request injector supports Request-object bodies without consuming unrelated connector traffic", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/web-stream/request-injection.ts", import.meta.url), "utf8");
  const wrappedFetch = source.indexOf("const wrappedFetch = async");
  const inputRequest = source.indexOf("input instanceof Request", wrappedFetch);
  const cloneText = source.indexOf("inputRequest.clone().text()", inputRequest);
  const placeholderGuard = source.indexOf("if (!rawBody.includes(placeholderValue))", cloneText);
  const consumed = source.indexOf("consumed = true;", placeholderGuard);
  const rebuiltRequest = source.indexOf("new Request(inputRequest", consumed);
  expect(wrappedFetch).toBeGreaterThanOrEqual(0);
  expect(inputRequest).toBeGreaterThan(wrappedFetch);
  expect(cloneText).toBeGreaterThan(inputRequest);
  expect(placeholderGuard).toBeGreaterThan(cloneText);
  expect(consumed).toBeGreaterThan(placeholderGuard);
  expect(rebuiltRequest).toBeGreaterThan(consumed);
});

test("page request injector rewrites one placeholder embedded in a connector-prefixed JSON string", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/web-stream/request-injection.ts", import.meta.url), "utf8");
  const wrappedFetch = source.indexOf("const wrappedFetch = async");
  const substringCount = source.indexOf("value.indexOf(placeholderValue");
  const encodedPlaceholder = source.indexOf("JSON.stringify(placeholderValue).slice(1, -1)", wrappedFetch);
  const encodedReplacement = source.indexOf("JSON.stringify(promptValue).slice(1, -1)", encodedPlaceholder);
  expect(substringCount).toBeGreaterThanOrEqual(0);
  expect(encodedPlaceholder).toBeGreaterThan(wrappedFetch);
  expect(encodedReplacement).toBeGreaterThan(encodedPlaceholder);
});

test("CDP request injector blocks malformed cardinality before exposing replay-safe fallback", async () => {
  const fixture = cdpRequestInjectorFixture();
  const placeholder = "__PLACEHOLDER__";
  const injector = await ChatGptCdpRequestInjector.install(fixture.page, placeholder, "real prompt");
  fixture.emit({
    requestId: "write-bad",
    request: {
      url: "https://chatgpt.com/backend-api/conversation",
      method: "POST",
      postData: `{"a":${JSON.stringify(placeholder)},"b":${JSON.stringify(placeholder)}}`,
    },
  });
  await expect(injector.assertRewriteAttempt(1_000)).rejects.toBeInstanceOf(ChatGptRequestInjectionFallbackError);
  expect(fixture.sent).toContainEqual({
    method: "Fetch.failRequest",
    params: { requestId: "write-bad", errorReason: "Aborted" },
  });
  expect(injector.snapshot()).toMatchObject({
    observed: true,
    rewritten: false,
    failureCode: "match-count",
    exactValueMatches: 2,
  });
  await injector.close();
});

test("CDP request injector never authorizes replay when the transport cannot prove a block", async () => {
  const fixture = cdpRequestInjectorFixture({ failContinue: true, failBlock: true });
  const placeholder = "__PLACEHOLDER__";
  const injector = await ChatGptCdpRequestInjector.install(fixture.page, placeholder, "real prompt");
  fixture.emit({
    requestId: "write-unsafe",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: `{"prompt":${JSON.stringify(placeholder)}}`,
    },
  });
  const error = await injector.assertRewriteAttempt(1_000).then(() => null, reason => reason as Error);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ChatGptRequestInjectionFallbackError);
  expect(error?.message).toContain("could neither continue the rewritten request nor prove the original request was blocked");
  await injector.close();
});

test("CDP request injector treats no observation as ambiguous instead of replay-safe", async () => {
  const fixture = cdpRequestInjectorFixture();
  const injector = await ChatGptCdpRequestInjector.install(fixture.page, "__PLACEHOLDER__", "real prompt");
  const error = await injector.assertRewriteAttempt(1).then(() => null, reason => reason as Error);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ChatGptRequestInjectionFallbackError);
  expect(error?.message).toContain("prompt replay is disabled");
  await injector.close();
});

test("CDP request injector enforces one-use placeholder semantics", async () => {
  const fixture = cdpRequestInjectorFixture();
  const placeholder = "__PLACEHOLDER__";
  const injector = await ChatGptCdpRequestInjector.install(fixture.page, placeholder, "real prompt");
  const event = (requestId: string) => ({
    requestId,
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: `{"prompt":${JSON.stringify(placeholder)}}`,
    },
  });
  fixture.emit(event("write-first"));
  await injector.assertRewriteAttempt(1_000);
  fixture.emit(event("write-duplicate"));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.sent).toContainEqual({
    method: "Fetch.failRequest",
    params: { requestId: "write-duplicate", errorReason: "Aborted" },
  });
  expect(fixture.sent.filter(entry => entry.method === "Fetch.continueRequest" && entry.params?.postData)).toHaveLength(1);
  await injector.close();
});

test("CDP shadow reuses the exact request rewrite cardinality rules without changing the body", () => {
  const prompt = "exact prompt";
  const body = `{"messages":[{"content":{"parts":[${JSON.stringify(prompt)}]}}],"other":true}`;
  expect(inspectChatGptRequestJsonBody(body, prompt)).toEqual({
    jsonObject: true,
    wouldRewrite: true,
    exactValueMatches: 1,
    literalMatches: 1,
  });

  const duplicate = `{"a":${JSON.stringify(prompt)},"b":${JSON.stringify(prompt)}}`;
  expect(inspectChatGptRequestJsonBody(duplicate, prompt)).toEqual({
    jsonObject: true,
    wouldRewrite: false,
    failureCode: "match-count",
    exactValueMatches: 2,
    literalMatches: 0,
  });
});

test("CDP shadow continues the exact paused request unchanged and records only content-free shape metadata", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const session = {
    on(event: string, listener: (payload: unknown) => void) {
      listeners.set(event, listener);
    },
    off(event: string) {
      listeners.delete(event);
    },
    async send(method: string, params?: Record<string, unknown>) {
      sent.push({ method, params });
      return {};
    },
    async detach() {},
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    context: () => ({ newCDPSession: async () => session }),
  } as unknown as Page;
  const prompt = "secret prompt never logged";
  const shadow = await ChatGptCdpRequestInjectionShadow.install(page, prompt);
  const listener = listeners.get("Fetch.requestPaused");
  expect(listener).toBeFunction();
  const body = `{"message":{"content":{"parts":[${JSON.stringify(prompt)}]}}}`;
  listener?.({
    requestId: "fetch-1",
    request: {
      url: "https://chatgpt.com/backend-api/f/conversation",
      method: "POST",
      postData: body,
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(shadow.snapshot()).toEqual({
    observed: true,
    supportedBody: true,
    bodyTransport: "post-data",
    bodyChars: body.length,
    jsonObject: true,
    wouldRewrite: true,
    exactValueMatches: 1,
    literalMatches: 1,
  });
  const continued = sent.find(entry => entry.method === "Fetch.continueRequest");
  expect(continued).toEqual({ method: "Fetch.continueRequest", params: { requestId: "fetch-1" } });
  expect(continued?.params).not.toHaveProperty("postData");
  await shadow.close();
});

test("CDP shadow fails closed on missing postData while still continuing the untouched request", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const continued: Record<string, unknown>[] = [];
  const session = {
    on(_event: string, next: (payload: unknown) => void) { listener = next; },
    off() {},
    async send(method: string, params?: Record<string, unknown>) {
      if (method === "Fetch.continueRequest" && params) continued.push(params);
      return {};
    },
    async detach() {},
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    context: () => ({ newCDPSession: async () => session }),
  } as unknown as Page;
  const shadow = await ChatGptCdpRequestInjectionShadow.install(page, "prompt");
  listener?.({
    requestId: "fetch-2",
    request: {
      url: "https://chatgpt.com/backend-api/conversation",
      method: "POST",
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(shadow.snapshot()).toEqual({
    observed: true,
    supportedBody: false,
    bodyTransport: "missing-post-data",
    jsonObject: false,
    wouldRewrite: false,
    failureCode: "missing-post-data",
    exactValueMatches: 0,
    literalMatches: 0,
    bodyChars: 0,
  });
  expect(continued).toEqual([{ requestId: "fetch-2" }]);
  await shadow.close();
});

test("request rewrite matching counts exact JSON string values but never object keys", () => {
  const prompt = "unique prompt";
  expect(countExactJsonStringValues({
    [prompt]: "key must not count",
    message: { content: { parts: [prompt] } },
    metadata: { similar: `${prompt} suffix`, other: "different" },
  }, prompt)).toBe(1);
  expect(countExactJsonStringValues({ a: prompt, b: [prompt] }, prompt)).toBe(2);
  expect(countExactJsonStringValues({ a: `${prompt}\n` }, prompt)).toBe(0);
});

test("request injection placeholder recognition accepts only generated nonce shape", () => {
  const placeholder = createChatGptRequestInjectionPlaceholder("real prompt");
  expect(isChatGptRequestInjectionPlaceholder(placeholder)).toBeTrue();
  expect(isChatGptRequestInjectionPlaceholder(`${placeholder}x`)).toBeFalse();
  expect(isChatGptRequestInjectionPlaceholder(`__CODEX_WEB_PROMPT_${"a".repeat(31)}__`)).toBeFalse();
  expect(isChatGptRequestInjectionPlaceholder(`__CODEX_WEB_PROMPT_${"A".repeat(32)}__`)).toBeFalse();
  expect(isChatGptRequestInjectionPlaceholder("real prompt")).toBeFalse();
});

test("request injection rewrites exactly one JSON value while preserving every other request byte", () => {
  const placeholder = createChatGptRequestInjectionPlaceholder("real prompt");
  const body = `{"z":1, "message":{"content":{"parts":[${JSON.stringify(placeholder)}]}}, "keep":"x"}`;
  const result = rewriteChatGptRequestJsonBody(body, placeholder, "real\nprompt");
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error("rewrite unexpectedly failed");
  expect(result.exactValueMatches).toBe(1);
  expect(result.literalMatches).toBe(1);
  expect(result.body).toBe(body.replace(JSON.stringify(placeholder), JSON.stringify("real\nprompt")));
});

test("request injection fails closed for duplicate values, object-key collisions, invalid JSON, and non-object JSON", () => {
  const placeholder = "__PLACEHOLDER__";
  expect(rewriteChatGptRequestJsonBody(
    JSON.stringify({ a: placeholder, b: placeholder }),
    placeholder,
    "prompt",
  )).toEqual({ ok: false, failureCode: "match-count", exactValueMatches: 2, literalMatches: 0 });
  const keyCollision = `{"${placeholder}":"key", "value":${JSON.stringify(placeholder)}}`;
  expect(rewriteChatGptRequestJsonBody(keyCollision, placeholder, "prompt")).toEqual({
    ok: false,
    failureCode: "literal-count",
    exactValueMatches: 1,
    literalMatches: 2,
  });
  expect(rewriteChatGptRequestJsonBody("{", placeholder, "prompt").ok).toBeFalse();
  expect(rewriteChatGptRequestJsonBody("[]", placeholder, "prompt").ok).toBeFalse();
});

test("wire waiters wake on stream start and terminal response", async () => {
  const capture = new ChatGptWireCapture();
  const started = capture.waitForStart(1_000);
  capture.accept({
    type: "start",
    streamId: "stream",
    url: "https://chatgpt.com/backend-api/f/conversation",
    status: 200,
    contentType: "text/event-stream",
  });
  expect((await started)?.streamId).toBe("stream");

  const ended = capture.waitForEnd(1_000);
  capture.accept({ type: "chunk", streamId: "stream", chunk: "data: [DONE]\n\n" });
  capture.accept({ type: "end", streamId: "stream" });
  expect((await ended)?.complete).toBeTrue();
});

test("wire capture timestamps the first final-answer text separately from transport chunks", () => {
  const capture = new ChatGptWireCapture();
  capture.accept({
    type: "start",
    streamId: "stream",
    url: "https://chatgpt.com/backend-api/f/conversation",
    status: 200,
    contentType: "text/event-stream",
  });
  capture.accept({ type: "chunk", streamId: "stream", chunk: sse({ type: "heartbeat" }) });
  expect(capture.snapshot().firstChunkAt).toBeNumber();
  expect(capture.snapshot().firstTextAt).toBeUndefined();

  capture.accept({
    type: "chunk",
    streamId: "stream",
    chunk: sse({
      message: {
        author: { role: "assistant" },
        channel: "final",
        recipient: "all",
        content: { content_type: "text", parts: ["answer"] },
      },
    }),
  });
  expect(capture.snapshot().firstTextAt).toBeNumber();
});

test("stream handoff extracts only an exact conversation-turn WebSocket topic", () => {
  expect(chatGptStreamHandoffTopic({
    type: "stream_handoff",
    options: [
      { type: "something_else", topic_id: "conversation-turn-wrong" },
      { type: "subscribe_ws_topic", topic_id: "conversation-turn-pro_123" },
    ],
  })).toBe("conversation-turn-pro_123");
  expect(chatGptStreamHandoffTopic({
    type: "stream_handoff",
    options: [{ type: "subscribe_ws_topic", topic_id: "other-topic" }],
  })).toBeUndefined();
});

test("WebSocket handoff accepts only exact-topic nested encoded SSE items", () => {
  const encoded = sse({ type: "message_stream_complete", conversation_id: "conversation-pro" });
  const exact = JSON.stringify({
    type: "message",
    topic_id: "conversation-turn-pro_123",
    payload: { payload: { encoded_item: encoded } },
  });
  const wrong = JSON.stringify({
    type: "message",
    topic_id: "conversation-turn-other",
    payload: { payload: { encoded_item: "private other-turn data" } },
  });
  expect(chatGptWebSocketEncodedItems(exact, "conversation-turn-pro_123")).toEqual([encoded]);
  expect(chatGptWebSocketEncodedItems(wrong, "conversation-turn-pro_123")).toEqual([]);
});

test("bootstrap DONE does not complete a handed-off turn, but exact-topic WS completion does", () => {
  const capture = new ChatGptWireCapture();
  capture.accept({
    type: "start",
    streamId: "pro-stream",
    url: "https://chatgpt.com/backend-api/f/conversation",
    status: 200,
    contentType: "text/event-stream",
  });
  capture.accept({
    type: "chunk",
    streamId: "pro-stream",
    chunk: sse({
      type: "stream_handoff",
      conversation_id: "conversation-pro",
      options: [{ type: "subscribe_ws_topic", topic_id: "conversation-turn-pro_123" }],
    }) + "data: [DONE]\n\n",
  });
  capture.accept({ type: "end", streamId: "pro-stream" });

  expect(capture.snapshot().handoffTopicId).toBe("conversation-turn-pro_123");
  expect(capture.snapshot().complete).toBeFalse();
  expect(capture.snapshot().completedAt).toBeUndefined();

  capture.acceptWebSocketFrame(JSON.stringify({
    type: "message",
    topic_id: "conversation-turn-other",
    payload: { payload: { encoded_item: sse({ type: "message_stream_complete" }) } },
  }));
  expect(capture.snapshot().complete).toBeFalse();

  capture.acceptWebSocketFrame(JSON.stringify({
    type: "message",
    topic_id: "conversation-turn-pro_123",
    payload: {
      payload: {
        encoded_item: sse({
          message: {
            author: { role: "assistant" },
            recipient: "all",
            channel: "final",
            content: { content_type: "text", parts: ["Pro answer"] },
            status: "finished_successfully",
            end_turn: true,
          },
          conversation_id: "conversation-pro",
        }),
      },
    },
  }));
  const final = capture.snapshot();
  expect(final.text).toBe("Pro answer");
  expect(final.complete).toBeTrue();
  expect(final.completedAt).toBeNumber();
  expect(final.firstHandoffChunkAt).toBeNumber();
});

test("tap installation fails closed before touching a non-temporary page", async () => {
  let exposed = false;
  const page = {
    url: () => "https://chatgpt.com/",
    exposeFunction: async () => { exposed = true; },
  } as unknown as Page;
  await expect(ChatGptWebStreamTap.install(page, "trace")).rejects.toThrow("left the isolated Temporary Chat surface");
  expect(exposed).toBeFalse();
});

test("request injection shadow fails closed before touching a non-temporary page", async () => {
  let exposed = false;
  const page = {
    url: () => "https://chatgpt.com/",
    exposeFunction: async () => { exposed = true; },
  } as unknown as Page;
  await expect(ChatGptRequestInjectionShadow.install(page, "trace", "secret prompt"))
    .rejects.toThrow("left the isolated Temporary Chat surface");
  expect(exposed).toBeFalse();
});

test("CDP request injection shadow fails closed before attaching to a non-temporary page", async () => {
  let attached = false;
  const page = {
    url: () => "https://chatgpt.com/",
    context: () => ({
      newCDPSession: async () => {
        attached = true;
        return {};
      },
    }),
  } as unknown as Page;
  await expect(ChatGptCdpRequestInjectionShadow.install(page, "secret prompt"))
    .rejects.toThrow("left the isolated Temporary Chat surface");
  expect(attached).toBeFalse();
});

test("request injection shadow wraps the real prompt before DOM attachment without changing the send path", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const installed = source.indexOf("ChatGptRequestInjectionShadow.install(");
  const promptStage = source.indexOf('"prompt_attachment"', installed);
  const sent = source.indexOf("let finalSubmissionEvidence", promptStage);
  const streamClosed = source.indexOf("await webStreamTap.close()", sent);
  const shadowClosed = source.indexOf("await requestInjectionShadow.close()", streamClosed);

  expect(installed).toBeGreaterThan(-1);
  expect(promptStage).toBeGreaterThan(installed);
  expect(sent).toBeGreaterThan(promptStage);
  expect(streamClosed).toBeGreaterThan(sent);
  expect(shadowClosed).toBeGreaterThan(streamClosed);
  expect(source).toContain('turnPlan.requestInjection === "shadow"');
  expect(source).toContain('mode: "request-injection-shadow"');
});

test("browser turns install the shadow only after attachments and close it before releasing the page", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const fileAttached = source.indexOf('await diagnostics.capture(page, "file-attachment-complete")');
  const installed = source.indexOf("ChatGptWebStreamTap.install(page, turn.traceId)", fileAttached);
  const sent = source.indexOf("let finalSubmissionEvidence", installed);
  const networkPrimary = source.indexOf("const domFailureBeforeWire", sent);
  const closed = source.indexOf("await webStreamTap.close()", networkPrimary);
  const connectionReleased = source.indexOf("await turnConnection.close()", closed);

  expect(fileAttached).toBeGreaterThan(-1);
  expect(installed).toBeGreaterThan(fileAttached);
  expect(sent).toBeGreaterThan(installed);
  expect(networkPrimary).toBeGreaterThan(sent);
  expect(closed).toBeGreaterThan(sent);
  expect(connectionReleased).toBeGreaterThan(closed);
  expect(source.slice(networkPrimary, closed)).toContain(
    'void responseTurnPromise.catch(error => resolve({ source: "dom-error", error }))',
  );
  expect(source.slice(networkPrimary, closed)).not.toContain('source: "dom" as const');
  expect(source).toContain("completed from Temporary Chat network stream");
  expect(source).toContain("firstTextMs=");
  expect(source).toContain("domCompletionMs=");
  expect(source).toContain("[chatgpt-web-metric]");
  expect(source).toContain('turnPlan.networkStream === "primary"');
});

test("opt-in request injection keeps the SPA submit pipeline and has a fail-closed DOM fallback", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const installed = source.indexOf("ChatGptRequestInjector.install(");
  const placeholderAttached = source.indexOf("promptForAttachment", installed);
  const send = source.indexOf('"send"', placeholderAttached);
  const rewriteProbe = source.indexOf("assertRewriteAttempt(5_000", send);
  const fallback = source.indexOf("assertRequestInjectionFallbackSafe", rewriteProbe);
  const closeStream = source.indexOf("await webStreamTap.close()", fallback);
  const closeInjector = source.indexOf("await activeRequestInjector.close()", closeStream);
  const fallbackPrompt = source.indexOf("finalPrompt,", closeInjector);
  const fallbackSend = source.indexOf('"send_fallback"', fallbackPrompt);

  expect(installed).toBeGreaterThan(-1);
  expect(placeholderAttached).toBeGreaterThan(installed);
  expect(send).toBeGreaterThan(placeholderAttached);
  expect(rewriteProbe).toBeGreaterThan(send);
  expect(fallback).toBeGreaterThan(rewriteProbe);
  expect(closeStream).toBeGreaterThan(fallback);
  expect(closeInjector).toBeGreaterThan(closeStream);
  expect(fallbackPrompt).toBeGreaterThan(closeInjector);
  expect(fallbackSend).toBeGreaterThan(fallbackPrompt);
  expect(source).toContain('turnPlan.requestInjection === "primary"');
  expect(source).toContain('mode: "request-injection-primary"');
});

test("default-off CDP request shadow is observational only and is scoped to the final send window", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const filesAttached = source.indexOf('await diagnostics.capture(page, "file-attachment-complete")');
  const installed = source.indexOf("ChatGptCdpRequestInjectionShadow.install(page, finalPrompt)", filesAttached);
  const send = source.indexOf("let finalSubmissionEvidence", installed);
  const metric = source.indexOf('mode: "request-injection-cdp-shadow"', send);
  const closed = source.indexOf("await requestInjectionCdpShadow.close()", metric);
  const connectionReleased = source.indexOf("await turnConnection.close()", closed);

  expect(filesAttached).toBeGreaterThan(-1);
  expect(installed).toBeGreaterThan(filesAttached);
  expect(send).toBeGreaterThan(installed);
  expect(metric).toBeGreaterThan(send);
  expect(closed).toBeGreaterThan(metric);
  expect(connectionReleased).toBeGreaterThan(closed);
  expect(source).toContain("chatGptRequestInjectionCdpShadowEnabled()");
  expect(source).toContain("turnPlan.requestInjectionCdpShadow");
  expect(source.slice(installed, send)).not.toContain("promptForAttachment =");
});
