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
- **`0</dev/null` in the payload.** The payload is `exec 2>&1 0</dev/null; <command>`, so the command's stdin is `/dev/null` from its first statement: it never inherits sudo's stdin pipe, which with `-S` carries the password. The pipe stays open until the password is written or the run ends, so a slow PAM module (about 30 s for an untouched fingerprint reader, see [PAM latency and biometrics](#pam-latency-and-biometrics)) cannot starve the command or truncate its input.
- **Timeout re-arm.** `armTimeout()` starts at spawn and is re-armed when the nonce prompt appears. `timeoutSec` is therefore also the maximum auth wait: a prompt that arrives before it ends gives the command a fresh full budget (a run that waited 30 s for the reader still gets its whole timeout for the command), while a wait longer than `timeoutSec` ends the run and the password is never written. The default (120 s) is far above any PAM wait; a short `timeout` is a short auth deadline too.
- **Empty buffer means PAM.** A password `Buffer` of length zero is a deliberate route, not a mistake: sudo is spawned with `-S` for any buffer and with `-n` only when the password is `undefined`. An empty buffer ends stdin immediately and the nonce latch never writes, so nothing is typed and PAM authenticates whichever way the stack offers. An empty-buffer run with exit 0 is never reported warm (the next call must still see the dialog), and it never enters the retry loop: success, the `no password was provided` failure, and every other failure each return once.
- **What is never written.** Not the sudo argv, the environment, the full-output file, tool details, notifications, logs, or the session. Tool details are `command`, `exitCode`, `durationMs`, `attempts`, `warm`, `approval`, `policyChecked`. `approval` is `once` or `ticket` for a run that happened, and absent when nothing ran.

`PasswordField` stores the value in a `Buffer`, renders bullets, and returns a copy from `take()` truncated at the first CR or LF, so a paste with a trailing newline cannot corrupt the password. pi's own `Input` component stores strings, which is why it is not used.

## Preview sanitising

What the approver reads must be what runs, so the command and the reason are rendered rather than cleaned: tabs become two spaces, CR and LF become `<CR>` and `<LF>`, and C0, DEL, C1 and format code points become `<U+XXXX>`. Nothing is dropped. An earlier version deleted escape-sequence bodies, which let a command hide a whole shell line from the approver while `/bin/sh` still executed it.

The denial reason goes through the same map, then collapses to a single line and is capped at 500 characters, because it becomes model input.

## Approval versus lifetime

Approval belongs to the extension; lifetime belongs to sudo. pi-sudo never sets, shortens, or extends sudo's ticket. One in-memory boolean per extension instance records a ticket-wide approval, and the flow is:

```text
sudo_exec
  └─ ticket grant held?
       ├─ yes → warm run of the user's command, approval: "ticket"
       │          └─ needsPassword → grant cleared, dialog with the password field
       └─ no  → probeTicket(): sudo -n true
              └─ approval dialog: three options, password row only when the probe found sudo cold
                       ├─ No          → nothing ran; a typed reason reaches the model as "The user added: …"
                       ├─ Yes, once   → warm run (probe warm) or cold run, approval: "once"
                       └─ Yes, until  → same run, grant set, approval: "ticket"
```

The probe runs `true` as root, not the user's command, so a denial genuinely runs nothing. The user's command reaches root only after the dialog returned an approval, or behind a grant the user gave earlier. The probe costs one short-lived root process; it avoids the old behaviour where a valid ticket executed the command before the dialog, which made a denial a lie. `true` only refreshes sudo's own timestamp, which is sudo's business, and it tells the extension exactly what it needs: whether sudo would prompt.

The dialog itself is a centred overlay (80% of the terminal wide, 90% tall, both dialogs use it so the two screens do not jump) drawn as one bordered frame titled `π sudo: Requesting root privilege`: the model's reason, then the sanitized command preview, then three stacked options — `Yes, once` preselected, `Yes, until sudo asks again`, and `No`. `↑/↓` move the selection, `shift+↑/↓` page the preview (PgUp/PgDn, Home, and End too, where the keyboard has them), Enter confirms, and Esc declines silently. A preview taller than the viewport hides the options altogether: the divider stays, a blank row follows it, and the footer says `You must read the full command to make a decision: scroll to the bottom.` above the dim scroll keys. Pressing Enter early turns that line red, and `End` jumps to the last line. The hint wraps rather than being truncated on a narrow terminal, and blank rows hold the options' place, so opening the gate does not resize the frame and the centred overlay does not jump. Only when the last line has been on screen do the options appear and Enter start to work. There is no focus mode: every other key goes to the field the selected row owns, the password on either `Yes` when the probe found sudo cold, and the denial reason on `No`, whose placeholder reads `enter reason for denial (optional)`. The reason hangs off `No` alone for the same reason the escalation note does: a note must never ride along with an approval. A `No` with text returns it as `The user added: …` after the standard denial, sanitized to one line and capped at 500 characters; an empty reason or Esc returns the plain denial. A warm ticket has no password row at all, since sudo would ignore what was typed. Enter with an empty password does not deny: it turns the `Password:` label red and leaves the dialog open, because an empty field is a slip, not a decision — Esc is the only silent denial in that state.

The grant is per extension instance rather than process-global because approval is per session. A new, resumed, or forked session is a different piece of work with a different command history, so it starts without a grant. A process-global boolean would carry one session's approval into the next, and it would leak across subagent nodes that share `globalThis`. The mutex is deliberately global; approval is deliberately not.

The measured window on this machine (sudo 1.9.17p2, `timestamp_type=tty`, `timestamp_timeout=5` minutes): `sudo -v` at 18:58:15, then `sudo -n true` exit 0 at 19:02:17 and exit 0 at 19:04:17, verified 2026-10-25 in one terminal. A warm use restarts the window, so it slides: the ticket option means no prompt until five minutes after the last sudo use, not five minutes after authentication. That is why the label says "until sudo asks again" and names no expiry.

Two boundaries:

- **Ticket mode is revocable only by three events plus `/sudo-forget`.** A warm run that finds sudo demanding a password clears the grant, `/sudo-forget` clears it explicitly, and a session start with reason `new`, `resume`, or `fork` clears it. Nothing else does: `reload` and `startup` keep both the grant and the ticket. Because the window slides, an agent that runs a root command more often than every five minutes never sees another dialog.
- **The session-change `sudo -k` clears pi's record, not your terminal's.** pi spawns sudo with pipes and no controlling terminal (`tty` reports `not a tty`), and `timestamp_type=tty` falls back to the parent process ID when no terminal is present (`man sudoers`). The record is therefore keyed on pi's pid, which a `new`, `resume`, or `fork` session switch does not change — that is exactly why those three run `sudo -k`. Without it, a new session would inherit a warm record. Your shell's tty-keyed record is a different entry and is untouched; a restarted pi starts cold on its own.

A session password cache was rejected: it would keep the secret in the pi process and invent a second lifetime to reason about.

## PAM latency and biometrics

PAM sits between sudo and the password, and it can be slow. On the machine this was measured on (Arch, `pam_fprintd` above `pam_unix` as `auth sufficient`, `timeout=30`, `max-tries=3`), a cold run whose reader is not touched costs about 30 s once: the verify times out and `pam_unix` asks, and the typed password is used as before. `max-tries` counts wrong-finger matches only, not timeouts. pi-sudo never reads PAM configuration and never spawns a probe such as `fprintd-list`; the only evidence is what the run itself shows.

- **What counts as a biometric delay.** `SLOW_AUTH_MS = 5000`, and `FINGERPRINT_MARKERS` is `/Verification timed out|Failed to match fingerprint/`. `ExecResult.authEvidence` is set when the delay from spawn to sudo's nonce prompt reaches `SLOW_AUTH_MS`, or when a marker appears in the stdout snapshot taken at the instant the prompt appears (`ExecResult.authMarker` records the marker alone). The snapshot cannot be faked: at that moment the command does not exist, so it has produced no output to forge the marker with.
- **A run that never prompts is also evidence.** On a cold run the probe has just proved that sudo wants a password, so a run with `promptSeen === false`, no timeout or abort, no signal, and no `sudo: …` line of its own authenticated through some other PAM module — Touch ID (`pam_tid` prints no marker, and it is touched immediately) or a smartcard. The command's exit code does not matter: a failed command after a successful touch still proves the module is there. A sudo that failed before authenticating prints `sudo: …` and is excluded, so a policy or PAM-config error teaches nothing. macOS therefore needs no special case, and the reader is recorded on the very first cold run that uses it.
- **Lifetimes.** `readerLearned` and `readerRejected` are module-level and in memory only; both die with the pi process or an extension reload, and nothing is persisted. `readerLearned` is set by `authEvidence` on a cold password run and by a successful empty-password run; it survives session switches, because the machine did not change. `readerRejected` is set when an empty-password run fails and sudo's stderr contains `no password was provided`; that call returns the fixed fingerprint-failure text and nothing ran. It is cleared by `session_start` with reason `new`, `resume`, or `fork` — a rejection is transient, and the empty answer may have been a slip or a cancelled touch — and by a later cold password run that shows a fingerprint marker or authenticates without a prompt. A delay alone does not clear it: a slow non-biometric PAM (LDAP/SSSD) would otherwise re-offer the reader, fail the empty run, and loop. The hint therefore returns after a session change, after a restart, or as soon as the reader answers again.
- **The empty-Enter rule.** With the fingerprint hint shown, Enter on an empty password approves a PAM-only run and stays out of the retry loop (the empty-buffer bullet above). Without the hint, the older rule stands: the `Password:` label turns red and the dialog waits, so a stray Enter cannot throw away the request.
- **The hint matrix.** `showReader = !warm && readerLearned && !readerRejected && errorText === undefined`. No hint on a warm run (sudo would ignore what was offered), before the first run that learned the reader, after a rejected reader until the session changes, and when reopening with sudo's error after a wrong password — there sudo waits for the typed password, not the reader. The hint row is reserved as blank space while the command preview has not been scrolled to the end, so opening the hint does not resize the frame. Every wrapped block in the gate (the gate hint and the reader hint) is capped at the options' height, so a narrow terminal cannot make the closed gate taller than the open one.
- **The wait note.** After three seconds of a cold run without command output, a status line goes to the streaming update only, never into the model-facing result. Its wording follows the record: `waiting for sudo authentication` before the reader is learned (a cold run promises nothing extra), and `waiting for sudo authentication: touch the fingerprint reader, or wait for the password prompt` once it is. `authWaitText(showReader)` is the single place that chooses.

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

A wrong password is retried only when sudo printed its `Sorry, try again.` line, up to three attempts; every other failure ends the call. After the third rejection the result tells the model not to retry blindly and to confirm the password with the user.

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
- The only `sudo -k` spawns are `/sudo-forget` and `session_start` with reason `new`, `resume`, or `fork`.
- The user's command runs only after the dialog returned an approval, or behind a ticket-wide approval from earlier; the pre-dialog probe runs `true`, not the command.

## Boundaries

Intentional limits for this version. Read them before relying on the tool.

- **Other extensions can see keystrokes.** `ctx.ui.onTerminalInput` receives raw input before the dialog component, so a malicious extension can read the password as it is typed. This cannot be fixed inside `pi-sudo`.
- **A root command can impersonate a prompt.** The sudo child is spawned with pipes and, as measured, no controlling terminal, so it cannot read `/dev/tty` or the terminal's keystrokes. It can still print text that looks like a prompt into the live output stream, and it can reopen the executor's stderr pipe via `/proc/<sudo-pid>/fd/2`. Forging that pipe matters only if the ticket went cold between probe and run; in that state sudo itself is prompting and the user's command has not started.
- **The bash guard is a nudge.** Only the `bash` tool, only command position, only this word list. Extension-provided shell tools and replaced bash tools are outside it.
- **Path checks are heuristic.** Tokens are split on whitespace and shell punctuation and resolved against the working directory, with `~/` against the home directory. Paths inside variables, shell expansions, or a program's own arguments escape them. The dialog remains the gate.
- **Signals may not reach grandchildren.** SIGTERM goes to sudo; sudo normally relays it, but the SIGKILL goes to the sudo process.
- **`NOPASSWD` already gives bash unattended root.** That is a sudoers policy choice; the bash guard cannot prevent it on a host where bash can invoke sudo unattended.
- **Binary-specific `NOPASSWD` rules do not match this payload.** The command is always `/bin/sh -c ...`, so `NOPASSWD: /usr/bin/reboot` does not apply and such commands still prompt.
- **Buffer hygiene is best-effort.** Buffers are zeroed after close and the field is cleared on denial, but Node strings, Buffers, libuv, terminal input, and garbage-collected copies can retain bytes. The code avoids converting the password to a string or logging it; JavaScript cannot guarantee erasure.
- **The tool is TUI-only.** RPC, JSON, and print modes fail closed.
- **Ticket-wide approval is high risk by design.** After `Yes, until sudo asks again`, commands run as root without a dialog until sudo asks again, which on this machine is five minutes after the last sudo use. A denial is still a real denial: the probe runs `true`, so nothing of the user's command executes before the dialog. Policy checks and escalation confirmations still run, and `/sudo-forget` clears both the grant and the ticket.
- **The temp sweep has no age check.** It now only removes retained full-output directories, since a run creates none of its own. See above.

## Rejected alternatives

- **Session password cache.** Keeps the secret in memory and invents a lifetime beside sudo's. Rejected in favour of sudo's own ticket.
- **`SUDO_ASKPASS` or a FIFO.** Would keep the command's stdin intact and retire the nonce latch, at the cost of a helper process or filesystem object holding the secret. Worth revisiting; the current design needs stdin for the password, so the command's stdin is not its own.
- **`sudo -k` after each run.** Turns every call cold and defeats the point of a warm ticket.
- **`ctx.ui.confirm` for the escalation gate.** No colour, no note, and Yes is forced.
- **Intercepting `sudo` inside the bash tool.** Hides escalation in a general tool and requires parsing shell syntax.
- **Root-side stderr redirection to a file.** Removed after review: the root shell opened a path that a same-UID process could replace with a symlink, and it left an unbounded file on disk. `exec 2>&1` gives the same isolation without a path.
- **Biometric or polkit authenticator.** Reading `/etc/pam.d` or spawning `fprintd-list` would leak configuration details into the model and add a subprocess whose output the model must never see. Rejected: the run itself is the only witness, via `authEvidence` (see [PAM latency and biometrics](#pam-latency-and-biometrics)); a stack pi-sudo has not seen simply costs one cold run without the hint.
