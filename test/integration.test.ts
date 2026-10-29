import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import extension, {
  setPermissionServiceFn,
  setSudoSpawnFn,
  type SudoExecDetails,
} from "../src/index.js";
import type { SpawnFn } from "../src/executor.js";

const DENIAL_TEXT =
  "The user denied this sudo request; nothing ran. Do not retry the same command. Explain to the user why root was needed and propose a safer non-privileged alternative if one exists.";
const ATTEMPTS_TEXT =
  "sudo rejected the password 3 times; the command was not executed and nothing else ran. Do not retry this call blindly: confirm with the user that they entered the right password and that the account can use sudo, then try again if needed.";
const PASSWORD_REQUIRED = "sudo: a password is required\n";
const RETRY_TEXT = "Sorry, try again.\n";
const CWD = "/tmp/pi-sudo-integration";

// Test files run in parallel, and other files' runs create pi-sudo-* dirs in the
// shared tmpdir. Give this file its own temp root so the hygiene assertions only
// see this file's artifacts.
const PRIVATE_TMP = mkdtempSync(join(tmpdir(), "pi-sudo-suite-"));
process.env.TMPDIR = PRIVATE_TMP;
const SESSION_ID = "integration-session";

class FakeStdin extends EventEmitter {
  readonly writes: Array<Buffer | string> = [];
  readonly snapshots: Buffer[] = [];
  ended = false;

  write(chunk: Buffer | string): boolean {
    this.writes.push(chunk);
    if (Buffer.isBuffer(chunk)) this.snapshots.push(Buffer.from(chunk));
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

function makeSpawn(behaviour: SpawnBehaviour): {
  records: SpawnRecord[];
  spawnFn: SpawnFn;
} {
  const records: SpawnRecord[] = [];
  const spawnFn: SpawnFn = (_command, args, _options: SpawnOptions) => {
    const child = new FakeChild();
    const index = records.length;
    records.push({ args, child });
    setTimeout(() => behaviour(child, args, index), 0);
    return child as unknown as ChildProcess;
  };
  return { records, spawnFn };
}

/** The warm probe is the only spawn with `-n`; the cold run uses `-S`. */
function isWarm(args: string[]): boolean {
  return args.includes("-n");
}

function nonceFrom(args: string[]): string {
  const index = args.indexOf("-p");
  const nonce = index === -1 ? undefined : args[index + 1];
  assert.ok(nonce !== undefined, "expected a -p nonce in the sudo argv");
  return nonce;
}

function needsPassword(child: FakeChild): void {
  child.stderr.emit("data", Buffer.from(PASSWORD_REQUIRED));
  child.emit("close", 1, null);
}

function prompted(child: FakeChild, args: string[], suffix = ""): void {
  child.stderr.emit("data", Buffer.from(`${nonceFrom(args)}${suffix}`));
}

function succeeded(child: FakeChild, stdout = ""): void {
  if (stdout.length > 0) child.stdout.emit("data", Buffer.from(stdout));
  child.emit("close", 0, null);
}

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  details: SudoExecDetails;
  isError?: boolean;
};

type ToolDefinition = {
  execute: (
    id: string,
    params: { command: string; reason: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionToolContext,
  ) => Promise<ToolResult>;
};

function toolFrom(): ToolDefinition {
  let tool: ToolDefinition | undefined;
  const pi = {
    registerTool: (definition: ToolDefinition) => {
      tool = definition;
    },
    registerCommand: () => {},
    on: () => () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as unknown as ExtensionAPI;
  extension(pi);
  assert.ok(tool !== undefined, "sudo_exec was not registered");
  return tool;
}

/** A `ctx.ui.custom` stub that drives the real dialog components. */
interface DialogDrive {
  password?: string;
  escape?: boolean;
  /** Escalation answer: true approves, false declines (optionally with a note). */
  approve?: boolean;
  note?: string;
  /** Approval dialog: types this reason on the No row and declines. */
  declineReason?: string;
  /** Approval dialog: presses Enter with no password, then Esc. */
  emptySubmit?: boolean;
  /** Keeps the dialog open until released. */
  hold?: Promise<void>;
}

type DialogComponent = { handleInput(data: string): void; render?(width: number): string[] };

type DialogFactory = (
  tui: { requestRender(): void; terminal: { rows: number } },
  theme: { fg(color: string, text: string): string },
  keybindings: Record<string, never>,
  done: (value: unknown) => void,
) => DialogComponent;

interface CtxCalls {
  custom: number;
  confirm: number;
  notify: Array<[string, string | undefined]>;
  /** Order in which the confirm and dialog surfaces were opened. */
  order: string[];
}

interface CtxOptions {
  mode?: "tui" | "rpc" | "json" | "print";
  hasUI?: boolean;
  cwd?: string;
  dialogs?: DialogDrive[];
}

function makeCtx(options: CtxOptions = {}): { ctx: ExtensionToolContext; calls: CtxCalls } {
  const calls: CtxCalls = { custom: 0, confirm: 0, notify: [], order: [] };
  const dialogs = options.dialogs ?? [];
  const ui = {
    custom: (factory: DialogFactory): Promise<unknown> => {
      const drive: DialogDrive = dialogs[calls.custom] ?? {};
      calls.custom += 1;
      calls.order.push("dialog");
      return new Promise<unknown>((done) => {
        const component = factory(
          { requestRender: () => {}, terminal: { rows: 40 } },
          { fg: (_color: string, text: string) => text },
          {},
          done,
        );
        void (async () => {
          // pi renders every dialog before it can take input; the read gate is
          // measured by that render, so the drive does it too.
          component.render?.(100);
          if (drive.hold !== undefined) await drive.hold;
          if (drive.emptySubmit === true) {
            component.handleInput("\r");
            component.handleInput("\x1b");
            return;
          }
          if (drive.escape === true) {
            component.handleInput("\x1b");
            return;
          }
          if (drive.declineReason !== undefined) {
            // Two rows down reach the No row of the three-option approval dialog.
            component.handleInput("\x1b[B");
            component.handleInput("\x1b[B");
            component.handleInput(drive.declineReason);
            component.handleInput("\r");
            return;
          }
          if (drive.approve !== undefined) {
            if (!drive.approve) component.handleInput("\x1b[B");
            if (drive.note !== undefined) component.handleInput(drive.note);
            component.handleInput("\r");
            return;
          }
          if (drive.password !== undefined && drive.password.length > 0) {
            component.handleInput(drive.password);
          }
          component.handleInput("\r");
        })();
      });
    },
    confirm: async (): Promise<boolean> => {
      calls.confirm += 1;
      calls.order.push("confirm");
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
    cwd: options.cwd ?? CWD,
    sessionManager: { getSessionId: () => SESSION_ID },
    signal: undefined,
  } as unknown as ExtensionToolContext;
  return { ctx, calls };
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function execute(
  tool: ToolDefinition,
  ctx: ExtensionToolContext,
  command: string,
  reason = "integration reason",
): Promise<ToolResult> {
  return tool.execute("call-1", { command, reason }, undefined, undefined, ctx);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("timed out waiting for the condition");
}

function tempArtifacts(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("pi-sudo-"))
    .sort();
}

after(() => {
  setSudoSpawnFn(undefined);
  setPermissionServiceFn(undefined);
  rmSync(PRIVATE_TMP, { recursive: true, force: true });
});

describe("sudo_exec integration: dialog outcomes", () => {
  it("returns the denial result for Esc and for an empty password followed by Esc", async () => {
    for (const drive of [{ escape: true }, { emptySubmit: true }] as DialogDrive[]) {
      const { records, spawnFn } = makeSpawn((child) => needsPassword(child));
      setSudoSpawnFn(spawnFn);
      try {
        const { ctx, calls } = makeCtx({ dialogs: [drive] });
        const result = await execute(toolFrom(), ctx, "id");
        assert.equal(result.isError, true);
        assert.equal(textOf(result), DENIAL_TEXT);
        assert.equal(calls.custom, 1);
        assert.equal(records.length, 1, "only the warm probe may spawn");
        assert.ok(records.every((record) => isWarm(record.args)));
      } finally {
        setSudoSpawnFn(undefined);
      }
    }
  });

  it("carries the approval dialog's denial reason into the result text", async () => {
    const note = "restart nginx from the deploy job instead";
    const { records, spawnFn } = makeSpawn((child) => needsPassword(child));
    setSudoSpawnFn(spawnFn);
    try {
      const { ctx, calls } = makeCtx({ dialogs: [{ declineReason: note }] });
      const result = await execute(toolFrom(), ctx, "systemctl restart nginx");
      assert.equal(result.isError, true);
      assert.equal(result.details.attempts, 0);
      assert.equal(textOf(result), `${DENIAL_TEXT}\n\nThe user added: ${note}`);
      assert.equal(calls.custom, 1);
      assert.equal(records.length, 1, "only the warm probe may spawn");
      assert.ok(records.every((record) => isWarm(record.args)));
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("ends in the authentication-failure result after three failed attempts", async () => {
    const { records, spawnFn } = makeSpawn((child, args, index) => {
      if (index === 0) {
        needsPassword(child);
        return;
      }
      prompted(child, args, RETRY_TEXT);
      child.emit("close", 1, null);
    });
    setSudoSpawnFn(spawnFn);
    try {
      const { ctx, calls } = makeCtx({
        dialogs: [
          { password: "wrong-one" },
          { password: "wrong-two" },
          { password: "wrong-three" },
        ],
      });
      const result = await execute(toolFrom(), ctx, "systemctl restart nginx");
      assert.equal(result.isError, true);
      assert.equal(textOf(result), ATTEMPTS_TEXT);
      assert.equal(result.details.attempts, 3);
      assert.equal(calls.custom, 3);
      assert.equal(records.length, 4, "one probe plus three authenticated runs");
      assert.equal(records[1].child.stdin.writes.length, 2, "password then newline");
      assert.equal(records[1].child.stdin.ended, true);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("reopens the dialog only after an attempt that saw the sudo prompt", async () => {
    // The first authenticated attempt prompts and is rejected: retry.
    const promptedRun = makeSpawn((child, args, index) => {
      if (index === 0) {
        needsPassword(child);
        return;
      }
      if (index === 1) {
        prompted(child, args, RETRY_TEXT);
        child.emit("close", 1, null);
        return;
      }
      prompted(child, args);
      succeeded(child, "ok\n");
    });
    setSudoSpawnFn(promptedRun.spawnFn);
    try {
      const { ctx, calls } = makeCtx({
        dialogs: [{ password: "first" }, { password: "second" }],
      });
      const result = await execute(toolFrom(), ctx, "systemctl restart nginx");
      assert.equal(result.isError, false);
      assert.equal(result.details.attempts, 2);
      assert.equal(calls.custom, 2);
      assert.equal(promptedRun.records.length, 3);
    } finally {
      setSudoSpawnFn(undefined);
    }

    // The attempt never reached sudo's prompt: its own stderr cannot force a retry.
    const silentRun = makeSpawn((child, _args, index) => {
      if (index === 0) {
        needsPassword(child);
        return;
      }
      // Deliberately no nonce: this is the command's stderr, not sudo's prompt.
      child.stderr.emit("data", Buffer.from(RETRY_TEXT));
      child.emit("close", 1, null);
    });
    setSudoSpawnFn(silentRun.spawnFn);
    try {
      const { ctx, calls } = makeCtx({ dialogs: [{ password: "only-attempt" }] });
      const result = await execute(toolFrom(), ctx, "id");
      assert.equal(result.isError, true);
      assert.notEqual(textOf(result), ATTEMPTS_TEXT);
      assert.equal(result.details.attempts, 1);
      assert.equal(calls.custom, 1);
      assert.equal(silentRun.records.length, 2);
      assert.match(textOf(result), /Sorry, try again\./);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });
});

describe("sudo_exec integration: policy service", () => {
  it("refuses a bash rule deny with no dialog and no spawn", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const { records, spawnFn } = makeSpawn(() => {
      throw new Error("spawn must not run for a policy deny");
    });
    setSudoSpawnFn(spawnFn);
    setPermissionServiceFn((sessionId) => {
      assert.equal(sessionId, SESSION_ID);
      return {
        checkPermission(surface, value) {
          seen.push([surface, value]);
          return { state: surface === "bash" ? "deny" : "allow" } as const;
        },
      };
    });
    try {
      const { ctx, calls } = makeCtx();
      const command = "rm -rf /tmp/pi-sudo-integration/data";
      const result = await execute(toolFrom(), ctx, command);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /permission policy denied/);
      assert.match(textOf(result), /surface: bash/);
      assert.match(textOf(result), /nothing ran/);
      assert.deepEqual(seen[0], ["bash", command]);
      assert.equal(calls.custom, 0);
      assert.equal(records.length, 0);
    } finally {
      setPermissionServiceFn(undefined);
      setSudoSpawnFn(undefined);
    }
  });

  it("refuses a per-token path deny with no dialog and no spawn", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const { records, spawnFn } = makeSpawn(() => {
      throw new Error("spawn must not run for a policy deny");
    });
    setSudoSpawnFn(spawnFn);
    setPermissionServiceFn(() => ({
      checkPermission(surface, value) {
        seen.push([surface, value]);
        const denied = surface === "path" && value === "/etc/shadow";
        return { state: denied ? "deny" : "allow" } as const;
      },
    }));
    try {
      const { ctx, calls } = makeCtx();
      const result = await execute(toolFrom(), ctx, "cat /etc/shadow");
      assert.equal(result.isError, true);
      assert.match(textOf(result), /surface: path/);
      assert.ok(seen.some(([surface, value]) => surface === "path" && value === "/etc/shadow"));
      assert.equal(calls.custom, 0);
      assert.equal(records.length, 0);
    } finally {
      setPermissionServiceFn(undefined);
      setSudoSpawnFn(undefined);
    }
  });
});

describe("sudo_exec integration: escalation and mutex", () => {
  it("asks the escalation dialog before the password dialog", async () => {
    const { records, spawnFn } = makeSpawn((child, args, index) => {
      if (index === 0) {
        needsPassword(child);
        return;
      }
      prompted(child, args);
      succeeded(child, "changed\n");
    });
    setSudoSpawnFn(spawnFn);
    try {
      const { ctx, calls } = makeCtx({
        dialogs: [{ approve: true }, { password: "pw" }],
      });
      const result = await execute(toolFrom(), ctx, "chown -R root:root /opt/app");
      assert.equal(result.isError, false);
      assert.deepEqual(calls.order, ["dialog", "dialog"]);
      assert.equal(calls.confirm, 0);
      assert.equal(calls.custom, 2);
      assert.equal(records.length, 2);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("treats a declined escalation as a denial before any spawn", async () => {
    const { records, spawnFn } = makeSpawn(() => {
      throw new Error("spawn must not run for a declined escalation");
    });
    setSudoSpawnFn(spawnFn);
    try {
      const { ctx, calls } = makeCtx({ dialogs: [{ approve: false }] });
      const result = await execute(toolFrom(), ctx, "chown -R root:root /opt/app");
      assert.equal(result.isError, true);
      assert.equal(textOf(result), DENIAL_TEXT);
      assert.equal(calls.custom, 1);
      assert.equal(records.length, 0);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("passes a decline note to the model", async () => {
    const { records, spawnFn } = makeSpawn(() => {
      throw new Error("spawn must not run for a declined escalation");
    });
    setSudoSpawnFn(spawnFn);
    try {
      const { ctx } = makeCtx({
        dialogs: [{ approve: false, note: "why does the app dir need root?" }],
      });
      const result = await execute(toolFrom(), ctx, "chown -R root:root /opt/app");
      assert.equal(result.isError, true);
      assert.equal(
        textOf(result),
        `${DENIAL_TEXT}\n\nThe user added: why does the app dir need root?`,
      );
      assert.equal(records.length, 0);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("rejects a concurrent call while another approval is open", async () => {
    const { records, spawnFn } = makeSpawn(() => {
      throw new Error("the first approval is denied before it spawns");
    });
    setSudoSpawnFn(spawnFn);
    let releaseDialog: () => void = () => {};
    const held = new Promise<void>((done) => {
      releaseDialog = done;
    });
    try {
      const first = makeCtx({ dialogs: [{ approve: false, hold: held }] });
      const running = execute(toolFrom(), first.ctx, "chown -R root:root /opt/app");
      await waitFor(() => first.calls.custom === 1);

      const second = makeCtx();
      const blocked = await execute(toolFrom(), second.ctx, "id");
      assert.equal(blocked.isError, true);
      assert.match(textOf(blocked), /already open/);
      assert.equal(second.calls.custom, 0);
      assert.equal(records.length, 0);

      releaseDialog();
      const denied = await running;
      assert.equal(denied.isError, true);
      assert.equal(textOf(denied), DENIAL_TEXT);
    } finally {
      releaseDialog();
      setSudoSpawnFn(undefined);
    }
  });
});

describe("sudo_exec integration: warm, non-TUI, and hygiene", () => {
  it("probes with true, asks for approval on a warm ticket, then runs warm", async () => {
    const { records, spawnFn } = makeSpawn((child, _args, index) => {
      succeeded(child, index === 0 ? "" : "active\n");
    });
    setSudoSpawnFn(spawnFn);
    try {
      const { ctx, calls } = makeCtx();
      const result = await execute(toolFrom(), ctx, "systemctl restart nginx");
      assert.equal(result.isError, false);
      assert.equal(result.details.warm, true);
      assert.equal(result.details.attempts, 0);
      assert.equal(result.details.approval, "once");
      assert.equal(calls.custom, 1, "a warm ticket must still be approved");
      assert.equal(calls.confirm, 0);
      assert.equal(records.length, 2, "one true probe and one approved run");
      assert.ok(records.every((record) => isWarm(record.args)));
      assert.equal(records[0].args[records[0].args.length - 1], "exec 2>&1 0</dev/null; true");
      assert.equal(
        records[1].args[records[1].args.length - 1],
        "exec 2>&1 0</dev/null; systemctl restart nginx",
      );
      assert.match(textOf(result), /^\$ systemctl restart nginx\nexit code: 0/);
      assert.match(textOf(result), /active/);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("fails closed in non-TUI modes with no spawn", async () => {
    const { records, spawnFn } = makeSpawn(() => {
      throw new Error("spawn must not run in a non-TUI mode");
    });
    try {
      for (const options of [
        { mode: "print" as const, hasUI: false },
        { mode: "json" as const, hasUI: false },
        { mode: "rpc" as const, hasUI: true },
      ]) {
        setSudoSpawnFn(spawnFn);
        const { ctx, calls } = makeCtx(options);
        const result = await execute(toolFrom(), ctx, "id");
        assert.equal(result.isError, true);
        assert.match(textOf(result), /interactive TUI approval dialog/);
        assert.equal(calls.custom, 0);
      }
      assert.equal(records.length, 0);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("never puts the password in the result content or details", async () => {
    const secret = "Zq9-integration-secret";
    const { records, spawnFn } = makeSpawn((child, args, index) => {
      if (index === 0) {
        needsPassword(child);
        return;
      }
      prompted(child, args);
      succeeded(child, "ok\n");
    });
    setSudoSpawnFn(spawnFn);
    try {
      const { ctx } = makeCtx({ dialogs: [{ password: secret }] });
      const result = await execute(toolFrom(), ctx, "id");
      assert.equal(result.isError, false);
      assert.equal(records[1].child.stdin.snapshots.length, 1);
      assert.equal(records[1].child.stdin.snapshots[0].toString("utf8"), secret);
      assert.equal(records[1].child.stdin.writes[1], "\n");
      assert.equal(textOf(result).includes(secret), false);
      assert.equal(JSON.stringify(result.content).includes(secret), false);
      assert.equal(JSON.stringify(result.details).includes(secret), false);
      for (const record of records) {
        assert.equal(record.args.join(" ").includes(secret), false);
      }
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("removes its temporary artifacts after a run", async () => {
    const before = tempArtifacts();
    const { spawnFn } = makeSpawn((child, args, index) => {
      if (index === 0) {
        needsPassword(child);
        return;
      }
      prompted(child, args);
      succeeded(child, "ok\n");
    });
    setSudoSpawnFn(spawnFn);
    try {
      const { ctx } = makeCtx({ dialogs: [{ password: "pw" }] });
      const result = await execute(toolFrom(), ctx, "id");
      assert.equal(result.isError, false);
      assert.deepEqual(tempArtifacts(), before);
    } finally {
      setSudoSpawnFn(undefined);
    }
  });

  it("streams command stdout through onUpdate and never streams sudo stderr", async () => {
    const { spawnFn } = makeSpawn((child, _args, index) => {
      if (index === 0) {
        // The probe runs `true`; its stderr is sudo's, not the command's.
        child.stderr.emit("data", Buffer.from("sudo: a notice\n"));
        succeeded(child);
        return;
      }
      succeeded(child, "chunk-1\n");
    });
    setSudoSpawnFn(spawnFn);
    try {
      const { ctx } = makeCtx({ dialogs: [{ password: "pw" }] });
      const updates: string[] = [];
      const result = await toolFrom().execute(
        "call-stream",
        { command: "id", reason: "stream reason" },
        undefined,
        (partial: ToolResult) => {
          updates.push(partial.content[0]?.text ?? "");
        },
        ctx,
      );
      assert.equal(result.isError, false);
      assert.ok(updates.some((text) => text.includes("chunk-1")), "stdout was not streamed");
      assert.equal(
        updates.some((text) => text.includes("a notice")),
        false,
        "sudo stderr must not be streamed",
      );
    } finally {
      setSudoSpawnFn(undefined);
    }
  });
});
