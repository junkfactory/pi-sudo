import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import extension, {
  authWaitText,
  isEscalation,
  needsSudoApproval,
  pathTokens,
  readerEvidence,
  setSudoSpawnFn,
  type SudoExecDetails,
} from "../src/index.js";
import type { SpawnFn } from "../src/executor.js";
import type { ApprovalDialog, ApprovalOutcome } from "../src/dialog.js";

const DENIAL_TEXT =
  "The user denied this sudo request; nothing ran. Do not retry the same command. Explain to the user why root was needed and propose a safer non-privileged alternative if one exists.";
const DENY: ApprovalOutcome = { approved: false, note: "" };

// session_start sweeps pi-sudo-* directories under tmpdir(). Other test files
// run in parallel against the shared tmpdir, so give this file a private root.
const PRIVATE_TMP = mkdtempSync(join(tmpdir(), "index-suite-pi-sudo-"));
process.env.TMPDIR = PRIVATE_TMP;

after(() => {
  rmSync(PRIVATE_TMP, { recursive: true, force: true });
});

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

/** The dialog factory askApproval hands to ctx.ui.custom, captured by the tests. */
type DialogCapture = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: (value: unknown) => void,
) => unknown;

interface CtxCalls {
  custom: number;
  confirm: number;
  notify: Array<[string, string | undefined]>;
  dialogs: DialogCapture[];
}

function makeCtx(options: {
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  cwd?: string;
  /** Answers `ctx.ui.custom` returns in order, standing in for the approval dialog. */
  answers?: ApprovalOutcome[];
  /** Stands in for `ctx.ui.custom`, e.g. to answer the escalation dialog. */
  onCustom?: () => Promise<unknown>;
} = {}): { ctx: ExtensionToolContext; calls: CtxCalls } {
  const calls: CtxCalls = { custom: 0, confirm: 0, notify: [], dialogs: [] };
  const answers = options.answers ?? [];
  let answerIndex = 0;
  const ui = {
    custom: async (render?: unknown) => {
      calls.custom += 1;
      calls.dialogs.push(render as DialogCapture);
      if (options.onCustom !== undefined) return options.onCustom();
      return answers[answerIndex++];
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

/** Build the captured approval dialog so its render output can be asserted. */
function realizeDialog(capture: DialogCapture): ApprovalDialog {
  const tui = { terminal: { rows: 40 }, requestRender() {} };
  const theme = { fg: (_color: string, text: string) => text };
  return capture(tui, theme, {}, () => {}) as ApprovalDialog;
}

/** The rendered dialog text, checked for the reader-hint wording. */
function dialogText(capture: DialogCapture): string {
  return realizeDialog(capture).render(120).join("\n");
}

function nonceFrom(args: string[]): string {
  const index = args.indexOf("-p");
  const nonce = index === -1 ? undefined : args[index + 1];
  assert.ok(nonce !== undefined, "expected a -p nonce in the sudo argv");
  return nonce;
}

function payloadFrom(args: string[]): string {
  return args[args.length - 1];
}

function once(password: string): ApprovalOutcome {
  return { approved: true, mode: "once", password: Buffer.from(password) };
}

const TICKET: ApprovalOutcome = { approved: true, mode: "ticket", password: Buffer.alloc(0) };

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
    assert.equal(needsSudoApproval("xargs -0 sudo id"), true);
    assert.equal(needsSudoApproval("sudo -u root id"), true);
    assert.equal(needsSudoApproval("su -c 'id'"), true);
    assert.equal(needsSudoApproval("echo ok && sudo id"), true);
    assert.equal(needsSudoApproval("echo ok; sudo id"), true);
    assert.equal(needsSudoApproval("ls | sudo tee /tmp/x"), true);
    assert.equal(needsSudoApproval("$(sudo id)"), true);
    assert.equal(needsSudoApproval("timeout 5 sudo id"), true);
    assert.equal(needsSudoApproval("env FOO=1 sudo id"), true);
    assert.equal(needsSudoApproval("FOO=1 sudo id"), true);
    assert.equal(needsSudoApproval("if sudo id; then :; fi"), true);
    // Hyphenated or slashed neighbours are not escalators.
    assert.equal(needsSudoApproval("jj status pi-sudo"), false);
    assert.equal(needsSudoApproval("rg sudo-exec"), false);
    assert.equal(needsSudoApproval("git log --format=%H -- foo-sudo"), false);
    assert.equal(needsSudoApproval("ls /home/papa/Work/pi/pi-sudo"), false);
    assert.equal(needsSudoApproval("catsudo id"), false);
    // The word as data in an argument is not a command.
    assert.equal(needsSudoApproval("rg 'sudo' README.md"), false);
    assert.equal(needsSudoApproval("grep -n sudo README.md"), false);
    assert.equal(
      needsSudoApproval('jj describe -m "needs sudo to install"'),
      false,
    );
    assert.equal(needsSudoApproval("echo 'use sudo later'"), false);
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
    assert.match(blocked?.reason ?? "", /no leading sudo/);

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

describe("auth wait note", () => {
  it("promises only authentication until the reader has been learned", () => {
    const neutral = authWaitText(false);
    assert.ok(neutral.includes("waiting for sudo authentication"));
    assert.equal(neutral.includes("fingerprint"), false,
      "a cold run must not promise a reader it has not seen");
  });

  it("names the reader once the record exists", () => {
    const reader = authWaitText(true);
    assert.ok(reader.includes("touch the fingerprint reader"));
    assert.ok(reader.includes("wait for the password prompt"));
  });
});

describe("reader evidence", () => {
  const quiet = {
    promptSeen: false,
    timedOut: false,
    aborted: false,
    signal: null,
    sudoStderr: "",
    authEvidence: false,
    authMarker: false,
  } as const;

  it("treats a clean prompt-less run as proof in both directions", () => {
    assert.deepEqual(readerEvidence({ ...quiet }), { learned: true, clearsRejection: true });
  });

  it("refuses to learn from sudo's own diagnostics", () => {
    const result = readerEvidence({ ...quiet, sudoStderr: "sudo: not in the sudoers file\n" });
    assert.deepEqual(result, { learned: false, clearsRejection: false });
  });

  it("refuses to learn from a killed, timed-out, or aborted run", () => {
    for (const result of [
      { ...quiet, signal: "SIGTERM" as NodeJS.Signals },
      { ...quiet, timedOut: true },
      { ...quiet, aborted: true },
    ]) {
      assert.deepEqual(readerEvidence(result), { learned: false, clearsRejection: false });
    }
  });

  it("learns from a marker and clears the rejection with it", () => {
    const result = readerEvidence({
      ...quiet,
      promptSeen: true,
      authEvidence: true,
      authMarker: true,
    });
    assert.deepEqual(result, { learned: true, clearsRejection: true });
  });

  it("learns from a delay but does not clear the rejection on it", () => {
    // A slow non-biometric PAM (LDAP/SSSD) must not re-offer the reader forever.
    const result = readerEvidence({
      ...quiet,
      promptSeen: true,
      authEvidence: true,
      authMarker: false,
    });
    assert.deepEqual(result, { learned: true, clearsRejection: false });
  });

  it("learns nothing from a prompt with no evidence", () => {
    assert.deepEqual(readerEvidence({ ...quiet, promptSeen: true }), {
      learned: false,
      clearsRejection: false,
    });
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
        answers: [once("one"), once("two")],
      });
      const result = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(result.isError, false);
      assert.equal(result.details.attempts, 2);
      assert.equal(result.details.warm, false);
      assert.equal(result.details.approval, "once");
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
      const { ctx, calls } = makeCtx({ answers: [once("one")] });
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

describe("sudo_exec approval lifetime", () => {
  it("asks again on a warm ticket when the previous answer was once", async () => {
    const { records, spawnFn } = makeSpawn((child) => {
      setTimeout(() => child.emit("close", 0, null), 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [once("hunter2"), once("hunter2")] });

      const first = await executeTool(tool, ctx, "systemctl restart nginx");
      const second = await executeTool(tool, ctx, "systemctl restart nginx");

      assert.equal(first.isError, false);
      assert.equal(first.details.approval, "once");
      assert.equal(second.details.approval, "once");
      assert.equal(calls.custom, 2, "a once approval must not suppress the next dialog");
      assert.deepEqual(
        records.map((record) => payloadFrom(record.args)),
        [
          "exec 2>&1 0</dev/null; true",
          "exec 2>&1 0</dev/null; systemctl restart nginx",
          "exec 2>&1 0</dev/null; true",
          "exec 2>&1 0</dev/null; systemctl restart nginx",
        ],
      );
      assert.equal(
        records.every((record) => record.args[0] === "-n"),
        true,
        "every spawn was passwordless",
      );
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("runs the next call silently under a ticket-wide approval", async () => {
    const { records, spawnFn } = makeSpawn((child) => {
      setTimeout(() => child.emit("close", 0, null), 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [TICKET] });

      const first = await executeTool(tool, ctx, "systemctl restart nginx");
      const second = await executeTool(tool, ctx, "systemctl restart nginx");

      assert.equal(first.details.approval, "ticket");
      assert.equal(calls.custom, 1, "a ticket approval suppresses the next dialog");
      assert.equal(second.details.approval, "ticket");
      assert.equal(second.details.attempts, 0);
      assert.equal(second.details.warm, true);
      assert.equal(records.length, 3, "one probe, one approved run, one silent run");
      assert.equal(records[2].args[0], "-n");
      assert.equal(payloadFrom(records[2].args), "exec 2>&1 0</dev/null; systemctl restart nginx");
      assert.equal(
        records.some((record) => record.args.includes("-k")),
        false,
        "a ticket run must not forget the ticket",
      );
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("clears the ticket when the silent run needs a password, then dialogs", async () => {
    const { records, spawnFn } = makeSpawn((child, args, index) => {
      setTimeout(() => {
        if (index === 2) {
          child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
          child.emit("close", 1, null);
          return;
        }
        if (index === 3) {
          child.stderr.emit("data", Buffer.from(nonceFrom(args)));
          child.emit("close", 0, null);
          return;
        }
        child.emit("close", 0, null);
      }, 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [TICKET, once("hunter2")] });

      const first = await executeTool(tool, ctx, "systemctl restart nginx");
      // The hidden run discovers sudo now wants a password: the grant is gone.
      const second = await executeTool(tool, ctx, "systemctl restart nginx");

      assert.equal(first.details.approval, "ticket");
      assert.equal(second.details.approval, "once");
      assert.equal(second.details.attempts, 1);
      assert.equal(second.details.warm, false);
      assert.equal(calls.custom, 2, "the cleared grant must open a dialog");
      assert.equal(records.length, 4);
      assert.equal(records[2].args[0], "-n");
      assert.equal(records[3].args[0], "-S");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("denies with the standard text and never runs the command as root", async () => {
    const { records, spawnFn } = makeSpawn((child) => {
      setTimeout(() => {
        child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
        child.emit("close", 1, null);
      }, 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [DENY] });

      const result = await executeTool(tool, ctx, "systemctl restart nginx");

      assert.equal(result.isError, true);
      assert.match(
        textOf(result),
        /^The user denied this sudo request; nothing ran\. Do not retry the same command\./,
      );
      assert.equal(result.details.approval, undefined);
      assert.equal(calls.custom, 1);
      assert.equal(records.length, 1, "only the true probe may spawn");
      assert.equal(records[0].args[0], "-n");
      assert.equal(payloadFrom(records[0].args), "exec 2>&1 0</dev/null; true");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("carries a declined request's reason into the result text once", async () => {
    const { records, spawnFn } = makeSpawn((child) => {
      setTimeout(() => {
        child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
        child.emit("close", 1, null);
      }, 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const note = "run it during the maintenance window";
      const { ctx, calls } = makeCtx({ answers: [{ approved: false, note }] });

      const result = await executeTool(tool, ctx, "systemctl restart nginx");

      assert.equal(result.isError, true);
      assert.equal(result.details.attempts, 0);
      assert.equal(result.details.approval, undefined);
      assert.equal(textOf(result), `${DENIAL_TEXT}\n\nThe user added: ${note}`);
      assert.equal(
        textOf(result).split("The user added:").length - 1,
        1,
        "the note is appended exactly once",
      );
      assert.equal(calls.custom, 1);
      assert.equal(records.length, 1, "only the warm probe may spawn");
      assert.equal(payloadFrom(records[0].args), "exec 2>&1 0</dev/null; true");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("adds no note suffix to a silent denial", async () => {
    const { spawnFn } = makeSpawn((child) => {
      setTimeout(() => {
        child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
        child.emit("close", 1, null);
      }, 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx } = makeCtx({ answers: [DENY] });

      const result = await executeTool(tool, ctx, "id");

      assert.equal(result.isError, true);
      assert.equal(result.details.attempts, 0);
      assert.equal(textOf(result), DENIAL_TEXT);
      assert.equal(textOf(result).includes("The user added:"), false);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("reports approval once for a cold authenticated run", async () => {
    const { records, spawnFn } = makeSpawn((child, args, index) => {
      setTimeout(() => {
        if (index === 0) {
          child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
          child.emit("close", 1, null);
          return;
        }
        child.stderr.emit("data", Buffer.from(nonceFrom(args)));
        child.emit("close", 0, null);
      }, 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const secret = "Zq9-once-secret";
      const { ctx, calls } = makeCtx({ answers: [once(secret)] });

      const result = await executeTool(tool, ctx, "id");

      assert.equal(result.isError, false);
      assert.equal(result.details.approval, "once");
      assert.equal(result.details.attempts, 1);
      assert.equal(result.details.warm, false);
      assert.equal(calls.custom, 1);
      assert.equal(records.length, 2);
      assert.equal(records[1].args[0], "-S");
      assert.equal(textOf(result).includes(secret), false);
      assert.equal(JSON.stringify(result.details).includes(secret), false);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });
});

describe("ticket reset", () => {
  function startSession(harness: Harness, reason: string): Promise<unknown> {
    const handler = harness.handlers.get("session_start")?.[0];
    assert.ok(handler !== undefined, "session_start handler is registered");
    const { ctx } = makeCtx();
    return Promise.resolve(handler({ type: "session_start", reason }, ctx));
  }

  it("forgets the ticket on new, resume, and fork, so the next call dialogs", async () => {
    for (const reason of ["new", "resume", "fork"]) {
      const { records, spawnFn } = makeSpawn((child) => {
        setTimeout(() => child.emit("close", 0, null), 0);
      });
      setSudoSpawnFn(spawnFn);
      try {
        const harness = makeHarness();
        const tool = harness.tools.get("sudo_exec");
        assert.ok(tool !== undefined);
        const { ctx, calls } = makeCtx({ answers: [TICKET, once("hunter2")] });

        const granted = await executeTool(tool, ctx, "systemctl restart nginx");
        assert.equal(granted.details.approval, "ticket", reason);
        assert.equal(calls.custom, 1, reason);
        const before = records.length;

        await startSession(harness, reason);
        assert.equal(
          records
            .slice(before)
            .some((record) => record.args.length === 1 && record.args[0] === "-k"),
          true,
          `${reason} must spawn sudo -k`,
        );

        const next = await executeTool(tool, ctx, "systemctl restart nginx");
        assert.equal(calls.custom, 2, `${reason} must force a dialog on the next call`);
        assert.equal(next.details.approval, "once", reason);
      } finally {
        setSudoSpawnFn(undefined);
      }
    }
  });

  it("keeps the granted ticket on reload", async () => {
    const { records, spawnFn } = makeSpawn((child) => {
      setTimeout(() => child.emit("close", 0, null), 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [TICKET] });

      const granted = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(granted.details.approval, "ticket");
      const before = records.length;

      await startSession(harness, "reload");
      assert.deepEqual(
        records.slice(before).filter((record) => record.args.includes("-k")),
        [],
        "reload must not spawn sudo -k",
      );

      const next = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(calls.custom, 1, "reload must keep the ticket silent");
      assert.equal(next.details.approval, "ticket");
      assert.equal(next.details.attempts, 0);
      assert.equal(next.details.warm, true);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("clears a granted ticket when /sudo-forget runs", async () => {
    const { records, spawnFn } = makeSpawn((child) => {
      setTimeout(() => child.emit("close", 0, null), 0);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [TICKET, once("hunter2")] });

      const granted = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(granted.details.approval, "ticket");

      const forget = harness.commands.get("sudo-forget");
      assert.ok(forget !== undefined);
      const before = records.length;
      await forget.handler("", ctx);
      assert.deepEqual(records[before].args, ["-k"]);

      const next = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(calls.custom, 2, "/sudo-forget must make the next call dialog");
      assert.equal(next.details.approval, "once");
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

describe("fingerprint learning", () => {
  // The learned record is module-level and shared with every test above; those
  // runs leave it untouched, so the ordered tests below start from nothing and
  // build on each other deliberately.
  type Step = (child: FakeChild, args: string[]) => void;

  function makeSequence(
    steps: Step[],
  ): { records: SpawnRecord[]; spawnFn: SpawnFn } {
    let index = 0;
    return makeSpawn((child, args) => {
      setTimeout(() => {
        // A session_start handler spawns sudo -k between the tool calls.
        if (args[0] === "-k") {
          child.emit("close", 0, null);
          return;
        }
        const step = steps[index];
        index += 1;
        if (step !== undefined) step(child, args);
        else child.emit("close", 0, null);
      }, 0);
    });
  }

  const passwordRequired: Step = (child) => {
    child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
    child.emit("close", 1, null);
  };
  /** sudo's stdout carries a biometric marker before the prompt ever appears. */
  const coldWithMarker: Step = (child, args) => {
    child.stdout.emit("data", Buffer.from("Verification timed out\n"));
    child.stderr.emit("data", Buffer.from(nonceFrom(args)));
    child.emit("close", 0, null);
  };
  const coldOk: Step = (child, args) => {
    child.stderr.emit("data", Buffer.from(nonceFrom(args)));
    child.emit("close", 0, null);
  };
  /** A cold run that never prompted but failed before authenticating. */
  const coldNoPromptDiagnostic: Step = (child) => {
    child.stderr.emit("data", Buffer.from("sudo: not in the sudoers file\n"));
    child.emit("close", 1, null);
  };
  const coldEmptyOk: Step = (child) => {
    child.emit("close", 0, null);
  };
  /** A cold run that never prompts: PAM authenticated some other way, then the command failed. */
  const coldNoPromptFail: Step = (child) => {
    child.emit("close", 1, null);
  };
  const coldNoPasswordProvided: Step = (child) => {
    child.stderr.emit("data", Buffer.from("sudo: no password was provided\n"));
    child.emit("close", 1, null);
  };
  const coldRetry: Step = (child, args) => {
    child.stderr.emit("data", Buffer.from(`${nonceFrom(args)}Sorry, try again.\n`));
    child.emit("close", 1, null);
  };

  async function startSession(harness: Harness, reason: string): Promise<void> {
    const handler = harness.handlers.get("session_start")?.[0];
    assert.ok(handler !== undefined, "session_start handler is registered");
    const { ctx } = makeCtx();
    await handler({ type: "session_start", reason }, ctx);
  }

  it("learns the reader from a password run whose child shows biometric evidence", async () => {
    const { records, spawnFn } = makeSequence([
      passwordRequired,
      coldWithMarker,
      passwordRequired,
      coldOk,
    ]);
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [once("hunter2"), once("hunter2")] });

      const first = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(first.isError, false);
      assert.equal(first.details.auth, "password");
      assert.equal(first.details.warm, false, "an authenticated cold run is never warm");
      assert.equal(dialogText(calls.dialogs[0]).includes("fingerprint reader"), false,
        "nothing is learned before the first evidence");

      const second = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(second.isError, false);
      assert.equal(second.details.auth, "password");
      assert.equal(dialogText(calls.dialogs[1]).includes("fingerprint reader"), true,
        "the next dialog offers the reader");
      assert.equal(records[1].args[0], "-S");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("runs an empty answer with -S, writes nothing, and reports the fingerprint route", async () => {
    const { records, spawnFn } = makeSequence([passwordRequired, coldEmptyOk]);
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [once("")] });

      const result = await executeTool(tool, ctx, "systemctl restart nginx");

      assert.equal(result.isError, false);
      assert.equal(records[0].args[0], "-n");
      assert.equal(records[1].args[0], "-S");
      assert.equal(records[1].child.stdin.writes.length, 0);
      assert.equal(records[1].child.stdin.ended, true);
      assert.equal(result.details.auth, "fingerprint");
      assert.equal(result.details.warm, false);
      assert.equal(result.details.approval, "once");
      // The reader hint is still offered while the record is held.
      assert.equal(dialogText(calls.dialogs[0]).includes("fingerprint reader"), true);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("rejects the reader after a failed empty answer and returns the fixed text", async () => {
    const { records, spawnFn } = makeSequence([
      passwordRequired,
      coldNoPasswordProvided,
      passwordRequired,
      coldEmptyOk,
    ]);
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [once(""), once("")] });

      const first = await executeTool(tool, ctx, "systemctl restart nginx");

      assert.equal(first.isError, true);
      assert.match(textOf(first), /^Fingerprint authentication did not succeed and no password was typed; nothing ran\./);
      assert.ok(textOf(first).includes("touch the reader when it asks."));
      assert.equal(first.details.attempts, 1, "the empty route runs once, with no dialog loop");
      assert.equal(records[1].args[0], "-S");
      assert.equal(records[1].child.stdin.writes.length, 0);

      const second = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(second.isError, false);
      assert.equal(dialogText(calls.dialogs[1]).includes("fingerprint reader"), false,
        "the rejected reader is no longer offered");
      assert.equal(second.details.auth, "fingerprint");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("keeps the learned reader across a session switch and drops the rejection", async () => {
    const { spawnFn } = makeSequence([
      passwordRequired,
      coldNoPasswordProvided,
      passwordRequired,
      coldEmptyOk,
    ]);
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [once(""), once("")] });

      // Re-establish a rejection: the dialog must not offer the reader now.
      const before = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(before.isError, true);
      assert.equal(dialogText(calls.dialogs[0]).includes("fingerprint reader"), false);

      await startSession(harness, "resume");

      const after = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(after.isError, false);
      assert.equal(dialogText(calls.dialogs[1]).includes("fingerprint reader"), true,
        "the learned record survives the session; the rejection does not");
      assert.equal(after.details.auth, "fingerprint");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("never offers the hint on a retry dialog after an error", async () => {
    const { spawnFn } = makeSequence([
      passwordRequired,
      coldRetry,
      coldOk,
    ]);
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [once("bad"), once("good")] });

      const result = await executeTool(tool, ctx, "systemctl restart nginx");

      assert.equal(result.isError, false);
      assert.equal(result.details.attempts, 2);
      assert.equal(dialogText(calls.dialogs[0]).includes("fingerprint reader"), true,
        "the first dialog still offers the learned reader");
      assert.equal(dialogText(calls.dialogs[1]).includes("fingerprint reader"), false,
        "the retry dialog shows the sudo error, not the reader");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("re-offers the reader after a typed run shows the delay again", async () => {
    const { spawnFn } = makeSequence([
      passwordRequired,
      coldNoPasswordProvided,
      passwordRequired,
      coldWithMarker,
      passwordRequired,
      coldOk,
    ]);
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [once(""), once("hunter2"), once("hunter2")] });

      const rejected = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(rejected.isError, true, "the empty answer established the rejection");

      const typed = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(typed.isError, false);
      assert.equal(dialogText(calls.dialogs[1]).includes("fingerprint reader"), false,
        "the rejected reader is still withheld while the rejection stands");

      const after = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(after.isError, false);
      assert.equal(dialogText(calls.dialogs[2]).includes("fingerprint reader"), true,
        "the delay seen on the typed run cleared the rejection");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("learns from a cold run that never prompted, even when the command fails", async () => {
    const { spawnFn } = makeSequence([
      passwordRequired,
      coldNoPasswordProvided,
      passwordRequired,
      coldNoPromptFail,
      passwordRequired,
      coldOk,
    ]);
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [once(""), once("hunter2"), once("hunter2")] });

      const rejected = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(rejected.isError, true, "the empty answer established the rejection");

      const touched = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(touched.isError, true, "the command failed; the authentication still stands");
      assert.equal(dialogText(calls.dialogs[1]).includes("fingerprint reader"), false,
        "the rejection was still in force while that dialog was open");

      const after = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(after.isError, false);
      assert.equal(dialogText(calls.dialogs[2]).includes("fingerprint reader"), true,
        "a cold run that never prompted cleared the rejection without a marker or delay");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("does not clear the rejection for a prompt-less run that sudo refused", async () => {
    const { spawnFn } = makeSequence([
      passwordRequired,
      coldNoPasswordProvided,
      passwordRequired,
      coldNoPromptDiagnostic,
      passwordRequired,
      coldOk,
    ]);
    setSudoSpawnFn(spawnFn);
    try {
      const harness = makeHarness();
      const tool = harness.tools.get("sudo_exec");
      assert.ok(tool !== undefined);
      const { ctx, calls } = makeCtx({ answers: [once(""), once("hunter2"), once("hunter2")] });

      const rejected = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(rejected.isError, true, "the empty answer established the rejection");

      const refused = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(refused.isError, true, "sudo refused before authenticating");
      assert.match(textOf(refused), /not in the sudoers file/);

      const after = await executeTool(tool, ctx, "systemctl restart nginx");
      assert.equal(after.isError, false);
      assert.equal(dialogText(calls.dialogs[2]).includes("fingerprint reader"), false,
        "a sudo policy error is not proof that a reader answered");
    } finally {
      setSudoSpawnFn(undefined);
    }
  });
});
