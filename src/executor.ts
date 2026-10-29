import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";

const RUN_DIR_PREFIX = "pi-sudo-";
const DEFAULT_TIMEOUT_SEC = 120;
const KILL_GRACE_MS = 3000;
const STDERR_SCAN_BYTES = 64 * 1024;
/** Retained command output; a command past this is terminated rather than buffered. */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const CAPTURE_LIMIT_NOTE = "\n[output limit reached; the command was terminated]\n";
const PASSWORD_REQUIRED = /^sudo: a password is required$/m;
const RETRY_MESSAGE = "Sorry, try again.";
const SLOW_AUTH_MS = 5000;
const FINGERPRINT_MARKERS = /Verification timed out|Failed to match fingerprint/;

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type FailCode = "sudo-missing" | "spawn-failed" | "temp-dir-failed" | "output-lost" | "aborted";

const FAIL_MESSAGES: Readonly<Record<FailCode, string>> = {
  "sudo-missing": "sudo was not found at /usr/bin/sudo; pi-sudo cannot run privileged commands.",
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
  /** Test seam; production default is 3000 ms. */
  killGraceMs?: number;
  /** Test seam; production default is 5000 ms. */
  slowAuthMs?: number;
}

export interface RunColdOptions extends SpawnRunOptions {
  /** An empty buffer means no password; PAM authenticates (the fingerprint reader). */
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
  /** ms from spawn to sudo's password prompt; null when it never appeared. */
  promptDelayMs: number | null;
  /** The run itself showed evidence that a biometric module held PAM up. */
  authEvidence: boolean;
  /** A fingerprint module's own message appeared before sudo's prompt. */
  authMarker: boolean;
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

/**
 * The only sudo pi-sudo will run. PATH is deliberately not consulted: the
 * process that receives the password must be a known absolute path, never a
 * name an attacker can shadow.
 */
export function resolveSudo(): string {
  const fixed = "/usr/bin/sudo";
  if (!existsSync(fixed)) throw fail("sudo-missing");
  return fixed;
}

/** Run a command without a password. Returns `needsPassword` when sudo wants one. */
export async function runWarm(options: SpawnRunOptions): Promise<WarmOutcome> {
  const outcome = await runOnce(options, undefined);
  if (outcome.needsPassword) return { needsPassword: true };
  return { ran: true, result: outcome.result };
}

/**
 * Learn whether sudo will prompt without running the user's command. `true`
 * as root prints nothing and only refreshes sudo's own timestamp, which is
 * sudo's business. Returns true when sudo would run without a password.
 */
export async function probeTicket(
  options: Omit<SpawnRunOptions, "command">,
): Promise<boolean> {
  const outcome = await runWarm({ ...options, command: "true" });
  return "ran" in outcome;
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

/**
 * The command's own stderr is merged into its stdout, so the stderr pipe carries
 * only sudo's messages. That keeps the nonce latch unspoofable without giving
 * root a pathname to reopen: no errfile, no symlink race. The command must
 * never inherit sudo's stdin pipe: with -S it carries the password.
 */
function buildPayload(command: string): string {
  return `exec 2>&1 0</dev/null; ${command}`;
}

interface CollectArgs {
  command: string;
  stdout: string;
  sudoStderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  timedOut: boolean;
  aborted: boolean;
  promptDelayMs: number | null;
  authEvidence: boolean;
  authMarker: boolean;
  promptSeen: boolean;
  warm: boolean;
  materialize: boolean;
}

async function collectResult(args: CollectArgs): Promise<ExecResult> {
  const full = args.stdout.length === 0 ? args.sudoStderr : args.stdout + args.sudoStderr;
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
    promptDelayMs: args.promptDelayMs,
    authEvidence: args.authEvidence,
    authMarker: args.authMarker,
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
    killGraceMs = KILL_GRACE_MS,
    slowAuthMs = SLOW_AUTH_MS,
  } = options;

  // An empty password is the fingerprint route: `-S` still applies (PAM asks
  // the reader), but sudo's password prompt must never be answered with text.
  const passwordOnly = password !== undefined && password.length > 0;

  const nonce = makeNonce();
  let child: ChildProcess;
  try {
    if (signal?.aborted) throw fail("aborted");
    const sudo = resolveSudo();
    const payload = buildPayload(command);
    const argv =
      password === undefined
        ? ["-n", "-p", nonce, "--", "/bin/sh", "-c", payload]
        : ["-S", "-p", nonce, "--", "/bin/sh", "-c", payload];
    child = spawnFn(sudo, argv, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
      detached: false,
    });
  } catch (error) {
    // The password was already taken from the dialog, so nothing else can clear it.
    password?.fill(0);
    if (error instanceof SudoError) throw error;
    throw fail("spawn-failed");
  }

  const startedAt = Date.now();
  let stdout = "";
  let captureCapped = false;
  let sudoStderr = "";
  let wroteOnce = false;
  let promptSeen = false;
  let promptDelayMs: number | null = null;
  let authStdout = "";
  let stdinEnded = false;
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let zeroed = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const clearTimers = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    timeoutTimer = undefined;
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

  // Authentication is not command time: give the command its full budget.
  const armTimeout = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1, timeoutSec * 1000));
    timeoutTimer.unref?.();
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
    if (captureCapped) return;
    const text = chunk.toString();
    if (stdout.length + text.length > MAX_CAPTURE_BYTES) {
      captureCapped = true;
      stdout = stdout.slice(0, MAX_CAPTURE_BYTES) + CAPTURE_LIMIT_NOTE;
      onOutput?.(CAPTURE_LIMIT_NOTE);
      terminate();
      return;
    }
    stdout += text;
    onOutput?.(text);
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    sudoStderr = (sudoStderr + text).slice(-STDERR_SCAN_BYTES);
    if (!passwordOnly || wroteOnce || stdinEnded || timedOut || aborted) return;
    if (!sudoStderr.includes(nonce)) return;
    wroteOnce = true;
    promptSeen = true;
    // The snapshot is taken before the command exists, so command output cannot fake it.
    promptDelayMs = Date.now() - startedAt;
    authStdout = stdout;
    armTimeout();
    writeSecret();
  });

  if (signal !== undefined) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  armTimeout();

  if (password === undefined || password.length === 0) {
    endStdin();
  }

  return await new Promise<InternalOutcome>((resolve, reject) => {
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      zeroPassword();
      reject(fail("spawn-failed"));
    });

    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", onAbort);

      const needsPassword = password === undefined && PASSWORD_REQUIRED.test(sudoStderr);
      // A fingerprint run authenticated the user, but ran cold: it must never
      // be reported warm, or the next call would skip the reader entirely.
      const warm =
        password === undefined ||
        (passwordOnly && !promptSeen && code === 0 && !timedOut && !aborted);

      const authMarker = FINGERPRINT_MARKERS.test(authStdout);
      void collectResult({
        command,
        stdout,
        sudoStderr,
        exitCode: code,
        signal: closeSignal,
        startedAt,
        timedOut,
        aborted,
        promptDelayMs,
        authEvidence: (promptDelayMs ?? 0) >= slowAuthMs || authMarker,
        authMarker,
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
