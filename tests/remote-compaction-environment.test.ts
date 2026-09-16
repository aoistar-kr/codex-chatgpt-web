import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest } from "../src/types";

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const THREAD_ID = "01a0a8e5-8179-70f3-b5ca-a44245c11442";
const COMPACT_TURN_ID = "01a0a8e5-9000-7181-9447-6aca612627f3";
const SOURCE_TURN_ID = "01a0a8e5-8b05-7181-9447-6aca612627f2";
const OTHER_TURN_ID = "01a0a8e5-1234-7181-8447-6aca612627f4";

function compactRequest(options: {
  sourceTurnId?: string;
  metadata?: Record<string, unknown>;
  compaction?: boolean;
} = {}): CodexParsedRequest {
  const sourceTurnId = options.sourceTurnId ?? SOURCE_TURN_ID;
  const metadata = options.metadata ?? {
    request_kind: "compaction",
    thread_id: THREAD_ID,
    turn_id: COMPACT_TURN_ID,
    agent_name: "/root",
    // Intentionally no sandbox/workspaces: this is the Codex Desktop compact shape that must
    // re-authenticate authority from its canonical rollout rather than inventing cwd locally.
  };
  return {
    modelId: "chatgpt-web/high",
    stream: false,
    context: { messages: [{ role: "user", content: "Continue the task", timestamp: 1 }] },
    options: { reasoning: "high" },
    ...(options.compaction === false ? {} : { _compactionRequest: true as const }),
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [{
        type: "message",
        id: "msg_source",
        role: "user",
        content: [{ type: "input_text", text: "Continue the task" }],
        internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
      }, { type: "compaction_trigger" }],
    },
  };
}

function withRootRollout<T>(options: {
  rolloutTurnId?: string;
  sandboxPolicy?: Record<string, unknown>;
  permissionProfile?: Record<string, unknown>;
} = {}, run: (store: ChatGptThreadEnvironmentStore, cwd: string) => T): T {
  const codexHome = mkdtempSync(join(tmpdir(), "cgw-remote-compact-env-"));
  temporaryRoots.push(codexHome);
  const cwd = resolve(codexHome, "workspace");
  mkdirSync(cwd, { recursive: true });
  const sessions = join(codexHome, "sessions", "2026", "09", "16");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `rollout-2026-09-16T15-00-00-${THREAD_ID}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: THREAD_ID, source: "vscode" } }),
    JSON.stringify({ type: "turn_context", payload: {
      turn_id: options.rolloutTurnId ?? SOURCE_TURN_ID,
      cwd,
      workspace_roots: [cwd],
      sandbox_policy: options.sandboxPolicy ?? { type: "danger-full-access" },
      permission_profile: options.permissionProfile ?? { type: "disabled" },
    } }),
    "",
  ].join("\n"));
  return run(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome), cwd);
}

test("root remote compaction recovers cwd and authority from the exact canonical rollout", () => {
  withRootRollout({}, (store, cwd) => {
    expect(store.resolve(compactRequest())).toEqual({
      cwd,
      roots: [cwd],
      writableRoots: [cwd],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });
});

test("ordinary turns cannot use the sparse remote-compaction root identity", () => {
  withRootRollout({}, store => {
    expect(() => store.resolve(compactRequest({ compaction: false }))).toThrow("missing cwd");
  });
});

test("remote compaction rejects child lineage instead of borrowing root rollout authority", () => {
  withRootRollout({}, store => {
    const request = compactRequest({ metadata: {
      request_kind: "compaction",
      thread_id: THREAD_ID,
      turn_id: COMPACT_TURN_ID,
      parent_thread_id: "01a0a8e5-7777-7181-8447-6aca612627f5",
      agent_name: "/root/child",
      subagent_kind: "thread_spawn",
    } });
    expect(() => store.resolve(request)).toThrow("missing cwd");
  });
});

test("remote compaction fails closed when its source turn is not the canonical rollout turn", () => {
  withRootRollout({ rolloutTurnId: SOURCE_TURN_ID }, store => {
    expect(() => store.resolve(compactRequest({ sourceTurnId: OTHER_TURN_ID })))
      .toThrow("no canonical rollout for the requested current turn");
  });
});

test("remote compaction still rejects malformed rollout permission authority", () => {
  withRootRollout({
    sandboxPolicy: { type: "workspace-write", network_access: false },
    permissionProfile: { type: "disabled" },
  }, store => {
    expect(() => store.resolve(compactRequest())).toThrow("cannot be represented safely");
  });
});
