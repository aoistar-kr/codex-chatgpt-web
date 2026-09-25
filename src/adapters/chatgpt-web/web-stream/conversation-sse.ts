import type { CodexOutputTextAnnotation } from "../../../types";
import { chatGptStreamHandoffTopic } from "./websocket-handoff";

export type ChatGptWireSnapshot = {
  streamId?: string;
  /** Page-local request epoch captured before the matching fetch was dispatched. */
  requestEpoch?: string;
  requestBodyTransport?: "init-string" | "request-clone" | "unavailable";
  requestClientUserMessageId?: string;
  requestConversationId?: string;
  requestIdentityConflict?: boolean;
  foreignStartCount?: number;
  conversationId?: string;
  /** Original explicit wire mapping only, never fresh post-reconnect conversation proof.
   * Raw IDs are process-local; do not serialize into metrics/protocol diagnostics.
   * Missing, unknown, or conflicted mapping cannot authorize any continuation. */
  assistantMessageId?: string;
  assistantMessageConversationId?: string;
  assistantMessageIdentityConflict?: boolean;
  assistantMessageIdentityUnknown?: boolean;
  /** All explicit assistant envelope ids observed on the owned response stream. This is separate
   * from assistantMessageId, which intentionally remains final-channel-only recovery authority. */
  responseOwnerAssistantIds?: readonly string[];
  responseOwnerIdentityConflict?: boolean;
  responseOwnerIdentityUnknown?: boolean;
  text: string;
  /** Final Responses-compatible annotations recovered from ChatGPT message metadata. */
  annotations?: CodexOutputTextAnnotation[];
  complete: boolean;
  failed: boolean;
  status?: number;
  contentType?: string;
  startedAt?: number;
  firstChunkAt?: number;
  firstTextAt?: number;
  completedAt?: number;
  handoffTopicId?: string;
  handoffObservedAt?: number;
  firstHandoffChunkAt?: number;
  protocolTrace?: ChatGptWireProtocolEvent[];
  protocolTraceDropped?: number;
  protocolSummary?: ChatGptWireProtocolSummary;
};

export type ChatGptWireProtocolSummary = {
  messageEvents: number;
  finalAssistantMessages: number;
  contentOps: number;
  appendOps: number;
  replaceOps: number;
  metadataOps: number;
  metadataRootOps: number;
  handoffEvents: number;
  unsupportedHandoffEvents: number;
  unknownTypedEvents: number;
  privateUseChars: number;
  maxContentReferences: number;
  maxSafeUrls: number;
  maxCitations: number;
  maxRefs: number;
};

export type ChatGptWireProtocolEvent =
  | {
      kind: "message";
      role: "assistant" | "other";
      channel: "final" | "analysis" | "other" | "none";
      contentType: "text" | "other" | "none";
      finalAssistant: boolean;
      textChars: number;
      privateUseChars: number;
      contentReferences: number;
      safeUrls: number;
      citations: number;
      refs: number;
    }
  | {
      kind: "content-op";
      source: "direct" | "batch" | "plain";
      operation: "append" | "replace" | "add" | "remove" | "plain" | "other";
      partIndex?: number;
      nestedPath: boolean;
      valueType: "string" | "array" | "object" | "boolean" | "number" | "null" | "other";
      valueChars?: number;
      privateUseChars?: number;
      trackingFinalAssistant: boolean;
    }
  | {
      kind: "metadata-op";
      source: "direct" | "batch";
      category: "content-references" | "safe-urls" | "citations" | "refs" | "indices" | "type" | "other";
      operation: "append" | "replace" | "add" | "remove" | "other";
      nestedPath: boolean;
      valueType: "string" | "array" | "object" | "boolean" | "number" | "null" | "other";
      itemCount?: number;
      trackingFinalAssistant: boolean;
    }
  | {
      kind: "metadata-root";
      source: "direct" | "batch";
      operation: "append" | "replace" | "add" | "remove" | "other";
      contentReferences: number;
      safeUrls: number;
      citations: number;
      refs: number;
      trackingFinalAssistant: boolean;
    }
  | {
      kind: "event-shape";
      category: "handoff-unsupported" | "unknown-typed";
      hasOptions: boolean;
      optionCount?: number;
    }
  | { kind: "handoff" };

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!content || typeof content !== "object") return "";
  const typedContent = content as { parts?: unknown[]; text?: unknown };
  if (Array.isArray(typedContent.parts)) {
    return typedContent.parts
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return typeof typedContent.text === "string" ? typedContent.text : "";
}

function isFinalAssistantMessage(message: Record<string, unknown>): boolean {
  const author = message.author;
  if (!author || typeof author !== "object" || (author as { role?: unknown }).role !== "assistant") return false;
  if (message.recipient !== undefined && message.recipient !== "all") return false;
  if (message.channel !== undefined && message.channel !== "final") return false;
  const content = message.content;
  if (!content || typeof content !== "object") return false;
  const contentType = (content as { content_type?: unknown }).content_type;
  return contentType === undefined || contentType === "text";
}

function isCompleteMessage(message: Record<string, unknown>): boolean {
  const metadata = message.metadata;
  return message.status === "finished_successfully"
    || message.end_turn === true
    || Boolean(metadata && typeof metadata === "object" && (metadata as { is_complete?: unknown }).is_complete === true);
}

function privateUseCharCount(value: string): number {
  let count = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    if (
      (codePoint >= 0xE000 && codePoint <= 0xF8FF)
      || (codePoint >= 0xF0000 && codePoint <= 0xFFFFD)
      || (codePoint >= 0x100000 && codePoint <= 0x10FFFD)
    ) count += 1;
  }
  return count;
}

function nestedMetadataArrayCount(value: unknown, key: string): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, entry) => sum + nestedMetadataArrayCount(entry, key), 0);
  const record = value as Record<string, unknown>;
  const local = Array.isArray(record[key]) ? record[key].length : 0;
  return local + Object.values(record).reduce<number>((sum, entry) => sum + nestedMetadataArrayCount(entry, key), 0);
}

const CHATGPT_REFERENCE_METADATA_KEYS = new Set(["content_references", "safe_urls", "citations", "refs"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]));
  }
  return value;
}

function selectReferenceMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const selected: Record<string, unknown> = {};
  for (const key of CHATGPT_REFERENCE_METADATA_KEYS) {
    if (Object.hasOwn(value, key)) selected[key] = cloneJsonValue(value[key]);
  }
  return selected;
}

function appendReferenceMetadata(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    const previous = merged[key];
    merged[key] = Array.isArray(previous) && Array.isArray(value)
      ? [...previous, ...value.map(cloneJsonValue)]
      : cloneJsonValue(value);
  }
  return merged;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function arrayIndex(segment: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
  const index = Number(segment);
  return Number.isSafeInteger(index) ? index : undefined;
}

function readContainerValue(container: Record<string, unknown> | unknown[], key: string): unknown {
  if (Array.isArray(container)) {
    const index = arrayIndex(key);
    return index === undefined ? undefined : container[index];
  }
  return container[key];
}

function writeContainerValue(
  container: Record<string, unknown> | unknown[],
  key: string,
  operation: unknown,
  value: unknown,
): void {
  const cloned = cloneJsonValue(value);
  if (Array.isArray(container)) {
    if (key === "-") {
      if (operation === "add" || operation === "append" || operation === undefined) container.push(cloned);
      return;
    }
    const index = arrayIndex(key);
    if (index === undefined) return;
    if (operation === "remove") {
      if (index < container.length) container.splice(index, 1);
      return;
    }
    if (operation === "add") {
      if (index <= container.length) container.splice(index, 0, cloned);
      return;
    }
    if (operation === "append") {
      const current = container[index];
      if (Array.isArray(current)) {
        if (Array.isArray(cloned)) current.push(...cloned);
        else current.push(cloned);
      } else if (typeof current === "string" && typeof cloned === "string") {
        container[index] = current + cloned;
      } else if (index <= container.length) {
        container[index] = cloned;
      }
      return;
    }
    if (index < container.length) container[index] = cloned;
    else if (index === container.length) container.push(cloned);
    return;
  }
  if (operation === "remove") {
    delete container[key];
    return;
  }
  if (operation === "append") {
    const current = container[key];
    if (Array.isArray(current)) {
      if (Array.isArray(cloned)) current.push(...cloned);
      else current.push(cloned);
    } else if (typeof current === "string" && typeof cloned === "string") {
      container[key] = current + cloned;
    } else {
      container[key] = cloned;
    }
    return;
  }
  container[key] = cloned;
}

function applyMetadataPath(
  root: Record<string, unknown>,
  segments: string[],
  operation: unknown,
  value: unknown,
): void {
  if (segments.length === 0 || !CHATGPT_REFERENCE_METADATA_KEYS.has(segments[0]!)) return;
  if (segments.some(segment => segment === "__proto__" || segment === "prototype" || segment === "constructor")) return;
  let container: Record<string, unknown> | unknown[] = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]!;
    const nextKey = segments[index + 1]!;
    let child = readContainerValue(container, key);
    if (!Array.isArray(child) && !isRecord(child)) {
      child = nextKey === "-" || arrayIndex(nextKey) !== undefined ? [] : {};
      writeContainerValue(container, key, "replace", child);
      child = readContainerValue(container, key);
    }
    if (!Array.isArray(child) && !isRecord(child)) return;
    container = child;
  }
  writeContainerValue(container, segments.at(-1)!, operation, value);
}

function deepInteger(value: unknown, names: readonly string[], depth = 0): number | undefined {
  if (depth > 6 || !isRecord(value)) return undefined;
  for (const name of names) {
    const candidate = value[name];
    if (Number.isSafeInteger(candidate) && (candidate as number) >= 0) return candidate as number;
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const entry of child) {
        const found = deepInteger(entry, names, depth + 1);
        if (found !== undefined) return found;
      }
    } else {
      const found = deepInteger(child, names, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function validHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function deepUrl(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !isRecord(value)) return undefined;
  for (const name of ["safe_url", "url", "href"]) {
    const found = validHttpUrl(value[name]);
    if (found) return found;
  }
  if (Array.isArray(value.safe_urls)) {
    for (const candidate of value.safe_urls) {
      const found = validHttpUrl(candidate);
      if (found) return found;
    }
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const entry of child) {
        const found = deepUrl(entry, depth + 1);
        if (found) return found;
      }
    } else {
      const found = deepUrl(child, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function deepString(value: unknown, names: readonly string[], depth = 0): string | undefined {
  if (depth > 6 || !isRecord(value)) return undefined;
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const entry of child) {
        const found = deepString(entry, names, depth + 1);
        if (found) return found;
      }
    } else {
      const found = deepString(child, names, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function referenceCandidates(value: unknown, output: Record<string, unknown>[], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const entry of value) referenceCandidates(entry, output, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  output.push(value);
  for (const child of Object.values(value)) referenceCandidates(child, output, depth + 1);
}

/** Convert ChatGPT reference metadata into the public Responses URL-citation shape Codex renders. */
export function chatGptOutputTextAnnotations(
  text: string,
  metadata: Record<string, unknown>,
): CodexOutputTextAnnotation[] {
  if (!text || Object.keys(metadata).length === 0) return [];
  const candidates: Record<string, unknown>[] = [];
  for (const key of ["content_references", "citations", "refs"] as const) {
    referenceCandidates(metadata[key], candidates);
  }
  const seen = new Set<string>();
  const annotations: CodexOutputTextAnnotation[] = [];
  for (const candidate of candidates.slice(0, 512)) {
    const url = deepUrl(candidate);
    if (!url) continue;
    let start = deepInteger(candidate, ["start_index", "start_idx", "start_ix", "start"]);
    let end = deepInteger(candidate, ["end_index", "end_idx", "end_ix", "end"]);
    if (start === undefined || end === undefined) {
      const matched = deepString(candidate, ["matched_text"]);
      if (!matched) continue;
      const located = text.indexOf(matched);
      if (located < 0 || located !== text.lastIndexOf(matched)) continue;
      start = located;
      end = located + matched.length;
    }
    if (start < 0 || end <= start || end > text.length) continue;
    const key = `${start}:${end}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let title = deepString(candidate, ["title", "name", "alt"]);
    if (!title) {
      try { title = new URL(url).hostname; } catch { title = url; }
    }
    title = title.slice(0, 4_096);
    annotations.push({ type: "url_citation", start_index: start, end_index: end, url, title });
  }
  return annotations.sort((left, right) => left.start_index - right.start_index
    || left.end_index - right.end_index || left.url.localeCompare(right.url)).slice(0, 256);
}

/** Incrementally decodes ChatGPT's legacy and patch-style conversation SSE formats. */
export class ChatGptConversationSseAccumulator {
  private lineBuffer = "";
  private dataLines: string[] = [];
  private trackingFinalAssistant = false;
  private assistantText = "";
  private finalAssistantMetadata: Record<string, unknown> = {};
  private conversationId?: string;
  private assistantMessageId?: string;
  private assistantMessageConversationId?: string;
  private assistantMessageIdentityConflict = false;
  private assistantMessageIdentityUnknown = false;
  private readonly responseOwnerAssistantIds: string[] = [];
  private responseOwnerIdentityConflict = false;
  private responseOwnerIdentityUnknown = false;
  private handoffTopicId?: string;
  private complete = false;
  private inputSource: "bootstrap" | "handoff" = "bootstrap";
  private readonly protocolTrace: ChatGptWireProtocolEvent[] = [];
  private protocolTraceDropped = 0;
  private readonly protocolSummary: ChatGptWireProtocolSummary = {
    messageEvents: 0,
    finalAssistantMessages: 0,
    contentOps: 0,
    appendOps: 0,
    replaceOps: 0,
    metadataOps: 0,
    metadataRootOps: 0,
    handoffEvents: 0,
    unsupportedHandoffEvents: 0,
    unknownTypedEvents: 0,
    privateUseChars: 0,
    maxContentReferences: 0,
    maxSafeUrls: 0,
    maxCitations: 0,
    maxRefs: 0,
  };

  constructor(private readonly recordProtocolTrace = false) {}

  feed(chunk: string, source: "bootstrap" | "handoff" = "bootstrap"): void {
    if (!chunk) return;
    this.inputSource = source;
    this.lineBuffer += chunk;
    for (;;) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      this.handleLine(line);
    }
  }

  end(): void {
    if (this.lineBuffer) {
      this.handleLine(this.lineBuffer.replace(/\r$/, ""));
      this.lineBuffer = "";
    }
    this.flushEvent();
  }

  snapshot(): Pick<
    ChatGptWireSnapshot,
    "conversationId" | "text" | "annotations" | "complete" | "handoffTopicId" | "protocolTrace" | "protocolTraceDropped" | "protocolSummary"
    | "assistantMessageId" | "assistantMessageConversationId" | "assistantMessageIdentityConflict" | "assistantMessageIdentityUnknown"
    | "responseOwnerAssistantIds" | "responseOwnerIdentityConflict" | "responseOwnerIdentityUnknown"
  > {
    return {
      conversationId: this.conversationId,
      ...(this.assistantMessageId ? {
        assistantMessageId: this.assistantMessageId,
        assistantMessageConversationId: this.assistantMessageConversationId,
      } : {}),
      ...(this.assistantMessageIdentityConflict ? { assistantMessageIdentityConflict: true } : {}),
      ...(this.assistantMessageId && this.assistantMessageIdentityUnknown ? { assistantMessageIdentityUnknown: true } : {}),
      ...(this.responseOwnerAssistantIds.length > 0
        ? { responseOwnerAssistantIds: [...this.responseOwnerAssistantIds] }
        : {}),
      ...(this.responseOwnerIdentityConflict ? { responseOwnerIdentityConflict: true } : {}),
      ...(this.responseOwnerIdentityUnknown ? { responseOwnerIdentityUnknown: true } : {}),
      text: this.assistantText,
      ...(this.complete ? { annotations: chatGptOutputTextAnnotations(this.assistantText, this.finalAssistantMetadata) } : {}),
      complete: this.complete,
      handoffTopicId: this.handoffTopicId,
      ...(this.recordProtocolTrace ? {
        protocolTrace: this.protocolTrace.map(event => ({ ...event })),
        protocolTraceDropped: this.protocolTraceDropped,
        protocolSummary: { ...this.protocolSummary },
      } : {}),
    };
  }

  handleEventObject(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const event = value as Record<string, unknown>;
    const handoffTopicId = chatGptStreamHandoffTopic(event);
    if (handoffTopicId) {
      this.recordProtocol({ kind: "handoff" });
      this.handoffTopicId = handoffTopicId;
      this.complete = false;
      this.observeConversationId(event.conversation_id);
      return;
    }
    const unsupportedHandoff = event.type === "stream_handoff";
    if (unsupportedHandoff) {
      const options = Array.isArray(event.options) ? event.options : undefined;
      this.recordProtocol({
        kind: "event-shape",
        category: "handoff-unsupported",
        hasOptions: options !== undefined,
        ...(options ? { optionCount: Math.min(options.length, 16) } : {}),
      });
    }
    if (event.type === "message_stream_complete") {
      if (!this.handoffTopicId || this.inputSource === "handoff") this.complete = true;
      this.observeConversationId(event.conversation_id);
      return;
    }
    if (event.message && typeof event.message === "object") {
      this.handleMessage(event.message as Record<string, unknown>, event.conversation_id);
      return;
    }
    if (!unsupportedHandoff && typeof event.type === "string") {
      const options = Array.isArray(event.options) ? event.options : undefined;
      this.recordProtocol({
        kind: "event-shape",
        category: "unknown-typed",
        hasOptions: options !== undefined,
        ...(options ? { optionCount: Math.min(options.length, 16) } : {}),
      });
    }

    const operation = event.o;
    const patchValue = event.v;
    this.recordMetadataOperation("direct", operation, event.p, patchValue);
    this.applyFinalAssistantMetadataPatch(event.p, operation, patchValue);
    if ((operation === "add" || operation === undefined)
      && patchValue && typeof patchValue === "object" && !Array.isArray(patchValue)
      && (patchValue as Record<string, unknown>).message
    ) {
      const added = patchValue as Record<string, unknown>;
      if (event.p !== undefined && event.p !== "" && event.p !== "/") {
        this.assistantMessageIdentityUnknown = true;
      }
      this.handleMessage(added.message as Record<string, unknown>, added.conversation_id);
      return;
    }
    this.observeIdentityPatch(event.p, operation);
    if (event.p === undefined && patchValue && typeof patchValue === "object" && !Array.isArray(patchValue)) {
      this.assistantMessageIdentityUnknown = true; // Unsupported root replacement, not a full-message proof.
    }
    if (Array.isArray(patchValue) && (operation === "patch" || operation === undefined)) {
      for (const entry of patchValue) this.handlePatchEntry(entry, "batch");
      return;
    }
    if (typeof patchValue === "string" && (operation === "append" || operation === "replace" || operation === undefined)) {
      const path = event.p;
      this.recordContentOperation("direct", operation, path, patchValue);
      if ((path === undefined || (typeof path === "string" && /^\/message\/content\/parts\/\d+$/.test(path)))
        && this.trackingFinalAssistant
      ) {
        if (operation === "replace") this.assistantText = patchValue;
        else this.assistantText += patchValue;
      }
    }
  }

  private handleLine(line: string): void {
    if (!line) {
      this.flushEvent();
      return;
    }
    if (line.startsWith("data:")) this.dataLines.push(line.slice(5).replace(/^ /, ""));
  }

  private flushEvent(): void {
    if (this.dataLines.length === 0) return;
    const payload = this.dataLines.join("\n");
    this.dataLines = [];
    if (payload === "[DONE]") {
      if (!this.handoffTopicId || this.inputSource === "handoff") this.complete = true;
      return;
    }
    try {
      this.handleEventObject(JSON.parse(payload));
    } catch {
      // Ignore non-JSON heartbeat and forward-compatible event frames.
    }
  }

  private handlePatchEntry(value: unknown, source: "batch" | "direct" = "batch"): void {
    if (!value || typeof value !== "object") return;
    const entry = value as Record<string, unknown>;
    const path = entry.p;
    this.observeIdentityPatch(path, entry.o);
    if (typeof path !== "string") return;
    this.recordContentOperation(source, entry.o, path, entry.v);
    this.recordMetadataOperation(source, entry.o, path, entry.v);
    this.applyFinalAssistantMetadataPatch(path, entry.o, entry.v);
    if (/^\/message\/content\/parts\/\d+$/.test(path)
      && (entry.o === "append" || entry.o === "replace")
      && typeof entry.v === "string" && this.trackingFinalAssistant
    ) {
      if (entry.o === "replace") this.assistantText = entry.v;
      else this.assistantText += entry.v;
      return;
    }
    if ((!this.handoffTopicId || this.inputSource === "handoff")
      && path === "/message/status" && entry.v === "finished_successfully" && this.trackingFinalAssistant) {
      this.complete = true;
      return;
    }
    if ((!this.handoffTopicId || this.inputSource === "handoff")
      && path === "/message/end_turn" && entry.v === true && this.trackingFinalAssistant) {
      this.complete = true;
    }
  }

  private handleMessage(message: Record<string, unknown>, conversationId: unknown): void {
    this.observeConversationId(conversationId);
    this.recordMessage(message);
    const author = message.author;
    const assistantEnvelope = Boolean(author && typeof author === "object"
      && (author as { role?: unknown }).role === "assistant");
    if (assistantEnvelope) {
      if (typeof message.id === "string" && message.id.trim().length > 0
        && !this.responseOwnerAssistantIds.includes(message.id)) {
        if (this.responseOwnerAssistantIds.length >= 64) {
          this.responseOwnerIdentityUnknown = true;
        } else {
          this.responseOwnerAssistantIds.push(message.id);
        }
      }
    }
    if (!isFinalAssistantMessage(message)) {
      this.trackingFinalAssistant = false;
      return;
    }
    // Deliberately require the ID and conversation in the same full-message envelope.
    // An earlier/later conversation or an ID-only patch never backfills this pair.
    if (typeof message.id !== "string" || message.id.trim().length === 0
      || typeof conversationId !== "string" || conversationId.trim().length === 0) {
      this.assistantMessageIdentityUnknown = true;
    } else if (this.assistantMessageId !== undefined) {
      if (this.assistantMessageId !== message.id || this.assistantMessageConversationId !== conversationId) {
        this.assistantMessageIdentityConflict = true;
      }
    } else {
      this.assistantMessageId = message.id;
      this.assistantMessageConversationId = conversationId;
    }
    if (message.conversation_id !== undefined && message.conversation_id !== conversationId) {
      this.assistantMessageIdentityConflict = true;
    }
    const wasTrackingFinalAssistant = this.trackingFinalAssistant;
    this.trackingFinalAssistant = true;
    if (!wasTrackingFinalAssistant) this.finalAssistantMetadata = {};
    if (isRecord(message.metadata)) this.finalAssistantMetadata = selectReferenceMetadata(message.metadata);
    const text = messageText(message);
    if (text.length >= this.assistantText.length) this.assistantText = text;
    if ((!this.handoffTopicId || this.inputSource === "handoff") && isCompleteMessage(message)) this.complete = true;
  }

  private observeConversationId(value: unknown): void {
    if (typeof value !== "string" || value.trim().length === 0) return;
    if (this.conversationId !== undefined && this.conversationId !== value) {
      this.assistantMessageIdentityConflict = true;
    }
    this.conversationId = value; // Preserve the existing text/completion parser semantics.
  }

  private observeIdentityPatch(path: unknown, operation: unknown): void {
    if (operation === "patch") return; // Batch entries are inspected individually.
    const finalIdentityAffected = path === "" || path === "/" || path === "/message"
      || (typeof path === "string" && /^\/(?:conversation_id(?:\/|$)|message\/(?:id|author|recipient|channel|content_type)(?:\/|$))/.test(path))
      || path === "/message/content" || path === "/message/content/content_type";
    if (finalIdentityAffected) {
      // Unsupported identity/qualification mutation: retain original evidence, but poison its
      // use as a complete mapping even if a later full message repeats the original ID.
      this.assistantMessageIdentityUnknown = true;
    }
    const responseOwnerAffected = path === "" || path === "/" || path === "/message"
      || (typeof path === "string" && /^\/message\/(?:id|author)(?:\/|$)/.test(path));
    if (responseOwnerAffected) {
      // Early response ownership depends only on an explicit assistant envelope id and author.
      // Recipient/channel/content patches may change final-answer qualification but do not erase
      // the request-owned assistant identity itself.
      this.responseOwnerIdentityUnknown = true;
    }
  }

  private applyFinalAssistantMetadataPatch(pathValue: unknown, operation: unknown, value: unknown): void {
    if (!this.trackingFinalAssistant || typeof pathValue !== "string") return;
    if (pathValue === "/message/metadata") {
      if (operation === "remove") {
        this.finalAssistantMetadata = {};
      } else if (isRecord(value)) {
        const selected = selectReferenceMetadata(value);
        this.finalAssistantMetadata = operation === "append"
          ? appendReferenceMetadata(this.finalAssistantMetadata, selected)
          : selected;
      }
      return;
    }
    const prefix = "/message/metadata/";
    if (!pathValue.startsWith(prefix)) return;
    const segments = pathValue.slice(prefix.length).split("/").map(decodeJsonPointerSegment);
    applyMetadataPath(this.finalAssistantMetadata, segments, operation, value);
  }

  private recordMessage(message: Record<string, unknown>): void {
    if (!this.recordProtocolTrace) return;
    const author = message.author;
    const role = author && typeof author === "object" && (author as { role?: unknown }).role === "assistant"
      ? "assistant"
      : "other";
    const channelValue = message.channel;
    const channel = channelValue === "final"
      ? "final"
      : channelValue === "analysis"
        ? "analysis"
        : channelValue === undefined || channelValue === null
          ? "none"
          : "other";
    const content = message.content;
    const contentTypeValue = content && typeof content === "object"
      ? (content as { content_type?: unknown }).content_type
      : undefined;
    const contentType = contentTypeValue === "text"
      ? "text"
      : contentTypeValue === undefined
        ? "none"
        : "other";
    const metadata = message.metadata && typeof message.metadata === "object"
      ? message.metadata as Record<string, unknown>
      : undefined;
    const contentReferences = nestedMetadataArrayCount(metadata, "content_references");
    const safeUrls = nestedMetadataArrayCount(metadata, "safe_urls");
    const citations = nestedMetadataArrayCount(metadata, "citations");
    const refs = nestedMetadataArrayCount(metadata, "refs");
    this.recordProtocol({
      kind: "message",
      role,
      channel,
      contentType,
      finalAssistant: isFinalAssistantMessage(message),
      textChars: messageText(message).length,
      privateUseChars: privateUseCharCount(messageText(message)),
      contentReferences,
      safeUrls,
      citations,
      refs,
    });
  }

  private recordContentOperation(
    source: "direct" | "batch",
    operationValue: unknown,
    pathValue: unknown,
    value: unknown,
  ): void {
    if (!this.recordProtocolTrace) return;
    const path = typeof pathValue === "string" ? pathValue : undefined;
    const part = path?.match(/^\/message\/content\/parts\/(\d+)(.*)$/);
    const isPlain = path === undefined && operationValue === undefined && typeof value === "string";
    if (!part && !isPlain) return;
    const operation = isPlain
      ? "plain"
      : operationValue === "append" || operationValue === "replace" || operationValue === "add" || operationValue === "remove"
        ? operationValue
        : "other";
    let valueType: "string" | "array" | "object" | "boolean" | "number" | "null" | "other";
    if (value === null) valueType = "null";
    else if (Array.isArray(value)) valueType = "array";
    else if (typeof value === "string") valueType = "string";
    else if (typeof value === "boolean") valueType = "boolean";
    else if (typeof value === "number") valueType = "number";
    else if (typeof value === "object") valueType = "object";
    else valueType = "other";
    this.recordProtocol({
      kind: "content-op",
      source: isPlain ? "plain" : source,
      operation,
      ...(part ? { partIndex: Number(part[1]) } : {}),
      nestedPath: Boolean(part?.[2]),
      valueType,
      ...(typeof value === "string" ? { valueChars: value.length } : {}),
      ...(typeof value === "string" ? { privateUseChars: privateUseCharCount(value) } : {}),
      trackingFinalAssistant: this.trackingFinalAssistant,
    });
  }

  private recordMetadataOperation(
    source: "direct" | "batch",
    operationValue: unknown,
    pathValue: unknown,
    value: unknown,
  ): void {
    if (!this.recordProtocolTrace || typeof pathValue !== "string") return;
    const rootMatch = pathValue.match(/^\/message\/metadata$/);
    if (rootMatch) {
      const operation = operationValue === "append"
        || operationValue === "replace"
        || operationValue === "add"
        || operationValue === "remove"
        ? operationValue
        : "other";
      this.recordProtocol({
        kind: "metadata-root",
        source,
        operation,
        contentReferences: nestedMetadataArrayCount(value, "content_references"),
        safeUrls: nestedMetadataArrayCount(value, "safe_urls"),
        citations: nestedMetadataArrayCount(value, "citations"),
        refs: nestedMetadataArrayCount(value, "refs"),
        trackingFinalAssistant: this.trackingFinalAssistant,
      });
      return;
    }
    const match = pathValue.match(/^\/message\/metadata\/(content_references|safe_urls|citations|refs)(.*)$/);
    if (!match) return;
    const tail = match[2] ?? "";
    const category = /\/safe_urls(?:\/|$)/.test(tail)
      ? "safe-urls"
      : /\/refs(?:\/|$)/.test(tail)
        ? "refs"
        : /\/(?:start|end|start_index|end_index|start_idx|end_idx|start_ix|end_ix)(?:\/|$)/.test(tail)
          ? "indices"
          : /\/type(?:\/|$)/.test(tail)
            ? "type"
            : match[1] === "content_references"
              ? "content-references"
              : match[1] === "safe_urls"
                ? "safe-urls"
                : match[1] === "citations"
                  ? "citations"
                  : match[1] === "refs"
                    ? "refs"
                    : "other";
    const operation = operationValue === "append"
      || operationValue === "replace"
      || operationValue === "add"
      || operationValue === "remove"
      ? operationValue
      : "other";
    let valueType: "string" | "array" | "object" | "boolean" | "number" | "null" | "other";
    if (value === null) valueType = "null";
    else if (Array.isArray(value)) valueType = "array";
    else if (typeof value === "string") valueType = "string";
    else if (typeof value === "boolean") valueType = "boolean";
    else if (typeof value === "number") valueType = "number";
    else if (typeof value === "object") valueType = "object";
    else valueType = "other";
    this.recordProtocol({
      kind: "metadata-op",
      source,
      category,
      operation,
      nestedPath: Boolean(match[2]),
      valueType,
      ...(Array.isArray(value) ? { itemCount: value.length } : {}),
      trackingFinalAssistant: this.trackingFinalAssistant,
    });
  }

  private recordProtocol(event: ChatGptWireProtocolEvent): void {
    if (!this.recordProtocolTrace) return;
    this.accumulateProtocolSummary(event);
    if (this.protocolTrace.length >= 96) {
      this.protocolTraceDropped += 1;
      return;
    }
    this.protocolTrace.push(event);
  }

  private accumulateProtocolSummary(event: ChatGptWireProtocolEvent): void {
    if (event.kind === "message") {
      this.protocolSummary.messageEvents += 1;
      if (event.finalAssistant) this.protocolSummary.finalAssistantMessages += 1;
      this.protocolSummary.privateUseChars += event.privateUseChars;
      this.protocolSummary.maxContentReferences = Math.max(
        this.protocolSummary.maxContentReferences,
        event.contentReferences,
      );
      this.protocolSummary.maxSafeUrls = Math.max(this.protocolSummary.maxSafeUrls, event.safeUrls);
      this.protocolSummary.maxCitations = Math.max(this.protocolSummary.maxCitations, event.citations);
      this.protocolSummary.maxRefs = Math.max(this.protocolSummary.maxRefs, event.refs);
      return;
    }
    if (event.kind === "content-op") {
      this.protocolSummary.contentOps += 1;
      if (event.operation === "append" || event.operation === "plain") this.protocolSummary.appendOps += 1;
      if (event.operation === "replace") this.protocolSummary.replaceOps += 1;
      this.protocolSummary.privateUseChars += event.privateUseChars ?? 0;
      return;
    }
    if (event.kind === "metadata-root") {
      this.protocolSummary.metadataRootOps += 1;
      this.protocolSummary.maxContentReferences = Math.max(
        this.protocolSummary.maxContentReferences,
        event.contentReferences,
      );
      this.protocolSummary.maxSafeUrls = Math.max(this.protocolSummary.maxSafeUrls, event.safeUrls);
      this.protocolSummary.maxCitations = Math.max(this.protocolSummary.maxCitations, event.citations);
      this.protocolSummary.maxRefs = Math.max(this.protocolSummary.maxRefs, event.refs);
      return;
    }
    if (event.kind === "metadata-op") {
      this.protocolSummary.metadataOps += 1;
      const count = event.itemCount ?? 0;
      if (event.category === "content-references") {
        this.protocolSummary.maxContentReferences = Math.max(this.protocolSummary.maxContentReferences, count);
      } else if (event.category === "safe-urls") {
        this.protocolSummary.maxSafeUrls = Math.max(this.protocolSummary.maxSafeUrls, count);
      } else if (event.category === "citations") {
        this.protocolSummary.maxCitations = Math.max(this.protocolSummary.maxCitations, count);
      } else if (event.category === "refs") {
        this.protocolSummary.maxRefs = Math.max(this.protocolSummary.maxRefs, count);
      }
      return;
    }
    if (event.kind === "event-shape") {
      if (event.category === "handoff-unsupported") this.protocolSummary.unsupportedHandoffEvents += 1;
      else this.protocolSummary.unknownTypedEvents += 1;
      return;
    }
    this.protocolSummary.handoffEvents += 1;
  }
}
