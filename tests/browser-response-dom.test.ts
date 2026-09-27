import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import type { Locator } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

type Snapshot = {
  visibleText: string;
  markdownSegments: ChatGptMarkdownSegment[];
  traceBlocks: Array<{ kind: "answer" | "commentary" | "status"; text: string }>;
};

async function snapshot(html: string): Promise<Snapshot> {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(html);
  const innerText = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText");
  const append = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "append");
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() { return this.textContent; },
  });
  Object.defineProperty(window.HTMLElement.prototype, "append", {
    configurable: true,
    value(this: HTMLElement, ...nodes: Node[]) { nodes.forEach(node => this.appendChild(node)); },
  });
  const collections = [window.document.querySelectorAll("div"), window.document.body.children]
    .map(Object.getPrototypeOf);
  const iterators = collections.map(prototype => Object.getOwnPropertyDescriptor(prototype, Symbol.iterator));
  for (const prototype of collections) Object.defineProperty(prototype, Symbol.iterator, {
    configurable: true,
    value: Array.prototype[Symbol.iterator],
  });
  try {
    const context = createContext({
      document: window.document,
      HTMLElement: window.HTMLElement,
      Element: window.Element,
      Node: window.Node,
      NodeFilter: window.NodeFilter,
      performance: { timeOrigin: 1 },
      getComputedStyle: (element: HTMLElement) => ({
        display: element.style.display || "block",
        visibility: "visible",
        opacity: "1",
      }),
      MutationObserver: class { observe() {} },
    });
    const errors: unknown[] = [];
    const locator = {
      evaluate: async (callback: Function, options: unknown) => {
        try {
          return runInContext(`(${callback.toString()})`, context)(window.document.getElementById("turn"), options);
        } catch (error) {
          errors.push(error);
          throw error;
        }
      },
      page: () => ({ isClosed: () => false }),
    } as unknown as Locator;
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      responseDomSnapshot(locator: Locator): Promise<Snapshot>;
    };
    const result = await worker.responseDomSnapshot(locator);
    if (errors.length > 0) throw errors[0];
    return result;
  } finally {
    collections.forEach((prototype, index) => {
      if (iterators[index]) Object.defineProperty(prototype, Symbol.iterator, iterators[index]!);
      else delete prototype[Symbol.iterator];
    });
    if (innerText) Object.defineProperty(window.HTMLElement.prototype, "innerText", innerText);
    else delete window.HTMLElement.prototype.innerText;
    if (append) Object.defineProperty(window.HTMLElement.prototype, "append", append);
    else delete window.HTMLElement.prototype.append;
  }
}

test("extracts the current assistant-message renderer without relying on the legacy markdown class", async () => {
  const response = await snapshot(`<section id="turn">
    <div data-content-search-unit-key="response:assistant">
      <h4 data-conversation-role="assistant">ChatGPT said:</h4>
      <div data-markdown-text-style="assistant-message"><p>Current renderer answer.</p></div>
    </div>
  </section>`);
  expect(response.visibleText).toBe("Current renderer answer.");
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(response.markdownSegments, 0);
  expect(buffer.finish().markdown).toBe("Current renderer answer.");
});

test("normalizes DIV code blocks and excludes their localized toolbar from the Markdown ledger", async () => {
  const code = '  first = "value"\n\n  print(first)\n';
  const html = (toolbar: string) => `<section id="turn" data-turn-key="code-response">
    <div data-content-search-unit-key="code-response:assistant"><h4 data-conversation-role="assistant"></h4>
    <div data-markdown-text-style="assistant-message">
      <p data-start="0" data-end="7">Example</p>
      <div data-start="8" data-end="80"><div data-markdown-copy="code-block">
        ${toolbar}<div><code class="language-python">${code}</code></div>
      </div></div>
    </div></div>
  </section>`;
  const during = await snapshot(html("코드<button>복사</button>"));
  const after = await snapshot(html(""));
  expect(during.markdownSegments[1]?.text).toBe(code.trim());
  expect(after.markdownSegments[1]?.text).toBe(code.trim());
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(during.markdownSegments, 0);
  buffer.observe(after.markdownSegments, 1);
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish().markdown).toBe(`Example\n\n\`\`\`python\n${code}\`\`\``);
});

test("keeps Activity summaries and commentary out of the final answer stream", async () => {
  const response = await snapshot(`<section id="turn" data-turn-key="activity">
    <div><span hidden data-chatgpt-agent-turn-start></span>
      <div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary"><p>Checked files</p></div>
      <div data-markdown-text-style="assistant-message"><p>I am comparing the implementations.</p></div>
    </div>
    <div data-content-search-unit-key="activity:assistant">
      <h4 data-conversation-role="assistant"></h4>
      <div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary"><p>Final answer only.</p></div>
    </div>
    <div class="turn-action-controls"><button>Copy</button></div>
  </section>`);
  expect(response.visibleText).toBe("Final answer only.");
  expect(response.traceBlocks.filter(block => block.kind === "status").map(block => block.text))
    .toContain("Checked files");
  expect(response.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text))
    .toContain("I am comparing the implementations.");
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(response.markdownSegments, 0);
  expect(buffer.finish().markdown).toBe("Final answer only.");
});
