import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

turndown.use(gfm);
turndown.remove(["button", "script", "style"]);
turndown.addRule("removeImages", {
  filter: node => ["IMG", "PICTURE", "SOURCE"].includes(node.nodeName),
  replacement: () => "",
});
turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});
turndown.addRule("linkInlineFilePaths", {
  filter: node => inlineFilePath(node) !== undefined,
  replacement: (_content, node) => {
    const path = node.textContent!;
    const target = path.replaceAll("\\", "/");
    return `[${path}](<${target}>)`;
  },
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, "")
      .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? "\n" : ""}`;
  },
});

function inlineFilePath(node: Node): string | undefined {
  if (node.nodeName !== "CODE") return undefined;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (["A", "PRE"].includes(ancestor.nodeName)) return undefined;
  }

  const path = node.textContent ?? "";
  if (path !== path.trim() || /[\s`<>()[\]]/.test(path)) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return undefined;

  const withoutLocation = path.replace(/:\d+(?::\d+)?$/, "");
  const separator = Math.max(withoutLocation.lastIndexOf("/"), withoutLocation.lastIndexOf("\\"));
  if (separator < 0) return undefined;

  const basename = withoutLocation.slice(separator + 1);
  if (!/\.[a-z\d][a-z\d._-]*$/i.test(basename)) return undefined;
  return path;
}

function preserveObsidianWikiLinks(markdown: string): string {
  // Turndown escapes literal brackets, but Codex interprets the resulting `\[` as LaTeX.
  // Double-bracket wiki links are already plain GFM text, so preserve only that exact syntax.
  return markdown.replace(/\\\[\\\[([^\r\n]*?)\\\]\\\]/g, "[[$1]]");
}

export function chatGptHtmlToMarkdown(html: string): string {
  return html.trim() ? preserveObsidianWikiLinks(turndown.turndown(html)).trim() : "";
}

export type ChatGptMarkdownEquivalence = "exact" | "known-safe" | "different";

export type ChatGptMarkdownCharClass =
  | "end"
  | "linebreak"
  | "space"
  | "backslash"
  | "underscore"
  | "asterisk"
  | "backtick"
  | "pipe"
  | "angle"
  | "bracket"
  | "paren"
  | "hash"
  | "hyphen"
  | "plus"
  | "digit"
  | "letter"
  | "punctuation"
  | "other";

export interface ChatGptMarkdownDifferenceShape {
  firstDifferenceOffset: number;
  commonSuffixChars: number;
  wireCharClass: ChatGptMarkdownCharClass;
  domCharClass: ChatGptMarkdownCharClass;
  wireLines: number;
  domLines: number;
  wireBlankLines: number;
  domBlankLines: number;
  wireTrailingSpaceLines: number;
  domTrailingSpaceLines: number;
  wireFenceLines: number;
  domFenceLines: number;
  wirePipeChars: number;
  domPipeChars: number;
  wireListMarkerLines: number;
  domListMarkerLines: number;
  wireBlockquoteLines: number;
  domBlockquoteLines: number;
  wireBackslashes: number;
  domBackslashes: number;
}

export interface ChatGptMarkdownComparison {
  equivalence: ChatGptMarkdownEquivalence;
  normalizations: Array<"line-endings" | "outer-blank-lines" | "intraword-underscore-escape">;
  difference?: ChatGptMarkdownDifferenceShape;
}

function normalizeDocumentLineEndings(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}

function trimOuterBlankLines(markdown: string): string {
  const leadingTrimmed = markdown.replace(/^\n+/g, "");
  // A trailing blank line can belong to an unclosed code/HTML block. Until block containment is
  // parsed, preserve literal-tail whitespace rather than treating every EOF newline as padding.
  return /(?:`{3,}|~{3,})|<[a-z/!?]/i.test(leadingTrimmed)
    ? leadingTrimmed
    : leadingTrimmed.replace(/\n+$/g, "");
}

function unicodeAlphaNumeric(value: string | undefined): boolean {
  return value !== undefined && /^[\p{L}\p{N}]$/u.test(value);
}

/**
 * Turndown escapes literal intraword underscores even though CommonMark does not treat an
 * underscore surrounded by letters/numbers as an emphasis delimiter. Remove only that one known
 * redundant escape, and only in ordinary prose. Code spans/fences, indented code, and link
 * destinations are deliberately left untouched so this helper can never be used as a broad
 * "looks equivalent" escape hatch.
 */
function normalizeKnownSafeIntrawordUnderscoreEscapes(markdown: string): string {
  const lines = markdown.split("\n");
  // This is a prose normalizer, not a CommonMark block parser. Container fences and raw HTML
  // can keep later, unmarked lines literal (CommonMark 0.31.2 sections 4.5/4.6/5.2). Without a
  // proven block boundary, decline underscore normalization for the document rather than erase
  // a significant backslash. Byte-identical documents still take the comparator's exact path.
  const containerLiteral = lines.some(line => (
    /^[ \t]*(?:>|[-+*][ \t]|\d+[.)][ \t])/.test(line) && /(?:`{3,}|~{3,})/.test(line)
  ) || /^[ \t]*(?:[-+*]|\d+[.)])(?: {5,}|\t)/.test(line));
  if (containerLiteral || /<[a-z/!?]/i.test(markdown)) return markdown;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let inlineCodeTicks = 0;

  return lines.map(line => {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close) {
        const run = close[1]!;
        const marker = run[0] as "`" | "~";
        if (fence.marker === marker && run.length >= fence.length) fence = undefined;
      }
      return line;
    }
    const open = inlineCodeTicks === 0 ? line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) : null;
    if (open) {
      const run = open[1]!;
      fence = { marker: run[0] as "`" | "~", length: run.length };
      return line;
    }
    // Be deliberately conservative around any syntax where an underscore escape can participate in
    // parsing or a target value rather than plain prose. A future promotion gate must never turn a
    // changed URL/reference/autolink/raw-HTML attribute into a false "known-safe" match.
    const syntaxSensitive = /^ {4}/.test(line)
      || /^[ \t]*\t/.test(line)
      || /[\[\]<>]/.test(line)
      || /(?:[a-z][a-z\d+.-]*:\/\/|www\.|\/\/)[^\s]*/i.test(line)
      || /[^\s@]+@[^\s@]+/.test(line);

    let output = "";
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      // Outside code, consume escaped backticks and paired backslashes before tick detection.
      // Inside code, backslashes are literal and must not hide a real closing delimiter.
      if (inlineCodeTicks === 0 && char === "\\" && /[\\`]/.test(line[index + 1] ?? "")) {
        output += line.slice(index, index + 2);
        index += 1;
        continue;
      }
      if (char === "`") {
        let end = index + 1;
        while (line[end] === "`") end += 1;
        const runLength = end - index;
        if (inlineCodeTicks === 0) inlineCodeTicks = runLength;
        else if (runLength === inlineCodeTicks) inlineCodeTicks = 0;
        output += line.slice(index, end);
        index = end - 1;
        continue;
      }
      if (
        !syntaxSensitive
        &&
        inlineCodeTicks === 0
        && char === "\\"
        && line[index + 1] === "_"
        && unicodeAlphaNumeric(line[index - 1])
        && unicodeAlphaNumeric(line[index + 2])
      ) {
        output += "_";
        index += 1;
        continue;
      }
      output += char;
    }
    return output;
  }).join("\n");
}

function markdownCharClass(value: string | undefined): ChatGptMarkdownCharClass {
  if (value === undefined) return "end";
  if (value === "\n") return "linebreak";
  if (value === " " || value === "\t") return "space";
  if (value === "\\") return "backslash";
  if (value === "_") return "underscore";
  if (value === "*") return "asterisk";
  if (value === "`") return "backtick";
  if (value === "|") return "pipe";
  if (value === "<" || value === ">") return "angle";
  if (value === "[" || value === "]") return "bracket";
  if (value === "(" || value === ")") return "paren";
  if (value === "#") return "hash";
  if (value === "-") return "hyphen";
  if (value === "+") return "plus";
  if (/^[0-9]$/.test(value)) return "digit";
  if (/^\p{L}$/u.test(value)) return "letter";
  if (/^[\p{P}\p{S}]$/u.test(value)) return "punctuation";
  return "other";
}

function countMatchingLines(markdown: string, predicate: (line: string) => boolean): number {
  return markdown.split("\n").filter(predicate).length;
}

function markdownDifferenceShape(wire: string, dom: string): ChatGptMarkdownDifferenceShape {
  const limit = Math.min(wire.length, dom.length);
  let firstDifferenceOffset = 0;
  while (firstDifferenceOffset < limit && wire[firstDifferenceOffset] === dom[firstDifferenceOffset]) {
    firstDifferenceOffset += 1;
  }

  let commonSuffixChars = 0;
  const maxSuffix = Math.min(
    wire.length - firstDifferenceOffset,
    dom.length - firstDifferenceOffset,
  );
  while (
    commonSuffixChars < maxSuffix
    && wire[wire.length - 1 - commonSuffixChars] === dom[dom.length - 1 - commonSuffixChars]
  ) {
    commonSuffixChars += 1;
  }

  const wireLines = wire.split("\n");
  const domLines = dom.split("\n");
  return {
    firstDifferenceOffset,
    commonSuffixChars,
    wireCharClass: markdownCharClass(wire[firstDifferenceOffset]),
    domCharClass: markdownCharClass(dom[firstDifferenceOffset]),
    wireLines: wireLines.length,
    domLines: domLines.length,
    wireBlankLines: wireLines.filter(line => line.length === 0).length,
    domBlankLines: domLines.filter(line => line.length === 0).length,
    wireTrailingSpaceLines: wireLines.filter(line => /[ \t]+$/.test(line)).length,
    domTrailingSpaceLines: domLines.filter(line => /[ \t]+$/.test(line)).length,
    wireFenceLines: countMatchingLines(wire, line => /^ {0,3}(`{3,}|~{3,})/.test(line)),
    domFenceLines: countMatchingLines(dom, line => /^ {0,3}(`{3,}|~{3,})/.test(line)),
    wirePipeChars: [...wire].filter(char => char === "|").length,
    domPipeChars: [...dom].filter(char => char === "|").length,
    wireListMarkerLines: countMatchingLines(wire, line => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line)),
    domListMarkerLines: countMatchingLines(dom, line => /^\s*(?:[-+*]|\d+[.)])\s+/.test(line)),
    wireBlockquoteLines: countMatchingLines(wire, line => /^\s*>\s?/.test(line)),
    domBlockquoteLines: countMatchingLines(dom, line => /^\s*>\s?/.test(line)),
    wireBackslashes: [...wire].filter(char => char === "\\").length,
    domBackslashes: [...dom].filter(char => char === "\\").length,
  };
}

/**
 * Conservative content-free classifier for wire Markdown vs the existing DOM/Turndown result.
 * "known-safe" means the only differences are document line endings/outer blank lines and/or
 * redundant intraword underscore escapes in ordinary prose. Everything else remains "different".
 */
export function compareChatGptWireAndDomMarkdown(
  wireMarkdown: string,
  domMarkdown: string,
): ChatGptMarkdownComparison {
  if (wireMarkdown === domMarkdown) return { equivalence: "exact", normalizations: [] };

  const normalizations: ChatGptMarkdownComparison["normalizations"] = [];
  let wire = wireMarkdown;
  let dom = domMarkdown;

  const wireLineEndings = normalizeDocumentLineEndings(wire);
  const domLineEndings = normalizeDocumentLineEndings(dom);
  if (wireLineEndings !== wire || domLineEndings !== dom) normalizations.push("line-endings");
  wire = wireLineEndings;
  dom = domLineEndings;

  const wireOuterTrimmed = trimOuterBlankLines(wire);
  const domOuterTrimmed = trimOuterBlankLines(dom);
  if (wireOuterTrimmed !== wire || domOuterTrimmed !== dom) normalizations.push("outer-blank-lines");
  wire = wireOuterTrimmed;
  dom = domOuterTrimmed;

  const wireUnderscores = normalizeKnownSafeIntrawordUnderscoreEscapes(wire);
  const domUnderscores = normalizeKnownSafeIntrawordUnderscoreEscapes(dom);
  if (wireUnderscores !== wire || domUnderscores !== dom) {
    normalizations.push("intraword-underscore-escape");
  }
  wire = wireUnderscores;
  dom = domUnderscores;

  return {
    equivalence: wire === dom ? "known-safe" : "different",
    normalizations,
    ...(wire === dom ? {} : { difference: markdownDifferenceShape(wire, dom) }),
  };
}

export interface ChatGptMarkdownSegment {
  key: string;
  tag?: string;
  html: string;
  text: string;
  group?: string;
  sourceStart?: number;
  sourceEnd?: number;
  streamable: boolean;
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number;
  streamableAt?: number;
}

interface CommittedChatGptMarkdownSegment {
  key: string;
  tag?: string;
  text: string;
  sourceStart?: number;
  sourceEnd?: number;
}

export class ChatGptMarkdownConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptMarkdownConsistencyError";
  }
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a character prefix is
 * not a safe commit boundary. It can also virtualize an already-rendered prefix, so later DOM
 * snapshots are partial observations rather than the response ledger. The browser supplies source
 * ranges for semantic blocks and marks a block streamable only after a following block exists.
 * Once committed, a missing prefix is harmless; changing text at a committed source range remains
 * an explicit protocol error because Responses deltas cannot be retracted.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<string, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;
  private consistencyError: ChatGptMarkdownConsistencyError | undefined;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error("ChatGPT Markdown stability window must be a non-negative finite number");
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    const reconciled = this.reconcile(segments);
    if (reconciled instanceof ChatGptMarkdownConsistencyError) {
      this.consistencyError = reconciled;
      return "";
    }
    this.consistencyError = undefined;
    this.latest = reconciled.map(segment => ({ ...segment }));

    const visibleCandidates = new Set<string>();
    for (const segment of reconciled) {
      const candidateId = this.candidateId(segment);
      visibleCandidates.add(candidateId);
      const previous = this.candidates.get(candidateId);
      const unchanged = previous
        && previous.key === segment.key
        && previous.tag === segment.tag
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group
        && previous.sourceStart === segment.sourceStart
        && previous.sourceEnd === segment.sourceEnd;
      this.candidates.set(candidateId, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      });
    }
    for (const candidateId of this.candidates.keys()) {
      if (!visibleCandidates.has(candidateId)) this.candidates.delete(candidateId);
    }

    let delta = "";
    let committedCount = 0;
    while (committedCount < reconciled.length) {
      const segment = reconciled[committedCount]!;
      const candidateId = this.candidateId(segment);
      const candidate = this.candidates.get(candidateId);
      if (!candidate?.streamable || candidate.streamableAt === undefined) break;
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
      delta += this.commit(candidate);
      this.committed.push(this.committedSegment(candidate));
      this.candidates.delete(candidateId);
      committedCount += 1;
    }
    this.latest = this.latest.slice(committedCount);
    return delta;
  }

  finish(): { markdown: string; delta: string } {
    if (this.consistencyError) throw this.consistencyError;
    let delta = "";
    for (const segment of this.latest) {
      delta += this.commit(segment);
      this.committed.push(this.committedSegment(segment));
    }
    this.candidates.clear();
    this.latest = [];
    return { markdown: this.markdown, delta };
  }

  currentSnapshotIsConsistent(): boolean {
    return this.consistencyError === undefined;
  }

  /**
   * Non-mutating compatibility check for a freshly rebound DOM projection. Recovery uses this
   * before it is allowed to resume the existing append-only ledger; no candidate/commit state is
   * changed until every independent identity proof has passed.
   */
  observationIsConsistent(segments: ChatGptMarkdownSegment[]): boolean {
    return !(this.reconcile(segments) instanceof ChatGptMarkdownConsistencyError);
  }

  private reconcile(
    segments: ChatGptMarkdownSegment[],
  ): ChatGptMarkdownSegment[] | ChatGptMarkdownConsistencyError {
    if (this.committed.length === 0 || segments.length === 0) return segments;

    const pending: ChatGptMarkdownSegment[] = [];
    const lastCommittedEnd = this.committed
      .map(segment => segment.sourceEnd)
      .filter((end): end is number => end !== undefined)
      .at(-1);
    let highestCommittedIndex = -1;
    let sawPending = false;
    let previousSourceStart: number | undefined;

    for (const segment of segments) {
      if (segment.sourceStart !== undefined) {
        if (previousSourceStart !== undefined && segment.sourceStart <= previousSourceStart) {
          return new ChatGptMarkdownConsistencyError(
            "ChatGPT final DOM exposed non-monotonic source ranges",
          );
        }
        previousSourceStart = segment.sourceStart;
      }
      const committedIndex = this.committedIndex(segment);
      if (committedIndex !== undefined) {
        const committed = this.committed[committedIndex]!;
        if (sawPending || committedIndex < highestCommittedIndex || committed.text !== segment.text) {
          return this.changedCommittedBlockError();
        }
        highestCommittedIndex = committedIndex;
        continue;
      }

      if (segment.sourceStart !== undefined && lastCommittedEnd !== undefined) {
        if (segment.sourceStart <= lastCommittedEnd) return this.changedCommittedBlockError();
        sawPending = true;
        pending.push(segment);
        continue;
      }

      const followsVisibleCommittedTail = highestCommittedIndex === this.committed.length - 1;
      if (!followsVisibleCommittedTail && !this.matchesLatestPending(segment)) {
        return new ChatGptMarkdownConsistencyError(
          "ChatGPT final DOM could not be aligned with text already streamed to Codex",
        );
      }
      sawPending = true;
      pending.push(segment);
    }

    return pending;
  }

  private committedIndex(segment: ChatGptMarkdownSegment): number | undefined {
    const exact = this.committed.findIndex(committed => (
      segment.sourceStart !== undefined && committed.sourceStart !== undefined
        ? segment.sourceStart === committed.sourceStart && segment.tag === committed.tag
        : segment.key === committed.key
    ));
    if (exact >= 0) return exact;

    if (segment.sourceStart !== undefined) return undefined;
    if (!segment.tag) return undefined;
    const semanticMatches = this.committed
      .map((committed, index) => ({ committed, index }))
      .filter(({ committed }) => committed.tag === segment.tag && committed.text === segment.text);
    return semanticMatches.length === 1 ? semanticMatches[0]!.index : undefined;
  }

  private matchesLatestPending(segment: ChatGptMarkdownSegment): boolean {
    const exact = this.latest.filter(candidate => (
      segment.sourceStart !== undefined && candidate.sourceStart !== undefined
        ? segment.sourceStart === candidate.sourceStart && segment.tag === candidate.tag
        : segment.key === candidate.key
    ));
    if (exact.length === 1) return true;
    if (segment.sourceStart !== undefined) return false;
    if (!segment.tag) return false;
    return this.latest.filter(candidate => (
      candidate.tag === segment.tag && candidate.text === segment.text
    )).length === 1;
  }

  private candidateId(segment: ChatGptMarkdownSegment): string {
    return segment.sourceStart !== undefined
      ? `source:${segment.sourceStart}:${segment.tag ?? ""}`
      : `key:${segment.key}`;
  }

  private committedSegment(segment: ChatGptMarkdownSegment): CommittedChatGptMarkdownSegment {
    return {
      key: segment.key,
      ...(segment.tag ? { tag: segment.tag } : {}),
      text: segment.text,
      ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
      ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
    };
  }

  private changedCommittedBlockError(): ChatGptMarkdownConsistencyError {
    return new ChatGptMarkdownConsistencyError(
      "ChatGPT changed a completed text block that was already streamed to Codex",
    );
  }

  private commit(segment: ChatGptMarkdownSegment): string {
    const block = this.transform(chatGptHtmlToMarkdown(segment.html));
    if (!block) return "";
    const separator = this.markdown
      ? segment.group !== undefined && segment.group === this.lastGroup ? "\n" : "\n\n"
      : "";
    const delta = `${separator}${block}`;
    this.markdown += delta;
    this.lastGroup = segment.group;
    return delta;
  }
}
