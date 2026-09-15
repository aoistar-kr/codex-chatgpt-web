/**
 * Privacy-preserving, read-only proof that a freshly rebound ChatGPT page can independently read
 * the already-committed Temporary Chat conversation and find the expected assistant message.
 *
 * This function is intentionally self-contained because Playwright serializes it into the page.
 * The session access token never leaves that page function: callers receive booleans/counts only.
 */
export interface ChatGptRecoveryServerProofInput {
  expectedConversationId: string;
  expectedMessageId: string;
  deadline: number;
}

export interface ChatGptRecoveryServerProofResult {
  available: boolean;
  sessionFetchOk: boolean;
  sessionHttpStatus?: number;
  conversationFetchOk: boolean;
  httpStatus?: number;
  conversationIdExact: boolean;
  isTemporaryChat: boolean;
  targetAssistantMessageMatches: number;
  targetMessageRoleAssistant: boolean;
  malformed: boolean;
  duplicate: boolean;
  messageCount: number;
  streamStatusFetchOk: boolean;
  streamStatusHttpStatus?: number;
  streamStatusJsonObject: boolean;
}

export async function collectChatGptRecoveryServerProof(
  input: ChatGptRecoveryServerProofInput,
): Promise<ChatGptRecoveryServerProofResult> {
  const result: ChatGptRecoveryServerProofResult = {
    available: typeof fetch === "function",
    sessionFetchOk: false,
    conversationFetchOk: false,
    conversationIdExact: false,
    isTemporaryChat: false,
    targetAssistantMessageMatches: 0,
    targetMessageRoleAssistant: false,
    malformed: false,
    duplicate: false,
    messageCount: 0,
    streamStatusFetchOk: false,
    streamStatusJsonObject: false,
  };
  if (!result.available) return result;
  if (!input || typeof input.expectedConversationId !== "string" || input.expectedConversationId.length === 0
    || typeof input.expectedMessageId !== "string" || input.expectedMessageId.length === 0
    || !Number.isFinite(input.deadline)) {
    result.malformed = true;
    return result;
  }

  const boundedFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const remaining = Math.floor(input.deadline - Date.now());
    if (remaining <= 0) throw new Error("recovery server proof deadline exhausted");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      return await fetch(url, {
        ...init,
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let sessionResponse: Response;
  try {
    sessionResponse = await boundedFetch("/api/auth/session");
  } catch {
    return result;
  }
  result.sessionHttpStatus = sessionResponse.status;
  result.sessionFetchOk = sessionResponse.ok;
  if (!sessionResponse.ok) return result;

  let accessToken: string | undefined;
  try {
    const session: unknown = await sessionResponse.json();
    if (session && typeof session === "object" && typeof (session as { accessToken?: unknown }).accessToken === "string"
      && (session as { accessToken: string }).accessToken.length > 0) {
      accessToken = (session as { accessToken: string }).accessToken;
    }
  } catch {
    result.malformed = true;
    return result;
  }
  if (!accessToken) {
    result.malformed = true;
    return result;
  }

  let conversationResponse: Response;
  try {
    conversationResponse = await boundedFetch(
      `/backend-api/conversations/${encodeURIComponent(input.expectedConversationId)}?include_has_versions=true&num_turns=100`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
  } catch {
    return result;
  }
  result.httpStatus = conversationResponse.status;
  result.conversationFetchOk = conversationResponse.ok;
  if (!conversationResponse.ok) {
    // Temporary Chats may intentionally reject history/detail hydration while the run-control
    // endpoint remains addressable. Record that independently for characterization only; this does
    // NOT satisfy strict server proof and does not fill conversation/message membership.
    try {
      const statusResponse = await boundedFetch(
        `/backend-api/conversation/${encodeURIComponent(input.expectedConversationId)}/stream_status`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      result.streamStatusHttpStatus = statusResponse.status;
      result.streamStatusFetchOk = statusResponse.ok;
      if (statusResponse.ok) {
        try {
          const statusBody: unknown = await statusResponse.json();
          result.streamStatusJsonObject = !!statusBody && typeof statusBody === "object" && !Array.isArray(statusBody);
        } catch {
          // Keep content-free reachability separate from response-shape characterization.
        }
      }
    } catch {
      // Optional characterization only; strict proof was already unavailable.
    }
    return result;
  }

  let conversation: unknown;
  try {
    conversation = await conversationResponse.json();
  } catch {
    result.malformed = true;
    return result;
  }
  if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) {
    result.malformed = true;
    return result;
  }
  const root = conversation as Record<string, unknown>;
  result.conversationIdExact = root.conversation_id === input.expectedConversationId;
  result.isTemporaryChat = root.is_temporary_chat === true;

  const entries: unknown[] = [];
  if (Array.isArray(root.messages)) entries.push(...root.messages);
  const mapping = root.mapping;
  if (mapping && typeof mapping === "object" && !Array.isArray(mapping)) entries.push(...Object.values(mapping));
  if (!Array.isArray(root.messages) && !(mapping && typeof mapping === "object" && !Array.isArray(mapping))) {
    result.malformed = true;
    return result;
  }
  // A diagnostic endpoint response should be small. Refuse to turn an unexpectedly huge payload
  // into an unbounded page-side scan; saturation is treated as malformed/fail-closed evidence.
  if (entries.length > 5_000) {
    result.malformed = true;
    return result;
  }
  result.messageCount = entries.length;

  let roleMatches = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const wrapper = entry as Record<string, unknown>;
    const rawMessage = wrapper.message && typeof wrapper.message === "object" && !Array.isArray(wrapper.message)
      ? wrapper.message as Record<string, unknown>
      : wrapper;
    if (rawMessage.id !== input.expectedMessageId) continue;
    result.targetAssistantMessageMatches += 1;
    const author = rawMessage.author;
    if (author && typeof author === "object" && !Array.isArray(author)
      && (author as Record<string, unknown>).role === "assistant") roleMatches += 1;
  }
  result.duplicate = result.targetAssistantMessageMatches > 1;
  result.targetMessageRoleAssistant = result.targetAssistantMessageMatches === 1 && roleMatches === 1;
  return result;
}

/** Strict acceptance for the diagnostic only. This grants no recovery authority. */
export function chatGptRecoveryServerProofExact(result: ChatGptRecoveryServerProofResult | undefined): boolean {
  return !!result && result.available && result.sessionFetchOk && result.conversationFetchOk
    && result.conversationIdExact && result.isTemporaryChat
    && result.targetAssistantMessageMatches === 1 && result.targetMessageRoleAssistant
    && !result.malformed && !result.duplicate;
}
