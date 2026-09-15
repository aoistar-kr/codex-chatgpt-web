import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ChatGptRequestInjectionShadow } from "../src/adapters/chatgpt-web/web-stream/request-injection";

async function observe(target: string, body: unknown, options: { enabled?: boolean; clone?: boolean; tamper?: boolean } = {}) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const calls: unknown[][] = [];
  const root: any = { fetch: async (...args: unknown[]) => { calls.push(args); return new Response("unchanged"); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: root });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://chatgpt.com" } });
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    exposeFunction: async (name: string, fn: (payload: string) => void) => {
      root[name] = (payload: string) => {
        if (options.tamper) { const value = JSON.parse(payload); value.promptShape.secret = "not permitted"; payload = JSON.stringify(value); }
        fn(payload);
      };
    },
    removeExposedFunction: async (name: string) => { delete root[name]; },
    evaluate: async (fn: Function, arg: unknown) => fn(arg),
    isClosed: () => false,
  } as unknown as Page;
  let shadow: ChatGptRequestInjectionShadow | undefined;
  try {
    shadow = await ChatGptRequestInjectionShadow.install(page, "shape-fixture", target, options.enabled ?? true);
    const init = { method: "POST", body: JSON.stringify(body) };
    const input = options.clone ? new Request("https://chatgpt.com/backend-api/conversation", init) : "/backend-api/conversation";
    const response = await root.fetch(input, options.clone ? undefined : init);
    expect(await response.text()).toBe("unchanged");
    if (options.clone) {
      // Request.clone().text() settles independently of the original response.
      for (let i = 0; i < 20 && !shadow.snapshot().observed; i++) await new Promise(resolve => setTimeout(resolve, 1));
      expect(await (input as Request).text()).toBe(init.body);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(input);
    if (!options.clone) expect(calls[0]![1]).toBe(init);
    return shadow.snapshot();
  } finally {
    await shadow?.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
  }
}

const prompt = "Private canary envelope retained exactly.\n> quoted fixture\nEnd of private canary envelope.";

test("prompt shape is opt-in and preserves exact-count behavior", async () => {
  const off = await observe(prompt, { parts: [prompt] }, { enabled: false });
  expect(off.exactValueMatches).toBe(1);
  expect(off.promptShape).toBeUndefined();
  const on = await observe(prompt, { parts: [prompt] });
  expect(on.exactValueMatches).toBe(1);
  expect(on.promptShape).toMatchObject({ candidateFound: true, candidateTied: false, scanTruncated: false, lineEndingsEqual: true, trimEqual: true, commonPrefixChars: prompt.length, commonSuffixChars: 0 });
  expect(JSON.stringify(on)).not.toContain("Private");
  expect(JSON.stringify(on)).not.toContain("quoted");
});

test("lost quote marker is diagnosed but never counted as an exact prompt", async () => {
  const result = await observe(prompt, { [prompt]: "irrelevant", messages: [{ content: { parts: [prompt.replace("> ", "")] } }] });
  expect(result.exactValueMatches).toBe(0);
  expect(result.promptShape).toMatchObject({ candidateFound: true, removedQuoteMarkersEqual: true, lineEndingsEqual: false, trimEqual: false, targetQuoteLines: 1, candidateQuoteLines: 0, targetChars: prompt.length, candidateChars: prompt.length - 2 });
});

test("clone-body diagnostics preserve the original body and distinguish newline drift", async () => {
  const result = await observe(prompt, { parts: [prompt.replaceAll("\n", "\r\n")] }, { clone: true });
  expect(result.bodyTransport).toBe("request-clone");
  expect(result.exactValueMatches).toBe(0);
  expect(result.promptShape).toMatchObject({ lineEndingsEqual: true, trimEqual: false });
});

test("ambiguous and unrelated candidates remain explicit", async () => {
  expect((await observe(prompt, { parts: [prompt, prompt] })).promptShape?.candidateTied).toBe(true);
  expect((await observe(prompt, { [prompt]: "unrelated" })).promptShape).toMatchObject({ candidateFound: false, candidateChars: 0, commonPrefixChars: 0, commonSuffixChars: 0 });
});

test("added punctuation escapes and HTML entities are only diagnostic, not exact matches", async () => {
  const escaped = prompt.replace(">", "&gt;").replace("fixture", "fixture\\*");
  expect((await observe(prompt, { parts: [escaped] })).promptShape?.addedEscapingOnly).toBe(false);
  const target = `${prompt}\n**emphasis** and _word_`;
  const result = await observe(target, { parts: [target.replace(">", "&gt;").replaceAll("*", "\\*").replaceAll("_", "\\_")] });
  expect(result.exactValueMatches).toBe(0);
  expect(result.promptShape).toMatchObject({ addedEscapingOnly: true, addedEscapeBackslashes: 6, addedHtmlEntities: 1 });
  const withEscapes = `${prompt}\nJSON: {"text":"line\\nvalue\\\\path"}`;
  expect((await observe(withEscapes, { parts: [withEscapes.replaceAll("\\", "\\\\")] })).promptShape).toMatchObject({ addedEscapingOnly: true, addedEscapeBackslashes: 3 });
});

test("diagnostic traversal is bounded and unexpected output fields are rejected", async () => {
  expect((await observe(prompt, { values: new Array(4_097).fill("x") })).promptShape?.scanTruncated).toBe(true);
  expect((await observe(prompt, { values: ["x".repeat(262_145)] })).promptShape?.scanTruncated).toBe(true);
  expect((await observe(prompt, { parts: [prompt] }, { tamper: true })).observed).toBe(false);
});
