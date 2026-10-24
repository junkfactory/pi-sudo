import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { askApproval, askEscalationConfirm } from "./dialog.js";
import {
  forgetTicket,
  runCold,
  runWarm,
  sweepStaleTemp,
  type ExecResult,
  type SpawnFn,
} from "./executor.js";

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
const MAX_ATTEMPTS = 3;
const PERMISSION_MODULE = "@gotgenes/pi-permission-system";
const MUTEX_KEY = Symbol.for("pi-sudo:mutex");

const DENIAL_TEXT =
  "The user denied this sudo request; nothing ran. Do not retry the same command. Explain to the user why root was needed and propose a safer non-privileged alternative if one exists.";
const MUTEX_BUSY_TEXT =
  "Another sudo approval is already open in this pi process; nothing ran. Wait for it to finish, then retry.";
const POLICY_ERROR_TEXT = "The permission policy could not be checked; nothing ran.";
const ATTEMPTS_TEXT =
  "sudo rejected the password 3 times; the command was not executed and nothing else ran. Do not retry this call blindly: confirm with the user that they entered the right password and that the account can use sudo, then try again if needed.";

const SUDO_GUARD_REASON =
  "`sudo` needs an interactive password prompt, which bash cannot provide here. Use the sudo_exec tool with the command itself (no leading sudo).";

const ESCALATOR_WORDS = new Set([
  "sudo",
  "sudoedit",
  "pkexec",
  "doas",
  "run0",
  "runuser",
  "su",
  "systemd-run",
  "nsenter",
]);

/**
 * Words that keep the following token in command position: wrappers, shell
 * keywords, and option/assignment syntax. A wrapped escalator is still a
 * command, so `xargs sudo`, `timeout 5 sudo`, and `env FOO=1 sudo` match.
 */
const TRANSPARENT_WORDS = new Set([
  "xargs",
  "env",
  "timeout",
  "nice",
  "nohup",
  "exec",
  "stdbuf",
  "setsid",
  "command",
  "builtin",
  "time",
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "{",
  "}",
  "$",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NUMBER = /^\d+[A-Za-z]*$/;

const READ_ONLY_COMMAND =
  /^\s*(?:cat|bat|ls|grep|rg|find|less|more|head|tail|stat|file|diff|wc|tree|sha\d+sum|md5sum|realpath|readlink|getfacl|lsattr|systemctl\s+status|journalctl|id|whoami)\b/;

const ESCALATION_PATTERNS: readonly RegExp[] = [
  /\bsudoers\b/,
  /\bpam\.d\b/,
  /\/etc\/(?:passwd|shadow|group|gshadow)\b/,
  /\bvisudo\b/,
  /\b(?:passwd|useradd|usermod|userdel|groupadd|groupdel|gpasswd|chage)\b/,
  /\bchmod\b[^;&|]*(?:\+s|\bu\+s\b|\b4[0-7]{3}\b)/,
  /\b(?:chown|setfacl|setcap|chattr)\b/,
  /\bdd\b[^;&|]*\bof=/,
  /\b(?:truncate|shred)\b/,
  /\bsed\b[^;&|]*\s-i/,
  /\b(?:tee|cp|mv|install)\b[^;&|]*\/etc\b/,
  /(?:^|[^0-9])>{1,2}\s*\/etc\b/,
];

const SYSTEM_PATH = /\/etc\b|\/root\b/;

export interface SudoExecDetails {
  command: string;
  exitCode: number | null;
  durationMs: number;
  attempts: number;
  warm: boolean;
  policyChecked: boolean;
}

interface PermissionCheckResult {
  state: "allow" | "ask" | "deny";
}

export interface PermissionsService {
  checkPermission(surface: string, value?: string): PermissionCheckResult;
}

interface PermissionsModule {
  getPermissionsService(sessionId: string): PermissionsService | undefined;
}

interface MutexSlot {
  busy: boolean;
}

type PolicyOutcome =
  | { kind: "continue"; checked: boolean }
  | { kind: "deny"; surface: string };

/**
 * Bash commands that would run a privilege escalator are blocked. Tokens are
 * compared by basename in command position only, so `/usr/bin/sudo`,
 * `xargs sudo`, and `a && sudo` match while `pi-sudo`, `rg 'sudo' file`, or a
 * commit message that mentions the word do not.
 */
export function needsSudoApproval(command: string): boolean {
  let commandPosition = true;
  for (const raw of command.replace(/[;&|()`\n]+/g, " ; ").split(/[\s<>'"{}]+/)) {
    if (raw === "" || raw === ";") {
      commandPosition = true;
      continue;
    }
    if (!commandPosition) continue;
    const token = raw.replace(/^.*\//, "");
    if (ESCALATOR_WORDS.has(token)) return true;
    if (
      TRANSPARENT_WORDS.has(token) ||
      token.startsWith("-") ||
      ASSIGNMENT.test(token) ||
      NUMBER.test(token)
    ) {
      continue;
    }
    commandPosition = false;
  }
  return false;
}

/** Heuristic: the command can leave lasting root privilege behind. */
export function isEscalation(command: string): boolean {
  if (ESCALATION_PATTERNS.some((pattern) => pattern.test(command))) return true;
  return SYSTEM_PATH.test(command) && !READ_ONLY_COMMAND.test(command);
}

/**
 * Path-looking tokens, resolved against `cwd` (and the home directory for
 * `~/`), for the permission service's path and external_directory gates.
 */
export function pathTokens(command: string, cwd: string): string[] {
  const found = new Set<string>();
  for (const raw of command.split(/[\s;&|<>()`]+/)) {
    const token = raw.replace(/^['"]+|['"]+$/g, "");
    if (token.length === 0) continue;
    const candidate =
      token.startsWith("~/") ||
      token.startsWith("/") ||
      token.includes("/") ||
      /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(token);
    if (!candidate) continue;
    if (token.startsWith("~/")) {
      found.add(resolve(homedir(), token.slice(2)));
    } else {
      found.add(resolve(cwd, token));
    }
  }
  return [...found];
}

function acquireMutex(): (() => void) | undefined {
  const store = globalThis as unknown as Record<symbol, MutexSlot | undefined>;
  const state = store[MUTEX_KEY] ?? { busy: false };
  store[MUTEX_KEY] = state;
  if (state.busy) return undefined;
  state.busy = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.busy = false;
  };
}

function textResult(
  text: string,
  isError: boolean,
  details: SudoExecDetails,
): AgentToolResult<SudoExecDetails> {
  return { content: [{ type: "text", text }], details, isError };
}

function execResult(
  result: ExecResult,
  attempts: number,
  policyChecked: boolean,
): AgentToolResult<SudoExecDetails> {
  const exit = result.exitCode === null ? "none (killed)" : String(result.exitCode);
  const header = `$ ${result.command}\nexit code: ${exit}`;
  const text =
    result.output.length === 0
      ? header
      : `${header}\n\n${result.output.replace(/\n+$/, "")}`;
  return {
    content: [{ type: "text", text }],
    details: {
      command: result.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      attempts,
      warm: result.warm,
      policyChecked,
    },
    isError: !result.ok,
  };
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(1, value));
}

function firstStderrLine(stderr: string): string | undefined {
  const line = stderr.trim().split("\n")[0]?.trim();
  return line === undefined || line.length === 0 ? undefined : line;
}

function denyText(surface: string): string {
  return `The permission policy denied this request (surface: ${surface}); nothing ran.`;
}

/**
 * The mutex is a process-global slot so two extension instances (in-process
 * subagent nodes) cannot open overlapping dialogs.
 */
async function checkPolicy(
  command: string,
  cwd: string,
  ctx: ExtensionContext,
  cachedSessionId: string | undefined,
): Promise<{ outcome: PolicyOutcome; sessionId: string | undefined }> {
  const sessionId = ctx.sessionManager.getSessionId() || cachedSessionId;
  if (sessionId === undefined || sessionId.length === 0) {
    return { outcome: { kind: "continue", checked: false }, sessionId: undefined };
  }
  let service: PermissionsService | undefined;
  if (permissionServiceImpl !== undefined) {
    service = permissionServiceImpl(sessionId);
  } else {
    try {
      const module = (await import(PERMISSION_MODULE)) as PermissionsModule;
      service = module.getPermissionsService(sessionId);
    } catch {
      return { outcome: { kind: "continue", checked: false }, sessionId };
    }
  }
  if (service === undefined) {
    return { outcome: { kind: "continue", checked: false }, sessionId };
  }

  const bash = service.checkPermission("bash", command);
  if (bash.state === "deny") {
    return { outcome: { kind: "deny", surface: "bash" }, sessionId };
  }
  for (const token of pathTokens(command, cwd)) {
    for (const surface of ["path", "external_directory"] as const) {
      if (service.checkPermission(surface, token).state === "deny") {
        return { outcome: { kind: "deny", surface }, sessionId };
      }
    }
  }
  return { outcome: { kind: "continue", checked: true }, sessionId };
}

const parameters = Type.Object({
  command: Type.String({
    description:
      "shell command to run as root, without a leading sudo; runs via /bin/sh -c",
  }),
  reason: Type.String({
    description: "one short sentence for the user: why this needs root",
  }),
  timeout: Type.Optional(
    Type.Number({
      description: `timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, maximum ${MAX_TIMEOUT_SEC})`,
    }),
  ),
});

let spawnImpl: SpawnFn = spawn;
let permissionServiceImpl:
  | ((sessionId: string) => PermissionsService | undefined)
  | undefined;

/** Test seam: replace the spawn implementation (production uses node:child_process). */
export function setSudoSpawnFn(fn: SpawnFn | undefined): void {
  spawnImpl = fn ?? spawn;
}

/** Test seam: replace the permission-service lookup (production imports the optional module). */
export function setPermissionServiceFn(
  fn: ((sessionId: string) => PermissionsService | undefined) | undefined,
): void {
  permissionServiceImpl = fn;
}

export default function (pi: ExtensionAPI) {
  let cachedSessionId: string | undefined;

  pi.events.on("permissions:ready", (data) => {
    const id = (data as { sessionId?: unknown }).sessionId;
    if (typeof id === "string" && id.length > 0) cachedSessionId = id;
  });

  pi.on("session_start", async () => {
    await sweepStaleTemp().catch(() => {});
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input.command;
    if (typeof command !== "string" || !needsSudoApproval(command)) return undefined;
    return { block: true, reason: SUDO_GUARD_REASON };
  });

  pi.registerCommand("sudo-forget", {
    description:
      "Clear sudo's cached ticket (runs sudo -k) so the next sudo_exec prompts again",
    handler: async (_args, ctx) => {
      try {
        const outcome = await forgetTicket(spawnImpl);
        if (outcome.ok) {
          ctx.ui.notify("sudo ticket cleared; the next sudo_exec will prompt.", "info");
        } else {
          ctx.ui.notify(
            `sudo -k exited with code ${outcome.exitCode ?? "none"}; the ticket may still be cached.`,
            "warning",
          );
        }
      } catch {
        ctx.ui.notify("Could not clear the sudo ticket.", "error");
      }
    },
  });

  pi.registerTool({
    name: "sudo_exec",
    label: "sudo",
    description:
      "Run a shell command as root after the user approves it in a masked sudo dialog. The command runs via /bin/sh -c and must not start with sudo.",
    promptSnippet:
      "Run a command as root after the user approves it in a masked sudo dialog",
    promptGuidelines: [
      "Use sudo_exec for privileged work: it asks the user, then runs the command as root. Never put sudo, pkexec, run0 or su inside a bash command: bash has no terminal here, so they cannot prompt for a password.",
      "The command passed to sudo_exec already runs as root. Do not prefix it with sudo.",
      "Never ask the user to type a password in chat, and never put a password in any command or file.",
      "Write a short, honest reason: it is shown in the approval dialog.",
    ],
    parameters,
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { destructiveHint: true, openWorldHint: true },
    async execute(
      _toolCallId: string,
      params,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<SudoExecDetails> | undefined,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<SudoExecDetails>> {
      const startedAt = Date.now();
      const command = params.command.trim();
      const reason = params.reason.trim();
      const timeoutSec = normalizeTimeout(params.timeout);

      const details = (patch: Partial<SudoExecDetails> = {}): SudoExecDetails => ({
        command,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        attempts: 0,
        warm: false,
        policyChecked: false,
        ...patch,
      });

      if (command.length === 0) {
        return textResult("sudo_exec needs a command; nothing ran.", true, details());
      }
      if (reason.length === 0) {
        return textResult("sudo_exec needs a reason for the user; nothing ran.", true, details());
      }
      if (command.includes("\0") || reason.includes("\0")) {
        return textResult("sudo_exec rejected a NUL byte in its input; nothing ran.", true, details());
      }
      if (process.getuid?.() === 0) {
        return textResult(
          "pi is already running as root; sudo_exec would add no privilege. Run the command directly instead.",
          true,
          details(),
        );
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        return textResult(
          "sudo_exec needs the interactive TUI approval dialog, which is unavailable in this mode; nothing ran.",
          true,
          details(),
        );
      }

      let policy: PolicyOutcome;
      try {
        const checked = await checkPolicy(command, ctx.cwd, ctx, cachedSessionId);
        cachedSessionId = checked.sessionId;
        policy = checked.outcome;
      } catch {
        return textResult(POLICY_ERROR_TEXT, true, details());
      }
      if (policy.kind === "deny") {
        return textResult(denyText(policy.surface), true, details());
      }
      const policyChecked = policy.checked;

      const release = acquireMutex();
      if (release === undefined) {
        return textResult(MUTEX_BUSY_TEXT, true, details({ policyChecked }));
      }

      // Live command stdout. Throttled so a chatty root command cannot flood the TUI.
      let partial = "";
      let lastEmit = 0;
      const streamOutput = (chunk: string): void => {
        partial += chunk;
        if (partial.length > 8000) partial = partial.slice(-8000);
        if (onUpdate === undefined) return;
        const now = Date.now();
        if (now - lastEmit < 100) return;
        lastEmit = now;
        onUpdate({
          content: [{ type: "text", text: `$ ${command}\n\n${partial}` }],
          details: details({ attempts: 1, policyChecked }),
        });
      };

      try {
        if (isEscalation(command)) {
          const escalation = await askEscalationConfirm(ctx);
          if (!escalation.approved) {
            const note =
              escalation.note.length > 0
                ? `\n\nThe user added: ${escalation.note}`
                : "";
            return textResult(
              `${DENIAL_TEXT}${note}`,
              true,
              details({ attempts: 0, policyChecked }),
            );
          }
        }

        const warm = await runWarm({
          command,
          cwd: ctx.cwd,
          timeoutSec,
          signal,
          spawnFn: spawnImpl,
          onOutput: streamOutput,
        });
        if ("ran" in warm) {
          return execResult(warm.result, 0, policyChecked);
        }

        let attempts = 0;
        let lastError: string | undefined;
        while (attempts < MAX_ATTEMPTS) {
          const password = await askApproval(ctx, command, reason, lastError);
          if (password === undefined) {
            return textResult(
              DENIAL_TEXT,
              true,
              details({ attempts, policyChecked }),
            );
          }
          attempts += 1;
          const outcome = await runCold({
            command,
            cwd: ctx.cwd,
            password,
            timeoutSec,
            signal,
            spawnFn: spawnImpl,
            onOutput: streamOutput,
          });
          if (outcome.status === "ran") {
            return execResult(outcome.result, attempts, policyChecked);
          }
          lastError = firstStderrLine(outcome.result.sudoStderr);
        }
        return textResult(
          ATTEMPTS_TEXT,
          true,
          details({ attempts, policyChecked }),
        );
      } catch (error) {
        const message =
          error instanceof Error && error.message.length > 0
            ? error.message
            : "sudo_exec failed; nothing ran.";
        return textResult(message, true, details({ policyChecked }));
      } finally {
        release();
      }
    },
  });
}
