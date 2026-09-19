import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createCodexRolloutControlTail,
  type CodexTurnControlEvent,
} from "../src/adapters/chatgpt-web/codex-rollout-control";

const THREAD_ID = "01a0a9e1-5e11-7453-8b94-87d7a7857831";
const TURN_ID = "01a0b111-1111-7111-8111-111111111111";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function rolloutFixture() {
  const codexHome = mkdtempSync(join(tmpdir(), "cgw-rollout-control-"));
  temporaryRoots.push(codexHome);
  const workspace = resolve(codexHome, "workspace");
  const sessions = join(codexHome, "sessions", "2026", "09", "16");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const rolloutPath = join(sessions, `rollout-2026-09-16T20-01-54-${THREAD_ID}.jsonl`);
  const initialContent = [{ type: "input_text", text: "initial request" }];
  writeFileSync(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: THREAD_ID, source: "vscode" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: TURN_ID } }),
    JSON.stringify({ type: "response_item", payload: {
      type: "message",
      id: "msg_initial",
      role: "user",
      content: initialContent,
      internal_chat_message_metadata_passthrough: { turn_id: TURN_ID },
    } }),
    JSON.stringify({ type: "turn_context", payload: {
      turn_id: TURN_ID,
      cwd: workspace,
      workspace_roots: [workspace],
      sandbox_policy: { type: "danger-full-access" },
      permission_profile: { type: "disabled" },
    } }),
    "",
  ].join("\n"));
  return { codexHome, rolloutPath, initialContent, workspace };
}

test("authenticated rollout control emits only new same-turn human steering once", () => {
  const fixture = rolloutFixture();
  const events: CodexTurnControlEvent[] = [];
  const tail = createCodexRolloutControlTail({
    codexHome: fixture.codexHome,
    lineage: { threadId: THREAD_ID, sandboxType: "dangerFullAccess", workspaceRoots: [fixture.workspace] },
    turnId: TURN_ID,
    initialRevisions: [{ itemId: "msg_initial", turnId: TURN_ID, content: fixture.initialContent }],
    onEvent: event => events.push(event),
  });
  expect(tail).toBeDefined();
  tail!.poll();
  expect(events).toEqual([]);

  const steering = {
    type: "response_item",
    payload: {
      type: "message",
      id: "msg_steer",
      role: "user",
      content: [{ type: "input_text", text: "change direction now" }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN_ID },
    },
  };
  appendFileSync(fixture.rolloutPath, `${JSON.stringify(steering)}\n${JSON.stringify(steering)}\n`);
  tail!.poll();
  expect(events).toEqual([{
    type: "steer",
    itemId: "msg_steer",
    content: steering.payload.content,
    sequence: 1,
  }]);
  tail!.close();
});

test("authenticated rollout abort wins and closes the control tail", () => {
  const fixture = rolloutFixture();
  const events: CodexTurnControlEvent[] = [];
  const tail = createCodexRolloutControlTail({
    codexHome: fixture.codexHome,
    lineage: { threadId: THREAD_ID, sandboxType: "dangerFullAccess", workspaceRoots: [fixture.workspace] },
    turnId: TURN_ID,
    initialRevisions: [{ itemId: "msg_initial", turnId: TURN_ID, content: fixture.initialContent }],
    onEvent: event => events.push(event),
  });
  tail!.poll();
  appendFileSync(fixture.rolloutPath, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: TURN_ID },
  })}\n`);
  tail!.poll();
  expect(events).toEqual([{ type: "interrupt", turnId: TURN_ID, sequence: 1 }]);

  appendFileSync(fixture.rolloutPath, `${JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      id: "msg_too_late",
      role: "user",
      content: [{ type: "input_text", text: "too late" }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN_ID },
    },
  })}\n`);
  tail!.poll();
  expect(events).toHaveLength(1);
});

test("rollout control ignores foreign-turn records and stops at the next task boundary", () => {
  const fixture = rolloutFixture();
  const events: CodexTurnControlEvent[] = [];
  const tail = createCodexRolloutControlTail({
    codexHome: fixture.codexHome,
    lineage: { threadId: THREAD_ID, sandboxType: "dangerFullAccess", workspaceRoots: [fixture.workspace] },
    turnId: TURN_ID,
    initialRevisions: [{ itemId: "msg_initial", turnId: TURN_ID, content: fixture.initialContent }],
    onEvent: event => events.push(event),
  });
  tail!.poll();
  const foreignTurn = "01a0b222-2222-7222-8222-222222222222";
  appendFileSync(fixture.rolloutPath, [
    JSON.stringify({ type: "response_item", payload: {
      type: "message",
      id: "msg_foreign",
      role: "user",
      content: [{ type: "input_text", text: "foreign" }],
      internal_chat_message_metadata_passthrough: { turn_id: foreignTurn },
    } }),
    JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: foreignTurn } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: foreignTurn } }),
    "",
  ].join("\n"));
  tail!.poll();
  expect(events).toEqual([{ type: "turn_complete", turnId: TURN_ID, sequence: 1 }]);
});

test("rollout control fails closed when the authenticated file is truncated", () => {
  const fixture = rolloutFixture();
  const tail = createCodexRolloutControlTail({
    codexHome: fixture.codexHome,
    lineage: { threadId: THREAD_ID, sandboxType: "dangerFullAccess", workspaceRoots: [fixture.workspace] },
    turnId: TURN_ID,
    initialRevisions: [{ itemId: "msg_initial", turnId: TURN_ID, content: fixture.initialContent }],
    onEvent: () => {},
  });
  tail!.poll();
  writeFileSync(fixture.rolloutPath, "{}\n");
  expect(() => tail!.poll()).toThrow("file truncation");
  tail!.close();
});
