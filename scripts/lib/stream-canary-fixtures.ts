import { chatGptHtmlToMarkdown } from "../../src/adapters/chatgpt-web/markdown";

export function richMarkdownExpected(): string {
  return [
    "## Markdown Fixture", "",
    "Paragraph alpha_beta with **bold_text**, *italic text*, and `inline_code`.", "",
    "- first_item", "  - nested_item", "- [OpenAI](https://openai.com/)", "",
    "> quoted_alpha", "",
    "| Key | Value |", "| --- | --- |", "| alpha_beta | `code_value` |", "",
    "```ts", "const alpha_beta = 1;", "console.log(alpha_beta);", "```", "",
    "MD_FIXTURE_END",
  ].join("\n");
}

export function richMarkdownPrompt(): string {
  return [
    "Return exactly the Markdown document below. Do not wrap the whole document in another code fence,",
    "do not explain it, and do not change punctuation, list markers, spacing, link targets, or code.",
    "", richMarkdownExpected(),
  ].join("\n");
}

/** Explicit reference rendering, not a reconstruction of an observed response. */
export function richMarkdownCanonicalExpected(): string {
  return chatGptHtmlToMarkdown([
    "<h2>Markdown Fixture</h2>",
    "<p>Paragraph alpha_beta with <strong>bold_text</strong>, <em>italic text</em>, and <code>inline_code</code>.</p>",
    '<ul><li>first_item<ul><li>nested_item</li></ul></li><li><a href="https://openai.com/">OpenAI</a></li></ul>',
    "<blockquote><p>quoted_alpha</p></blockquote>",
    "<table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>alpha_beta</td><td><code>code_value</code></td></tr></tbody></table>",
    '<pre><code class="language-ts">const alpha_beta = 1;\nconsole.log(alpha_beta);\n</code></pre>',
    "<p>MD_FIXTURE_END</p>",
  ].join(""));
}

/** Independent content-free diagnostics. No equivalence result relaxes the strict source gate. */
export function inspectRichMarkdownFixture(markdown: string) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const source = richMarkdownExpected();
  const canonical = richMarkdownCanonicalExpected();
  const exact = (value: string) => normalized === value || normalized === `${value}\n`;
  const code = normalized.match(/(?:^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1(?:\n|$)/);
  return {
    sourceExact: exact(source), canonicalExact: exact(canonical),
    sourceChars: source.length, canonicalChars: canonical.length, observedChars: normalized.length,
    quotedTextPresent: /quoted(?:_|\\_)alpha/.test(normalized),
    blockquoteMarkerPresent: /(?:^|\n)[ \t]*>[ \t]*quoted(?:_|\\_)alpha(?:\n|$)/.test(normalized),
    codeExact: normalized.includes("```ts\nconst alpha_beta = 1;\nconsole.log(alpha_beta);\n```"),
    codeBodyExact: code?.[3] === "const alpha_beta = 1;\nconsole.log(alpha_beta);",
    codeBodyChars: code?.[3]?.length ?? 0,
    codeLanguageTs: code?.[2] === "ts", codeLanguageTypeScript: code?.[2] === "typescript",
    codeLanguageChars: code?.[2]?.length ?? 0,
    codeLanguageTrimmedTs: code?.[2]?.trim().toLowerCase() === "ts",
    codeLanguageTrimmedTypeScript: code?.[2]?.trim().toLowerCase() === "typescript",
    endMarkerPresent: /(?:^|\n)MD(?:_|\\_)FIXTURE(?:_|\\_)END\n?$/.test(normalized),
  };
}
