import { expect, test } from "bun:test";
import { ChatGptWireCapture } from "../src/adapters/chatgpt-web/web-stream/network-observer";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown, compareChatGptWireAndDomMarkdown } from "../src/adapters/chatgpt-web/markdown";

// Constructed protocol/DOM fixtures, not captured ChatGPT responses or live citation evidence.
const citationUrl = "https://example.invalid/source_alpha";
const metadata = { content_references: [{ type: "citation", title: "fixture-private-title", safe_urls: [citationUrl],
  refs: ["fixture-private-ref"], citations: [{ url: citationUrl }], start_idx: 0, end_idx: 4 }] };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function capture(text = "") {
  const wire = new ChatGptWireCapture(true);
  wire.accept({ type: "start", streamId: "fixture-stream", url: "https://chatgpt.com/backend-api/conversation", status: 200, contentType: "text/event-stream" });
  feed(wire, { conversation_id: "fixture-conversation", message: {
    id: "fixture-message", author: { role: "assistant" }, recipient: "all", channel: "final",
    content: { content_type: "text", parts: [text] }, status: "in_progress",
  } });
  return wire;
}
function feed(wire: ChatGptWireCapture, value: unknown, width = 13) {
  const data = event(value);
  for (let i = 0; i < data.length; i += width) wire.accept({ type: "chunk", streamId: "fixture-stream", chunk: data.slice(i, i + width) });
}
function segment(html: string, streamable = false) {
  return { key: "rich-block", html, text: chatGptHtmlToMarkdown(html), sourceStart: 0, sourceEnd: 100, streamable };
}

test("annotated wire text and hydrated citation DOM stay structurally different after complete parsing", () => {
  const wire = capture();
  feed(wire, { p: "/message/content/parts/0", o: "append", v: "Result alpha_beta \uE200cite\uE202turn0search0\uE201" }, 1);
  feed(wire, { p: "/message/metadata", o: "append", v: metadata }, 1);
  feed(wire, { type: "message_stream_complete" });
  wire.accept({ type: "end", streamId: "fixture-stream" });
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe([segment(`<p>Result alpha_beta <a href="${citationUrl}">Reference</a></p>`)]);
  const final = wire.snapshot();
  expect(final.complete).toBeTrue();
  expect(compareChatGptWireAndDomMarkdown(final.text, buffer.finish().markdown).equivalence).toBe("different");
  expect(final.protocolSummary).toMatchObject({ privateUseChars: 3, maxContentReferences: 1, maxSafeUrls: 1, maxCitations: 1, maxRefs: 1 });
  const diagnostic = JSON.stringify({ trace: final.protocolTrace, summary: final.protocolSummary });
  for (const privateValue of [citationUrl, "fixture-private-title", "fixture-private-ref", "turn0search0"]) expect(diagnostic).not.toContain(privateValue);
});

test("metadata append replace and remove never become assistant text or reconstructed cardinality", () => {
  const wire = capture("# Report\n\nStable text.");
  feed(wire, { p: "/message/metadata", o: "append", v: metadata });
  feed(wire, { p: "/message/metadata/content_references", o: "replace", v: [] });
  feed(wire, { p: "/message/metadata/content_references", o: "remove" });
  const final = wire.snapshot();
  expect(final.text).toBe("# Report\n\nStable text.");
  expect(final.protocolSummary?.maxContentReferences).toBe(1); // Observed maximum survives removal.
  expect(final.protocolSummary?.metadataOps).toBe(2);
  expect(final.protocolSummary?.metadataRootOps).toBe(1);
  expect(compareChatGptWireAndDomMarkdown(final.text, final.text).equivalence).toBe("exact");
  // Exact text comparison does not prove fidelity of the external citation metadata.
  expect(final.protocolSummary?.maxSafeUrls).toBe(1);
});

test("late citation hydration may update an uncommitted block but cannot rewrite an emitted block", () => {
  const before = segment("<p>Result alpha_beta.</p>");
  const after = segment(`<p>Result alpha_beta. <a href="${citationUrl}">Source</a></p>`);
  const pending = new ChatGptMarkdownBuffer();
  expect(pending.observe([before], 0)).toBe("");
  expect(pending.observe([after], 1)).toBe("");
  expect(pending.finish().markdown).toBe(after.text);
  const emitted = new ChatGptMarkdownBuffer(value => value, 0);
  expect(emitted.observe([{ ...before, streamable: true }], 0)).toBe(before.text);
  expect(emitted.observe([after], 1)).toBe("");
  expect(emitted.currentSnapshotIsConsistent()).toBeFalse();
  expect(() => emitted.finish()).toThrow("streamed to Codex");
});

test("rich citation URL and literal code changes are never covered by prose underscore normalization", () => {
  for (const html of [
    `<ul><li><pre><code>alpha_beta\n</code></pre></li></ul>`,
    `<blockquote><pre><code>alpha_beta\n</code></pre></blockquote>`,
    `<p><a href="${citationUrl}">Source alpha_beta</a></p>`,
  ]) {
    const original = chatGptHtmlToMarkdown(html);
    const changed = chatGptHtmlToMarkdown(html.replaceAll("alpha_beta", "alpha\\_beta").replace("source_alpha", "source\\_alpha"));
    expect(compareChatGptWireAndDomMarkdown(original, changed).equivalence).toBe("different");
  }
});

test("rich metadata evidence survives a full protocol trace without leaking late citation payload", () => {
  const wire = capture();
  for (let i = 0; i < 110; i++) feed(wire, { p: "/message/content/parts/0", o: "append", v: "x" });
  feed(wire, { p: "/message/metadata", o: "append", v: metadata });
  feed(wire, { type: "message_stream_complete" });
  const snapshot = wire.snapshot();
  expect(snapshot.complete).toBeTrue();
  expect(snapshot.text).toBe("x".repeat(110));
  expect(snapshot.protocolTrace).toHaveLength(96);
  expect(snapshot.protocolTraceDropped).toBeGreaterThan(0);
  expect(snapshot.protocolSummary).toMatchObject({ metadataRootOps: 1, maxContentReferences: 1, maxCitations: 1 });
  expect(JSON.stringify(snapshot.protocolSummary)).not.toContain(citationUrl);
});
