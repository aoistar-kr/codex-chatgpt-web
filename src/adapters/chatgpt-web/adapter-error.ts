export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

/** Internal preemption marker for native Codex steering. */
export class ChatGptTurnSupersededError extends ChatGptWebAdapterError {
  constructor() {
    super(
      "A newer Codex instruction superseded this ChatGPT response.",
      { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
    );
    this.name = "ChatGptTurnSupersededError";
  }
}

/** Rejection of one revision; it must not cancel the browser that owns the ongoing response. */
export class ChatGptSteeringUnavailableError extends ChatGptWebAdapterError {
  constructor() {
    super(
      "ChatGPT does not expose an enabled in-flight Send control. The new instruction was not submitted; the existing browser response and Temporary Chat remain active.",
      { status: 409, errorType: "invalid_request_error", code: "inflight_steering_unavailable", retryable: false },
    );
    this.name = "ChatGptSteeringUnavailableError";
  }
}

/** Exact native Stop marker. The browser generation ends, but its proven Temporary Chat survives. */
export class ChatGptTurnInterruptedError extends ChatGptWebAdapterError {
  constructor() {
    super(
      "The active Codex turn was interrupted.",
      { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
    );
    this.name = "ChatGptTurnInterruptedError";
  }
}

// Only the compaction owner emits this after its one-shot handoff is accepted.
// It stops browser observation without reclassifying the accepted native summary as a failure.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

/**
 * The outer Codex turn ended while its browser turn was still waiting for the tool results of an
 * emitted batch. The follow-up round that would deliver those results can never arrive, so the
 * browser turn is retired instead of holding the ChatGPT surface and its turn token hostage.
 */
export function chatGptFollowUpRoundMissingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The Codex turn ended before its ChatGPT tool results returned, so the browser turn was retired.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "follow_up_round_missing",
      retryable: false,
    },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    // Our fork classifies a persistent 'Stopped thinking' as a terminal cancelled turn: Codex must
    // not retry it. Upstream returns a retryable server_error here, which our contract test rejects.
    "ChatGPT remained in 'Stopped thinking' for 5 seconds, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptTurnSupersededError();
}
