import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";

const RUN_DIR_PREFIX = "pi-sudo-";
const DEFAULT_TIMEOUT_SEC = 120;
const NO_PROMPT_MS = 5000;
const KILL_GRACE_MS = 3000;
const STDERR_SCAN_BYTES = 64 * 1024;
const PASSWORD_REQUIRED = /^sudo: a password is required$/m;
const RETRY_MESSAGE = "Sorry, try again.";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type FailCode = "sudo-missing" | "spawn-failed" | "temp-dir-failed" | "output-lost" | "aborted";

const FAIL_MESSAGES: Readonly<Record<FailCode, string>> = {
  "sudo-missing": "sudo was not found at /usr/bin/sudo or on PATH; pi-sudo cannot run privileged commands.",
  "spawn-failed": "sudo could not be started; nothing ran.",
  "temp-dir-failed": "pi-sudo could not create a private temporary directory; nothing ran.",
  "output-lost": "The full command output could not be written to a secure file and was lost.",
  aborted: "The sudo request was aborted before anything ran.",
};

export class SudoError extends Error {
  readonly code: FailCode;

  constructor(code: FailCode) {
    super(FAIL_MESSAGES[code]);
    this.name = "SudoError";
    this.code = code;
  }
}

/** The single fixed-message error factory. Never interpolates caller data. */
export function fail(code: FailCode): SudoError {
  return new SudoError(code);
}

export interface SpawnRunOptions {
  command: string;
  cwd: string;
  timeoutSec?: number;
  signal?: AbortSignal;
  /** Live command stdout only; sudo's own stderr is never streamed. */
  onOutput?: (chunk: string) => void;
  spawnFn?: SpawnFn;
  /** Test seam; production default is 5000 ms. */
  noPromptMs?: number;
  /** Test seam; production default is 3000 ms. */
  killGraceMs?: number;
}

export interface RunColdOptions extends SpawnRunOptions {
  password: Buffer;
}

export interface ExecResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  /** Model-facing: stdout plus command/sudo stderr tail (truncated). */
  output: string;
  sudoStderr: string;
  truncated: boolean;
  fullOutputPath: string | null;
  promptSeen: boolean;
  timedOut: boolean;
  aborted: boolean;
  warm: boolean;
  ok: boolean;
}

export type WarmOutcome = { needsPassword: true } | { ran: true; result: ExecResult };

export type ColdOutcome =
  | { status: "ran"; result: ExecResult }
  | { status: "retry"; result: ExecResult };

interface InternalOutcome {
  needsPassword: boolean;
  result: ExecResult;
}

export interface ForgetTicketOutcome {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** `/usr/bin/sudo` when it exists, otherwise the first `sudo` on PATH. */
export function resolveSudo(): string {
  const fixed = "/usr/bin/sudo";
  if (existsSync(fixed)) return fixed;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "sudo");
    if (existsSync(candidate)) return candidate;
  }
  throw fail("sudo-missing");
}

/** The warm probe runs the real command; only password-required prompts defer to the dialog. */
export async function runWarm(options: SpawnRunOptions): Promise<WarmOutcome> {
  const outcome = await runOnce(options, undefined);
  if (outcome.needsPassword) return { needsPassword: true };
  return { ran: true, result: outcome.result };
}

/** The authenticated run. Returns `retry` only for sudo's "Sorry, try again." line. */
export async function runCold(options: RunColdOptions): Promise<ColdOutcome> {
  const outcome = await runOnce(options, options.password);
  const result = outcome.result;
  if (result.promptSeen && !result.ok && result.sudoStderr.includes(RETRY_MESSAGE)) {
    return { status: "retry", result };
  }
  return { status: "ran", result };
}

/** The only place in this module that spawns `sudo -k`. */
export async function forgetTicket(spawnFn: SpawnFn = spawn): Promise<ForgetTicketOutcome> {
  const sudo = resolveSudo();
  return await new Promise<ForgetTicketOutcome>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const child = spawnFn(sudo, ["-k"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
      detached: false,
    });
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end();
    } catch {
      // ignore: -k does not read stdin
    }
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_SCAN_BYTES);
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      reject(fail("spawn-failed"));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ ok: code === 0, exitCode: code, signal, stderr });
    });
  });
}

/** Remove leftover `pi-sudo-*` directories (crash debris) from the temp dir. */
export async function sweepStaleTemp(): Promise<number> {
  const base = tmpdir();
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(RUN_DIR_PREFIX)) continue;
    const target = join(base, name);
    try {
      const stats = await lstat(target);
      if (!stats.isDirectory()) continue;
      await rm(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A racing session or an unreadable entry is not our failure.
    }
  }
  return removed;
}

function makeNonce(): string {
  return `[pi-sudo:${randomBytes(8).toString("hex")}] password: `;
}

function quoteForDoubleQuotes(value: string): string {
  return value.replace(/[\\"$`]/g, (char) => `\\${char}`);
}

function buildPayload(command: string, errfile: string): string {
  return `exec 2>"${quoteForDoubleQuotes(errfile)}"; ${command}`;
}

function joinStderr(commandStderr: string, sudoStderr: string): string {
  if (commandStderr.length === 0) return sudoStderr;
  if (sudoStderr.length === 0) return commandStderr;
  return commandStderr.endsWith("\n") ? commandStderr + sudoStderr : `${commandStderr}\n${sudoStderr}`;
}

function mergeOutput(stdout: string, stderr: string): string {
  if (stderr.length === 0) return stdout;
  const head = stdout.length === 0 || stdout.endsWith("\n") ? stdout : `${stdout}\n`;
  return `${head}--- stderr ---\n${stderr}`;
}

async function makeRunDir(): Promise<string> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), RUN_DIR_PREFIX));
    await chmod(dir, 0o700);
  } catch {
    throw fail("temp-dir-failed");
  }
  return dir;
}

async function makeErrfile(dir: string): Promise<string> {
  const errfile = join(dir, "stderr");
  try {
    await writeFile(errfile, "", { mode: 0o600, flag: "wx" });
    await chmod(errfile, 0o600);
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw fail("temp-dir-failed");
  }
  return errfile;
}

interface CollectArgs {
  command: string;
  dir: string;
  errfile: string;
  stdout: string;
  sudoStderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  timedOut: boolean;
  aborted: boolean;
  promptSeen: boolean;
  warm: boolean;
  materialize: boolean;
}

async function collectResult(args: CollectArgs): Promise<ExecResult> {
  let commandStderr = "";
  try {
    commandStderr = await readFile(args.errfile, "utf8");
  } catch {
    commandStderr = "";
  }
  await unlink(args.errfile).catch(() => {});
  await rm(args.dir, { recursive: true, force: true }).catch(() => {});

  const full = mergeOutput(args.stdout, joinStderr(commandStderr, args.sudoStderr));
  const tail = truncateTail(full);
  let output = tail.content;
  let fullOutputPath: string | null = null;

  if (tail.truncated && args.materialize) {
    try {
      const outDir = await mkdtemp(join(tmpdir(), RUN_DIR_PREFIX));
      await chmod(outDir, 0o700);
      const outFile = join(outDir, "output");
      await writeFile(outFile, full, { mode: 0o600, flag: "wx" });
      await chmod(outFile, 0o600);
      fullOutputPath = outFile;
      output = `${output}\n[full output: ${outFile}]\n`;
    } catch {
      output = `${output}\n${FAIL_MESSAGES["output-lost"]}\n`;
    }
  }

  const ok = args.exitCode === 0 && args.signal === null && !args.timedOut && !args.aborted;

  return {
    command: args.command,
    exitCode: args.exitCode,
    signal: args.signal,
    durationMs: Date.now() - args.startedAt,
    output,
    sudoStderr: args.sudoStderr,
    truncated: tail.truncated,
    fullOutputPath,
    promptSeen: args.promptSeen,
    timedOut: args.timedOut,
    aborted: args.aborted,
    warm: args.warm,
    ok,
  };
}

async function runOnce(options: SpawnRunOptions, password: Buffer | undefined): Promise<InternalOutcome> {
  const {
    command,
    cwd,
    timeoutSec = DEFAULT_TIMEOUT_SEC,
    signal,
    onOutput,
    spawnFn = spawn,
    noPromptMs = NO_PROMPT_MS,
    killGraceMs = KILL_GRACE_MS,
  } = options;

  if (signal?.aborted) throw fail("aborted");

  const sudo = resolveSudo();
  const dir = await makeRunDir();
  const errfile = await makeErrfile(dir);
  const nonce = makeNonce();
  const payload = buildPayload(command, errfile);
  const argv =
    password === undefined
      ? ["-n", "-p", nonce, "--", "/bin/sh", "-c", payload]
      : ["-S", "-p", nonce, "--", "/bin/sh", "-c", payload];

  let child: ChildProcess;
  try {
    child = spawnFn(sudo, argv, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
      detached: false,
    });
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw fail("spawn-failed");
  }

  const startedAt = Date.now();
  let stdout = "";
  let sudoStderr = "";
  let wroteOnce = false;
  let promptSeen = false;
  let stdinEnded = false;
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let zeroed = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let promptTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const clearTimers = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (promptTimer !== undefined) clearTimeout(promptTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    timeoutTimer = undefined;
    promptTimer = undefined;
    killTimer = undefined;
  };

  const zeroPassword = (): void => {
    if (zeroed || password === undefined) return;
    zeroed = true;
    password.fill(0);
  };

  const endStdin = (): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    try {
      child.stdin?.end();
    } catch {
      // EPIPE is also swallowed by the stdin error handler.
    }
  };

  const writeSecret = (): void => {
    if (password === undefined) return;
    try {
      child.stdin?.write(password);
    } catch {
      // handled by the stdin error handler
    }
    try {
      child.stdin?.write("\n");
    } catch {
      // handled by the stdin error handler
    }
    endStdin();
  };

  const terminate = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    if (killTimer !== undefined) return;
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, killGraceMs);
    killTimer.unref?.();
  };

  const onAbort = (): void => {
    aborted = true;
    terminate();
  };

  // Attach the stdin error handler before any write can happen.
  child.stdin?.on("error", () => {});
  child.stdin?.once("finish", zeroPassword);
  child.once("close", zeroPassword);

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    stdout += text;
    onOutput?.(text);
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    sudoStderr = (sudoStderr + text).slice(-STDERR_SCAN_BYTES);
    if (password === undefined || wroteOnce || stdinEnded || timedOut || aborted) return;
    if (!sudoStderr.includes(nonce)) return;
    wroteOnce = true;
    promptSeen = true;
    if (promptTimer !== undefined) {
      clearTimeout(promptTimer);
      promptTimer = undefined;
    }
    writeSecret();
  });

  if (signal !== undefined) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, Math.max(1, timeoutSec * 1000));
  timeoutTimer.unref?.();

  if (password === undefined) {
    endStdin();
  } else {
    promptTimer = setTimeout(() => {
      promptTimer = undefined;
      if (wroteOnce) return;
      endStdin();
    }, noPromptMs);
    promptTimer.unref?.();
  }

  return await new Promise<InternalOutcome>((resolve, reject) => {
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      void rm(dir, { recursive: true, force: true })
        .catch(() => {})
        .then(() => reject(fail("spawn-failed")));
    });

    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);

      const needsPassword = password === undefined && PASSWORD_REQUIRED.test(sudoStderr);
      const warm = password === undefined || (!promptSeen && code === 0 && !timedOut && !aborted);

      void collectResult({
        command,
        dir,
        errfile,
        stdout,
        sudoStderr,
        exitCode: code,
        signal: closeSignal,
        startedAt,
        timedOut,
        aborted,
        promptSeen,
        warm,
        materialize: !needsPassword,
      }).then(
        (result) => resolve({ needsPassword, result }),
        (error: unknown) => reject(error),
      );
    });
  });
}
