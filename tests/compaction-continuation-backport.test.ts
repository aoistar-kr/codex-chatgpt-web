import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rememberCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import {
  extractChatGptTurnUserRevision,
  extractChatGptTurnIdentity,
  isChatGptCompactionContinuation,
} from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const threadId = "01a06c66-4232-7ae1-9108-69b5f70e0671";
const turnId = "01a06c66-4380-75c6-a0df-318f890ef6de";
const oldTurnId = "01a06c66-0000-75c6-a0df-318f890ef6de";

function fixture(environmentRoot?: string, summary = "Verified compacted state") {
  const codexHome = mkdtempSync(join(tmpdir(), "cgw-compaction-authority-"));
  roots.push(codexHome);
  const cwd = resolve(environmentRoot ?? codexHome, "workspace");
  mkdirSync(cwd, { recursive: true });
  const environmentXml = `<environment_context>
  <cwd>${cwd}</cwd>
  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
  const source = {
    type: "message", role: "user", id: "msg_source",
    content: [{ type: "input_text", text: "Continue the original task" }],
    internal_chat_message_metadata_passthrough: { turn_id: oldTurnId },
  };
  const currentEnvironment = {
    type: "message", role: "user", id: "msg_current_environment",
    content: [{ type: "input_text", text: environmentXml }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
  const metadata = {
    request_kind: "turn", thread_id: threadId, turn_id: turnId, agent_name: "/root",
    sandbox_mode: "danger-full-access", workspaces: { [cwd]: { has_changes: true } },
  };
  const parsed: CodexParsedRequest = {
    modelId: "chatgpt-web/high", stream: false,
    context: { messages: [{ role: "user", content: "Continue the original task", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [currentEnvironment, source, { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
    },
  };
  const compact = { ...parsed, _compactionRequest: true as const };
  rememberCompactionContinuation(compact, extractChatGptTurnIdentity(parsed), [
    { turnId: oldTurnId, content: source.content },
  ], summary);

  const dir = join(codexHome, "sessions", "2026", "09", "10");
  mkdirSync(dir, { recursive: true });
  const rollout = join(dir, `rollout-2026-09-10T02-00-00-${threadId}.jsonl`);
  writeFileSync(rollout, [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, source: "vscode" } }),
    JSON.stringify({ type: "turn_context", payload: {
      turn_id: turnId, cwd, workspace_roots: [cwd],
      sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" },
    } }),
  ].join("\n") + "\n");
  return { codexHome, cwd, parsed, currentEnvironment, summary };
}

function replaceCompactionWithReadableSummary(parsed: CodexParsedRequest, text: string): void {
  const input = (parsed._rawBody as { input: unknown[] }).input;
  input[input.length - 1] = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

test("exact completed compaction continuation re-authenticates cwd and sandbox from the current rollout", () => {
  const { codexHome, cwd, parsed } = fixture();
  expect(isChatGptCompactionContinuation(parsed)).toBeTrue();
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parsed)).toMatchObject({
    cwd, roots: [cwd], writableRoots: [cwd], sandboxPolicy: { type: "dangerFullAccess" },
  });
});

test.each([
  ["native v1", "\n"],
  ["transparent v2", "\n\n"],
])("%s readable summary re-authenticates the exact completed compaction", (_shape, separator) => {
  const { codexHome, cwd, parsed, summary } = fixture();
  replaceCompactionWithReadableSummary(parsed, `${SUMMARY_PREFIX}${separator}${summary}`);

  expect(isChatGptCompactionContinuation(parsed)).toBeTrue();
  expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parsed)).toMatchObject({
    cwd, roots: [cwd], writableRoots: [cwd], sandboxPolicy: { type: "dangerFullAccess" },
  });
});

test("transparent v2 preserves an intentional leading newline in the summary", () => {
  const summary = "\nVerified compacted state with a leading newline";
  const { parsed } = fixture(undefined, summary);
  replaceCompactionWithReadableSummary(parsed, `${SUMMARY_PREFIX}\n\n${summary}`);

  expect(isChatGptCompactionContinuation(parsed)).toBeTrue();
});

test("readable compaction continuation rejects a modified summary", () => {
  const { parsed, summary } = fixture();
  replaceCompactionWithReadableSummary(parsed, `${SUMMARY_PREFIX}\n\n${summary} modified`);

  expect(isChatGptCompactionContinuation(parsed)).toBeFalse();
  expect(() => extractChatGptTurnUserRevision(parsed))
    .toThrow("conflicts with native Codex turn_id metadata");
});

test("compaction continuation rejects a current environment claim that disagrees with the native rollout", () => {
  const { codexHome, cwd, parsed, currentEnvironment } = fixture();
  const wrong = resolve(cwd, "other");
  (currentEnvironment.content as Array<{ text: string }>)[0]!.text = (currentEnvironment.content as Array<{ text: string }>)[0]!.text.replaceAll(cwd, wrong);
  expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(parsed))
    .toThrow("conflicts with its current Codex rollout");
});
