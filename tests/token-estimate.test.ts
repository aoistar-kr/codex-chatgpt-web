import { expect, test } from "bun:test";
import { estimateTokens } from "../src/lib/token-estimate";

test("counts GPT-5 text with the o200k tokenizer", () => {
  expect(estimateTokens("hello world")).toBe(2);
});

test("dense encoded context is not under-counted as prose", () => {
  let state = 0x12345678;
  const bytes = Buffer.allocUnsafe(300_000);
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  const encoded = bytes.toString("base64");

  expect(encoded.length).toBe(400_000);
  expect(estimateTokens(encoded)).toBeGreaterThan(256_000);
});

test("pathological repeated text is counted in bounded chunks", () => {
  expect(estimateTokens("a".repeat(32_768))).toBe(4_096);
});

test("repeated chunk accounting preserves distinct chunks and the final partial chunk", () => {
  const first = "a".repeat(4_096);
  const second = "b".repeat(4_096);
  const tail = "hello world";
  expect(estimateTokens(first.repeat(60) + second.repeat(60) + tail)).toBe(
    60 * estimateTokens(first) + 60 * estimateTokens(second) + estimateTokens(tail),
  );
});

test("chunk cache saturation preserves exact independent chunk accounting", () => {
  const chunks = Array.from({ length: 65 }, (_, index) => `${index}:`.padEnd(4_096, " word"));
  const expected = chunks.reduce((sum, chunk) => sum + estimateTokens(chunk), 0);
  expect(estimateTokens(chunks.join("").repeat(2))).toBe(expected * 2);
});

test("large ordinary prose is not inflated by a character-ratio heuristic", () => {
  const prose = `${"word ".repeat(97_999)}word`;
  expect(prose.length).toBe(489_999);
  expect(estimateTokens(prose)).toBeLessThan(100_000);
});
