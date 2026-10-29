import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  fail,
  forgetTicket,
  probeTicket,
  resolveSudo,
  runCold,
  runWarm,
  SudoError,
  sweepStaleTemp,
  type SpawnFn,
} from "../src/executor.js";

class FakeStdin extends EventEmitter {
  readonly writes: Array<Buffer | string> = [];
  ended = false;

  write(chunk: Buffer | string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(): this {
    // A real writable flushes asynchronously; tests emit "finish" themselves.
    this.ended = true;
    return this;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
}

interface SpawnRecord {
  cmd: string;
  args: string[];
  opts: SpawnOptions;
  child: FakeChild;
}

function makeSpawn(): { records: SpawnRecord[]; spawnFn: SpawnFn } {
  const records: SpawnRecord[] = [];
  const spawnFn: SpawnFn = (cmd, args, opts) => {
    const child = new FakeChild();
    records.push({ cmd, args, opts, child });
    return child as unknown as ChildProcess;
  };
  return { records, spawnFn };
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nextSpawn(records: SpawnRecord[], index = 0): Promise<SpawnRecord> {
  for (let i = 0; i < 200; i += 1) {
    if (records[index] !== undefined) return records[index];
    await tick(5);
  }
  throw new Error("expected a spawn");
}

function nonceFrom(args: string[]): string {
  const nonce = args[2];
  assert.equal(args[0] === "-S" || args[0] === "-n", true);
  assert.equal(args[1], "-p");
  return nonce;
}

function payloadFrom(args: string[]): string {
  return args[args.length - 1];
}

function prompt(child: FakeChild, nonce: string): void {
  child.stderr.emit("data", Buffer.from(nonce));
}

function mode(file: string): Promise<number> {
  return stat(file).then((stats) => stats.mode & 0o777);
}

const PASSWORD = "s3cret-pw";

describe("executor", () => {
  it("warm run executes the approved command with -n, LC_ALL=C, and merged stderr", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runWarm({ command: "id -u", cwd: "/tmp", spawnFn });
    const rec = await nextSpawn(records);

    assert.equal(rec.cmd, resolveSudo());
    assert.deepEqual(rec.args.slice(0, 4), ["-n", "-p", nonceFrom(rec.args), "--"]);
    assert.deepEqual(rec.args.slice(3), ["--", "/bin/sh", "-c", rec.args[6]]);
    assert.equal(payloadFrom(rec.args), "exec 2>&1 0</dev/null; id -u");
    assert.equal(rec.opts.detached, false);
    assert.equal(rec.opts.env?.LC_ALL, "C");
    assert.deepEqual(rec.opts.stdio, ["pipe", "pipe", "pipe"]);

    rec.child.finish(0);
    const outcome = await run;
    assert.equal("ran" in outcome && outcome.ran, true);
    if ("ran" in outcome) {
      assert.equal(outcome.result.ok, true);
      assert.equal(outcome.result.warm, true);
      assert.equal(outcome.result.exitCode, 0);
    }
    assert.equal(records.every((entry) => !entry.args.includes("-k")), true, "warm runs never spawn sudo -k");
  });

  it("probeTicket runs true as root and never the user's command", async () => {
    const { records, spawnFn } = makeSpawn();
    const probe = probeTicket({ cwd: "/tmp", spawnFn });
    const rec = await nextSpawn(records);

    assert.equal(rec.cmd, resolveSudo());
    assert.equal(rec.args[0], "-n");
    assert.equal(rec.args[1], "-p");
    assert.equal(rec.args[3], "--");
    assert.deepEqual(rec.args.slice(4), ["/bin/sh", "-c", "exec 2>&1 0</dev/null; true"]);
    assert.equal(payloadFrom(rec.args), "exec 2>&1 0</dev/null; true");
    assert.equal(rec.args.join(" ").includes("systemctl"), false);
    assert.equal(rec.opts.env?.LC_ALL, "C");

    rec.child.finish(0);
    assert.equal(await probe, true);
  });

  it("probeTicket reports false when sudo demands a password, writing nothing", async () => {
    const { records, spawnFn } = makeSpawn();
    const probe = probeTicket({ cwd: "/tmp", spawnFn });
    const rec = await nextSpawn(records);
    assert.equal(payloadFrom(rec.args), "exec 2>&1 0</dev/null; true");

    // sudo's real prompt line, and the -p nonce never appeared: no secret exists.
    rec.child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
    rec.child.finish(1);

    assert.equal(await probe, false);
    assert.equal(nonceFrom(rec.args).includes("pi-sudo:"), true);
    assert.equal(rec.child.stdin.writes.length, 0);
    assert.equal(rec.child.stdin.ended, true);
  });

  it("cold run uses -S -p, writes the password once on the nonce, newline separately, then ends stdin", async () => {
    const { records, spawnFn } = makeSpawn();
    const password = Buffer.from(PASSWORD);
    const run = runCold({ command: "id -u", cwd: "/tmp", password, spawnFn });
    const rec = await nextSpawn(records);
    const nonce = nonceFrom(rec.args);

    assert.equal(rec.args[0], "-S");
    assert.equal(rec.opts.detached, false);
    assert.equal(rec.opts.env?.LC_ALL, "C");

    const payload = payloadFrom(rec.args);
    assert.equal(payload, "exec 2>&1 0</dev/null; id -u");

    // The command's stderr now shares its stdout pipe.
    rec.child.stdout.emit("data", Buffer.from("command stderr\n"));

    prompt(rec.child, nonce);
    assert.equal(rec.child.stdin.writes.length, 2);
    assert.equal(Buffer.isBuffer(rec.child.stdin.writes[0]), true);
    assert.equal((rec.child.stdin.writes[0] as Buffer).toString(), PASSWORD);
    assert.equal(rec.child.stdin.writes[1], "\n");
    assert.equal(rec.child.stdin.ended, true);
    // The buffer must not be zeroed synchronously after the write.
    assert.equal(password.toString(), PASSWORD);

    // The write latch is one-shot even if the nonce appears again.
    prompt(rec.child, nonce);
    assert.equal(rec.child.stdin.writes.length, 2);

    rec.child.finish(0);
    // "close" zeroes the buffer before the promise settles.
    assert.equal(password.every((byte) => byte === 0), true);

    const outcome = await run;
    assert.equal(outcome.status, "ran");
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.result.warm, false);
    assert.equal(outcome.result.promptSeen, true);
    assert.match(outcome.result.output, /^command stderr\n/);
    assert.equal(
      outcome.result.output.includes("command stderr"),
      true,
      "command output stays model-visible",
    );
    assert.equal(
      records.every((entry) => !entry.args.includes("-k")),
      true,
      "no run may spawn sudo -k",
    );
  });

  it("zeroes the password on stdin finish, not before", async () => {
    const { records, spawnFn } = makeSpawn();
    const password = Buffer.from(PASSWORD);
    const run = runCold({ command: "true", cwd: "/tmp", password, spawnFn });
    const rec = await nextSpawn(records);

    prompt(rec.child, nonceFrom(rec.args));
    assert.equal(password.toString(), PASSWORD);
    rec.child.stdin.emit("finish");
    assert.equal(password.every((byte) => byte === 0), true);

    rec.child.finish(0);
    const outcome = await run;
    assert.equal(outcome.status, "ran");
  });

  it("an empty password spawns -S, writes nothing, ends stdin at once, and is not warm", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runCold({ command: "true", cwd: "/tmp", password: Buffer.alloc(0), spawnFn });
    const rec = await nextSpawn(records);

    // -S still applies: PAM authenticates with the fingerprint reader.
    assert.equal(rec.args[0], "-S");
    assert.equal(rec.child.stdin.ended, true, "the reader route needs no stdin");

    // Even sudo's own prompt on stderr must not squeeze a write out of it.
    prompt(rec.child, nonceFrom(rec.args));
    assert.equal(rec.child.stdin.writes.length, 0);

    rec.child.finish(0);
    const outcome = await run;
    assert.equal(outcome.status, "ran");
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.result.warm, false, "a fingerprint run is never reported warm");
    assert.equal(outcome.result.promptSeen, false);
  });

  it("keeps stdin open when the prompt never appears; a failing exit gives no retry", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runCold({
      command: "false",
      cwd: "/tmp",
      password: Buffer.from(PASSWORD),
      spawnFn,
    });
    const rec = await nextSpawn(records);
    await tick(60);
    assert.equal(rec.child.stdin.ended, false);
    assert.equal(rec.child.stdin.writes.length, 0);
    rec.child.finish(1);
    const outcome = await run;
    assert.equal(outcome.status, "ran", "no retry without a real sudo prompt");
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.warm, false);
  });

  it("writes the password when the prompt arrives late", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runCold({
      command: "true",
      cwd: "/tmp",
      password: Buffer.from(PASSWORD),
      spawnFn,
    });
    const rec = await nextSpawn(records);
    await tick(60);
    prompt(rec.child, nonceFrom(rec.args));
    assert.deepEqual(rec.child.stdin.writes, [Buffer.from(PASSWORD), "\n"]);
    assert.equal(rec.child.stdin.ended, true);
    rec.child.finish(0);
    const outcome = await run;
    assert.equal(outcome.status, "ran");
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.result.promptSeen, true);
  });

  it("prompts past the command timeout and still lets the command finish", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runCold({
      command: "true",
      cwd: "/tmp",
      password: Buffer.from(PASSWORD),
      spawnFn,
      timeoutSec: 1,
    });
    const rec = await nextSpawn(records);
    const nonce = nonceFrom(rec.args);
    setTimeout(() => prompt(rec.child, nonce), 600);
    setTimeout(() => rec.child.finish(0), 1400);
    const outcome = await run;
    assert.equal(outcome.status, "ran");
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.result.timedOut, false);
    assert.equal(outcome.result.promptSeen, true);
    assert.equal(rec.child.kills.includes("SIGTERM"), false);
  });

  describe("auth evidence", () => {
    it("a fast prompt with the default threshold gives authEvidence:false and a small promptDelayMs", async () => {
      const { records, spawnFn } = makeSpawn();
      const run = runCold({
        command: "true",
        cwd: "/tmp",
        password: Buffer.from(PASSWORD),
        spawnFn,
      });
      const rec = await nextSpawn(records);
      prompt(rec.child, nonceFrom(rec.args));
      rec.child.finish(0);
      const outcome = await run;
      assert.equal(outcome.status, "ran");
      assert.equal(outcome.result.authEvidence, false);
      assert.equal(typeof outcome.result.promptDelayMs, "number");
      assert.ok(outcome.result.promptDelayMs !== null);
      assert.ok(outcome.result.promptDelayMs >= 0);
      assert.ok(outcome.result.promptDelayMs < 5000);
    });

    it("a prompt beyond the slow-auth threshold gives authEvidence:true", async () => {
      const { records, spawnFn } = makeSpawn();
      const run = runCold({
        command: "true",
        cwd: "/tmp",
        password: Buffer.from(PASSWORD),
        spawnFn,
        slowAuthMs: 20,
      });
      const rec = await nextSpawn(records);
      await tick(60);
      prompt(rec.child, nonceFrom(rec.args));
      rec.child.finish(0);
      const outcome = await run;
      assert.equal(outcome.status, "ran");
      assert.equal(outcome.result.authEvidence, true);
      assert.equal(outcome.result.authMarker, false, "a slow prompt is not a marker");
      assert.ok(outcome.result.promptDelayMs !== null);
      assert.ok(outcome.result.promptDelayMs >= 20);
    });

    it("a fingerprint marker on sudo's stdout before the prompt gives authEvidence:true", async () => {
      const { records, spawnFn } = makeSpawn();
      const run = runCold({
        command: "true",
        cwd: "/tmp",
        password: Buffer.from(PASSWORD),
        spawnFn,
      });
      const rec = await nextSpawn(records);
      rec.child.stdout.emit("data", Buffer.from("Verification timed out\n"));
      prompt(rec.child, nonceFrom(rec.args));
      rec.child.finish(0);
      const outcome = await run;
      assert.equal(outcome.status, "ran");
      assert.equal(outcome.result.authEvidence, true);
      assert.equal(outcome.result.authMarker, true, "the marker alone is recorded");
      assert.ok(outcome.result.promptDelayMs !== null);
    });

    it("a fingerprint marker on sudo's stderr before the prompt also counts", async () => {
      const { records, spawnFn } = makeSpawn();
      const run = runCold({
        command: "true",
        cwd: "/tmp",
        password: Buffer.from(PASSWORD),
        spawnFn,
      });
      const rec = await nextSpawn(records);
      rec.child.stderr.emit("data", Buffer.from("Verification timed out\n"));
      prompt(rec.child, nonceFrom(rec.args));
      rec.child.finish(0);
      const outcome = await run;
      assert.equal(outcome.status, "ran");
      assert.equal(outcome.result.authMarker, true, "the marker was on the auth channel");
      assert.equal(outcome.result.authEvidence, true);
    });

    it("the same marker printed by the command after the prompt gives authEvidence:false", async () => {
      const { records, spawnFn } = makeSpawn();
      const run = runCold({
        command: "printf 'Verification timed out\\n'",
        cwd: "/tmp",
        password: Buffer.from(PASSWORD),
        spawnFn,
      });
      const rec = await nextSpawn(records);
      prompt(rec.child, nonceFrom(rec.args));
      rec.child.stdout.emit("data", Buffer.from("Verification timed out\n"));
      rec.child.finish(0);
      const outcome = await run;
      assert.equal(outcome.status, "ran");
      assert.equal(outcome.result.ok, true);
      assert.equal(outcome.result.authEvidence, false);
      assert.equal(outcome.result.authMarker, false);
    });

    it("a run without a prompt reports promptDelayMs:null and authEvidence:false", async () => {
      const { records, spawnFn } = makeSpawn();
      const run = runCold({
        command: "false",
        cwd: "/tmp",
        password: Buffer.from(PASSWORD),
        spawnFn,
      });
      const rec = await nextSpawn(records);
      await tick(60);
      rec.child.finish(1);
      const outcome = await run;
      assert.equal(outcome.status, "ran");
      assert.equal(outcome.result.promptSeen, false);
      assert.equal(outcome.result.promptDelayMs, null);
      assert.equal(outcome.result.authEvidence, false);
    });
  });

  it("ignores a nonce or password-required line written by the command itself", async () => {
    const cold = makeSpawn();
    const run = runCold({
      command: "printf '%s' \"$NONCE\" >&2",
      cwd: "/tmp",
      password: Buffer.from(PASSWORD),
      spawnFn: cold.spawnFn,
    });
    const rec = await nextSpawn(cold.records);
    // The command writes the forged text to its own stderr, which is its stdout now.
    rec.child.stdout.emit(
      "data",
      Buffer.from(`${nonceFrom(rec.args)}\nsudo: a password is required\n`),
    );
    await tick(60);
    assert.equal(rec.child.stdin.writes.length, 0, "command stderr must never feed the detector");
    rec.child.finish(1);
    const coldOutcome = await run;
    assert.equal(coldOutcome.status, "ran", "no retry without a real sudo prompt");
    assert.equal(coldOutcome.result.promptSeen, false);
    assert.match(coldOutcome.result.output, /sudo: a password is required/);

    const warm = makeSpawn();
    const probe = runWarm({ command: "true", cwd: "/tmp", spawnFn: warm.spawnFn });
    const warmRec = await nextSpawn(warm.records);
    warmRec.child.stdout.emit(
      "data",
      Buffer.from(`${nonceFrom(warmRec.args)}\nsudo: a password is required\n`),
    );
    warmRec.child.finish(0);
    const warmOutcome = await probe;
    assert.equal("needsPassword" in warmOutcome, false, "forged text cannot force a probe retry");
    assert.equal("ran" in warmOutcome && warmOutcome.ran, true);
  });

  it("detects needsPassword only for sudo's own exact line", async () => {
    const negative = makeSpawn();
    const notPrompt = runWarm({ command: "true", cwd: "/tmp", spawnFn: negative.spawnFn });
    const negativeRec = await nextSpawn(negative.records);
    negativeRec.child.stderr.emit(
      "data",
      Buffer.from("not sudo: a password is required\n"),
    );
    negativeRec.child.finish(0);
    const negativeOutcome = await notPrompt;
    assert.equal("needsPassword" in negativeOutcome, false);

    const positive = makeSpawn();
    const prompted = runWarm({ command: "true", cwd: "/tmp", spawnFn: positive.spawnFn });
    const positiveRec = await nextSpawn(positive.records);
    positiveRec.child.stderr.emit("data", Buffer.from("sudo: a password is required\n"));
    positiveRec.child.finish(1);
    const positiveOutcome = await prompted;
    assert.deepEqual(positiveOutcome, { needsPassword: true });
  });

  it("retries only on Sorry, try again.; other post-prompt errors fail immediately", async () => {
    const retryable = makeSpawn();
    const run = runCold({
      command: "true",
      cwd: "/tmp",
      password: Buffer.from(PASSWORD),
      spawnFn: retryable.spawnFn,
    });
    const rec = await nextSpawn(retryable.records);
    prompt(rec.child, nonceFrom(rec.args));
    rec.child.stderr.emit("data", Buffer.from("Sorry, try again.\n"));
    rec.child.finish(1);
    const retryOutcome = await run;
    assert.equal(retryOutcome.status, "retry");
    assert.equal(retryOutcome.result.ok, false);

    const immediate = makeSpawn();
    const failing = runCold({
      command: "true",
      cwd: "/tmp",
      password: Buffer.from(PASSWORD),
      spawnFn: immediate.spawnFn,
    });
    const failRec = await nextSpawn(immediate.records);
    prompt(failRec.child, nonceFrom(failRec.args));
    failRec.child.stderr.emit("data", Buffer.from("sudo: not in the sudoers file\n"));
    failRec.child.finish(1);
    const failOutcome = await failing;
    assert.equal(failOutcome.status, "ran");
    assert.equal(failOutcome.result.ok, false);
    assert.match(failOutcome.result.output, /not in the sudoers file/);
  });

  it("swallows stdin EPIPE instead of throwing", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runCold({
      command: "true",
      cwd: "/tmp",
      password: Buffer.from(PASSWORD),
      spawnFn,
    });
    const rec = await nextSpawn(records);
    prompt(rec.child, nonceFrom(rec.args));
    rec.child.finish(0);
    rec.child.stdin.emit("error", new Error("EPIPE"));
    const outcome = await run;
    assert.equal(outcome.status, "ran");
  });

  it("reports a null exit code as a failure", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runWarm({ command: "sleep 1", cwd: "/tmp", spawnFn });
    const rec = await nextSpawn(records);
    rec.child.finish(null, "SIGKILL");
    const outcome = await run;
    assert.equal("ran" in outcome, true);
    if ("ran" in outcome) {
      assert.equal(outcome.result.exitCode, null);
      assert.equal(outcome.result.signal, "SIGKILL");
      assert.equal(outcome.result.ok, false);
    }
  });

  it("times out with SIGTERM and then SIGKILL", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runWarm({
      command: "sleep 300",
      cwd: "/tmp",
      spawnFn,
      timeoutSec: 0.02,
      killGraceMs: 30,
    });
    const rec = await nextSpawn(records);
    await tick(50);
    assert.equal(rec.child.kills.includes("SIGTERM"), true);
    await tick(60);
    assert.equal(rec.child.kills.includes("SIGKILL"), true);
    rec.child.finish(null, "SIGKILL");
    const outcome = await run;
    assert.equal("ran" in outcome, true);
    if ("ran" in outcome) {
      assert.equal(outcome.result.timedOut, true);
      assert.equal(outcome.result.ok, false);
    }
  });

  it("kills on abort and reports it; a pre-aborted signal spawns nothing", async () => {
    const { records, spawnFn } = makeSpawn();
    const controller = new AbortController();
    const run = runWarm({ command: "sleep 300", cwd: "/tmp", spawnFn, signal: controller.signal });
    const rec = await nextSpawn(records);
    controller.abort();
    assert.equal(rec.child.kills.includes("SIGTERM"), true);
    rec.child.finish(null, "SIGTERM");
    const outcome = await run;
    assert.equal("ran" in outcome, true);
    if ("ran" in outcome) {
      assert.equal(outcome.result.aborted, true);
      assert.equal(outcome.result.ok, false);
    }

    const aborted = makeSpawn();
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      runWarm({ command: "true", cwd: "/tmp", spawnFn: aborted.spawnFn, signal: preAborted.signal }),
      (error: unknown) => error instanceof SudoError && error.code === "aborted",
    );
    assert.equal(aborted.records.length, 0);
  });

  it("truncates the tail and writes a 0600 full-output file under a 0700 directory", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runWarm({ command: "seq 1 4000", cwd: "/tmp", spawnFn });
    const rec = await nextSpawn(records);
    const big = `${"x".repeat(200)}\n`.repeat(400);
    rec.child.stdout.emit("data", Buffer.from(big));
    rec.child.finish(0);
    const outcome = await run;
    assert.equal("ran" in outcome, true);
    if (!("ran" in outcome)) return;

    const result = outcome.result;
    assert.equal(result.truncated, true);
    assert.equal(typeof result.fullOutputPath, "string");
    assert.ok(result.fullOutputPath !== null);
    assert.equal(await mode(result.fullOutputPath), 0o600);
    assert.equal(await mode(dirname(result.fullOutputPath)), 0o700);
    assert.equal(await readFile(result.fullOutputPath, "utf8"), big);
    assert.equal(result.output.includes(result.fullOutputPath), true);
    assert.equal(result.output.length < big.length, true);
    assert.equal(result.output.endsWith("\n"), true);

    await rm(dirname(result.fullOutputPath), { recursive: true, force: true });
  });

  it("forgetTicket spawns sudo -k non-detached with LC_ALL=C", async () => {
    const { records, spawnFn } = makeSpawn();
    const pending = forgetTicket(spawnFn);
    const rec = await nextSpawn(records);
    assert.deepEqual(rec.args, ["-k"]);
    assert.equal(rec.cmd, resolveSudo());
    assert.equal(rec.opts.detached, false);
    assert.equal(rec.opts.env?.LC_ALL, "C");
    assert.deepEqual(rec.opts.stdio, ["pipe", "pipe", "pipe"]);
    rec.child.finish(0);
    assert.deepEqual(await pending, { ok: true, exitCode: 0, signal: null, stderr: "" });
  });

  it("sweeps only stale pi-sudo-* directories", async () => {
    const stale = await mkdtemp(join(tmpdir(), "pi-sudo-test-stale-"));
    const other = await mkdtemp(join(tmpdir(), "pi-sudo-sweep-keep-"));
    const keep = await mkdtemp(join(tmpdir(), "keep-me-"));
    try {
      await writeFile(join(stale, "output"), "root output");
      const removed = await sweepStaleTemp();
      assert.ok(removed >= 1);
      await assert.rejects(stat(stale), { code: "ENOENT" });
      // "pi-sudo-sweep-keep-" also matches the prefix and is expected to go.
      await assert.rejects(stat(other), { code: "ENOENT" });
      assert.equal((await stat(keep)).isDirectory(), true);
    } finally {
      await rm(keep, { recursive: true, force: true });
      await rm(stale, { recursive: true, force: true }).catch(() => {});
      await rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("resolveSudo ignores PATH and only accepts the absolute path", () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-shadow-dir";
      assert.equal(resolveSudo(), "/usr/bin/sudo");
    } finally {
      process.env.PATH = original;
    }
  });

  it("zeroes a taken password when the spawn throws", async () => {
    const password = Buffer.from(PASSWORD);
    const throwing: SpawnFn = () => {
      throw new Error("spawn blew up");
    };
    await assert.rejects(
      runCold({ command: "true", cwd: "/tmp", password, spawnFn: throwing }),
      (error: unknown) => error instanceof SudoError && error.code === "spawn-failed",
    );
    assert.equal(password.every((byte) => byte === 0), true);
  });

  it("zeroes a taken password when the request was already aborted", async () => {
    const password = Buffer.from(PASSWORD);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runCold({ command: "true", cwd: "/tmp", password, spawnFn: makeSpawn().spawnFn, signal: controller.signal }),
      (error: unknown) => error instanceof SudoError && error.code === "aborted",
    );
    assert.equal(password.every((byte) => byte === 0), true);
  });

  it("caps retained output and terminates a command that floods it", async () => {
    const { records, spawnFn } = makeSpawn();
    const run = runWarm({ command: "yes", cwd: "/tmp", spawnFn });
    const rec = await nextSpawn(records);
    rec.child.stdout.emit("data", Buffer.from("x".repeat(3 * 1024 * 1024)));
    assert.equal(rec.child.kills.includes("SIGTERM"), true);
    rec.child.finish(null, "SIGTERM");
    const outcome = await run;
    assert.equal("ran" in outcome, true);
    if ("ran" in outcome) {
      assert.match(outcome.result.output, /\[output limit reached; the command was terminated\]/);
      assert.equal(outcome.result.ok, false);
    }
  });

  it("fail() returns fixed messages and codes", () => {
    const error = fail("spawn-failed");
    assert.equal(error instanceof SudoError, true);
    assert.equal(error.code, "spawn-failed");
    assert.equal(error.message, "sudo could not be started; nothing ran.");
    assert.equal(fail("sudo-missing").message.includes("/usr/bin/sudo"), true);
    assert.equal(fail("temp-dir-failed").code, "temp-dir-failed");
  });
});
