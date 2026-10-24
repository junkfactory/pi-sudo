# pi-sudo design

Why the extension is shaped this way, what it guarantees, and where it stops. Read [README.md](./README.md) for install and day-to-day behaviour.

## Problem

An agent sometimes needs root for a task: install a package, edit a file under `/etc`, restart a service. The agent has no terminal, so `sudo` in bash fails: with `timestamp_type=tty` there is no tty to prompt on, and with any other setting the prompt would appear in output the model can read.

Three designs were possible:

1. Let the model ask the user to run the command. Safe, but the agent cannot act on the result.
2. Teach the bash tool to intercept `sudo`. Rejected: it hides the escalation inside a general-purpose tool, and the interception has to parse shell syntax it cannot fully see.
3. Add a dedicated tool that owns the whole exchange: show the command, take the password in a masked field, spawn sudo, report the result. This is what shipped.

The constraint that drives everything else: the password must never reach the model. Not in the tool result, the session file, an export, a log, argv, or the environment.

## Architecture

```text
extensions/index.ts     re-exports src/index.ts (pi package entry convention)
src/index.ts            tool definition, bash guard, /sudo-forget, mutex, policy check
src/executor.ts         spawn logic: warm probe, cold run, prompt nonce, timeout, cleanup
src/dialog.ts           approval dialog, escalation dialog, sanitising helpers
src/password-field.ts   Buffer-backed masked input
```

The tool is registered with `exposure: "model-only"` and `executionMode: "sequential"`. Model-only keeps it out of `ALL_TOOLS` for scripts; sequential keeps two approvals from interleaving inside one pi process.

`src/index.ts` never spawns. It validates, checks policy, takes the mutex, drives dialogs, and calls the executor. The executor never touches the UI: it takes a password `Buffer`, a command, and a timeout, and returns a result.

## Password path

The hard part is telling sudo's prompt apart from command output, because the command's stdout and stderr are model-visible.

- **Nonce prompt.** Each run generates a random nonce and passes `-p "[pi-sudo:<hex>] password:"`. The executor writes the password only after that exact line appears on the executor's own stderr pipe, and only once. A forged marker in command output cannot reach that pipe.
- **stderr merge.** The payload is `/bin/sh -c 'exec 2>&1; <command>'`, so the command's own stderr joins its stdout on the model-visible pipe. The executor's stderr pipe therefore carries only sudo's messages, which makes the nonce latch unspoofable by ordinary command output. There is no errfile: an earlier version redirected the command's stderr into a `0600` file inside a `0700` directory and let the root shell open that path, which gave a same-UID process a symlink race against a root-owned open, and left an unbounded file on disk. Merging needs no path and no cleanup; stdout and stderr interleave instead of arriving in two sections.
- **Two writes.** The password buffer goes to stdin first, then `"\n"` as a separate write, then stdin ends. A single write would let sudo consume the newline as part of the password when the buffer is delivered in one chunk.
- **Zeroing.** The buffer is zeroed on stdin `finish` or child `close`, whichever comes first, and deliberately not before close: Node may hand the buffer to libuv without copying.
- **No exit code trust for the prompt.** If the nonce never appears within five seconds, stdin is ended without writing. Zero exit then means the command ran warm; non-zero is a failure. Neither branch writes the password.
- **What is never written.** Not the sudo argv, the environment, the full-output file, tool details, notifications, logs, or the session. Tool details are `command`, `exitCode`, `durationMs`, `attempts`, `warm`, `policyChecked`.

`PasswordField` stores the value in a `Buffer`, renders bullets, and returns a copy from `take()` truncated at the first CR or LF, so a paste with a trailing newline cannot corrupt the password. pi's own `Input` component stores strings, which is why it is not used.

## Ticket model

Sudo owns the ticket. pi-sudo never sets, shortens, or extends it, and never runs `sudo -k` after a run.

- Before the dialog, the real command runs with `sudo -n` as a warm probe. Valid ticket: the command runs, no dialog, `warm: true`. Password required: nothing ran, so the dialog path starts.
- The probe uses the same `/bin/sh -c` payload as the authenticated run, so a command is never executed twice and a command-specific `NOPASSWD` rule cannot be probed with a different command.
- `/sudo-forget` runs `sudo -k` and is the only ticket-clearing path.
- Permission checks and escalation confirmations run on every call, warm or cold.

The consequence is deliberate and documented: after one authenticated run, later calls inside sudo's window run without a password dialog, exactly like a terminal where sudo was already used. A session password cache was rejected: it would keep the secret in the pi process and invent a second lifetime to reason about.

## Escalation gate

Some commands leave lasting root privilege behind: sudoers and PAM edits, account changes, SUID/ACL/capability changes, writes under `/etc` or `/root`. For those, a second dialog runs before the password dialog.

The gate is a separate component rather than `ctx.ui.confirm`, for three reasons: the body needs to be red, `confirm` always preselects Yes, and the decline needs an optional note.

- Options are stacked with Yes preselected, matching pi's confirm.
- The note field lives on the No line and exists only while No is selected. Keystrokes are dropped on Yes, so a note can never ride along with an approval, and the field cannot be filled before the user has actually chosen to decline.
- A decline with text returns `The user added: …` after the standard denial. The note is stripped of control and format characters, collapsed to one line, and capped at 500 characters, because it becomes model input.
- Esc declines without a note; Tab switches options; arrow keys edit the note once No is selected.

The predicate is a heuristic over the command string plus the system-path rule, not a proof. An unusual way to grant lasting privilege can miss it. The password dialog and the policy check remain the real gates.

## Bash guard

`sudo` in the `bash` tool cannot work, so the guard blocks it and points the model at `sudo_exec`. It is a nudge, not a boundary: base64, `sh -c`, spelling tricks, and other extensions' tools all escape it.

Matching is by basename in command position:

- Control characters are normalised to `;` so command boundaries survive tokenising.
- A token is checked only while it can still be the command word: at the start, or after `;`, `&&`, `||`, `|`, `(`, a backtick, or a transparent word.
- Transparent words are wrappers and keywords (`xargs`, `env`, `timeout`, `nice`, `nohup`, `exec`, `command`, `if`, `while`, `do`, …), option flags, `NAME=value` assignments, and bare numbers. So `xargs -0 sudo id`, `timeout 5 sudo id`, and `env FOO=1 sudo id` all block.
- The first ordinary command word closes command position, so the word as an argument is data: `rg 'sudo' file`, a commit message mentioning sudo, and `jj describe -m "… sudo …"` are allowed.
- `=` does not split tokens, so `sudo=foo` cannot match.

An earlier version matched the word anywhere and blocked its own documentation and commit messages. That is why the guard tracks position.

## Permission-system integration

The permission module is optional and resolved on each use. When present, the command string is checked with the `bash` rules, then path-looking tokens are checked against the `path` and `external_directory` surfaces.

- `deny` is reported before the dialog and before any spawn.
- `ask` and `allow` continue: the approval dialog is stricter than an ask prompt, so asking twice would only add friction.
- `policyChecked: false` when the module or its service is unavailable.
- A policy check that throws produces a fixed error and nothing runs.

The tool is deliberately not registered in `shellTools`: that would route its command through bash gating, so rules such as `rm *` would prompt on top of the dialog.

The leading-sudo bash rule (`"sudo *": "deny"`) stays useful: it matches a bash command that starts with sudo, and does not match `sudo_exec`, whose command has no leading sudo.

## Failure handling

Guards run before any spawn: empty command, empty reason, NUL byte, pi running as root, non-TUI mode, missing UI, missing sudo binary, policy deny, mutex held.

Timeouts send SIGTERM, then SIGKILL after a three-second grace period. Signal forwarding to grandchildren is not guaranteed: SIGKILL goes to the sudo process, not necessarily to the command.

A stdin `error` such as EPIPE is handled and cannot throw with the password still live.

Full output that exceeds the model-visible cap is written to a `0600` file inside a `0700` directory, and the model receives the path. If that write fails, the result says the full output was lost.

## Startup temp sweep

On `session_start` the extension removes every `pi-sudo-*` directory under the system temp directory. A run creates no directory of its own; only truncated full output is materialized, and those directories are cleaned up here. There is no age check and no coordination with other pi processes, so a concurrent process can lose an in-progress directory. A pid- or age-based sweep would fix that and is the obvious follow-up.

## Guarantees

- Empty commands, empty reasons, and NUL bytes are rejected before any spawn.
- pi running as root is rejected; sudo would add no privilege.
- Non-TUI modes, or a context without a UI, fail closed before any process is spawned.
- A missing sudo binary produces a fixed error.
- A policy deny is reported before the dialog or any spawn.
- Only one dialog can be open per pi process, keyed on `globalThis` so in-process subagent nodes share it.
- Command output cannot reach the executor's stderr pipe, because the command's stderr is merged into its stdout, so ordinary writes cannot forge the nonce, the password-required line, or the retry text.
- Retained output is capped at 2 MiB; a command past it is terminated and the result says the limit was reached.
- A password already taken from the dialog is zeroed even when the run fails before spawning.
- Both spawns use `LC_ALL=C`, so sudo's detection strings are deterministic.
- A stdin error cannot throw with the password live.
- An abort or timeout sends SIGTERM, then SIGKILL after three seconds.
- Truncated full output goes to a `0600` file in a `0700` directory, and a failed write is reported.
- The only `sudo -k` spawn is in `/sudo-forget`.

## Boundaries

Intentional limits for this version. Read them before relying on the tool.

- **Other extensions can see keystrokes.** `ctx.ui.onTerminalInput` receives raw input before the dialog component, so a malicious extension can read the password as it is typed. This cannot be fixed inside `pi-sudo`.
- **The terminal is shared.** The sudo child is not detached, so it shares pi's controlling terminal and sudo's tty ticket. A root command can print a fake prompt or read `/dev/tty` to phish the user. Merging the command's stderr into its stdout keeps ordinary output off the executor's pipe, but a root command can still reopen that pipe via `/proc/<sudo-pid>/fd/2`; that matters only if the ticket warmed between probe and run, and in that state sudo already runs commands without a dialog.
- **The bash guard is a nudge.** Only the `bash` tool, only command position, only this word list. Extension-provided shell tools and replaced bash tools are outside it.
- **Path checks are heuristic.** Tokens are split on whitespace and shell punctuation and resolved against the working directory, with `~/` against the home directory. Paths inside variables, shell expansions, or a program's own arguments escape them. The dialog remains the gate.
- **Signals may not reach grandchildren.** SIGTERM goes to sudo; sudo normally relays it, but the SIGKILL goes to the sudo process.
- **`NOPASSWD` already gives bash unattended root.** That is a sudoers policy choice; the bash guard cannot prevent it on a host where bash can invoke sudo unattended.
- **Binary-specific `NOPASSWD` rules do not match this payload.** The command is always `/bin/sh -c ...`, so `NOPASSWD: /usr/bin/reboot` does not apply and such commands still prompt.
- **Buffer hygiene is best-effort.** Buffers are zeroed after close and the field is cleared on denial, but Node strings, Buffers, libuv, terminal input, and garbage-collected copies can retain bytes. The code avoids converting the password to a string or logging it; JavaScript cannot guarantee erasure.
- **The tool is TUI-only.** RPC, JSON, and print modes fail closed.
- **The ticket window is high risk by design.** Once a run authenticates, commands run as root without a dialog until sudo's window expires. Policy checks and escalation confirmations still run, and `/sudo-forget` clears it.
- **The temp sweep has no age check.** It now only removes retained full-output directories, since a run creates none of its own. See above.

## Rejected alternatives

- **Session password cache.** Keeps the secret in memory and invents a lifetime beside sudo's. Rejected in favour of sudo's own ticket.
- **`SUDO_ASKPASS` or a FIFO.** Would keep the command's stdin intact and retire the nonce latch, at the cost of a helper process or filesystem object holding the secret. Worth revisiting; the current design needs stdin for the password, so the command's stdin is not its own.
- **`sudo -k` after each run.** Turns every call cold and defeats the point of a warm ticket.
- **`ctx.ui.confirm` for the escalation gate.** No colour, no note, and Yes is forced.
- **Intercepting `sudo` inside the bash tool.** Hides escalation in a general tool and requires parsing shell syntax.
- **Root-side stderr redirection to a file.** Removed after review: the root shell opened a path that a same-UID process could replace with a symlink, and it left an unbounded file on disk. `exec 2>&1` gives the same isolation without a path.
- **Biometric or polkit authenticator.** Not in this version; no `Authenticator` seam exists yet, so adding one means adding the seam first.
