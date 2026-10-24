import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import extension, {
  isEscalation,
  needsSudoApproval,
  pathTokens,
  setSudoSpawnFn,
  type SudoExecDetails,
} from "../src/index.js";
import type { SpawnFn } from "../src/executor.js";

class FakeStdin extends EventEmitter {
  readonly writes: Array<Buffer | string> = [];
  ended = false;

  write(chunk: Buffer | string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();

  kill(): boolean {
    return true;
  }
}

interface SpawnRecord {
  args: string[];
  child: FakeChild;
}

type SpawnBehaviour = (child: FakeChild, args: string[], index: number) => void;

function makeSpawn(behaviour?: SpawnBehaviour): {
  records: SpawnRecord[];
  spawnFn: SpawnFn;
} {
  const records: SpawnRecord[] = [];
  const spawnFn: SpawnFn = (_command, args, _options: SpawnOptions) => {
    const child = new FakeChild();
    const index = records.length;
    records.push({ args, child });
    if (behaviour !== undefined) {
      behaviour(child, args, index);
    } else {
      setTimeout(() => child.emit("close", 1, null), 0);
    }
    return child as unknown as ChildProcess;
  };
  return { records, spawnFn };
}

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  details: SudoExecDetails;
  isError?: boolean;
};

type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  exposure?: string;
  executionMode?: string;
  annotations?: Record<string, boolean>;
  parameters?: unknown;
  execute: (
    id: string,
    params: { command: string; reason: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionToolContext,
  ) => Promise<ToolResult>;
};

interface Harness {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: ExtensionToolContext) => Promise<void> }>;
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionToolContext) => unknown>>;
}

function makeHarness(): Harness {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionToolContext) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionToolContext) => unknown>>();
  const pi = {
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (
      name: string,
      options: { description?: string; handler: (args: string, ctx: ExtensionToolContext) => Promise<void> },
    ) => {
      commands.set(name, options);
    },
    on: (event: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  extension(pi);
  return { tools, commands, handlers };
}

interface CtxCalls {
  custom: number;
  confirm: number;
  notify: Array<[string, string | undefined]>;
}

function makeCtx(options: {
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  cwd?: string;
  passwords?: Array<Buffer | undefined>;
  /** Stands in for `ctx.ui.custom`, e.g. to answer the escalation dialog. */
  onCustom?: () => Promise<unknown>;
} = {}): { ctx: ExtensionToolContext; calls: CtxCalls } {
  const calls: CtxCalls = { custom: 0, confirm: 0, notify: [] };
  const passwords = options.passwords ?? [];
  let passwordIndex = 0;
  const ui = {
    custom: async () => {
      calls.custom += 1;
      if (options.onCustom !== undefined) return options.onCustom();
      return passwords[passwordIndex++];
    },
    confirm: async () => {
      calls.confirm += 1;
      return false;
    },
    notify: (message: string, type?: "info" | "warning" | "error") => {
      calls.notify.push([message, type]);
    },
  };
  const ctx = {
    ui: ui as unknown as ExtensionUIContext,
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    cwd: options.cwd ?? "/tmp/pi-sudo-test",
    sessionManager: { getSessionId: () => "test-session" },
    signal: undefined,
  } as unknown as ExtensionToolContext;
  return { ctx, calls };
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function executeTool(
  tool: ToolDefinition,
  ctx: ExtensionToolContext,
  command: string,
  reason = "test reason",
): Promise<ToolResult> {
  return tool.execute("call-1", { command, reason }, undefined, undefined, ctx);
}

function nonceFrom(args: string[]): string {
  const index = args.indexOf("-p");
  const nonce = index === -1 ? undefined : args[index + 1];
  assert.ok(nonce !== undefined, "expected a -p nonce in the sudo argv");
  return nonce;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("timed out waiting for the condition");
}

describe("sudo_exec registration", () => {
  it("registers the model-only sequential tool with the plan's contract", () => {
    const harness = makeHarness();
    const tool = harness.tools.get("sudo_exec");
    assert.ok(tool !== undefined);
    assert.equal(tool.label, "sudo");
    assert.equal(tool.exposure, "model-only");
    assert.equal(tool.executionMode, "sequential");
    assert.deepEqual(tool.annotations, { destructiveHint: true, openWorldHint: true });
    assert.equal(
      tool.promptSnippet,
      "Run a command as root after the user approves it in a masked sudo dialog",
    );
    assert.equal(tool.promptGuidelines?.length, 4);
    assert.ok(tool.parameters !== undefined);
    assert.ok(harness.commands.has("sudo-forget"));
  });

  it("runs sudo -k for /sudo-forget and notifies the user", async () => {
    const { records, spawnFn } = makeSpawn((child) => {
      setTimeout(() => child.emit("close", 0, null), 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const command = harness.commands.get("sudo-forget");
      assert.ok(command !== undefined);
      const { ctx, calls } = makeCtx();
      await command.handler("", ctx);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0].args, ["-k"]);
      assert.equal(calls.notify.length, 1);
      assert.match(calls.notify[0][0], /ticket cleared/);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });
});

describe("bash escalation guard", () => {
  it("blocks privilege-escalation words in bash commands", async () => {
    for (const word of [
      "sudo",
      "sudoedit",
      "pkexec",
      "doas",
      "run0",
      "runuser",
      "su",
      "systemd-run",
      "nsenter",
    ]) {
      assert.equal(needsSudoApproval(`${word} --version`), true, word);
    }
    assert.equal(needsSudoApproval("grep 'sud[o]' file"), false);
    assert.equal(needsSudoApproval("echo sudos"), false);
    // Absolute paths and wrappers still resolve to the escalator word.
    assert.equal(needsSudoApproval("/usr/bin/sudo id"), true);
    assert.equal(needsSudoApproval("xargs sudo id"), true);
    assert.equal(needsSudoApproval("sudo -u root id"), true);
    assert.equal(needsSudoApproval("su -c 'id'"), true);
    assert.equal(needsSudoApproval("echo ok && sudo id"), true);
    assert.equal(needsSudoApproval("$(sudo id)"), true);
    // Hyphenated or slashed neighbours are not escalators.
    assert.equal(needsSudoApproval("jj status pi-sudo"), false);
    assert.equal(needsSudoApproval("rg sudo-exec"), false);
    assert.equal(needsSudoApproval("git log --format=%H -- foo-sudo"), false);
    assert.equal(needsSudoApproval("ls /home/papa/Work/pi/pi-sudo"), false);
    assert.equal(needsSudoApproval("catsudo id"), false);
  });

  it("blocks a bash tool call with the plan's reason", async () => {
    const harness = makeHarness();
    const guard = harness.handlers.get("tool_call")?.[0];
    assert.ok(guard !== undefined);
    const { ctx } = makeCtx();
    const blocked = (await guard(
      { type: "tool_call", toolName: "bash", toolCallId: "1", input: { command: "sudo ls" } },
      ctx,
    )) as { block?: boolean; reason?: string } | undefined;
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /sudo_exec/);
    assert.match(blocked?.reason ?? "", /grep 'sud\[o\]'/);

    const allowed = await guard(
      { type: "tool_call", toolName: "bash", toolCallId: "2", input: { command: "ls -la" } },
      ctx,
    );
    assert.equal(allowed, undefined);
    const other = await guard(
      { type: "tool_call", toolName: "read", toolCallId: "3", input: { path: "/etc/x" } },
      ctx,
    );
    assert.equal(other, undefined);
  });
});

describe("isEscalation", () => {
  it("flags lasting-privilege changes", () => {
    for (const command of [
      "visudo",
      "cat /etc/sudoers",
      "cat /etc/passwd",
      "useradd mallory",
      "chmod u+s /usr/bin/x",
      "chmod 4755 /usr/bin/x",
      "chown root:root /tmp/x",
      "setcap cap_setuid+ep /usr/bin/x",
      "dd if=/dev/zero of=/dev/sda",
      "sed -i s/a/b/ /etc/hosts",
      "echo hi > /etc/motd",
      "cp /tmp/motd /etc/motd",
      "echo x > /root/.ssh/authorized_keys",
    ]) {
      assert.equal(isEscalation(command), true, command);
    }
  });

  it("leaves ordinary and read-only commands alone", () => {
    for (const command of [
      "id",
      "apt-get update",
      "cat /etc/hosts",
      "ls /root",
      "systemctl status nginx",
    ]) {
      assert.equal(isEscalation(command), false, command);
    }
  });
});

describe("escalation answer", () => {
  it("declines before any spawn and forwards the user's note", async () => {
    const harness = makeHarness();
    const tool = harness.tools.get("sudo_exec");
    assert.ok(tool !== undefined);
    const { ctx, calls } = makeCtx({
      onCustom: async () => ({ approved: false, note: "why root for /opt/app?" }),
    });
    const result = await executeTool(tool, ctx, "chown -R root:root /opt/app");
    assert.equal(result.isError, true);
    assert.equal(calls.custom, 1);
    assert.equal(calls.confirm, 0);
    assert.match(textOf(result), /nothing ran\. Do not retry/);
    assert.match(textOf(result), /The user added: why root for \/opt\/app\?$/);
  });

  it("omits the note when the user declines silently", async () => {
    const harness = makeHarness();
    const tool = harness.tools.get("sudo_exec");
    assert.ok(tool !== undefined);
    const { ctx } = makeCtx({ onCustom: async () => ({ approved: false, note: "" }) });
    const result = await executeTool(tool, ctx, "chown -R root:root /opt/app");
    assert.equal(result.isError, true);
    assert.equal(textOf(result).includes("The user added"), false);
  });
});

describe("pathTokens", () => {
  it("resolves absolute, relative, and bare-filename candidates", () => {
    const cwd = "/repo/project";
    assert.deepEqual(pathTokens("cat secrets.env", cwd), [resolve(cwd, "secrets.env")]);
    assert.deepEqual(pathTokens("cat /etc/hosts", cwd), ["/etc/hosts"]);
    assert.deepEqual(pathTokens("cat ./a.txt", cwd), [resolve(cwd, "a.txt")]);
    assert.deepEqual(pathTokens("cat ~/notes.txt", cwd), [resolve(homedir(), "notes.txt")]);
    assert.deepEqual(pathTokens("git status && ls src/x.ts", cwd), [
      resolve(cwd, "src/x.ts"),
    ]);
    assert.deepEqual(pathTokens("git status", cwd), []);
  });
});

describe("sudo_exec guards", () => {
  it("fails closed in non-TUI modes before any spawn", async () => {
    const { records, spawnFn } = makeSpawn();
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      for (const options of [
        { mode: "print" as const, hasUI: false },
        { mode: "json" as const, hasUI: false },
        { mode: "rpc" as const, hasUI: true },
      ]) {
        const { ctx } = makeCtx(options);
        const result = await executeTool(tool, ctx, "id");
        assert.equal(result.isError, true);
        assert.match(textOf(result), /interactive TUI approval dialog/);
      }
      assert.equal(records.length, 0);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("rejects a root pi before any spawn", async () => {
    const { records, spawnFn } = makeSpawn();
    setSudoSpawnFn(spawnFn);
    const processWithGetuid = process as unknown as { getuid?: () => number };
    const original = processWithGetuid.getuid;
    processWithGetuid.getuid = () => 0;
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx } = makeCtx();
      const result = await executeTool(tool, ctx, "id");
      assert.equal(result.isError, true);
      assert.match(textOf(result), /already running as root/);
      assert.equal(records.length, 0);
    } finally {
      processWithGetuid.getuid = original;
      setSudoSpawnFn(undefined);
    }
  });
});

describe("sudo_exec retry policy", () => {
  it("offers a second dialog only after a prompt-backed retry", async () => {
    const { records, spawnFn } = makeSpawn((child, args, index) => {
      setTimeout(() => {
        if (index === 0) {
          child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
          child.emit("close", 1, null);
          return;
        }
        const nonce = nonceFrom(args);
        if (index === 1) {
          child.stderr.emit("data", Buffer.from(`${nonce}Sorry, try again.\n`));
          child.emit("close", 1, null);
          return;
        }
        child.stderr.emit("data", Buffer.from(nonce));
        child.stdout.emit("data", Buffer.from("ok\n"));
        child.emit("close", 0, null);
      }, 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({
        passwords: [Buffer.from("one"), Buffer.from("two")],
      });
      const result = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(result.isError, false);
      assert.equal(result.details.attempts, 2);
      assert.equal(result.details.warm, false);
      assert.equal(calls.custom, 2);
      assert.equal(records.length, 3);
      assert.match(textOf(result), /^\$ systemctl restart nginx\n/);
      assert.match(textOf(result), /exit code: 0/);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("does not reopen the dialog for a non-retry failure", async () => {
    const { records, spawnFn } = makeSpawn((child, args, index) => {
      setTimeout(() => {
        if (index === 0) {
          child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
          child.emit("close", 1, null);
          return;
        }
        const nonce = nonceFrom(args);
        child.stderr.emit(
          "data",
          Buffer.from(`${nonce}sudo: user is not in the sudoers file.\n`),
        );
        child.emit("close", 1, null);
      }, 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ passwords: [Buffer.from("one")] });
      const result = await executeTool(tool, ctx, "id");
      assert.equal(result.isError, true);
      assert.equal(result.details.attempts, 1);
      assert.equal(calls.custom, 1);
      assert.equal(records.length, 2);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });
});

describe("global mutex", () => {
  it("rejects a concurrent call from a second extension instance", async () => {
    const { records, spawnFn } = makeSpawn();
    setSudoSpawnFn(spawnFn);
    let resolveDialog: (value: unknown) => void = () => {};
    const pendingDialog = new Promise<unknown>((resolve) => {
      resolveDialog = resolve;
    });
    try {
      const first = makeHarness();
      const second = makeHarness();
      const toolA = first.tools.get("sudo_exec");
      const toolB = second.tools.get("sudo_exec");
      assert.ok(toolA !== undefined);
      assert.ok(toolB !== undefined);

      const ctxA = makeCtx({ onCustom: () => pendingDialog });
      const running = executeTool(toolA, ctxA.ctx, "chown -R root:root /opt/app");
      await waitFor(() => ctxA.calls.custom === 1);

      const ctxB = makeCtx();
      const blocked = await executeTool(toolB, ctxB.ctx, "id");
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked), /already open/);
      assert.equal(records.length, 0);

      resolveDialog({ approved: false, note: "" });
      const denied = await running;
      assert.equal(denied.isError, true);
      assert.match(textOf(denied), /The user denied this sudo request/);
      assert.equal(records.length, 0);
    } finally {
      resolveDialog({ approved: false, note: "" });
      setSudoSpawnFn(undefined);
    }
  });
});
