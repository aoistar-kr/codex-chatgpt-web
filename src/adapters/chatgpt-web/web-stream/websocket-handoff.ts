export function chatGptStreamHandoffTopic(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (event.type !== "stream_handoff" || !Array.isArray(event.options)) return undefined;
  const topic = event.options.find(option => (
    option
    && typeof option === "object"
    && (option as Record<string, unknown>).type === "subscribe_ws_topic"
  ));
  const topicId = topic && typeof topic === "object"
    ? (topic as Record<string, unknown>).topic_id
    : undefined;
  return typeof topicId === "string" && /^conversation-turn-[A-Za-z0-9_-]+$/.test(topicId)
    ? topicId
    : undefined;
}

/** Extract only encoded SSE items for the exact handoff topic from a ChatGPT WS envelope. */
export function chatGptWebSocketEncodedItems(payload: string, topicId: string): string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return [];
  }
  const result: string[] = [];
  const acceptMessage = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    if (message.type !== "message" || message.topic_id !== topicId) return;
    const outerPayload = message.payload;
    if (!outerPayload || typeof outerPayload !== "object") return;
    const inner = (outerPayload as Record<string, unknown>).payload;
    if (!inner || typeof inner !== "object") return;
    const encodedItem = (inner as Record<string, unknown>).encoded_item;
    if (typeof encodedItem === "string" && encodedItem) result.push(encodedItem);
  };
  const items = Array.isArray(decoded) ? decoded : [decoded];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const typed = item as Record<string, unknown>;
    if (typed.type === "message") {
      acceptMessage(typed);
      continue;
    }
    if (typed.type !== "reply" || !typed.reply || typeof typed.reply !== "object") continue;
    const reply = typed.reply as Record<string, unknown>;
    if (reply.type !== "subscribe" || reply.topic_id !== topicId || !Array.isArray(reply.catchups)) continue;
    for (const catchup of reply.catchups) acceptMessage(catchup);
  }
  return result;
}
