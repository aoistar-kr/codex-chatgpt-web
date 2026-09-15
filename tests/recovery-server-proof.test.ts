import { expect, test } from "bun:test";
import {
  chatGptRecoveryServerProofExact,
  collectChatGptRecoveryServerProof,
} from "../src/adapters/chatgpt-web/recovery-server-proof";

const conversationId = "conversation-fixture";
const messageId = "12345678-1234-4234-8234-123456789abc";

async function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previous;
  }
}

function input() {
  return { expectedConversationId: conversationId, expectedMessageId: messageId, deadline: Date.now() + 5_000 };
}

test("authenticated fresh server proof returns only content-free exact evidence", async () => {
  const token = "secret-page-local-token";
  let calls = 0;
  await withFetch((url, init) => {
    calls += 1;
    if (url === "/api/auth/session") return Response.json({ accessToken: token });
    expect(url).toContain(`/backend-api/conversations/${conversationId}`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    return Response.json({
      conversation_id: conversationId,
      is_temporary_chat: true,
      messages: [{ id: messageId, author: { role: "assistant" }, content: { parts: ["must-not-leak"] } }],
    });
  }, async () => {
    const result = await collectChatGptRecoveryServerProof(input());
    expect(result).toEqual({
      available: true, sessionFetchOk: true, sessionHttpStatus: 200,
      conversationFetchOk: true, httpStatus: 200, conversationIdExact: true,
      isTemporaryChat: true, targetAssistantMessageMatches: 1, targetMessageRoleAssistant: true,
      malformed: false, duplicate: false, messageCount: 1,
      streamStatusFetchOk: false, streamStatusJsonObject: false,
    });
    expect(chatGptRecoveryServerProofExact(result)).toBeTrue();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
  expect(calls).toBe(2);
});

test("mapping-shaped conversation detail proves the same assistant without returning message data", async () => {
  await withFetch((url) => url === "/api/auth/session"
    ? Response.json({ accessToken: "token" })
    : Response.json({ conversation_id: conversationId, is_temporary_chat: true,
      mapping: { one: { message: { id: messageId, author: { role: "assistant" }, content: { parts: ["private"] } } } } }), async () => {
    const result = await collectChatGptRecoveryServerProof(input());
    expect(chatGptRecoveryServerProofExact(result)).toBeTrue();
    expect(result.messageCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private");
  });
});

test("wrong conversation temporary flag role missing target and duplicate target all fail closed", async () => {
  const variants = [
    { conversation_id: "wrong", is_temporary_chat: true, messages: [{ id: messageId, author: { role: "assistant" } }] },
    { conversation_id: conversationId, is_temporary_chat: false, messages: [{ id: messageId, author: { role: "assistant" } }] },
    { conversation_id: conversationId, is_temporary_chat: true, messages: [{ id: messageId, author: { role: "user" } }] },
    { conversation_id: conversationId, is_temporary_chat: true, messages: [] },
    { conversation_id: conversationId, is_temporary_chat: true,
      messages: [{ id: messageId, author: { role: "assistant" } }, { id: messageId, author: { role: "assistant" } }] },
  ];
  for (const body of variants) {
    await withFetch((url) => url === "/api/auth/session" ? Response.json({ accessToken: "token" }) : Response.json(body), async () => {
      expect(chatGptRecoveryServerProofExact(await collectChatGptRecoveryServerProof(input()))).toBeFalse();
    });
  }
});

test("missing session token, auth failures, malformed detail and expired deadline stay unavailable for strict proof", async () => {
  await withFetch((url) => url === "/api/auth/session" ? Response.json({}) : Response.json({}), async () => {
    const result = await collectChatGptRecoveryServerProof(input());
    expect(result.malformed).toBeTrue();
    expect(result.conversationFetchOk).toBeFalse();
    expect(chatGptRecoveryServerProofExact(result)).toBeFalse();
  });
  await withFetch(() => new Response("", { status: 401 }), async () => {
    const result = await collectChatGptRecoveryServerProof(input());
    expect(result.sessionHttpStatus).toBe(401);
    expect(chatGptRecoveryServerProofExact(result)).toBeFalse();
  });
  await withFetch((url) => url === "/api/auth/session" ? Response.json({ accessToken: "token" }) : Response.json({ nope: true }), async () => {
    const result = await collectChatGptRecoveryServerProof(input());
    expect(result.malformed).toBeTrue();
    expect(chatGptRecoveryServerProofExact(result)).toBeFalse();
  });
  await withFetch(() => { throw new Error("expired proof must not fetch"); }, async () => {
    const result = await collectChatGptRecoveryServerProof({ ...input(), deadline: Date.now() - 1 });
    expect(result.sessionFetchOk).toBeFalse();
    expect(chatGptRecoveryServerProofExact(result)).toBeFalse();
  });
});

test("detail 404 may characterize Temporary run-control reachability but never upgrades strict proof", async () => {
  await withFetch((url) => {
    if (url === "/api/auth/session") return Response.json({ accessToken: "token" });
    if (url.includes("/stream_status")) return Response.json({ status: "IS_STREAMING" });
    return new Response("", { status: 404 });
  }, async () => {
    const result = await collectChatGptRecoveryServerProof(input());
    expect(result).toMatchObject({
      conversationFetchOk: false, httpStatus: 404,
      streamStatusFetchOk: true, streamStatusHttpStatus: 200, streamStatusJsonObject: true,
    });
    expect(chatGptRecoveryServerProofExact(result)).toBeFalse();
  });
});
