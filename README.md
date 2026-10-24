# pi-sudo

`pi-sudo` adds one model-callable pi tool, `sudo_exec`. The tool shows a masked approval dialog in the terminal, asks for the sudo password there, and then runs the approved command as root itself. The model never receives the password.

## Install

Install the local package path:

```bash
pi install /home/papa/Work/pi/pi-sudo
```

To try the package for one invocation without touching your settings, load it explicitly and skip every other extension:

```bash
pi -ne -e /home/papa/Work/pi/pi-sudo
```

`-ne` is `--no-extensions`, which disables discovered, configured, and built-in extensions; the explicit `-e` path still loads. With the permission system disabled this way, the policy checks report `policyChecked: false` and only the dialog gates the command.

Start a new pi session after installing. The package registers its extension from `./extensions/index.ts`, which re-exports `./src/index.ts`, through the `pi.extensions` entry in `package.json`.

## What the dialog shows

`sudo_exec` takes `command` (required), `reason` (required), and `timeout` in seconds (optional; default 120, clamped to 1-600). The command is trimmed and run through `/bin/sh -c` as root. Do not put `sudo` in front of it.

The approval dialog shows:

- The sanitized command. ANSI/OSC/CSI escapes and control bytes are removed, tabs become spaces, CR and LF become visible `<CR>` and `<LF>` markers, and invisible/format characters become visible `U+XXXX` markers.
- The header `π sudo: approve root command`.
- `Reason:` followed by the model's one-line reason for the request, sanitized like the command and shortened to one display line.
- A masked password field that renders bullets, never the typed text.
- On a retry, sudo's first error line above the field.
- A footer with the available action.

When the wrapped command preview fits in 10 lines, the whole command is visible and Enter approves and runs it. When it is longer, Enter is disabled until the preview has been scrolled to the last line. Use Up/Down, PgUp/PgDn, Home, or End to scroll.

Esc denies the request. Enter with an empty password also denies it. A denial runs nothing and returns an error result that tells the model not to retry the same command and to explain why root was needed.

A wrong password reopens the dialog with sudo's error for up to three attempts. Only sudo's `Sorry, try again.` response is retried; other failures fail immediately. Each attempt passes one password to a fresh `sudo` and then closes stdin, so real sudo's own `passwd_tries` never applies. After the third rejection the result states that nothing was executed and asks the agent to confirm the password with the user instead of retrying blindly.

Commands that match the escalation heuristic get one extra confirmation before the password dialog. The confirmation names the lasting-privilege risk and offers `Yes` (preselected) and `No`, plus an optional note field that is always focused. Declining with a note returns it to the model as `The user added: …` after the standard denial text; the note is stripped of control and format characters, collapsed to one line, and capped at 500 characters. Esc denies without a note. The patterns cover sudoers, PAM, account files and account commands, SUID/ACL/capability changes, destructive file changes, and non-read-only commands carrying paths under `/etc` or `/root`. This is a heuristic, not a security boundary.

## Password path

Each run uses a fresh random prompt nonce of the form `[pi-sudo:<hex>] password:`. Both the warm probe and the authenticated run pass it to sudo with `-p`.

The command's own stderr is redirected away from the pipe that carries sudo's messages. The payload is `/bin/sh -c 'exec 2>"<errfile>"; <command>'`. The errfile is created `0600` inside a private `0700` run directory. After exit, its contents are merged into the model-visible output under a `--- stderr ---` marker, and the run directory is removed. Sudo's own messages therefore remain on the executor's stderr pipe and are the only text used for prompt and retry detection.

On the authenticated run, pi-sudo scans that sudo stderr. It writes the password buffer to sudo's stdin only after the per-run nonce appears, and only once. It then writes the newline as a separate write and ends stdin. If the nonce does not appear within five seconds, stdin is ended without writing anything. That outcome is classified by the exit code: zero is reported as a warm success because the command actually ran; a non-zero exit is a failure.

The password buffer is zeroed on the stdin `finish` event or the child `close` event, whichever happens first. The zeroing is deliberately after close because Node may pass the buffer to libuv without copying. The field is also cleared on denial and after `take()`.

pi-sudo does not write the password to the sudo argv, the environment, the errfile, the full-output file, the tool result details, notifications, logs, or the session. Tool details contain only `command`, `exitCode`, `durationMs`, `attempts`, `warm`, and `policyChecked`.

## Tickets and `/sudo-forget`

Sudo is the single source of truth for ticket reuse. pi-sudo never sets, shortens, or extends the ticket window, and it does not run `sudo -k` after a run.

Before opening the dialog, pi-sudo runs the real command with `sudo -n` as a warm probe. If sudo's ticket is valid, the command runs and no dialog appears. If sudo reports that a password is required, nothing ran, and the dialog path starts. The warm probe uses the same `/bin/sh -c` payload, so a command is never run twice and a command-specific `NOPASSWD` rule cannot be probed with a different command.

After one authenticated run, later `sudo_exec` calls inside sudo's ticket window skip the password dialog, exactly like a terminal that has already run sudo. Permission checks and escalation confirmations still run on every call, including warm calls. The window's length comes from sudoers `timestamp_type` and `timestamp_timeout`.

`/sudo-forget` is a manual command that runs `sudo -k` with the same non-detached stdio and `LC_ALL=C` environment, then reports whether the ticket was cleared. It is the only way this extension clears the ticket.

Only one approval can be open in a pi process at a time. A second concurrent `sudo_exec` call is rejected before any dialog or spawn. The lock is keyed on `globalThis`, so it also covers in-process subagent nodes. It does not coordinate separate pi processes.

## Guarantees

- Empty commands, empty reasons, and inputs containing a NUL byte are rejected before any spawn.
- pi running as root is rejected; sudo would add no privilege.
- Non-TUI modes, or a context without a UI, fail closed before any process is spawned.
- A missing sudo binary produces a fixed error.
- A permission-policy deny is reported before the dialog or any spawn. `ask` and `allow` continue, because the approval dialog is stricter than an ask prompt.
- Only one dialog can be open per pi process.
- Command output cannot reach the executor's stderr pipe, so ordinary command writes cannot forge the nonce, `sudo: a password is required`, or the retry text. A root command can still reopen that pipe through `/proc`; see Boundaries.
- Both spawns use `LC_ALL=C`, so sudo's detection strings are deterministic.
- A stdin error such as EPIPE is handled and cannot throw with the password still live.
- An abort or timeout sends SIGTERM, then SIGKILL after a three-second grace period.
- Full output that is truncated is written to a `0600` file inside a `0700` directory, and the model receives the path. If that write fails, the result says the full output was lost.
- The only `sudo -k` spawn is in `/sudo-forget`.

## Boundaries

These limits are intentional for this version. Read them before relying on the tool.

- Other extensions can see keystrokes. `ctx.ui.onTerminalInput` receives raw terminal input before the dialog component. A malicious extension can read the password as it is typed. This cannot be fixed inside `pi-sudo`.
- The terminal is shared. The sudo child is not detached, so it shares pi's controlling terminal and sudo's tty ticket. A root command can print a fake password prompt or read `/dev/tty` to phish the user. The overlay dialog is the only approval surface this extension controls. Command stderr isolation keeps ordinary output off the executor's pipe, but a root command can reopen that pipe via `/proc/<sudo-pid>/fd/2`; that only matters if sudo's ticket warmed between the probe and the run, and in that state sudo already runs commands without a dialog, so the ticket is not a new capability.
- The bash guard covers only the `bash` tool. It blocks a bash command whose command words include a privilege escalator and points the model to `sudo_exec`. Tokens are split on shell punctuation and compared by basename, so `/usr/bin/sudo`, `xargs sudo`, and `su -c` are blocked while `pi-sudo`, `sudo-exec`, or `catsudo` are not. A bare `grep sudo file` is still blocked, so search for the literal with `grep 'sud[o]'` instead. An extension-provided shell tool, or a replaced bash tool, is outside this guard. Bypasses such as spelling tricks, base64, or input mutation also exist; the guard is a nudge, not a boundary.
- Path checks for root commands are heuristic. pi-sudo checks the command string with the permission service's bash rules, then checks path-looking tokens against the `path` and `external_directory` surfaces. Tokens are split on whitespace and shell punctuation and resolved against the working directory, with `~/` resolved against the home directory. Paths hidden in variables, generated by shell expansion, or buried inside a program's own arguments can escape these checks. The dialog remains the gate.
- Signal forwarding to grandchildren is not guaranteed. SIGTERM goes to sudo. Sudo normally relays it, but after the grace period the SIGKILL goes to the sudo process, not necessarily to the command. A command that ignores SIGTERM, or a grandchild, may survive.
- `NOPASSWD` entries already give bash unattended root. That is a sudoers policy choice outside this extension, and the bash guard cannot prevent it on a host where a bash command can invoke sudo unattended.
- Binary-specific `NOPASSWD` rules do not match this tool's payload. The command is always run as `/bin/sh -c ...`, so a rule such as `NOPASSWD: /usr/bin/reboot` does not match. Such commands still prompt unless a rule permits the `/bin/sh -c` form.
- JavaScript buffer hygiene is best-effort. pi-sudo zeroes its password buffer after close and clears the field on denial, but Node strings, Buffers, libuv, terminal input, and garbage-collected copies can retain bytes. The code avoids converting the password back to a string, logging it, or stringifying it, but JavaScript cannot guarantee memory erasure.
- The tool is TUI-only. RPC, JSON, and print modes fail closed.
- pi running as root is rejected.
- The ticket window is high risk by design. Once one run authenticates, commands can run as root without a password dialog until sudo's own ticket expires. Policy checks and escalation confirmations still run, and `/sudo-forget` clears the ticket, but the reuse window is sudo's to choose.
- The startup sweep has no age check. It removes every `pi-sudo-*` directory under the system temp directory. A concurrent pi process using the same temp directory can lose its in-progress full-output directory.

## Permission-system interaction

Keep the leading-sudo bash rule. For the permission system's configuration, the relevant part is:

```json
{
  "permission": {
    "bash": {
      "sudo *": "deny"
    }
  }
}
```

That rule stops a bash command from starting with `sudo`. It does not match `sudo_exec`, whose command has no leading `sudo`, so the tool itself is still allowed by the existing `"*": "allow"` rule. The tool checks the command through the permission service before prompting, so a denied bash command or path is refused even though the command would run as root.

If you tighten the top-level `"*"` rule to `ask` or `deny`, add `"sudo_exec": "allow"` for this tool. Do not register `sudo_exec` in `shellTools`: that routes its command through bash gating, so rules such as `rm *` would produce a permission prompt in addition to the pi-sudo dialog.

The permission module is optional. pi-sudo looks it up on each use. If the module or its service is unavailable, the policy check is skipped, `policyChecked` is `false`, and the approval dialog remains the gate. A policy check that throws is reported as a fixed error and nothing runs.

## Startup temp sweep

On `session_start`, pi-sudo calls `sweepStaleTemp()`. It scans the system temp directory and removes directories whose names start with `pi-sudo-`. This cleans up crash debris and the retained full-output directories from earlier runs. Per-run errfile directories are already removed at the end of each run; full-output directories are kept until a later sweep. The sweep does not check the age of a directory or whether another pi process is using it.

## Biometric authenticator seam

There is no biometric or polkit authenticator in this version. The password dialog is the only authenticator. The plan described an `Authenticator` interface as a future seam, but the shipped `src/` does not define one, so adding a biometric backend requires adding that seam first.

## Running the tests

From the package directory:

```bash
cd /home/papa/Work/pi/pi-sudo
npm install
npm run check
npm test
```

`npm run check` runs `tsc --noEmit`. `npm test` runs the Node test runner through `jiti` over `test/**/*.test.ts`. The executor tests use an injected fake spawn function, so they do not need sudo or a password. They cover the dialog, password field, executor invariants, bash guard, escalation and path-token predicates, permission policy mapping, the global mutex, and the tool's early-exit behavior.
