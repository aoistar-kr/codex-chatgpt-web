import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "playwright-core";

import { assertTemporaryChatPage } from "../../../chatgpt-session";

export type ChatGptRequestInjectionShadowSnapshot = {
  observed: boolean;
  supportedBody?: boolean;
  bodyTransport?: "init-string" | "request-clone" | "unsupported";
  jsonObject?: boolean;
  exactValueMatches?: number;
  bodyChars?: number;
  promptShape?: ChatGptRequestPromptShape;
};

/** Canary-only similarity evidence, never a prompt match or rewrite authorization. */
export type ChatGptRequestPromptShape = {
  candidateFound: boolean;
  candidateTied: boolean;
  scanTruncated: boolean;
  lineEndingsEqual: boolean;
  trimEqual: boolean;
  removedQuoteMarkersEqual: boolean;
  addedEscapingOnly: boolean;
  addedEscapeBackslashes: number;
  addedHtmlEntities: number;
  stringValues: number;
  targetChars: number;
  candidateChars: number;
  commonPrefixChars: number;
  commonSuffixChars: number;
  targetNewlines: number;
  candidateNewlines: number;
  targetBackslashes: number;
  candidateBackslashes: number;
  targetQuoteLines: number;
  candidateQuoteLines: number;
};

export type ChatGptDirectRequestMetadata = {
  connector?: { pluginId: string; appName: string };
  mode?: { model: string; thinkingEffort?: string };
};

export type ChatGptRequestInjectionSnapshot = {
  observed: boolean;
  rewritten: boolean;
  failureCode?: "unsupported-body" | "invalid-json" | "non-object-json" | "match-count" | "literal-count" | "request-shape" | "transport";
  exactValueMatches?: number;
  literalMatches?: number;
  originalBodyChars?: number;
  rewrittenBodyChars?: number;
};

export type ChatGptCdpRequestInjectionShadowSnapshot = {
  observed: boolean;
  supportedBody?: boolean;
  bodyTransport?: "post-data" | "missing-post-data";
  jsonObject?: boolean;
  wouldRewrite?: boolean;
  failureCode?: "missing-post-data" | "invalid-json" | "non-object-json" | "match-count" | "literal-count";
  exactValueMatches?: number;
  literalMatches?: number;
  bodyChars?: number;
};

type RequestInjectionShadowEvent = {
  type: "request-shadow";
  supportedBody: boolean;
  bodyTransport: "init-string" | "request-clone" | "unsupported";
  jsonObject: boolean;
  exactValueMatches: number;
  bodyChars: number;
  promptShape?: ChatGptRequestPromptShape;
};

type RequestInjectionEvent = {
  type: "request-injection";
  rewritten: boolean;
  failureCode?: ChatGptRequestInjectionSnapshot["failureCode"];
  exactValueMatches: number;
  literalMatches: number;
  originalBodyChars: number;
  rewrittenBodyChars: number;
};

export class ChatGptRequestInjectionFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptRequestInjectionFallbackError";
  }
}

/** Count exact JSON string values only. Object keys are deliberately never considered. */
export function countExactJsonStringValues(value: unknown, target: string): number {
  if (typeof value === "string") return value === target ? 1 : 0;
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countExactJsonStringValues(entry, target), 0);
  }
  if (!value || typeof value !== "object") return 0;
  return Object.values(value as Record<string, unknown>)
    .reduce<number>((count, entry) => count + countExactJsonStringValues(entry, target), 0);
}

export type ChatGptRequestBodyRewriteResult =
  | {
      ok: true;
      body: string;
      exactValueMatches: 1;
      literalMatches: 1;
    }
  | {
      ok: false;
      failureCode: "invalid-json" | "non-object-json" | "match-count" | "literal-count";
      exactValueMatches: number;
      literalMatches: number;
    };

/** Byte-preserving except for the one exact JSON string literal selected for replacement. */
export function rewriteChatGptRequestJsonBody(
  rawBody: string,
  placeholder: string,
  prompt: string,
): ChatGptRequestBodyRewriteResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return { ok: false, failureCode: "invalid-json", exactValueMatches: 0, literalMatches: 0 };
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return { ok: false, failureCode: "non-object-json", exactValueMatches: 0, literalMatches: 0 };
  }
  const exactValueMatches = countExactJsonStringValues(decoded, placeholder);
  if (exactValueMatches !== 1) {
    return { ok: false, failureCode: "match-count", exactValueMatches, literalMatches: 0 };
  }
  const placeholderLiteral = JSON.stringify(placeholder);
  let literalMatches = 0;
  let searchFrom = 0;
  for (;;) {
    const index = rawBody.indexOf(placeholderLiteral, searchFrom);
    if (index < 0) break;
    literalMatches += 1;
    searchFrom = index + placeholderLiteral.length;
  }
  if (literalMatches !== 1) {
    return { ok: false, failureCode: "literal-count", exactValueMatches, literalMatches };
  }
  const replacementLiteral = JSON.stringify(prompt);
  const literalIndex = rawBody.indexOf(placeholderLiteral);
  return {
    ok: true,
    body: rawBody.slice(0, literalIndex)
      + replacementLiteral
      + rawBody.slice(literalIndex + placeholderLiteral.length),
    exactValueMatches: 1,
    literalMatches: 1,
  };
}

export function createChatGptRequestInjectionPlaceholder(prompt: string): string {
  for (;;) {
    const candidate = `__CODEX_WEB_PROMPT_${randomUUID().replaceAll("-", "")}__`;
    if (!prompt.includes(candidate)) return candidate;
  }
}

export function isChatGptRequestInjectionPlaceholder(value: string): boolean {
  return /^__CODEX_WEB_PROMPT_[0-9a-f]{32}__$/.test(value);
}

/**
 * Applies the exact production rewrite cardinality rules without changing the body. H4's CDP
 * shadow uses the real DOM/page-fetch prompt as the target and discards the returned body; this
 * answers only whether the same request would be eligible for a one-value rewrite.
 */
export function inspectChatGptRequestJsonBody(
  rawBody: string,
  target: string,
): Omit<ChatGptCdpRequestInjectionShadowSnapshot, "observed" | "supportedBody" | "bodyTransport" | "bodyChars"> {
  const result = rewriteChatGptRequestJsonBody(rawBody, target, target);
  if (result.ok) {
    return {
      jsonObject: true,
      wouldRewrite: true,
      exactValueMatches: result.exactValueMatches,
      literalMatches: result.literalMatches,
    };
  }
  return {
    jsonObject: result.failureCode !== "invalid-json" && result.failureCode !== "non-object-json",
    wouldRewrite: false,
    failureCode: result.failureCode,
    exactValueMatches: result.exactValueMatches,
    literalMatches: result.literalMatches,
  };
}

type ChatGptFetchRequestPausedEvent = {
  requestId: string;
  request: {
    url: string;
    method: string;
    postData?: string;
  };
};

/**
 * Default-off H4 transport probe. Chromium pauses only matching request candidates, this class
 * inspects content-free rewrite cardinality, and then continues the exact original request by
 * requestId only. It never supplies postData to Fetch.continueRequest and therefore has no write
 * authority. Any CDP attach/format failure is isolated to this optional diagnostic path.
 */
export class ChatGptCdpRequestInjectionShadow {
  private closed = false;
  private snapshotValue: ChatGptCdpRequestInjectionShadowSnapshot = { observed: false };
  private requestPausedListener?: (event: ChatGptFetchRequestPausedEvent) => void;

  private constructor(
    private readonly cdpSession: CDPSession,
    private readonly pageOrigin: string,
    private readonly prompt: string,
  ) {}

  static async install(page: Page, prompt: string): Promise<ChatGptCdpRequestInjectionShadow> {
    await assertTemporaryChatPage(page);
    const pageOrigin = new URL(page.url()).origin;
    let cdpSession: CDPSession | undefined;
    try {
      cdpSession = await page.context().newCDPSession(page);
      const shadow = new ChatGptCdpRequestInjectionShadow(cdpSession, pageOrigin, prompt);
      const listener = (event: ChatGptFetchRequestPausedEvent) => {
        void shadow.handleRequestPaused(event).catch(() => {
          // Optional diagnostics never make the browser turn fail. A detached/disabled Fetch
          // domain releases its paused requests, and ordinary handler errors are contained here.
        });
      };
      shadow.requestPausedListener = listener;
      cdpSession.on("Fetch.requestPaused", listener);
      await cdpSession.send("Fetch.enable", {
        patterns: [{
          urlPattern: `${pageOrigin}/backend-api/*conversation*`,
          requestStage: "Request",
        }],
      });
      return shadow;
    } catch (error) {
      await cdpSession?.send("Fetch.disable").catch(() => {});
      await cdpSession?.detach().catch(() => {});
      throw error;
    }
  }

  snapshot(): ChatGptCdpRequestInjectionShadowSnapshot {
    return { ...this.snapshotValue };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.requestPausedListener) {
      this.cdpSession.off("Fetch.requestPaused", this.requestPausedListener);
      this.requestPausedListener = undefined;
    }
    await this.cdpSession.send("Fetch.disable").catch(() => {});
    await this.cdpSession.detach().catch(() => {});
  }

  private async handleRequestPaused(event: ChatGptFetchRequestPausedEvent): Promise<void> {
    try {
      if (!this.closed && !this.snapshotValue.observed && this.isConversationPost(event.request)) {
        const rawBody = event.request.postData;
        if (typeof rawBody !== "string") {
          this.snapshotValue = {
            observed: true,
            supportedBody: false,
            bodyTransport: "missing-post-data",
            jsonObject: false,
            wouldRewrite: false,
            failureCode: "missing-post-data",
            exactValueMatches: 0,
            literalMatches: 0,
            bodyChars: 0,
          };
        } else {
          this.snapshotValue = {
            observed: true,
            supportedBody: true,
            bodyTransport: "post-data",
            bodyChars: rawBody.length,
            ...inspectChatGptRequestJsonBody(rawBody, this.prompt),
          };
        }
      }
    } finally {
      // Supplying requestId alone is the core passive invariant: Chromium continues the exact
      // request it paused, with no method/url/header/body override from this experiment.
      await this.cdpSession.send("Fetch.continueRequest", { requestId: event.requestId });
    }
  }

  private isConversationPost(request: ChatGptFetchRequestPausedEvent["request"]): boolean {
    if (request.method.toUpperCase() !== "POST") return false;
    try {
      const url = new URL(request.url);
      return url.origin === this.pageOrigin
        && /^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname);
    } catch {
      return false;
    }
  }
}

/**
 * Dedicated default-off H4 write canary. This is deliberately a separate transport from the
 * proven page-fetch injector: browser-worker never installs both writers on one turn. The CDP
 * writer keeps the same one-use placeholder/cardinality contract and only exposes a fallback
 * after Chromium has positively acknowledged that the rejected request was failed. If both
 * continueRequest and failRequest fail, the submission is transport-ambiguous and ordinary DOM
 * replay is forbidden.
 */
export class ChatGptCdpRequestInjector {
  private closed = false;
  private consumed = false;
  private snapshotValue: ChatGptRequestInjectionSnapshot = { observed: false, rewritten: false };
  private unsafeTransportError?: Error;
  private readonly listeners = new Set<() => void>();
  private requestPausedListener?: (event: ChatGptFetchRequestPausedEvent) => void;

  private constructor(
    private readonly cdpSession: CDPSession,
    private readonly pageOrigin: string,
    private readonly placeholder: string,
    private readonly prompt: string,
  ) {}

  static async install(
    page: Page,
    placeholder: string,
    prompt: string,
  ): Promise<ChatGptCdpRequestInjector> {
    await assertTemporaryChatPage(page);
    if (!placeholder || prompt.includes(placeholder)) {
      throw new Error("ChatGPT CDP request injection placeholder is invalid");
    }
    const pageOrigin = new URL(page.url()).origin;
    let cdpSession: CDPSession | undefined;
    try {
      cdpSession = await page.context().newCDPSession(page);
      const injector = new ChatGptCdpRequestInjector(cdpSession, pageOrigin, placeholder, prompt);
      const listener = (event: ChatGptFetchRequestPausedEvent) => {
        void injector.handleRequestPaused(event).catch((error) => {
          injector.markUnsafeTransportFailure(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      };
      injector.requestPausedListener = listener;
      cdpSession.on("Fetch.requestPaused", listener);
      await cdpSession.send("Fetch.enable", {
        patterns: [{
          urlPattern: `${pageOrigin}/backend-api/*conversation*`,
          requestStage: "Request",
        }],
      });
      return injector;
    } catch (error) {
      await cdpSession?.send("Fetch.disable").catch(() => {});
      await cdpSession?.detach().catch(() => {});
      throw error;
    }
  }

  snapshot(): ChatGptRequestInjectionSnapshot {
    return { ...this.snapshotValue };
  }

  async assertRewriteAttempt(timeoutMs = 5_000, signal?: AbortSignal): Promise<void> {
    await this.waitForAttempt(timeoutMs, signal);
    if (this.unsafeTransportError) throw this.unsafeTransportError;
    const snapshot = this.snapshot();
    if (!snapshot.observed) {
      // Unlike the in-page injector, failure to see the request is not proof that the browser
      // did not send it: a CDP pattern/transport drift could have let a placeholder request pass
      // outside this session. No-observation is therefore terminal for this canary, never a DOM
      // replay signal.
      throw new Error("ChatGPT CDP request injection did not observe the submitted request; prompt replay is disabled");
    }
    if (!snapshot.rewritten) {
      throw new ChatGptRequestInjectionFallbackError(
        `ChatGPT CDP request injection rejected the generated request (${snapshot.failureCode ?? "unknown"})`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.requestPausedListener) {
      this.cdpSession.off("Fetch.requestPaused", this.requestPausedListener);
      this.requestPausedListener = undefined;
    }
    await this.cdpSession.send("Fetch.disable").catch(() => {});
    await this.cdpSession.detach().catch(() => {});
    this.notify();
  }

  private async handleRequestPaused(event: ChatGptFetchRequestPausedEvent): Promise<void> {
    if (this.closed || !this.isConversationPost(event.request)) {
      await this.cdpSession.send("Fetch.continueRequest", { requestId: event.requestId });
      return;
    }

    const rawBody = event.request.postData;
    if (typeof rawBody !== "string" || !rawBody.includes(this.placeholder)) {
      // Connector/local-tool flows may emit unrelated conversation POSTs before the user send.
      // Only a request that actually carries our unguessable placeholder may consume the one-use
      // rewrite slot; unrelated traffic must remain transparent.
      await this.cdpSession.send("Fetch.continueRequest", { requestId: event.requestId });
      return;
    }
    if (this.consumed) {
      await this.failRequestOrMarkUnsafe(event.requestId, new Error(
        "ChatGPT CDP request injection observed a second request carrying its one-use placeholder",
      ));
      return;
    }
    this.consumed = true;

    const rewrite = rewriteChatGptRequestJsonBody(rawBody, this.placeholder, this.prompt);
    if (!rewrite.ok) {
      await this.rejectForSafeFallback(event.requestId, {
        failureCode: rewrite.failureCode,
        exactValueMatches: rewrite.exactValueMatches,
        literalMatches: rewrite.literalMatches,
        originalBodyChars: rawBody.length,
      });
      return;
    }

    try {
      await this.cdpSession.send("Fetch.continueRequest", {
        requestId: event.requestId,
        // CDP's `binary` JSON type is base64 encoded. Preserve the exact UTF-8 JSON bytes
        // produced by the shared rewrite helper rather than round-tripping the object.
        postData: Buffer.from(rewrite.body, "utf8").toString("base64"),
      });
      this.snapshotValue = {
        observed: true,
        rewritten: true,
        exactValueMatches: rewrite.exactValueMatches,
        literalMatches: rewrite.literalMatches,
        originalBodyChars: rawBody.length,
        rewrittenBodyChars: rewrite.body.length,
      };
      this.notify();
    } catch (error) {
      const continued = error instanceof Error ? error : new Error(String(error));
      try {
        await this.cdpSession.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Aborted",
        });
        this.snapshotValue = {
          observed: true,
          rewritten: false,
          failureCode: "transport",
          exactValueMatches: rewrite.exactValueMatches,
          literalMatches: rewrite.literalMatches,
          originalBodyChars: rawBody.length,
          rewrittenBodyChars: 0,
        };
        this.notify();
      } catch (failedBlock) {
        this.markUnsafeTransportFailure(new AggregateError(
          [continued, failedBlock],
          "ChatGPT CDP request injection could neither continue the rewritten request nor prove the original request was blocked",
        ));
      }
    }
  }

  private async rejectForSafeFallback(
    requestId: string,
    failure: {
      failureCode: NonNullable<ChatGptRequestInjectionSnapshot["failureCode"]>;
      exactValueMatches: number;
      literalMatches: number;
      originalBodyChars: number;
    },
  ): Promise<void> {
    try {
      await this.cdpSession.send("Fetch.failRequest", { requestId, errorReason: "Aborted" });
      this.snapshotValue = {
        observed: true,
        rewritten: false,
        ...failure,
        rewrittenBodyChars: 0,
      };
      this.notify();
    } catch (error) {
      this.markUnsafeTransportFailure(new Error(
        `ChatGPT CDP request injection could not prove its rejected request was blocked: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  private async failRequestOrMarkUnsafe(requestId: string, error: Error): Promise<void> {
    try {
      await this.cdpSession.send("Fetch.failRequest", { requestId, errorReason: "Aborted" });
    } catch (failedBlock) {
      this.markUnsafeTransportFailure(new AggregateError([error, failedBlock], error.message));
    }
  }

  private markUnsafeTransportFailure(error: Error): void {
    if (this.unsafeTransportError) return;
    this.unsafeTransportError = error;
    if (!this.snapshotValue.observed) {
      this.snapshotValue = {
        observed: true,
        rewritten: false,
        failureCode: "transport",
        exactValueMatches: 0,
        literalMatches: 0,
        originalBodyChars: 0,
        rewrittenBodyChars: 0,
      };
    }
    this.notify();
  }

  private waitForAttempt(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.snapshotValue.observed || this.unsafeTransportError || signal?.aborted || timeoutMs <= 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.listeners.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private isConversationPost(request: ChatGptFetchRequestPausedEvent["request"]): boolean {
    if (request.method.toUpperCase() !== "POST") return false;
    try {
      const url = new URL(request.url);
      return url.origin === this.pageOrigin
        && /^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname);
    } catch {
      return false;
    }
  }
}

/**
 * Opt-in request body rewrite. ChatGPT still creates the request; only one exact placeholder JSON
 * string value is replaced, while every other request byte stays unchanged.
 */
export class ChatGptRequestInjector {
  private closed = false;
  private snapshotValue: ChatGptRequestInjectionSnapshot = { observed: false, rewritten: false };
  private readonly listeners = new Set<(snapshot: ChatGptRequestInjectionSnapshot) => void>();

  private constructor(
    private readonly page: Page,
    private readonly bindingName: string,
    private readonly token: string,
  ) {}

  static async install(
    page: Page,
    traceId: string,
    placeholder: string,
    prompt: string,
    directMetadata?: ChatGptDirectRequestMetadata,
  ): Promise<ChatGptRequestInjector> {
    await assertTemporaryChatPage(page);
    if (!placeholder || prompt.includes(placeholder)) {
      throw new Error("ChatGPT request injection placeholder is invalid");
    }
    if (directMetadata?.connector) {
      const { pluginId, appName } = directMetadata.connector;
      if (!/^plugin:[A-Za-z0-9_-]{16,128}$/.test(pluginId)
        || !appName.trim() || appName.length > 80 || appName.includes("@")) {
        throw new Error("ChatGPT direct connector metadata is invalid");
      }
    }
    if (directMetadata?.mode) {
      const { model, thinkingEffort } = directMetadata.mode;
      if (!/^[A-Za-z0-9._-]{3,128}$/.test(model)
        || (thinkingEffort !== undefined && !/^[A-Za-z0-9._-]{2,40}$/.test(thinkingEffort))) {
        throw new Error("ChatGPT direct mode metadata is invalid");
      }
    }
    const safeTrace = traceId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
    const token = randomUUID();
    const bindingName = `__codexRequestInject_${safeTrace}_${token.replaceAll("-", "")}`;
    const injector = new ChatGptRequestInjector(page, bindingName, token);
    await page.exposeFunction(bindingName, (payload: string) => injector.receive(payload));
    try {
      await page.evaluate(({ bindingName: installedBinding, installedToken, placeholderValue, promptValue, directMetadataValue }) => {
        const root = window as typeof window & {
          __codexRequestInjector?: { token: string; restore(): void };
          [key: string]: unknown;
        };
        root.__codexRequestInjector?.restore();
        const originalFetch = window.fetch.bind(window);
        const binding = root[installedBinding];
        if (typeof binding !== "function") {
          throw new Error("ChatGPT request injection binding was not installed in the page main world");
        }
        let consumed = false;
        const emit = (event: RequestInjectionEvent) => {
          try {
            void (binding as (payload: string) => Promise<unknown>)(JSON.stringify(event));
          } catch {
            // The request itself remains fail-closed even if diagnostics disconnect.
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
        const countExactValues = (value: unknown): number => {
          if (typeof value === "string") {
            let count = 0;
            let searchFrom = 0;
            for (;;) {
              const index = value.indexOf(placeholderValue, searchFrom);
              if (index < 0) return count;
              count += 1;
              searchFrom = index + placeholderValue.length;
            }
          }
          if (Array.isArray(value)) return value.reduce((count, entry) => count + countExactValues(entry), 0);
          if (!value || typeof value !== "object") return 0;
          return Object.values(value as Record<string, unknown>)
            .reduce<number>((count, entry) => count + countExactValues(entry), 0);
        };
        const fail = (
          failureCode: NonNullable<RequestInjectionEvent["failureCode"]>,
          exactValueMatches = 0,
          literalMatches = 0,
          originalBodyChars = 0,
        ): never => {
          emit({
            type: "request-injection",
            rewritten: false,
            failureCode,
            exactValueMatches,
            literalMatches,
            originalBodyChars,
            rewrittenBodyChars: 0,
          });
          throw new TypeError(`ChatGPT request injection rejected the generated request (${failureCode})`);
        };
        const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          if (!isConversationPost(input, init)) return originalFetch(input, init);
          const placeholderLiteral = JSON.stringify(placeholderValue).slice(1, -1);
          const inputRequest = input instanceof Request ? input : undefined;
          let rawBody: string;
          let requestBodyTransport: "init-string" | "request-clone";
          if (typeof init?.body === "string") {
            rawBody = init.body;
            requestBodyTransport = "init-string";
          } else if (init?.body !== undefined) {
            if (consumed) return originalFetch(input, init);
            return fail("unsupported-body");
          } else if (inputRequest) {
            try {
              rawBody = await inputRequest.clone().text();
            } catch {
              if (consumed) return originalFetch(input, init);
              return fail("unsupported-body");
            }
            requestBodyTransport = "request-clone";
          } else {
            if (consumed) return originalFetch(input, init);
            return fail("unsupported-body");
          }
          if (!rawBody.includes(placeholderValue)) {
            // Connector/local-tool flows may POST conversation bookkeeping before the real user
            // submission. Do not spend the one-use rewrite slot until the placeholder is present.
            return originalFetch(input, init);
          }
          if (consumed) {
            return fail("literal-count", 0, 1, rawBody.length);
          }
          consumed = true;
          let decoded: unknown;
          try {
            decoded = JSON.parse(rawBody);
          } catch {
            return fail("invalid-json", 0, 0, rawBody.length);
          }
          if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
            return fail("non-object-json", 0, 0, rawBody.length);
          }
          const exactValueMatches = countExactValues(decoded);
          if (exactValueMatches !== 1) {
            return fail("match-count", exactValueMatches, 0, rawBody.length);
          }
          let literalMatches = 0;
          let searchFrom = 0;
          for (;;) {
            const index = rawBody.indexOf(placeholderLiteral, searchFrom);
            if (index < 0) break;
            literalMatches += 1;
            searchFrom = index + placeholderLiteral.length;
          }
          if (literalMatches !== 1) {
            return fail("literal-count", exactValueMatches, literalMatches, rawBody.length);
          }
          let rewrittenBody: string;
          if (directMetadataValue?.connector || directMetadataValue?.mode) {
            const body = decoded as Record<string, unknown>;
            const replacePlaceholder = (value: unknown): number => {
              if (typeof value === "string") return 0;
              if (Array.isArray(value)) {
                let count = 0;
                for (let index = 0; index < value.length; index += 1) {
                  const entry = value[index];
                  if (typeof entry === "string" && entry.includes(placeholderValue)) {
                    const occurrences = entry.split(placeholderValue).length - 1;
                    if (occurrences !== 1) return 2;
                    value[index] = entry.replace(placeholderValue, promptValue);
                    count += 1;
                  } else {
                    count += replacePlaceholder(entry);
                  }
                }
                return count;
              }
              if (!value || typeof value !== "object") return 0;
              let count = 0;
              for (const entry of Object.values(value as Record<string, unknown>)) count += replacePlaceholder(entry);
              return count;
            };
            if (directMetadataValue.mode) {
              if (typeof body.model !== "string"
                || (body.thinking_effort !== undefined && typeof body.thinking_effort !== "string")) {
                return fail("request-shape", exactValueMatches, literalMatches, rawBody.length);
              }
              body.model = directMetadataValue.mode.model;
              if (directMetadataValue.mode.thinkingEffort === undefined) {
                delete body.thinking_effort;
              } else {
                body.thinking_effort = directMetadataValue.mode.thinkingEffort;
              }
            }
            if (directMetadataValue.connector) {
              const { pluginId, appName } = directMetadataValue.connector;
              const messages = body.messages;
              if (!Array.isArray(messages) || messages.length !== 1
                || !messages[0] || typeof messages[0] !== "object" || Array.isArray(messages[0])) {
                return fail("request-shape", exactValueMatches, literalMatches, rawBody.length);
              }
              const message = messages[0] as Record<string, unknown>;
              const content = message.content;
              const metadata = message.metadata;
              if (!content || typeof content !== "object" || Array.isArray(content)
                || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
                return fail("request-shape", exactValueMatches, literalMatches, rawBody.length);
              }
              const parts = (content as Record<string, unknown>).parts;
              if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0] !== "string"
                || parts[0].split(placeholderValue).length - 1 !== 1) {
                return fail("request-shape", exactValueMatches, literalMatches, rawBody.length);
              }
              const topHints = body.system_hints;
              const messageMetadata = metadata as Record<string, unknown>;
              const messageHints = messageMetadata.system_hints;
              if (!Array.isArray(topHints) || (topHints.length !== 0 && !(topHints.length === 1 && topHints[0] === pluginId))
                || (messageHints !== undefined && (!Array.isArray(messageHints)
                  || (messageHints.length !== 0 && !(messageHints.length === 1 && messageHints[0] === pluginId))))) {
                return fail("request-shape", exactValueMatches, literalMatches, rawBody.length);
              }
              let serialization = messageMetadata.serialization_metadata;
              if (serialization === undefined) {
                serialization = {};
                messageMetadata.serialization_metadata = serialization;
              }
              if (!serialization || typeof serialization !== "object" || Array.isArray(serialization)) {
                return fail("request-shape", exactValueMatches, literalMatches, rawBody.length);
              }
              const serializationObject = serialization as Record<string, unknown>;
              const offsets = serializationObject.custom_symbol_offsets;
              if (offsets !== undefined && (!Array.isArray(offsets) || offsets.length !== 0)) {
                return fail("request-shape", exactValueMatches, literalMatches, rawBody.length);
              }
              const mention = `@${appName}`;
              parts[0] = `${mention}  ${parts[0]}`;
              body.system_hints = [pluginId];
              messageMetadata.system_hints = [pluginId];
              serializationObject.custom_symbol_offsets = [{
                id: pluginId, symbol: "ecosystemMention", startIndex: 0, endIndex: mention.length,
              }];
              body.client_prepare_state = "success";
            }
            if (replacePlaceholder(body) !== 1) {
              return fail("request-shape", exactValueMatches, literalMatches, rawBody.length);
            }
            rewrittenBody = JSON.stringify(body);
          } else {
            const replacementLiteral = JSON.stringify(promptValue).slice(1, -1);
            const literalIndex = rawBody.indexOf(placeholderLiteral);
            rewrittenBody = rawBody.slice(0, literalIndex)
              + replacementLiteral
              + rawBody.slice(literalIndex + placeholderLiteral.length);
          }
          emit({
            type: "request-injection",
            rewritten: true,
            exactValueMatches,
            literalMatches,
            originalBodyChars: rawBody.length,
            rewrittenBodyChars: rewrittenBody.length,
          });
          if (requestBodyTransport === "request-clone" && inputRequest) {
            let rewrittenRequest: Request;
            try {
              rewrittenRequest = new Request(inputRequest, { ...init, body: rewrittenBody });
            } catch {
              return fail("transport", exactValueMatches, literalMatches, rawBody.length);
            }
            return originalFetch(rewrittenRequest);
          }
          return originalFetch(input, { ...init, body: rewrittenBody });
        };
        window.fetch = wrappedFetch as typeof window.fetch;
        root.__codexRequestInjector = {
          token: installedToken,
          restore() {
            if (window.fetch === wrappedFetch) window.fetch = originalFetch;
            if (root.__codexRequestInjector?.token === installedToken) delete root.__codexRequestInjector;
          },
        };
      }, {
        bindingName,
        installedToken: token,
        placeholderValue: placeholder,
        promptValue: prompt,
        directMetadataValue: directMetadata,
      });
    } catch (error) {
      const removablePage = page as Page & { removeExposedFunction?: (name: string) => Promise<void> };
      await removablePage.removeExposedFunction?.(bindingName).catch(() => {});
      throw error;
    }
    return injector;
  }

  snapshot(): ChatGptRequestInjectionSnapshot {
    return { ...this.snapshotValue };
  }

  async assertRewriteAttempt(timeoutMs = 5_000, signal?: AbortSignal): Promise<void> {
    const snapshot = await this.waitForAttempt(timeoutMs, signal);
    if (!snapshot?.observed) {
      throw new ChatGptRequestInjectionFallbackError("ChatGPT request injection did not observe the submitted request");
    }
    if (!snapshot.rewritten) {
      throw new ChatGptRequestInjectionFallbackError(
        `ChatGPT request injection rejected the generated request (${snapshot.failureCode ?? "unknown"})`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.page.isClosed()) {
      await this.page.evaluate((token) => {
        const root = window as typeof window & { __codexRequestInjector?: { token: string; restore(): void } };
        if (root.__codexRequestInjector?.token === token) root.__codexRequestInjector.restore();
      }, this.token).catch(() => {});
      const removablePage = this.page as Page & { removeExposedFunction?: (name: string) => Promise<void> };
      await removablePage.removeExposedFunction?.(this.bindingName).catch(() => {});
    }
  }

  private waitForAttempt(timeoutMs: number, signal?: AbortSignal): Promise<ChatGptRequestInjectionSnapshot | undefined> {
    const initial = this.snapshot();
    if (initial.observed) return Promise.resolve(initial);
    if (signal?.aborted || timeoutMs <= 0) return Promise.resolve(undefined);
    return new Promise(resolve => {
      let settled = false;
      const finish = (value: ChatGptRequestInjectionSnapshot | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish(undefined);
      const unsubscribe = this.subscribe(snapshot => {
        if (snapshot.observed) finish(snapshot);
      });
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private subscribe(listener: (snapshot: ChatGptRequestInjectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private receive(payload: string): void {
    if (this.closed || this.snapshotValue.observed) return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRequestInjectionEvent(event)) return;
    this.snapshotValue = {
      observed: true,
      rewritten: event.rewritten,
      failureCode: event.failureCode,
      exactValueMatches: event.exactValueMatches,
      literalMatches: event.literalMatches,
      originalBodyChars: event.originalBodyChars,
      rewrittenBodyChars: event.rewrittenBodyChars,
    };
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

/**
 * Passive request-shape probe for the future placeholder rewrite path. It never changes the body
 * sent by ChatGPT. The only data crossing the Playwright binding is content-free shape metadata.
 */
export class ChatGptRequestInjectionShadow {
  private closed = false;
  private snapshotValue: ChatGptRequestInjectionShadowSnapshot = { observed: false };

  private constructor(
    private readonly page: Page,
    private readonly bindingName: string,
    private readonly token: string,
  ) {}

  static async install(
    page: Page,
    traceId: string,
    prompt: string,
    promptShapeDiagnostic = false,
  ): Promise<ChatGptRequestInjectionShadow> {
    await assertTemporaryChatPage(page);
    const safeTrace = traceId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48);
    const token = randomUUID();
    const bindingName = `__codexRequestShadow_${safeTrace}_${token.replaceAll("-", "")}`;
    const shadow = new ChatGptRequestInjectionShadow(page, bindingName, token);
    await page.exposeFunction(bindingName, (payload: string) => shadow.receive(payload));
    try {
      await page.evaluate(({ bindingName: installedBinding, installedToken, targetPrompt, promptShapeDiagnostic }) => {
        const root = window as typeof window & {
          __codexRequestInjectionShadow?: { token: string; restore(): void };
          [key: string]: unknown;
        };
        root.__codexRequestInjectionShadow?.restore();
        const originalFetch = window.fetch.bind(window);
        const binding = root[installedBinding];
        if (typeof binding !== "function") {
          throw new Error("ChatGPT request shadow binding was not installed in the page main world");
        }
        let observed = false;
        const emit = (event: RequestInjectionShadowEvent) => {
          if (observed) return;
          observed = true;
          try {
            void (binding as (payload: string) => Promise<unknown>)(JSON.stringify(event));
          } catch {
            // Passive diagnostics must never disturb ChatGPT's request path.
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
        const countExactValues = (value: unknown): number => {
          if (typeof value === "string") return value === targetPrompt ? 1 : 0;
          if (Array.isArray(value)) return value.reduce((count, entry) => count + countExactValues(entry), 0);
          if (!value || typeof value !== "object") return 0;
          return Object.values(value as Record<string, unknown>)
            .reduce<number>((count, entry) => count + countExactValues(entry), 0);
        };
        const inspectPromptShape = (decoded: unknown): ChatGptRequestPromptShape | undefined => {
          if (!promptShapeDiagnostic) return undefined;
          // Search values, not keys; bounded work and aggregate-only output. Similarity does not
          // establish which field the server consumes. Ties/truncation remain explicit unknowns.
          let candidate: string | undefined;
          let bestScore = -1;
          let prefix = 0;
          let suffix = 0;
          let tied = false;
          let truncated = targetPrompt.length > 262_144;
          let strings = 0;
          let chars = 0;
          const pending: unknown[] = truncated ? [] : [decoded];
          let visited = 0;
          while (pending.length && visited++ < 4_096) {
            const value = pending.pop();
            if (typeof value === "string") {
              strings += 1;
              chars += value.length;
              if (chars > 2_000_000 || value.length > 262_144) { truncated = true; break; }
              let start = 0;
              const limit = Math.min(value.length, targetPrompt.length);
              while (start < limit && value[start] === targetPrompt[start]) start += 1;
              let end = 0;
              while (end < limit - start && value[value.length - 1 - end] === targetPrompt[targetPrompt.length - 1 - end]) end += 1;
              const score = start + end;
              if (score < Math.min(32, targetPrompt.length) || targetPrompt.length === 0) continue;
              if (score > bestScore) {
                candidate = value; bestScore = score; prefix = start; suffix = end; tied = false;
              } else if (score === bestScore) tied = true;
            } else if (value && typeof value === "object") {
              const values = Object.values(value);
              if (values.length + pending.length > 4_096) { truncated = true; break; }
              pending.push(...values);
            }
          }
          if (pending.length) truncated = true;
          const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;
          const normalized = (text: string) => text.replace(/\r\n?/g, "\n");
          let sourceIndex = 0;
          let candidateIndex = 0;
          let addedEscapeBackslashes = 0;
          let addedHtmlEntities = 0;
          while (candidate !== undefined && sourceIndex < targetPrompt.length && candidateIndex < candidate.length) {
            if (targetPrompt[sourceIndex] === "\\" && candidate[candidateIndex] === "\\") {
              let sourceEnd = sourceIndex;
              let candidateEnd = candidateIndex;
              while (targetPrompt[sourceEnd] === "\\") sourceEnd++;
              while (candidate[candidateEnd] === "\\") candidateEnd++;
              const extra = (candidateEnd - candidateIndex) - (sourceEnd - sourceIndex);
              if (extra < 0) break;
              addedEscapeBackslashes += extra;
              sourceIndex = sourceEnd; candidateIndex = candidateEnd; continue;
            }
            if (targetPrompt[sourceIndex] === candidate[candidateIndex]) { sourceIndex++; candidateIndex++; continue; }
            const next = candidate[candidateIndex + 1] ?? "";
            if (candidate[candidateIndex] === "\\" && next === targetPrompt[sourceIndex] && /[!-/:-@[-`{-~]/.test(next)) {
              candidateIndex++; addedEscapeBackslashes++; continue;
            }
            const entity = targetPrompt[sourceIndex] === ">" ? "&gt;" : targetPrompt[sourceIndex] === "<" ? "&lt;" : targetPrompt[sourceIndex] === "&" ? "&amp;" : undefined;
            if (entity && candidate.startsWith(entity, candidateIndex)) {
              sourceIndex++; candidateIndex += entity.length; addedHtmlEntities++; continue;
            }
            break;
          }
          return {
            candidateFound: candidate !== undefined, candidateTied: tied, scanTruncated: truncated,
            lineEndingsEqual: candidate !== undefined && normalized(candidate) === normalized(targetPrompt),
            trimEqual: candidate !== undefined && candidate.trim() === targetPrompt.trim(),
            removedQuoteMarkersEqual: candidate !== undefined && candidate === targetPrompt.replace(/^ {0,3}> ?/gm, ""),
            addedEscapingOnly: candidate !== undefined && sourceIndex === targetPrompt.length && candidateIndex === candidate.length,
            addedEscapeBackslashes, addedHtmlEntities,
            stringValues: strings, targetChars: targetPrompt.length, candidateChars: candidate?.length ?? 0,
            commonPrefixChars: prefix, commonSuffixChars: suffix,
            targetNewlines: count(targetPrompt, /\n/g), candidateNewlines: count(candidate ?? "", /\n/g),
            targetBackslashes: count(targetPrompt, /\\/g), candidateBackslashes: count(candidate ?? "", /\\/g),
            targetQuoteLines: count(targetPrompt, /^ {0,3}>/gm), candidateQuoteLines: count(candidate ?? "", /^ {0,3}>/gm),
          };
        };
        const inspectText = (text: string) => {
          let decoded: unknown;
          try {
            decoded = JSON.parse(text);
          } catch {
            emit({
              type: "request-shadow",
              supportedBody: true,
              bodyTransport: "init-string",
              jsonObject: false,
              exactValueMatches: 0,
              bodyChars: text.length,
            });
            return;
          }
          const jsonObject = Boolean(decoded && typeof decoded === "object" && !Array.isArray(decoded));
          emit({
            type: "request-shadow",
            supportedBody: true,
            bodyTransport: "init-string",
            jsonObject,
            exactValueMatches: jsonObject ? countExactValues(decoded) : 0,
            bodyChars: text.length,
            promptShape: jsonObject ? inspectPromptShape(decoded) : undefined,
          });
        };
        const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          if (!isConversationPost(input, init)) return originalFetch(input, init);
          let requestClone: Request | undefined;
          if (init?.body === undefined && input instanceof Request) {
            try { requestClone = input.clone(); } catch {}
          }
          const responsePromise = originalFetch(input, init);
          if (typeof init?.body === "string") {
            inspectText(init.body);
          } else if (init?.body !== undefined) {
            emit({
              type: "request-shadow",
              supportedBody: false,
              bodyTransport: "unsupported",
              jsonObject: false,
              exactValueMatches: 0,
              bodyChars: 0,
            });
          } else if (requestClone) {
            void requestClone.text().then((text) => {
              let decoded: unknown;
              try {
                decoded = JSON.parse(text);
              } catch {
                emit({
                  type: "request-shadow",
                  supportedBody: true,
                  bodyTransport: "request-clone",
                  jsonObject: false,
                  exactValueMatches: 0,
                  bodyChars: text.length,
                });
                return;
              }
              const jsonObject = Boolean(decoded && typeof decoded === "object" && !Array.isArray(decoded));
              emit({
                type: "request-shadow",
                supportedBody: true,
                bodyTransport: "request-clone",
                jsonObject,
                exactValueMatches: jsonObject ? countExactValues(decoded) : 0,
                bodyChars: text.length,
                promptShape: jsonObject ? inspectPromptShape(decoded) : undefined,
              });
            }, () => emit({
              type: "request-shadow",
              supportedBody: false,
              bodyTransport: "unsupported",
              jsonObject: false,
              exactValueMatches: 0,
              bodyChars: 0,
            }));
          } else {
            emit({
              type: "request-shadow",
              supportedBody: false,
              bodyTransport: "unsupported",
              jsonObject: false,
              exactValueMatches: 0,
              bodyChars: 0,
            });
          }
          return responsePromise;
        };
        window.fetch = wrappedFetch as typeof window.fetch;
        root.__codexRequestInjectionShadow = {
          token: installedToken,
          restore() {
            if (window.fetch === wrappedFetch) window.fetch = originalFetch;
            if (root.__codexRequestInjectionShadow?.token === installedToken) {
              delete root.__codexRequestInjectionShadow;
            }
          },
        };
      }, { bindingName, installedToken: token, targetPrompt: prompt, promptShapeDiagnostic });
    } catch (error) {
      const removablePage = page as Page & { removeExposedFunction?: (name: string) => Promise<void> };
      await removablePage.removeExposedFunction?.(bindingName).catch(() => {});
      throw error;
    }
    return shadow;
  }

  snapshot(): ChatGptRequestInjectionShadowSnapshot {
    return { ...this.snapshotValue };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.page.isClosed()) {
      await this.page.evaluate((token) => {
        const root = window as typeof window & {
          __codexRequestInjectionShadow?: { token: string; restore(): void };
        };
        if (root.__codexRequestInjectionShadow?.token === token) {
          root.__codexRequestInjectionShadow.restore();
        }
      }, this.token).catch(() => {});
      const removablePage = this.page as Page & { removeExposedFunction?: (name: string) => Promise<void> };
      await removablePage.removeExposedFunction?.(this.bindingName).catch(() => {});
    }
  }

  private receive(payload: string): void {
    if (this.closed || this.snapshotValue.observed) return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRequestInjectionShadowEvent(event)) return;
    this.snapshotValue = {
      observed: true,
      supportedBody: event.supportedBody,
      bodyTransport: event.bodyTransport,
      jsonObject: event.jsonObject,
      exactValueMatches: event.exactValueMatches,
      bodyChars: event.bodyChars,
      promptShape: event.promptShape,
    };
  }
}

function isRequestInjectionShadowEvent(value: unknown): value is RequestInjectionShadowEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return event.type === "request-shadow"
    && typeof event.supportedBody === "boolean"
    && (event.bodyTransport === "init-string"
      || event.bodyTransport === "request-clone"
      || event.bodyTransport === "unsupported")
    && typeof event.jsonObject === "boolean"
    && Number.isSafeInteger(event.exactValueMatches)
    && Number(event.exactValueMatches) >= 0
    && Number.isSafeInteger(event.bodyChars)
    && Number(event.bodyChars) >= 0
    && (event.promptShape === undefined || isRequestPromptShape(event.promptShape));
}

function isRequestPromptShape(value: unknown): value is ChatGptRequestPromptShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const booleans = ["candidateFound", "candidateTied", "scanTruncated", "lineEndingsEqual", "trimEqual", "removedQuoteMarkersEqual", "addedEscapingOnly"];
  const counts = ["stringValues", "targetChars", "candidateChars", "commonPrefixChars", "commonSuffixChars", "targetNewlines", "candidateNewlines", "targetBackslashes", "candidateBackslashes", "targetQuoteLines", "candidateQuoteLines", "addedEscapeBackslashes", "addedHtmlEntities"];
  return Object.keys(fields).length === booleans.length + counts.length
    && booleans.every(key => typeof fields[key] === "boolean")
    && counts.every(key => Number.isSafeInteger(fields[key]) && Number(fields[key]) >= 0);
}

function isRequestInjectionEvent(value: unknown): value is RequestInjectionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  const failureCodeValid = event.failureCode === undefined
    || event.failureCode === "unsupported-body"
    || event.failureCode === "invalid-json"
    || event.failureCode === "non-object-json"
    || event.failureCode === "match-count"
    || event.failureCode === "literal-count"
    || event.failureCode === "request-shape"
    || event.failureCode === "transport";
  return event.type === "request-injection"
    && typeof event.rewritten === "boolean"
    && failureCodeValid
    && Number.isSafeInteger(event.exactValueMatches)
    && Number(event.exactValueMatches) >= 0
    && Number.isSafeInteger(event.literalMatches)
    && Number(event.literalMatches) >= 0
    && Number.isSafeInteger(event.originalBodyChars)
    && Number(event.originalBodyChars) >= 0
    && Number.isSafeInteger(event.rewrittenBodyChars)
    && Number(event.rewrittenBodyChars) >= 0;
}
