import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { resolve, toNamespacedPath } from "node:path";
import {
  MAX_ROLLOUT_JSON_LINE_BYTES,
  resolveCurrentCodexRolloutAuthority,
  type AuthenticatedCodexRolloutAuthority,
  type CodexRolloutIdentity,
} from "./codex-rollout-environment";
import {
  chatGptSameTurnHumanUserRevision,
  type ChatGptTurnUserRevision,
} from "./environment";

const ROLLOUT_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_CONTROL_POLL_MS = 1_000;
const MAX_CONTROL_REVISION_IDENTITIES = 4096;

export type CodexTurnControlEvent =
  | { type: "steer"; itemId: string; content: unknown; sequence: number }
  | { type: "interrupt"; turnId: string; sequence: number }
  | { type: "turn_complete"; turnId: string; sequence: number };

export interface CodexRolloutControlTailOptions {
  codexHome: string;
  sqliteHome?: string;
  lineage: CodexRolloutIdentity;
  turnId: string;
  initialRevisions: readonly ChatGptTurnUserRevision[];
  onEvent: (event: CodexTurnControlEvent) => void;
  onError?: (error: Error) => void;
  pollIntervalMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJsonLine(line: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line.toString("utf8").replace(/^\uFEFF/, ""));
    const item = record(parsed);
    if (!item) throw new Error("not an object");
    return item;
  } catch (error) {
    throw new Error("Codex rollout control tail found an invalid complete JSONL record", { cause: error });
  }
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? toNamespacedPath(normalized).toLowerCase() : normalized;
}

function contentHash(content: unknown): string {
  const serialized = JSON.stringify(content);
  return createHash("sha256").update(serialized === undefined ? "undefined" : serialized).digest("hex");
}

function revisionIdentity(turnId: string, itemId: string, content: unknown): string {
  return `${turnId}:${itemId}:${contentHash(content)}`;
}

function sameFileIdentity(
  authority: AuthenticatedCodexRolloutAuthority,
  stat: { dev: number; ino: number; birthtimeMs: number },
): boolean {
  return stat.dev === authority.device
    && stat.ino === authority.inode
    && stat.birthtimeMs === authority.birthtimeMs;
}

export class CodexRolloutControlTail {
  readonly authority: AuthenticatedCodexRolloutAuthority;

  private readonly baseline = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly pollIntervalMs: number;
  private offset = 0;
  private carry = Buffer.alloc(0);
  private sequence = 0;
  private scopeStarted = false;
  private initialized = false;
  private closed = false;
  private polling = false;
  private pollAgain = false;
  private timer?: ReturnType<typeof setInterval>;
  private fileWatcher?: FSWatcher;

  private constructor(
    private readonly options: CodexRolloutControlTailOptions,
    authority: AuthenticatedCodexRolloutAuthority,
  ) {
    this.authority = authority;
    // The authority lookup above already proved the exact current native turn and validated the
    // rollout's session metadata. This module is a *tail*, so start at the authenticated EOF rather
    // than reparsing the entire historical JSONL on every active turn. Direct app-server control
    // frames are the primary low-latency steering/interrupt path; this watcher only needs records
    // appended after attachment for recovery/lineage confirmation.
    this.offset = authority.size;
    this.scopeStarted = true;
    this.initialized = true;
    const requestedInterval = options.pollIntervalMs ?? DEFAULT_CONTROL_POLL_MS;
    this.pollIntervalMs = Number.isFinite(requestedInterval) && requestedInterval >= 25
      ? Math.floor(requestedInterval)
      : DEFAULT_CONTROL_POLL_MS;
    for (const revision of options.initialRevisions) {
      if (!revision.itemId) continue;
      this.addBoundedIdentity(this.baseline, revisionIdentity(
        revision.turnId ?? options.turnId,
        revision.itemId,
        revision.content,
      ));
    }
  }

  static create(options: CodexRolloutControlTailOptions): CodexRolloutControlTail | undefined {
    const authority = resolveCurrentCodexRolloutAuthority({
      codexHome: options.codexHome,
      ...(options.sqliteHome ? { sqliteHome: options.sqliteHome } : {}),
      lineage: options.lineage,
      turnId: options.turnId,
    });
    return authority ? new CodexRolloutControlTail(options, authority) : undefined;
  }

  start(): void {
    if (this.closed || this.timer || this.fileWatcher) return;
    try {
      this.fileWatcher = watch(this.authority.rolloutPath, { persistent: false }, () => this.safePoll());
      this.fileWatcher.on("error", error => this.fail(error));
    } catch (error) {
      this.fail(error);
      return;
    }
    this.timer = setInterval(() => this.safePoll(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  poll(): void {
    if (this.closed) return;
    this.assertCanonicalFilePath();
    const fd = openSync(this.authority.rolloutPath, "r");
    try {
      const stat = fstatSync(fd);
      if (!sameFileIdentity(this.authority, stat)) {
        throw new Error("Codex rollout control tail detected file replacement");
      }
      if (!Number.isSafeInteger(stat.size) || stat.size < this.authority.size || stat.size < this.offset) {
        throw new Error("Codex rollout control tail detected file truncation");
      }
      const targetSize = stat.size;
      while (!this.closed && this.offset < targetSize) {
        const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, targetSize - this.offset);
        const chunk = Buffer.alloc(length);
        const count = readSync(fd, chunk, 0, length, this.offset);
        if (count !== length) throw new Error("Codex rollout changed during control-tail read");
        this.offset += count;
        this.assertCanonicalFilePath();
        const current = fstatSync(fd);
        if (!sameFileIdentity(this.authority, current) || current.size < targetSize) {
          throw new Error("Codex rollout control tail lost file identity during read");
        }
        this.consume(chunk.subarray(0, count));
      }
      if (!this.initialized) {
        this.initialized = true;
        if (!this.scopeStarted) {
          throw new Error("Codex rollout control tail found no authenticated current-turn task boundary");
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.fileWatcher?.close();
    this.fileWatcher = undefined;
    this.carry = Buffer.alloc(0);
  }

  private safePoll(): void {
    if (this.closed) return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    try {
      do {
        this.pollAgain = false;
        this.poll();
      } while (!this.closed && this.pollAgain);
    } catch (error) {
      this.fail(error);
    } finally {
      this.polling = false;
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.close();
    this.options.onError?.(normalized);
  }

  private assertCanonicalFilePath(): void {
    const stat = lstatSync(this.authority.rolloutPath);
    if (stat.isSymbolicLink() || !stat.isFile() || !sameFileIdentity(this.authority, stat)) {
      throw new Error("Codex rollout control tail lost canonical file identity");
    }
    if (pathIdentity(realpathSync(this.authority.rolloutPath)) !== pathIdentity(this.authority.rolloutPath)) {
      throw new Error("Codex rollout control tail detected a rollout path authority change");
    }
  }

  private consume(chunk: Buffer): void {
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    let start = 0;
    for (let end = data.indexOf(0x0a); end >= 0; end = data.indexOf(0x0a, start)) {
      const line = data.subarray(start, end);
      start = end + 1;
      if (line.length === 0) continue;
      if (line.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
        throw new Error("Codex rollout control tail JSONL record exceeds the bounded record size");
      }
      this.consumeRecord(parseJsonLine(line));
      if (this.closed) break;
    }
    if (this.closed) return;
    this.carry = Buffer.from(data.subarray(start));
    if (this.carry.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
      throw new Error("Codex rollout control tail JSONL record exceeds the bounded record size");
    }
  }

  private consumeRecord(item: Record<string, unknown>): void {
    const payload = record(item.payload);
    if (item.type === "event_msg" && payload?.type === "task_started") {
      const eventTurnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
      if (eventTurnId === this.options.turnId) {
        this.scopeStarted = true;
        return;
      }
      if (this.scopeStarted && eventTurnId) {
        this.emit({ type: "turn_complete", turnId: this.options.turnId, sequence: this.nextSequence() });
        this.close();
      }
      return;
    }
    if (!this.scopeStarted) return;

    if (item.type === "event_msg" && payload?.type === "turn_aborted") {
      if (payload.turn_id !== this.options.turnId) return;
      this.emit({ type: "interrupt", turnId: this.options.turnId, sequence: this.nextSequence() });
      this.close();
      return;
    }

    if (item.type !== "response_item") return;
    const revision = chatGptSameTurnHumanUserRevision(payload, this.options.turnId);
    if (!revision?.itemId) return;
    const identity = revisionIdentity(this.options.turnId, revision.itemId, revision.content);
    if (this.baseline.has(identity) || this.seen.has(identity)) return;
    this.addBoundedIdentity(this.seen, identity);
    this.emit({
      type: "steer",
      itemId: revision.itemId,
      content: revision.content,
      sequence: this.nextSequence(),
    });
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private emit(event: CodexTurnControlEvent): void {
    this.options.onEvent(event);
  }

  private addBoundedIdentity(target: Set<string>, identity: string): void {
    if (target.has(identity)) return;
    if (target.size >= MAX_CONTROL_REVISION_IDENTITIES) {
      throw new Error("Codex rollout control tail revision ledger exceeded its bound");
    }
    target.add(identity);
  }
}

export function createCodexRolloutControlTail(
  options: CodexRolloutControlTailOptions,
): CodexRolloutControlTail | undefined {
  return CodexRolloutControlTail.create(options);
}
