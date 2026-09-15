import { expect, test } from "bun:test";
import {
  chatGptHtmlToMarkdown,
  compareChatGptWireAndDomMarkdown,
} from "../src/adapters/chatgpt-web/markdown";

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/johnmacartew/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/johnmacartew/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/johnmacartew/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/johnmacartew/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    expect(chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`))
      .toBe(`Created [${path}](<${target}>).`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("classifies byte-identical wire and DOM Markdown as exact", () => {
  expect(compareChatGptWireAndDomMarkdown(
    "- one\n- two",
    "- one\n- two",
  )).toEqual({ equivalence: "exact", normalizations: [] });
});

test("classifies only known-safe document and intraword underscore normalization as equivalent", () => {
  expect(compareChatGptWireAndDomMarkdown(
    "\r\nSTREAM_CANARY_OK\r\n",
    "STREAM\\_CANARY\\_OK",
  )).toEqual({
    equivalence: "known-safe",
    normalizations: ["line-endings", "outer-blank-lines", "intraword-underscore-escape"],
  });
});

test("never normalizes underscore escapes inside inline or fenced code", () => {
  expect(compareChatGptWireAndDomMarkdown(
    "Use `alpha_beta`.",
    "Use `alpha\\_beta`.",
  ).equivalence).toBe("different");
  expect(compareChatGptWireAndDomMarkdown(
    "```ts\nconst alpha_beta = 1;\n```",
    "```ts\nconst alpha\\_beta = 1;\n```",
  ).equivalence).toBe("different");
  expect(compareChatGptWireAndDomMarkdown(
    "Use `first line\nalpha_beta` after.",
    "Use `first line\nalpha\\_beta` after.",
  ).equivalence).toBe("different");
  expect(compareChatGptWireAndDomMarkdown(
    "```ts\n```not-a-close\nalpha_beta\n```",
    "```ts\n```not-a-close\nalpha\\_beta\n```",
  ).equivalence).toBe("different");
  expect(compareChatGptWireAndDomMarkdown(
    "\talpha_beta",
    "\talpha\\_beta",
  ).equivalence).toBe("different");
  for (const prefix of [" \t", "  \t", "   \t"]) {
    expect(compareChatGptWireAndDomMarkdown(
      `${prefix}alpha_beta`,
      `${prefix}alpha\\_beta`,
    ).equivalence).toBe("different");
  }
});

test("never treats URL, reference, autolink, or raw-HTML underscore escapes as known-safe", () => {
  const unsafePairs = [
    ["https://example.com/a_b", "https://example.com/a\\_b"],
    ["[ref]: https://example.com/a_b", "[ref]: https://example.com/a\\_b"],
    ["<https://example.com/a_b>", "<https://example.com/a\\_b>"],
    ['<a href="https://example.com/a_b">x</a>', '<a href="https://example.com/a\\_b">x</a>'],
    ["mail user_name@example.com", "mail user\\_name@example.com"],
    ["(https://example.com/a_b)", "(https://example.com/a\\_b)"],
    ["(user_name@example.com)", "(user\\_name@example.com)"],
    ["www.example.com/a_b", "www.example.com/a\\_b"],
    ["//example.com/a_b", "//example.com/a\\_b"],
  ] as const;
  for (const [wire, dom] of unsafePairs) {
    expect(compareChatGptWireAndDomMarkdown(wire, dom).equivalence).toBe("different");
  }
});

test("keeps structural Markdown differences classified as different", () => {
  expect(compareChatGptWireAndDomMarkdown(
    "* item",
    "- item",
  ).equivalence).toBe("different");
  expect(compareChatGptWireAndDomMarkdown(
    "[alpha_beta](https://example.com/a_b)",
    "[alpha\\_beta](https://example.com/a_b)",
  ).equivalence).toBe("different");
});

test("container-prefixed fences cannot normalize changed literal code into a known-safe match", () => {
  const cases = [
    "- ~~~text\n  alpha_beta\n  ~~~",
    "1. ~~~~\n   alpha_beta\n   ~~~~",
    "+ ~~~\n  alpha_beta\n  ~~~",
    "- ```text\n  ```not-a-close\n  alpha_beta\n  ```",
    "> - ~~~\n>   alpha_beta\n>   ~~~",
    "- > ~~~\n  > alpha_beta\n  > ~~~",
    "-     alpha_beta",
    "1.     alpha_beta",
  ];
  for (const wire of cases) {
    const dom = wire.replace("alpha_beta", "alpha\\_beta");
    expect(compareChatGptWireAndDomMarkdown(wire, dom).equivalence).toBe("different");
    expect(compareChatGptWireAndDomMarkdown(dom, wire).equivalence).toBe("different");
    expect(compareChatGptWireAndDomMarkdown(wire, wire).equivalence).toBe("exact");
  }
});

test("multiline raw HTML remains literal instead of leaking prose normalization across lines", () => {
  for (const wire of [
    "<pre>\nalpha_beta\n</pre>",
    "<div>\nalpha_beta\n</div>",
    "<script>\nalpha_beta\n</script>",
    '<span title="\nalpha_beta\n">value</span>',
    "<!--\nalpha_beta\n-->",
    "<![CDATA[\nalpha_beta\n]]>",
  ]) {
    expect(compareChatGptWireAndDomMarkdown(wire, wire.replace("alpha_beta", "alpha\\_beta")).equivalence).toBe("different");
  }
});

test("escaped prose backticks cannot invert the following real code span", () => {
  for (const prefix of ["\\` literal ", "\\\\\\` literal ", "\\\\", "\\\\\\\\"]) {
    const wire = `${prefix}\`alpha_beta\``;
    expect(compareChatGptWireAndDomMarkdown(wire, wire.replace("alpha_beta", "alpha\\_beta")).equivalence).toBe("different");
  }
  // Inside a code span a backslash does not escape a closing backtick.
  expect(compareChatGptWireAndDomMarkdown("`x\\` alpha_beta", "`x\\` alpha\\_beta").equivalence).toBe("known-safe");
  expect(compareChatGptWireAndDomMarkdown("alpha\\\\_beta", "alpha\\_beta").equivalence).toBe("different");
});

test("trailing blank lines in unclosed literal blocks are not disposable outer whitespace", () => {
  for (const prefix of ["~~~\nalpha", "```ts\nalpha", "- ~~~\n  alpha", "<pre>\nalpha", "<!--\nalpha"]) {
    expect(compareChatGptWireAndDomMarkdown(prefix + "\n\n", prefix + "\n").equivalence).toBe("different");
  }
});

test("reports only content-free shape metadata for residual Markdown differences", () => {
  const comparison = compareChatGptWireAndDomMarkdown(
    "alpha_beta\n\n| A | B |\n| - | - |\n",
    "alpha\\_beta\n| A | B |\n| - | - |\n",
  );
  expect(comparison.equivalence).toBe("different");
  expect(comparison.normalizations).toContain("intraword-underscore-escape");
  expect(comparison.difference).toEqual({
    firstDifferenceOffset: 11,
    commonSuffixChars: 19,
    wireCharClass: "linebreak",
    domCharClass: "pipe",
    wireLines: 4,
    domLines: 3,
    wireBlankLines: 1,
    domBlankLines: 0,
    wireTrailingSpaceLines: 0,
    domTrailingSpaceLines: 0,
    wireFenceLines: 0,
    domFenceLines: 0,
    wirePipeChars: 6,
    domPipeChars: 6,
    wireListMarkerLines: 0,
    domListMarkerLines: 0,
    wireBlockquoteLines: 0,
    domBlockquoteLines: 0,
    wireBackslashes: 0,
    domBackslashes: 0,
  });
});
