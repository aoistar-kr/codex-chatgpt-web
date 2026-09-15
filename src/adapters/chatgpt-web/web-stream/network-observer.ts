import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "playwright-core";

import { assertTemporaryChatPage } from "../../../chatgpt-session";
import { ChatGptConversationSseAccumulator, type ChatGptWireSnapshot } from "./conversation-sse";
import {
  chatGptCompletedRebindDiagnosticsEnabled,
  chatGptIncompleteCaptureRecoveryEnabled,
  chatGptStreamProtocolDiagnosticsEnabled,
} from "./flags";
import { chatGptWebSocketEncodedItems } from "./websocket-handoff";

const CHATGPT_CONVERSATION_POST = /^\/backend-api\/(?:f\/)?conversation$/;

type WireEvent =
  | { type: "start"; streamId: string; url: string; status: number; contentType: string }
  | { type: "chunk"; streamId: string; chunk: string }
  | { type: "end"; streamId: string }
  | { type: "error"; streamId: string; message: string };

export class ChatGptWireCapture {
  private readonly accumulator: ChatGptConversationSseAccumulator;
  private streamId?: string;
  private status?: number;
  private contentType?: string;
  private startedAt?: number;
  private firstChunkAt?: number;
  private firstTextAt?: number;
  private completedAt?: number;
  private handoffObservedAt?: number;
  private firstHandoffChunkAt?: number;
  private failed = false;
  private readonly listeners = new Set<(snapshot: ChatGptWireSnapshot) => void>();

  constructor(recordProtocolTrace = false) {
    this.accumulator = new ChatGptConversationSseAccumulator(recordProtocolTrace);
  }

  accept(event: WireEvent): void {
    if (event.type === "start") {
      if (this.streamId !== undefined) return;
      this.streamId = event.streamId;
      this.status = event.status;
      this.contentType = event.contentType;
      this.startedAt = Date.now();
      this.notify();
      return;
    }
    if (event.streamId !== this.streamId) return;
    if (event.type === "chunk") {
      this.firstChunkAt ??= Date.now();
      const textBefore = this.accumulator.snapshot().text;
      const handoffBefore = this.accumulator.snapshot().handoffTopicId;
      this.accumulator.feed(event.chunk);
      const after = this.accumulator.snapshot();
      if (!handoffBefore && after.handoffTopicId) this.handoffObservedAt ??= Date.now();
      if (!textBefore && after.text) this.firstTextAt ??= Date.now();
      this.notify();
      return;
    }
    this.accumulator.end();
    if (event.type === "error") this.failed = true;
    if (this.failed || this.accumulator.snapshot().complete) this.completedAt = Date.now();
    this.notify();
  }

  acceptWebSocketFrame(payload: string): void {
    const topicId = this.accumulator.snapshot().handoffTopicId;
    if (!topicId || !this.streamId || this.failed || this.completedAt !== undefined) return;
    const chunks = chatGptWebSocketEncodedItems(payload, topicId);
    if (chunks.length === 0) return;
    this.firstHandoffChunkAt ??= Date.now();
    for (const chunk of chunks) {
      const textBefore = this.accumulator.snapshot().text;
      this.accumulator.feed(chunk, "handoff");
      if (!textBefore && this.accumulator.snapshot().text) this.firstTextAt ??= Date.now();
    }
    if (this.accumulator.snapshot().complete) this.completedAt = Date.now();
    this.notify();
  }

  snapshot(): ChatGptWireSnapshot {
    return {
      streamId: this.streamId,
      ...this.accumulator.snapshot(),
      failed: this.failed,
      status: this.status,
      contentType: this.contentType,
      startedAt: this.startedAt,
      firstChunkAt: this.firstChunkAt,
      firstTextAt: this.firstTextAt,
      completedAt: this.completedAt,
      handoffObservedAt: this.handoffObservedAt,
      firstHandoffChunkAt: this.firstHandoffChunkAt,
    };
  }

  subscribe(listener: (snapshot: ChatGptWireSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  waitForStart(timeoutMs: number, signal?: AbortSignal): Promise<ChatGptWireSnapshot | undefined> {
    return this.waitFor(snapshot => snapshot.streamId !== undefined, timeoutMs, signal);
  }

  waitForEnd(timeoutMs: number, signal?: AbortSignal): Promise<ChatGptWireSnapshot | undefined> {
    return this.waitFor(snapshot => snapshot.completedAt !== undefined, timeoutMs, signal);
  }

  private waitFor(
    predicate: (snapshot: ChatGptWireSnapshot) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ChatGptWireSnapshot | undefined> {
    const initial = this.snapshot();
    if (predicate(initial)) return Promise.resolve(initial);
    if (signal?.aborted || timeoutMs <= 0) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let settled = false;
      const finish = (value: ChatGptWireSnapshot | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish(undefined);
      const unsubscribe = this.subscribe(snapshot => {
        if (predicate(snapshot)) finish(snapshot);
      });
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

/**
 * Passive, per-turn stream tap. It never changes the request or the response returned to ChatGPT.
 * Installation is fail-closed unless the owned page is an exact Temporary Chat surface.
 */
export class ChatGptWebStreamTap {
  private capture?: ChatGptWireCapture;
  private closed = false;
  private cdpSession?: CDPSession;
  private webSocketFrameListener?: (event: { response?: { opcode?: number; payloadData?: string } }) => void;

  private constructor(
    private readonly page: Page,
    private readonly bindingName: string,
    private readonly token: string,
  ) {}

  static async install(page: Page, traceId: string): Promise<ChatGptWebStreamTap> {
    await assertTemporaryChatPage(page);
    const safeTrace = traceId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
    const token = randomUUID();
    const bindingName = `__codexWebStream_${safeTrace}_${token.replaceAll("-", "")}`;
    const tap = new ChatGptWebStreamTap(page, bindingName, token);
    await page.exposeFunction(bindingName, (payload: string) => tap.receive(payload));
    try {
      await page.evaluate(({ bindingName: installedBinding, token: installedToken, requestDiagnostics }) => {
      const root = window as typeof window & {
        __codexWebStreamTap?: { token: string; restore(): void; requestDiagnostic?(): {
          wrapperCurrent: boolean; conversationPostAttempts: number; saturated: boolean;
        } };
        [key: string]: unknown;
      };
      root.__codexWebStreamTap?.restore();
      const originalFetch = window.fetch.bind(window);
      const binding = root[installedBinding];
      if (typeof binding !== "function") throw new Error("ChatGPT stream binding was not installed in the page main world");
      const emit = (event: unknown) => {
        try {
          void (binding as (payload: string) => Promise<unknown>)(JSON.stringify(event));
        } catch {
          // A disconnected observer must never disturb the original ChatGPT response.
        }
      };
      const isConversationPost = (input: RequestInfo | URL, init?: RequestInit): boolean => {
        try {
          const request = input instanceof Request ? input : undefined;
          const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
          if (method !== "POST") return false;
          const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : request?.url ?? "";
          const url = new URL(rawUrl, location.origin);
          return url.origin === location.origin && /^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname);
        } catch {
          return false;
        }
      };
      let conversationPostAttempts = 0;
      const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        // Diagnostic only. Count before fetch so rejection/non-SSE responses are not hidden.
        // This is page-fetch coverage, NOT a browser-wide/network duplicate-submission proof.
        if (requestDiagnostics && isConversationPost(input, init)) {
          conversationPostAttempts = Math.min(1_000, conversationPostAttempts + 1);
        }
        const response = await originalFetch(input, init);
        try {
          if (!isConversationPost(input, init)) return response;
          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("text/event-stream") || !response.body || response.bodyUsed) return response;
          const copy = response.clone();
          if (!copy.body) return response;
          const streamId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          emit({ type: "start", streamId, url: response.url, status: response.status, contentType });
          const reader = copy.body.getReader();
          const decoder = new TextDecoder();
          void (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                if (chunk) emit({ type: "chunk", streamId, chunk });
              }
              const tail = decoder.decode();
              if (tail) emit({ type: "chunk", streamId, chunk: tail });
              emit({ type: "end", streamId });
            } catch (error) {
              emit({
                type: "error",
                streamId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
        } catch {
          // The passive copy is optional. Always return the untouched original response.
        }
        return response;
      };
      window.fetch = wrappedFetch as typeof window.fetch;
      root.__codexWebStreamTap = {
        token: installedToken,
        ...(requestDiagnostics ? { requestDiagnostic: () => ({
          wrapperCurrent: window.fetch === wrappedFetch,
          conversationPostAttempts, saturated: conversationPostAttempts >= 1_000,
        }) } : {}),
        restore() {
          if (window.fetch === wrappedFetch) window.fetch = originalFetch;
          if (root.__codexWebStreamTap?.token === installedToken) delete root.__codexWebStreamTap;
        },
      };
      }, {
        bindingName,
        token,
        requestDiagnostics: chatGptCompletedRebindDiagnosticsEnabled() || chatGptIncompleteCaptureRecoveryEnabled(),
      });
      // The POST response carries the bootstrap SSE. Extended/Pro turns may then move the same
      // logical stream to a WebSocket topic. Observe Chromium's Network domain passively so the
      // DOM path remains authoritative if CDP is unavailable or the handoff format changes.
      let cdpSession: CDPSession | undefined;
      try {
        cdpSession = await page.context().newCDPSession(page);
        const listener = (event: { response?: { opcode?: number; payloadData?: string } }) => {
          if (event.response?.opcode !== 1 || typeof event.response.payloadData !== "string") return;
          tap.capture?.acceptWebSocketFrame(event.response.payloadData);
        };
        await cdpSession.send("Network.enable");
        cdpSession.on("Network.webSocketFrameReceived", listener);
        tap.cdpSession = cdpSession;
        tap.webSocketFrameListener = listener;
      } catch {
        await cdpSession?.detach().catch(() => {});
        // Fetch shadow still covers ordinary SSE turns. Never fail a browser turn merely because
        // an optional passive WebSocket observer could not attach.
      }
    } catch (error) {
      const removablePage = page as Page & { removeExposedFunction?: (name: string) => Promise<void> };
      await removablePage.removeExposedFunction?.(bindingName).catch(() => {});
      throw error;
    }
    return tap;
  }

  beginCapture(): ChatGptWireCapture {
    if (this.closed) throw new Error("ChatGPT web stream tap is closed");
    this.capture = new ChatGptWireCapture(chatGptStreamProtocolDiagnosticsEnabled());
    return this.capture;
  }

  /** Use the fresh page after reconnect; counters survive only on the original document.
   * Wrapper equality is an endpoint check, not proof that it was never bypassed/replaced. */
  async readFetchSubmissionDiagnostic(page: Page = this.page) {
    if (this.closed) return { available: false as const };
    return page.evaluate(token => {
      const state = (window as typeof window & { __codexWebStreamTap?: {
        token: string; requestDiagnostic?(): { wrapperCurrent: boolean; conversationPostAttempts: number; saturated: boolean };
      } }).__codexWebStreamTap;
      if (state?.token !== token || !state.requestDiagnostic) return { available: false as const };
      return { available: true as const, ...state.requestDiagnostic() };
    }, this.token);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const cdpSession = this.cdpSession;
    const webSocketFrameListener = this.webSocketFrameListener;
    this.cdpSession = undefined;
    this.webSocketFrameListener = undefined;
    if (cdpSession) {
      if (webSocketFrameListener) cdpSession.off("Network.webSocketFrameReceived", webSocketFrameListener);
      await cdpSession.detach().catch(() => {});
    }
    if (!this.page.isClosed()) {
      await this.page.evaluate((token) => {
        const root = window as typeof window & { __codexWebStreamTap?: { token: string; restore(): void } };
        if (root.__codexWebStreamTap?.token === token) root.__codexWebStreamTap.restore();
      }, this.token).catch(() => {});
      const removablePage = this.page as Page & { removeExposedFunction?: (name: string) => Promise<void> };
      await removablePage.removeExposedFunction?.(this.bindingName).catch(() => {});
    }
  }

  private receive(payload: string): void {
    if (this.closed || !this.capture) return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isWireEvent(event)) return;
    this.capture.accept(event);
  }
}

function isWireEvent(value: unknown): value is WireEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || typeof event.streamId !== "string") return false;
  if (event.type === "start") {
    return typeof event.url === "string"
      && typeof event.status === "number"
      && typeof event.contentType === "string";
  }
  if (event.type === "chunk") return typeof event.chunk === "string";
  if (event.type === "end") return true;
  return event.type === "error" && typeof event.message === "string";
}

export function isChatGptConversationPostUrl(value: string): boolean {
  try {
    const url = new URL(value, "https://chatgpt.com");
    return url.origin === "https://chatgpt.com" && CHATGPT_CONVERSATION_POST.test(url.pathname);
  } catch {
    return false;
  }
}
