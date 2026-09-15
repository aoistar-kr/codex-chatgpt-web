import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chatGptCanaryExpectedTextExact } from "../src/adapters/chatgpt-web/browser-worker";
import { inspectRichMarkdownFixture, richMarkdownCanonicalExpected, richMarkdownExpected, richMarkdownPrompt } from "../scripts/lib/stream-canary-fixtures";

test("rich canary source stays exact and includes the quote and code requirements", () => {
  const expected = richMarkdownExpected();
  expect(richMarkdownPrompt()).toEndWith(expected);
  expect(inspectRichMarkdownFixture(expected)).toMatchObject({ sourceExact: true, quotedTextPresent: true, blockquoteMarkerPresent: true, codeExact: true, endMarkerPresent: true });
  expect(inspectRichMarkdownFixture(expected.replaceAll("\n", "\r\n") + "\r\n").sourceExact).toBeTrue();
  expect(inspectRichMarkdownFixture(expected + "\n\n").sourceExact).toBeFalse();
});

test("known canonical rendering is diagnosed separately and cannot pass the source-exact gate", () => {
  const canonical = richMarkdownCanonicalExpected();
  expect(canonical).not.toBe(richMarkdownExpected());
  expect(inspectRichMarkdownFixture(canonical)).toMatchObject({ sourceExact: false, canonicalExact: true, quotedTextPresent: true, blockquoteMarkerPresent: true, codeExact: true, endMarkerPresent: true });
});

test("quote loss code mutation and truncation are distinct fixture failures without output leakage", () => {
  const source = richMarkdownExpected();
  expect(inspectRichMarkdownFixture(source.replace("> quoted_alpha", "quoted_alpha"))).toMatchObject({ sourceExact: false, quotedTextPresent: true, blockquoteMarkerPresent: false });
  expect(inspectRichMarkdownFixture(source.replace("> quoted_alpha\n\n", ""))).toMatchObject({ sourceExact: false, quotedTextPresent: false, blockquoteMarkerPresent: false });
  expect(inspectRichMarkdownFixture(source.replace("const alpha_beta = 1", "const alpha_beta = 2")).codeExact).toBeFalse();
  expect(inspectRichMarkdownFixture(source.replace("const alpha_beta = 1", "const alpha_beta = 2")).codeBodyExact).toBeFalse();
  expect(inspectRichMarkdownFixture(source.replace("```ts", "```typescript"))).toMatchObject({ codeExact: false, codeBodyExact: true, codeLanguageTs: false, codeLanguageTypeScript: true });
  expect(inspectRichMarkdownFixture(source.replace("MD_FIXTURE_END", "")).endMarkerPresent).toBeFalse();
  expect(JSON.stringify(inspectRichMarkdownFixture("private fixture response"))).not.toContain("private fixture response");
});

test("known-fixture wire equality is opt-in exact and returns neither text nor digest", () => {
  const text = richMarkdownExpected();
  const digest = createHash("sha256").update(text).digest("hex");
  const env = { CODEX_CHATGPT_WEB_STREAM_CANARY_EXPECTED_SHA256: digest };
  expect(chatGptCanaryExpectedTextExact(text, {})).toBeUndefined();
  expect(chatGptCanaryExpectedTextExact(text, { CODEX_CHATGPT_WEB_STREAM_CANARY_EXPECTED_SHA256: "invalid" })).toBeUndefined();
  expect(chatGptCanaryExpectedTextExact(text, env)).toBeTrue();
  for (const changed of [text + "\n", text.replace("> quoted_alpha", "quoted_alpha"), text.replace("const alpha_beta = 1", "const alpha_beta = 2")]) {
    expect(chatGptCanaryExpectedTextExact(changed, env)).toBeFalse();
  }
  expect(JSON.stringify({ match: chatGptCanaryExpectedTextExact(text, env) })).toBe('{"match":true}');
});
