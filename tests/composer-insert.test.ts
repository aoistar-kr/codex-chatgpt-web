import { afterEach, expect, test } from "bun:test";
import { insertPlainTextIntoComposer } from "../src/adapters/chatgpt-web/browser-worker";

/**
 * The composer insert runs inside the page, where the caret state is whatever the last UI
 * interaction left behind. Effort selection closes a menu immediately before a staged part is
 * attached, so these fixtures model the focus and selection states that actually occur there.
 */
interface FakeSelection {
  isCollapsed: boolean;
  anchorNode: object | null;
  removeAllRanges(): void;
  addRange(range: object): void;
}

const originals = { document: globalThis.document, window: globalThis.window };
afterEach(() => {
  (globalThis as Record<string, unknown>).document = originals.document;
  (globalThis as Record<string, unknown>).window = originals.window;
});

function harness(options: {
  focusable: boolean;
  caretInsideComposer: boolean;
  collapsed?: boolean;
  execCommandResult?: boolean;
  connected?: boolean;
}) {
  const inside = { name: "text-node-inside-composer" };
  let composerText = "";
  const composer = {
    focus() { if (options.focusable) fakeDocument.activeElement = composer; },
    contains: (node: object | null) => node === inside || node === composer,
    get isConnected() { return options.connected ?? true; },
    cloneNode() {
      return {
        querySelectorAll: () => [],
        childNodes: [{ textContent: composerText }],
      };
    },
  };
  const calls: Array<{ command: string; value: string }> = [];
  const selection: FakeSelection = {
    isCollapsed: options.collapsed ?? true,
    anchorNode: options.caretInsideComposer ? inside : { name: "node-in-the-effort-menu" },
    removeAllRanges() { selection.anchorNode = null; },
    addRange() { selection.anchorNode = inside; selection.isCollapsed = true; },
  };
  const fakeDocument = {
    activeElement: null as unknown,
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand(command: string, _ui: boolean, value: string) {
      calls.push({ command, value });
      const accepted = options.execCommandResult ?? true;
      if (accepted) composerText += value;
      return accepted;
    },
  };
  (globalThis as Record<string, unknown>).document = fakeDocument;
  (globalThis as Record<string, unknown>).window = { getSelection: () => selection };
  return { composer: composer as unknown as HTMLElement, calls, selection, fakeDocument };
}

test("places the caret itself when focus has not yet produced one in the composer", async () => {
  // The exact state left behind a tenth of a second after the effort menu closes.
  const { composer, calls, selection } = harness({ focusable: true, caretInsideComposer: false });

  expect(await insertPlainTextIntoComposer(composer, "staged part")).toEqual({
    inserted: true,
    observed: "staged part",
  });
  expect(calls).toEqual([{ command: "insertText", value: "staged part" }]);
  expect(selection.isCollapsed).toBeTrue();
});

test("leaves an existing caret inside the composer exactly where it is", async () => {
  const { composer, calls, selection } = harness({ focusable: true, caretInsideComposer: true });
  const anchorBefore = selection.anchorNode;

  expect(await insertPlainTextIntoComposer(composer, "second part")).toEqual({
    inserted: true,
    observed: "second part",
  });
  expect(selection.anchorNode).toBe(anchorBefore);
  expect(calls).toEqual([{ command: "insertText", value: "second part" }]);
});

test("refuses to insert when the composer cannot take focus at all", async () => {
  // A covered or detached composer must still fail rather than have text typed somewhere else.
  const { composer, calls } = harness({ focusable: false, caretInsideComposer: false });

  expect(await insertPlainTextIntoComposer(composer, "staged part")).toEqual({
    inserted: false,
    observed: null,
  });
  expect(calls).toEqual([]);
});

test("reports a genuinely rejected edit as a failure", async () => {
  const { composer } = harness({
    focusable: true,
    caretInsideComposer: true,
    execCommandResult: false,
  });

  expect(await insertPlainTextIntoComposer(composer, "staged part")).toEqual({
    inserted: false,
    observed: null,
  });
});

test("withholds the fast readback when the composer is replaced after insertion", async () => {
  const { composer, calls } = harness({
    focusable: true,
    caretInsideComposer: true,
    connected: false,
  });

  expect(await insertPlainTextIntoComposer(composer, "staged part")).toEqual({
    inserted: true,
    observed: null,
  });
  expect(calls).toEqual([{ command: "insertText", value: "staged part" }]);
});

test("withholds the fast readback when renderer text changes across task boundaries", async () => {
  const { composer, calls } = harness({
    focusable: true,
    caretInsideComposer: true,
  });
  let reads = 0;
  (composer as unknown as { cloneNode(): unknown }).cloneNode = () => {
    reads += 1;
    return {
      querySelectorAll: () => [],
      childNodes: [{ textContent: reads === 1 ? "staged part" : "rewritten later" }],
    };
  };

  expect(await insertPlainTextIntoComposer(composer, "staged part")).toEqual({
    inserted: true,
    observed: null,
  });
  expect(reads).toBe(2);
  expect(calls).toEqual([{ command: "insertText", value: "staged part" }]);
});
