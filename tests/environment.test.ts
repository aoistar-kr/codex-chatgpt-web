import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractChatGptTurnEnvironment, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest, CodexTool } from "../src/types";

const root = resolve(process.cwd());
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const environmentXml = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

function filesystemEnvironmentXml(permissionProfileXml: string): string {
  return `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots>${permissionProfileXml}</filesystem>
</environment_context>`;
}

const dangerFullAccessProfileXml = `<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>`;
const workspaceWriteProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>${root}</path></entry><entry access="write"><special>:slash_tmp</special></entry><entry access="write"><special>:tmpdir</special></entry><entry access="read"><path>${root}/.git</path></entry></file_system></permission_profile>`;
const readOnlyProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>`;
const externalProfileXml = `<permission_profile type="external"><file_system type="external" /></permission_profile>`;

function currentWire(
  options: { workspace?: string; sandbox?: string; includeIds?: boolean; environmentXml?: string } = {},
): CodexParsedRequest {
  const workspace = options.workspace ?? root;
  const sandbox = options.sandbox ?? "none";
  const includeIds = options.includeIds ?? true;
  const envXml = options.environmentXml ?? environmentXml;
  const turnMetadata = {
    thread_id: "thread_current",
    turn_id: "turn_current",
    sandbox,
    workspaces: { [workspace]: { has_changes: true } },
  };
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: { messages: [{ role: "user", content: "Inspect the workspace", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(turnMetadata) },
      input: [
        {
          type: "message",
          ...(includeIds ? { id: "msg_context" } : {}),
          role: "user",
          content: [
            { type: "input_text", text: "<app-context>native app context</app-context>" },
            { type: "input_text", text: envXml },
          ],
        },
        {
          type: "message",
          ...(includeIds ? { id: "msg_active" } : {}),
          role: "user",
          content: [{ type: "input_text", text: "Inspect the workspace" }],
        },
      ],
    },
  };
}

function rolloutOnlyRequest(options: {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  sandbox?: string;
  workspace?: string;
  includeSessionId?: boolean;
} = {}): CodexParsedRequest {
  const sessionId = options.sessionId ?? "session_rollout_123";
  const threadId = options.threadId ?? sessionId;
  const turnId = options.turnId ?? "turn_rollout_123";
  const workspace = options.workspace ?? root;
  const request = currentWire({ workspace, sandbox: options.sandbox ?? "none" });
  const body = request._rawBody as { client_metadata: Record<string, string>; input: Array<Record<string, unknown>> };
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    ...(options.includeSessionId === false ? {} : { session_id: sessionId }),
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox: options.sandbox ?? "none",
    workspaces: { [workspace]: { has_changes: true } },
  });
  body.input[0]!.content = [{ type: "input_text", text: "<app-context>native app context</app-context>" }];
  return request;
}

function withCodexRollout<T>(options: {
  request?: CodexParsedRequest;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  cwd?: string;
  roots?: string[];
  sandboxPolicy?: Record<string, unknown>;
  includeThreadSettings?: boolean;
  threadSettingsCwd?: string;
  laterThreadSettingsCwd?: string;
}, fn: (request: CodexParsedRequest) => T): T {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-rollout-"));
  temporaryRoots.push(codexHome);
  const sessionId = options.sessionId ?? "session_rollout_123";
  const threadId = options.threadId ?? sessionId;
  const turnId = options.turnId ?? "turn_rollout_123";
  const cwd = options.cwd ?? root;
  const roots = options.roots ?? [root];
  const request = options.request ?? rolloutOnlyRequest({ sessionId, threadId, turnId });
  const dir = join(codexHome, "sessions", "2026", "09", "09");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: sessionId, session_id: sessionId, cwd } }),
    ...(options.includeThreadSettings === false ? [] : [JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_id: threadId,
        thread_settings: { cwd: options.threadSettingsCwd ?? cwd },
      },
    })]),
    JSON.stringify({
      type: "turn_context",
      payload: {
        turn_id: turnId,
        root_turn_id: turnId,
        cwd,
        workspace_roots: roots,
        sandbox_policy: options.sandboxPolicy ?? { type: "danger-full-access" },
      },
    }),
    ...(options.laterThreadSettingsCwd ? [JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_id: threadId,
        thread_settings: { cwd: options.laterThreadSettingsCwd },
      },
    })] : []),
    "",
  ];
  writeFileSync(join(dir, `rollout-2026-09-09T13-00-00-${sessionId}.jsonl`), lines.join("\n"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try { return fn(request); }
  finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

describe("trusted current Codex environment envelope", () => {
  test("accepts the v0.146 split envelope when workspace and sandbox metadata agree", () => {
    expect(extractChatGptTurnEnvironment(currentWire())).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("recovers the first workspace root from a cwd-less filesystem diff", () => {
    const primary = resolve(root, "workspace-primary");
    const additional = resolve(root, "workspace-additional");
    const cwdlessEnvironment = `<environment_context>
  <filesystem><workspace_roots><root>${primary}</root><root>${additional}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;

    expect(extractChatGptTurnEnvironment(currentWire({
      workspace: primary,
      environmentXml: cwdlessEnvironment,
    }))).toMatchObject({
      cwd: primary,
      roots: [primary, additional],
      writableRoots: [primary, additional],
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  test("fails closed for malformed cwd markup instead of using workspace-root recovery", () => {
    const malformedEnvironment = `<environment_context>
  <cwd/>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;

    expect(() => extractChatGptTurnEnvironment(currentWire({ environmentXml: malformedEnvironment })))
      .toThrow("missing cwd");
  });

  test("accepts Codex 0.153 rollout turn_context when the request omits environment XML", () => {
    withCodexRollout({}, request => {
      expect(extractChatGptTurnEnvironment(request)).toEqual({
        cwd: root,
        roots: [root],
        writableRoots: [root],
        sandboxPolicy: { type: "dangerFullAccess" },
        tools: [],
      });
    });
  });

  test("accepts Codex Desktop root rollout without session_id or initial thread_settings", () => {
    const request = rolloutOnlyRequest({ includeSessionId: false });
    withCodexRollout({ request, includeThreadSettings: false }, value => {
      expect(extractChatGptTurnEnvironment(value)).toEqual({
        cwd: root,
        roots: [root],
        writableRoots: [root],
        sandboxPolicy: { type: "dangerFullAccess" },
        tools: [],
      });
    });
  });

  test("sessionless rollout bootstrap is root-thread only", () => {
    const request = rolloutOnlyRequest({
      includeSessionId: false,
      sessionId: "session_rollout_123",
      threadId: "thread_child_123",
    });
    withCodexRollout({
      request,
      sessionId: "session_rollout_123",
      threadId: "thread_child_123",
      includeThreadSettings: false,
    }, value => {
      expect(() => extractChatGptTurnEnvironment(value)).toThrow("missing cwd");
    });
  });

  test("later thread settings do not retroactively invalidate an earlier exact turn_context", () => {
    const request = rolloutOnlyRequest({ includeSessionId: false });
    withCodexRollout({
      request,
      includeThreadSettings: false,
      laterThreadSettingsCwd: resolve(root, "later-workspace"),
    }, value => {
      expect(extractChatGptTurnEnvironment(value).cwd).toBe(root);
    });
  });

  test("thread settings before the target turn must agree with its cwd", () => {
    const request = rolloutOnlyRequest({ includeSessionId: false });
    const other = resolve(root, "other-thread-cwd");
    withCodexRollout({ request, cwd: other, roots: [other], threadSettingsCwd: root }, value => {
      expect(() => extractChatGptTurnEnvironment(value)).toThrow("missing cwd");
    });
  });

  test("maps rollout workspace-write and read-only policies without widening authority", () => {
    withCodexRollout({
      request: rolloutOnlyRequest({ sandbox: "workspace-write" }),
      sandboxPolicy: { type: "workspace-write", network_access: false },
    }, request => {
      expect(extractChatGptTurnEnvironment(request)).toMatchObject({
        writableRoots: [root],
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      });
    });
    withCodexRollout({
      request: rolloutOnlyRequest({ sandbox: "read-only" }),
      sandboxPolicy: { type: "read-only" },
    }, request => {
      expect(extractChatGptTurnEnvironment(request)).toMatchObject({
        writableRoots: [],
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
    });
  });

  test("rejects rollout fallback when session, thread, turn, roots, or sandbox authority disagree", () => {
    const outside = resolve(root, "..", "rollout-outside");
    const cases: Array<Parameters<typeof withCodexRollout>[0]> = [
      { request: rolloutOnlyRequest(), sessionId: "session_other_123" },
      { request: rolloutOnlyRequest({ threadId: "thread_other_123" }) },
      { request: rolloutOnlyRequest(), turnId: "turn_other_123" },
      { request: rolloutOnlyRequest(), cwd: root, roots: [outside] },
      { request: rolloutOnlyRequest(), sandboxPolicy: { type: "read-only" } },
    ];
    for (const testCase of cases) {
      withCodexRollout(testCase, request => {
        expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
      });
    }
  });

  test("does not let conflicting XML fall through to rollout authority", () => {
    const conflicting = `<environment_context>
  <cwd>${root}</cwd>
  <cwd>${resolve(root, "other")}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;
    const request = rolloutOnlyRequest();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    body.input[0]!.content = [{ type: "input_text", text: conflicting }];
    withCodexRollout({ request }, value => {
      expect(() => extractChatGptTurnEnvironment(value)).toThrow();
    });
  });

  test("accepts a trusted same-turn developer message between the environment and prompt", () => {
    const request = currentWire();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    for (const item of body.input) {
      item.internal_chat_message_metadata_passthrough = { turn_id: "turn_current" };
    }
    body.input.splice(1, 0, {
      type: "message",
      id: "msg_developer",
      role: "developer",
      content: [{ type: "input_text", text: "Follow the current task instructions." }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
    });

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("accepts either canonical provenance form on an intervening developer message", () => {
    for (const developer of [
      {
        type: "message",
        id: "msg_developer_without_turn",
        role: "developer",
        content: [{ type: "input_text", text: "Server-owned developer content" }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Same-turn developer content" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
      },
    ]) {
      const request = currentWire();
      const body = request._rawBody as { input: Array<Record<string, unknown>> };
      body.input.splice(1, 0, developer);
      expect(extractChatGptTurnEnvironment(request).cwd).toBe(root);
    }
  });

  test("accepts same-turn Codex app additional context between the environment and prompt", () => {
    const auxiliary = resolve(root, "..", "desktop-nongit-workspace");
    const desktopEnvironment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${auxiliary}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;
    const request = currentWire({ environmentXml: desktopEnvironment });
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    body.input.splice(1, 0, {
      type: "message",
      id: "msg_writing_block_edits",
      role: "user",
      content: [{ type: "input_text", text: "<external_codex_apps_writing_block_edits>[]</external_codex_apps_writing_block_edits>" }],
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn_current",
        content_item_kinds: ["additional_content.codex_apps_writing_block_edits"],
      },
    });

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: root,
      roots: [root, auxiliary],
      writableRoots: [root, auxiliary],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("rejects user-shaped app context without same-turn additional-content provenance", () => {
    const auxiliary = resolve(root, "..", "desktop-untrusted-extra-root");
    const multiRootEnvironment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${auxiliary}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;
    for (const gap of [
      {
        type: "message",
        id: "msg_unprovenanced_app_context",
        role: "user",
        content: [{ type: "input_text", text: "<external_codex_apps_writing_block_edits>[]</external_codex_apps_writing_block_edits>" }],
      },
      {
        type: "message",
        id: "msg_wrong_kind",
        role: "user",
        content: [{ type: "input_text", text: "Looks like app context" }],
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn_current",
          content_item_kinds: ["user.text"],
        },
      },
      {
        type: "message",
        id: "msg_other_turn",
        role: "user",
        content: [{ type: "input_text", text: "Looks like app context" }],
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn_other",
          content_item_kinds: ["additional_content.codex_apps_writing_block_edits"],
        },
      },
    ]) {
      const request = currentWire({ environmentXml: multiRootEnvironment });
      const body = request._rawBody as { input: Array<Record<string, unknown>> };
      body.input.splice(1, 0, gap);
      expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
    }
  });

  test("rejects an unprovenanced developer gap before the environment", () => {
    const request = currentWire();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    body.input.splice(1, 0, {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Unprovenanced developer content" }],
    });

    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
  });

  test("rejects a developer gap owned by another turn", () => {
    const request = currentWire();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    body.input.splice(1, 0, {
      type: "message",
      id: "msg_developer_other_turn",
      role: "developer",
      content: [{ type: "input_text", text: "Other-turn developer content" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_other" },
    });

    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
  });

  test("rejects a workspace mismatch", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({ workspace: resolve(root, "elsewhere") })))
      .toThrow("missing cwd");
  });

  test("rejects a sandbox mismatch", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({ sandbox: "read-only" })))
      .toThrow("missing cwd");
  });

  test("rejects unprovenanced adjacent user content without native item ids", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({ includeIds: false })))
      .toThrow("missing cwd");
  });

  test("recovers a canonical current-turn environment when a skill message follows the prompt", () => {
    const request = currentWire();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    for (const item of body.input) {
      item.internal_chat_message_metadata_passthrough = { turn_id: "turn_current" };
    }
    body.input.push({
      type: "message",
      id: "msg_skill",
      role: "user",
      content: [{ type: "input_text", text: "<skill name=\"repository-review\">Use this skill.</skill>" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
    });

    expect(extractChatGptTurnEnvironment(request)).toMatchObject({
      cwd: root,
      roots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  test("skill recovery accepts the current task's Codex visualization root", () => {
    const codexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    const visualizationRoot = join(codexHome, "visualizations", "2026", "08", "25", "thread_current");
    const projectEnvironment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${visualizationRoot}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;
    const request = currentWire({ environmentXml: projectEnvironment });
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    for (const item of body.input) {
      item.internal_chat_message_metadata_passthrough = { turn_id: "turn_current" };
    }
    body.input.splice(1, 0, {
      type: "message",
      id: "msg_developer",
      role: "developer",
      content: [{ type: "input_text", text: "Current Codex Desktop developer context." }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
    });
    body.input.push({
      type: "message",
      id: "msg_skill",
      role: "user",
      content: [{ type: "input_text", text: "<skill name=\"autopilot\">Use this skill.</skill>" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
    });

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: root,
      roots: [root, visualizationRoot],
      writableRoots: [root, visualizationRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("steering accepts the spawned task's parent visualization root", () => {
    const codexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    const visualizationRoot = join(codexHome, "visualizations", "2026", "08", "25", "thread_parent");
    const projectEnvironment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${visualizationRoot}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;
    const request = currentWire({
      environmentXml: projectEnvironment,
    });
    const body = request._rawBody as { client_metadata: Record<string, string>; input: Array<Record<string, unknown>> };
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    metadata.thread_id = "thread_child";
    metadata.parent_thread_id = "thread_parent";
    metadata.agent_name = "/root/reviewer";
    metadata.subagent_kind = "thread_spawn";
    metadata.request_kind = "turn";
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    for (const item of body.input) item.internal_chat_message_metadata_passthrough = { turn_id: "turn_current" };
    body.input.push(
      {
        type: "message", id: "msg_assistant", role: "assistant",
        content: [{ type: "output_text", text: "Working." }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
      },
      {
        type: "message", id: "msg_steering", role: "user",
        content: [{ type: "input_text", text: "Stop and review first." }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
      },
    );

    expect(extractChatGptTurnEnvironment(request).roots).toEqual([root, visualizationRoot]);
  });

  test("skill recovery rejects another task's Codex visualization root", () => {
    const codexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
    const visualizationRoot = join(codexHome, "visualizations", "2026", "08", "25", "thread_other");
    const injectedEnvironment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${visualizationRoot}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;
    const request = currentWire({ environmentXml: injectedEnvironment });
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    for (const item of body.input) {
      item.internal_chat_message_metadata_passthrough = { turn_id: "turn_current" };
    }
    body.input.push({
      type: "message",
      id: "msg_skill",
      role: "user",
      content: [{ type: "input_text", text: "<skill name=\"autopilot\">Use this skill.</skill>" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
    });

    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
  });

  test("same-turn skill recovery cannot trust roots outside canonical workspace metadata", () => {
    const outside = resolve(root, "..", "untrusted-skill-root");
    const injectedEnvironment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${outside}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;
    const request = currentWire({ environmentXml: injectedEnvironment });
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    for (const item of body.input) {
      item.internal_chat_message_metadata_passthrough = { turn_id: "turn_current" };
    }
    body.input.push({
      type: "message",
      id: "msg_skill",
      role: "user",
      content: [{ type: "input_text", text: "<skill name=\"repository-review\">Use this skill.</skill>" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
    });

    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
  });

  test("accepts Codex auxiliary roots that are intentionally absent from git workspace metadata", () => {
    const auxiliary = resolve(root, "auxiliary-output");
    const projectEnvironment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${auxiliary}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;
    expect(extractChatGptTurnEnvironment(currentWire({ environmentXml: projectEnvironment }))).toEqual({
      cwd: root,
      roots: [root, auxiliary],
      writableRoots: [root, auxiliary],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("uses the primary cwd from Codex's canonical multi-environment envelope", () => {
    const secondary = resolve(root, "secondary-environment");
    const multiEnvironment = `<environment_context>
  <environments>
    <environment id="secondary" primary="false">
      <cwd>${secondary}</cwd>
      <shell>bash</shell>
    </environment>
    <environment id="primary" primary="true">
      <cwd>${root}</cwd>
      <shell>bash</shell>
    </environment>
  </environments>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;

    expect(extractChatGptTurnEnvironment(currentWire({ environmentXml: multiEnvironment }))).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("selects the metadata-authenticated cwd from the stable legacy multi-environment envelope", () => {
    const auxiliary = resolve(root, "legacy-auxiliary");
    const legacyEnvironment = `<environment_context>
  <environments>
    <environment id="auxiliary"><cwd>${auxiliary}</cwd></environment>
    <environment id="project"><cwd>${root}</cwd></environment>
  </environments>
  <filesystem><workspace_roots><root>${root}</root><root>${auxiliary}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;

    expect(extractChatGptTurnEnvironment(currentWire({ environmentXml: legacyEnvironment }))).toEqual({
      cwd: root,
      roots: [root, auxiliary],
      writableRoots: [root, auxiliary],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("accepts a single legacy environment without a primary attribute", () => {
    const legacyEnvironment = `<environment_context>
  <environments><environment id="project"><cwd>${root}</cwd></environment></environments>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;

    expect(extractChatGptTurnEnvironment(currentWire({ environmentXml: legacyEnvironment }))).toMatchObject({ cwd: root });
  });

  test("rejects a legacy multi-environment envelope when metadata cannot identify one cwd", () => {
    const secondary = resolve(root, "secondary-environment");
    const ambiguousEnvironment = `<environment_context>
  <environments>
    <environment id="first"><cwd>${root}</cwd></environment>
    <environment id="second"><cwd>${secondary}</cwd></environment>
  </environments>
  <filesystem><workspace_roots><root>${root}</root><root>${secondary}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;

    expect(() => extractChatGptTurnEnvironment(currentWire({
      workspace: resolve(root, ".."),
      environmentXml: ambiguousEnvironment,
    })))
      .toThrow("missing cwd");
  });

  test("rejects an envelope with multiple conflicting cwd declarations", () => {
    const conflictingEnvironment = `<environment_context>
  <cwd>${root}</cwd>
  <cwd>${resolve(root, "other")}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots>${dangerFullAccessProfileXml}</filesystem>
</environment_context>`;
    expect(() => extractChatGptTurnEnvironment(currentWire({ environmentXml: conflictingEnvironment })))
      .toThrow("missing cwd");
  });
});

describe("permission_profile sandbox detection (Codex CLI 0.146+)", () => {
  test("new-format workspace-write resolves with a workspaceWrite sandbox policy", () => {
    expect(extractChatGptTurnEnvironment(currentWire({
      sandbox: "workspace-write",
      environmentXml: filesystemEnvironmentXml(workspaceWriteProfileXml),
    }))).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [],
    });
  });

  test("new-format read-only resolves with a readOnly sandbox policy", () => {
    expect(extractChatGptTurnEnvironment(currentWire({
      sandbox: "read-only",
      environmentXml: filesystemEnvironmentXml(readOnlyProfileXml),
    }))).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      tools: [],
    });
  });

  test("new-format danger-full-access still resolves dangerFullAccess", () => {
    expect(extractChatGptTurnEnvironment(currentWire({
      sandbox: "none",
      environmentXml: filesystemEnvironmentXml(dangerFullAccessProfileXml),
    }))).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("accepts platform sandbox metadata when the envelope carries a managed policy", () => {
    for (const sandbox of ["windows_sandbox", "windows_elevated", "seatbelt", "seccomp"]) {
      expect(extractChatGptTurnEnvironment(currentWire({
        sandbox,
        environmentXml: filesystemEnvironmentXml(workspaceWriteProfileXml),
      }))).toMatchObject({
        cwd: root,
        sandboxPolicy: { type: "workspaceWrite" },
      });
    }
  });

  test("keeps a platform-tagged read-only envelope read-only", () => {
    expect(extractChatGptTurnEnvironment(currentWire({
      sandbox: "windows_sandbox",
      environmentXml: filesystemEnvironmentXml(readOnlyProfileXml),
    })).sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });

  test("permission_profile type=external remains unmapped and fails closed", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({
      sandbox: "workspace-write",
      environmentXml: filesystemEnvironmentXml(externalProfileXml),
    }))).toThrow("missing cwd");
  });
});

describe("trusted Codex task environment continuity", () => {
  test("sessionless Desktop rollout bootstraps same-thread model-switch continuity", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "codex-chatgpt-sessionless-continuity-"));
    temporaryRoots.push(stateRoot);
    const store = new ChatGptThreadEnvironmentStore(join(stateRoot, "thread-environments.json"));
    const first = rolloutOnlyRequest({ includeSessionId: false });
    withCodexRollout({ request: first, includeThreadSettings: false }, request => {
      expect(store.resolve(request).cwd).toBe(root);

      const followUp = rolloutOnlyRequest({ includeSessionId: false, turnId: "turn_follow_up_123" });
      expect(store.resolve(followUp).cwd).toBe(root);
    });
  });

  test("persists the trusted first-turn authority and refreshes tools from every follow-up", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "codex-chatgpt-thread-environment-"));
    temporaryRoots.push(stateRoot);
    const statePath = join(stateRoot, "thread-environments.json");
    const first = currentWire();
    const firstTools: CodexTool[] = [{ name: "first_tool", description: "first", parameters: { type: "object" } }];
    first.context.tools = firstTools;

    expect(new ChatGptThreadEnvironmentStore(statePath).resolve(first).tools).toEqual(firstTools);
    const onDisk = readFileSync(statePath, "utf8");
    expect(onDisk).toContain('"thread_current"');
    expect(onDisk).not.toContain("first_tool");

    const next = currentWire();
    const nextTools: CodexTool[] = [{ name: "next_tool", description: "next", parameters: { type: "object" } }];
    next.context.tools = nextTools;
    next._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_current", turn_id: "turn_next" }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue the same task" }],
      }],
    };

    expect(new ChatGptThreadEnvironmentStore(statePath).resolve(next)).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: nextTools,
    });
  });

  test("does not borrow authority across threads or hide an invalid trusted update", () => {
    const store = new ChatGptThreadEnvironmentStore();
    store.resolve(currentWire());

    const unrelated = currentWire();
    unrelated._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_unrelated", turn_id: "turn_next" }),
      },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }],
    };
    expect(() => store.resolve(unrelated)).toThrow("missing cwd");

    const invalidUpdate = currentWire({ sandbox: "read-only" });
    invalidUpdate.context.systemPrompt = [`<environment_context><cwd>${root}</cwd></environment_context>`];
    expect(() => store.resolve(invalidUpdate)).toThrow("missing cwd");
  });

  test("accepts only the spawned child's direct-parent agent_message as its current instruction", () => {
    const request = currentWire();
    const body = request._rawBody as { client_metadata: Record<string, string>; input: Array<Record<string, unknown>> };
    const metadata = {
      request_kind: "turn",
      thread_id: "thread_child",
      turn_id: "turn_child",
      parent_thread_id: "thread_current",
      agent_name: "/root/reviewer",
      subagent_kind: "thread_spawn",
      sandbox: "danger-full-access",
      workspaces: { [root]: { has_changes: true } },
    };
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    const environment = {
      type: "message", id: "msg_environment", role: "user",
      content: [{ type: "input_text", text: environmentXml }],
    };
    const task = {
      type: "agent_message", id: "amsg_task", author: "/root", recipient: "/root/reviewer",
      content: [{ type: "input_text", text: "Inspect the workspace." }],
    };
    body.input = [environment, task];
    expect(extractChatGptTurnEnvironment(request).cwd).toBe(root);
    expect(extractChatGptTurnUserRevision(request)).toEqual(task.content);

    for (const invalid of [
      { ...task, id: undefined },
      { ...task, author: "/root/peer" },
      { ...task, recipient: "/root/other" },
      { ...task, author: "/root/reviewer/worker" },
    ]) {
      body.input = [environment, invalid];
      expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
      expect(() => extractChatGptTurnUserRevision(request)).toThrow("current-turn user message");
    }
  });

  test("inherits authority only through canonical Codex thread-spawn lineage", () => {
    const store = new ChatGptThreadEnvironmentStore();
    const parent = currentWire();
    store.resolve(parent);

    const child = currentWire();
    const childTools: CodexTool[] = [{ name: "child_tool", description: "child", parameters: { type: "object" } }];
    child.context.tools = childTools;
    child._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "turn",
          thread_id: "thread_child",
          turn_id: "turn_child",
          parent_thread_id: "thread_current",
          agent_name: "/root/read_package_version",
          subagent_kind: "thread_spawn",
          sandbox_mode: "danger-full-access",
          workspaces: { [root]: { has_changes: true } },
        }),
      },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Read package.json" }] }],
    };

    expect(store.resolve(child)).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: childTools,
    });

    const childFollowUp = structuredClone(child);
    (childFollowUp._rawBody as { client_metadata: Record<string, string> }).client_metadata["x-codex-turn-metadata"] = JSON.stringify({
      thread_id: "thread_child",
      turn_id: "turn_child_next",
    });
    childFollowUp.context.tools = [];
    expect(store.resolve(childFollowUp).cwd).toBe(root);

    const nongitChild = structuredClone(child);
    (nongitChild._rawBody as { client_metadata: Record<string, string> }).client_metadata["x-codex-turn-metadata"] = JSON.stringify({
      request_kind: "turn",
      thread_id: "thread_nongit_child",
      turn_id: "turn_nongit_child",
      parent_thread_id: "thread_current",
      agent_name: "/root/nongit_child",
      subagent_kind: "thread_spawn",
      sandbox_mode: "danger-full-access",
    });
    expect(store.resolve(nongitChild).cwd).toBe(root);
  });

  test("rejects forged or conflicting child lineage instead of borrowing parent authority", () => {
    const store = new ChatGptThreadEnvironmentStore();
    store.resolve(currentWire());
    const child = currentWire();
    const metadata = {
      request_kind: "turn",
      thread_id: "thread_child",
      turn_id: "turn_child",
      parent_thread_id: "thread_current",
      agent_name: "/root/child",
      subagent_kind: "thread_spawn",
      sandbox_mode: "read-only",
      workspaces: { [root]: { has_changes: false } },
    };
    child._rawBody = {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }],
    };
    expect(() => store.resolve(child)).toThrow("sandbox metadata conflicts");

    metadata.sandbox_mode = "danger-full-access";
    metadata.subagent_kind = "other";
    (child._rawBody as { client_metadata: Record<string, string> }).client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    expect(() => store.resolve(child)).toThrow("missing cwd");
  });
});
