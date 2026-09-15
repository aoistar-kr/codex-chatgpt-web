import type { Browser, BrowserContext, CDPSession, Page, Request } from "playwright-core";
import { assertTemporaryChatPage } from "../../chatgpt-session";

/** Target-scoped evidence only; not coverage of workers, other targets or server acceptance. */
export interface RecoveryRequestObservation {
  scope: "independent-page-target-cdp";
  available: boolean;
  continuous: boolean;
  expired: boolean;
  navigationObserved: boolean;
  conversationPostEvents: number;
  distinctRequestIds: number;
  redirectEvents: number;
  malformedEvents: number;
  saturated: boolean;
}

export interface RecoveryConversationBindingObservation {
  available: boolean;
  streamStatusEvents: number;
  exactConversationEvents: number;
  otherConversationEvents: number;
  distinctConversationIds: number;
  malformedStreamStatusEvents: number;
  exactSuccessfulResponses: number;
  exactNonSuccessfulResponses: number;
  otherConversationResponses: number;
  malformedStreamStatusResponses: number;
  exact: boolean;
}

export interface RecoveryBrowserWideRequestObservation {
  scope: "independent-launcher-browser-context";
  available: boolean;
  browserWide: boolean;
  expired: boolean;
  browserContextCount: number;
  conversationPostEvents: number;
  redirectEvents: number;
  malformedEvents: number;
  saturated: boolean;
  exact: boolean;
}

/**
 * Independent request counter across every page in the launcher BrowserContext. A receipt is called
 * browser-wide only while that independently connected Chromium browser exposes exactly this one
 * context; otherwise the scope is explicitly incomplete and `exact` is false. No body/header/ID is
 * read or retained.
 */
export class ChatGptRecoveryBrowserWideRequestObserver {
  private ready = false;
  private closed = false;
  private disconnected = false;
  private contextClosed = false;
  private posts = 0;
  private redirects = 0;
  private malformed = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly onDisconnected = () => { this.disconnected = true; };
  private readonly onContextClosed = () => { this.contextClosed = true; };
  private readonly onRequest = (request: Request) => {
    if (this.closed || Date.now() >= this.deadline) return;
    try {
      const url = new URL(request.url());
      if (url.origin !== "https://chatgpt.com" || request.method().toUpperCase() !== "POST"
        || !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
      this.posts = Math.min(1_000, this.posts + 1);
      if (request.redirectedFrom() !== null) this.redirects = Math.min(1_000, this.redirects + 1);
    } catch {
      this.malformed = Math.min(1_000, this.malformed + 1);
    }
  };

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly deadline: number,
  ) {}

  static async install(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    deadline: number,
  ): Promise<ChatGptRecoveryBrowserWideRequestObserver> {
    await assertTemporaryChatPage(page);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("browser-wide request diagnostic deadline expired");
    if (!browser.isConnected() || !browser.contexts().includes(context)) {
      throw new Error("browser-wide request diagnostic has no live launcher context");
    }
    const observer = new ChatGptRecoveryBrowserWideRequestObserver(
      browser, context, Math.min(deadline, Date.now() + 120_000),
    );
    browser.on("disconnected", observer.onDisconnected);
    context.on("close", observer.onContextClosed);
    context.on("request", observer.onRequest);
    observer.timer = setTimeout(() => { void observer.close(); }, Math.max(0, observer.deadline - Date.now()));
    observer.ready = true;
    return observer;
  }

  snapshot(): RecoveryBrowserWideRequestObservation {
    const expired = Date.now() >= this.deadline;
    const contexts = this.browser.isConnected() ? this.browser.contexts() : [];
    const available = this.ready && !this.closed && !this.disconnected && !this.contextClosed && !expired
      && contexts.includes(this.context);
    const browserWide = available && contexts.length === 1 && contexts[0] === this.context;
    const saturated = this.posts >= 1_000;
    const exact = browserWide && !saturated && this.malformed === 0 && this.redirects === 0 && this.posts === 1;
    return {
      scope: "independent-launcher-browser-context",
      available,
      browserWide,
      expired,
      browserContextCount: contexts.length,
      conversationPostEvents: this.posts,
      redirectEvents: this.redirects,
      malformedEvents: this.malformed,
      saturated,
      exact,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.context.off("request", this.onRequest);
    this.context.off("close", this.onContextClosed);
    this.browser.off("disconnected", this.onDisconnected);
  }
}

/** Agreement in these two bounded observation scopes, not a browser-wide no-duplicate claim. */
export function recoveryRequestCountsAgree(
  cdp: RecoveryRequestObservation | undefined,
  fetch: { available: boolean; wrapperCurrent?: boolean; conversationPostAttempts?: number; saturated?: boolean },
): boolean {
  return cdp?.scope === "independent-page-target-cdp" && cdp.available && cdp.continuous
    && !cdp.expired && !cdp.navigationObserved && !cdp.saturated && cdp.malformedEvents === 0
    && cdp.conversationPostEvents === 1 && cdp.distinctRequestIds === 1 && cdp.redirectEvents === 0
    && fetch.available && fetch.wrapperCurrent === true && fetch.conversationPostAttempts === 1 && fetch.saturated === false;
}

/** Use a separately owned CDP connection so the worker's reconnect cannot hide a request gap. */
export class ChatGptRecoveryRequestObserver {
  private ready = false;
  private closed = false;
  private disconnected = false;
  private navigated = false;
  private posts = 0;
  private redirects = 0;
  private malformed = 0;
  private readonly requestIds = new Set<string>();
  private streamStatusEvents = 0;
  private malformedStreamStatus = 0;
  private malformedStreamStatusResponses = 0;
  private readonly streamStatusConversationIds = new Map<string, number>();
  private readonly streamStatusRequestConversation = new Map<string, string>();
  private readonly streamStatusSuccessfulResponses = new Map<string, number>();
  private readonly streamStatusNonSuccessfulResponses = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly onClose = () => { this.disconnected = true; };
  private readonly onNavigation = (event: { frame: { parentId?: string } }) => {
    if (!event.frame.parentId) this.navigated = true;
  };
  private readonly onSameDocumentNavigation = () => { this.navigated = true; };
  private readonly onRequest = (event: {
    requestId: string; request: { url: string; method: string }; redirectResponse?: unknown;
  }) => {
    if (this.closed || Date.now() >= this.deadline) return;
    try {
      const url = new URL(event.request.url);
      if (url.origin === "https://chatgpt.com" && event.request.method === "GET") {
        const match = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/stream_status$/);
        if (match) {
          this.streamStatusEvents = Math.min(1_000, this.streamStatusEvents + 1);
          let decoded: string | undefined;
          try { decoded = decodeURIComponent(match[1]!); }
          catch { this.malformedStreamStatus = Math.min(1_000, this.malformedStreamStatus + 1); }
          if (!decoded) this.malformedStreamStatus = Math.min(1_000, this.malformedStreamStatus + 1);
          else if (this.streamStatusConversationIds.size < 1_000 || this.streamStatusConversationIds.has(decoded)) {
            this.streamStatusConversationIds.set(decoded, Math.min(1_000, (this.streamStatusConversationIds.get(decoded) ?? 0) + 1));
            if (typeof event.requestId === "string" && event.requestId && this.streamStatusRequestConversation.size < 1_000) {
              this.streamStatusRequestConversation.set(event.requestId, decoded);
            } else {
              this.malformedStreamStatus = Math.min(1_000, this.malformedStreamStatus + 1);
            }
          }
          return;
        }
      }
      if (url.origin !== "https://chatgpt.com" || event.request.method !== "POST"
        || !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
      this.posts = Math.min(1_000, this.posts + 1);
      if (typeof event.requestId !== "string" || !event.requestId) this.malformed = Math.min(1_000, this.malformed + 1);
      else if (this.requestIds.size < 1_000) this.requestIds.add(event.requestId);
      // Redirects can reuse a requestId. Count events as well as distinct IDs, never dedupe a POST away.
      if (event.redirectResponse !== undefined) this.redirects = Math.min(1_000, this.redirects + 1);
    } catch { this.malformed = Math.min(1_000, this.malformed + 1); }
  };
  private readonly onResponse = (event: {
    requestId: string; response: { url: string; status: number };
  }) => {
    if (this.closed || Date.now() >= this.deadline) return;
    const conversationId = this.streamStatusRequestConversation.get(event.requestId);
    if (!conversationId) return;
    try {
      const url = new URL(event.response.url);
      const match = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)\/stream_status$/);
      let decoded: string | undefined;
      try { decoded = match ? decodeURIComponent(match[1]!) : undefined; } catch {}
      if (url.origin !== "https://chatgpt.com" || !decoded || decoded !== conversationId
        || !Number.isFinite(event.response.status)) {
        this.malformedStreamStatusResponses = Math.min(1_000, this.malformedStreamStatusResponses + 1);
        return;
      }
      const target = event.response.status >= 200 && event.response.status < 300
        ? this.streamStatusSuccessfulResponses : this.streamStatusNonSuccessfulResponses;
      target.set(conversationId, Math.min(1_000, (target.get(conversationId) ?? 0) + 1));
    } catch {
      this.malformedStreamStatusResponses = Math.min(1_000, this.malformedStreamStatusResponses + 1);
    }
  };

  private constructor(private readonly session: CDPSession, private readonly deadline: number) {}

  static async install(page: Page, deadline: number): Promise<ChatGptRecoveryRequestObserver> {
    await assertTemporaryChatPage(page);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("request diagnostic deadline expired");
    const session = await page.context().newCDPSession(page);
    const observer = new ChatGptRecoveryRequestObserver(session, Math.min(deadline, Date.now() + 120_000));
    session.on("close", observer.onClose);
    session.on("Network.requestWillBeSent", observer.onRequest);
    session.on("Network.responseReceived", observer.onResponse);
    session.on("Page.frameNavigated", observer.onNavigation);
    session.on("Page.navigatedWithinDocument", observer.onSameDocumentNavigation);
    observer.timer = setTimeout(() => { void observer.close(); }, Math.max(0, observer.deadline - Date.now()));
    try {
      await session.send("Page.enable");
      await session.send("Network.enable");
      if (observer.closed || observer.disconnected || Date.now() >= observer.deadline) throw new Error("request diagnostic expired during install");
      observer.ready = true;
      return observer;
    } catch (error) { await observer.close(); throw error; }
  }

  async snapshot(): Promise<RecoveryRequestObservation> {
    // Check that the same session is still responsive before publishing delivered-event counts.
    // This is not a server acknowledgement or a guarantee about events not yet delivered.
    // Failure invalidates continuity; no reconnect or request replay is attempted here.
    if (!this.closed && !this.disconnected) {
      try { await this.session.send("Page.getFrameTree"); }
      catch { this.disconnected = true; }
    }
    const expired = Date.now() >= this.deadline;
    const available = this.ready && !this.closed && !this.disconnected && !expired;
    return {
      scope: "independent-page-target-cdp", available,
      continuous: available && !this.navigated && this.malformed === 0 && this.posts < 1_000,
      expired, navigationObserved: this.navigated, conversationPostEvents: this.posts,
      distinctRequestIds: this.requestIds.size, redirectEvents: this.redirects,
      malformedEvents: this.malformed, saturated: this.posts >= 1_000 || this.requestIds.size >= 1_000,
    };
  }

  /** Compare page-generated run-control traffic with an expected conversation without exposing IDs. */
  async conversationBinding(expectedConversationId: string): Promise<RecoveryConversationBindingObservation> {
    const state = await this.snapshot();
    const exactConversationEvents = this.streamStatusConversationIds.get(expectedConversationId) ?? 0;
    const otherConversationEvents = Math.max(0, this.streamStatusEvents - exactConversationEvents - this.malformedStreamStatus);
    const exactSuccessfulResponses = this.streamStatusSuccessfulResponses.get(expectedConversationId) ?? 0;
    const exactNonSuccessfulResponses = this.streamStatusNonSuccessfulResponses.get(expectedConversationId) ?? 0;
    const allResponses = [...this.streamStatusSuccessfulResponses.values(), ...this.streamStatusNonSuccessfulResponses.values()]
      .reduce((sum, count) => sum + count, 0);
    const otherConversationResponses = Math.max(0, allResponses - exactSuccessfulResponses - exactNonSuccessfulResponses);
    const available = state.available && state.continuous && typeof expectedConversationId === "string" && expectedConversationId.length > 0;
    return {
      available,
      streamStatusEvents: this.streamStatusEvents,
      exactConversationEvents,
      otherConversationEvents,
      distinctConversationIds: this.streamStatusConversationIds.size,
      malformedStreamStatusEvents: this.malformedStreamStatus,
      exactSuccessfulResponses,
      exactNonSuccessfulResponses,
      otherConversationResponses,
      malformedStreamStatusResponses: this.malformedStreamStatusResponses,
      exact: available && exactConversationEvents > 0 && otherConversationEvents === 0
        && this.malformedStreamStatus === 0 && this.streamStatusConversationIds.size === 1
        && exactSuccessfulResponses > 0 && exactNonSuccessfulResponses === 0
        && otherConversationResponses === 0 && this.malformedStreamStatusResponses === 0,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.session.off("Network.requestWillBeSent", this.onRequest);
    this.session.off("Network.responseReceived", this.onResponse);
    this.session.off("Page.frameNavigated", this.onNavigation);
    this.session.off("Page.navigatedWithinDocument", this.onSameDocumentNavigation);
    this.session.off("close", this.onClose);
    this.requestIds.clear();
    this.streamStatusConversationIds.clear();
    this.streamStatusRequestConversation.clear();
    this.streamStatusSuccessfulResponses.clear();
    this.streamStatusNonSuccessfulResponses.clear();
    await this.session.detach().catch(() => {});
  }
}
