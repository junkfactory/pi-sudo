---
repo: pi-sudo
objective: Make sudo_exec honour the typed password on fingerprint sudo machines, and let an empty password mean fingerprint-only authentication
slug: fingerprint-sudo-auth
status: active
created: 2026-10-29
---

# Fingerprint sudo: honour the password, offer the reader

## Goal

On a machine whose PAM stack tries a fingerprint first, `sudo_exec` runs the
approved command: a typed password is used when PAM asks for it, and an empty
password approves a run that authenticates with the reader alone.

## Non-goals

- Reading any file outside the workspace, or spawning any probe program. No
  `/etc/pam.d`, no `/etc/sudo.conf`, no `fprintd-list`. Evidence comes only from
  the sudo run itself.
- Changing `/etc/pam.d` or sudoers as part of pi-sudo. The optional root-side
  tweak is documentation only.
- New `Authenticator` seam, askpass helper, FIFO, PTY, D-Bus client.
- Touch-only approval without a dialog, NOPASSWD handling, polkit.
- Persisting what a run learns: it lives in the pi process.

## Decisions

Resolved with the user on 2026-10-29:

1. Learn from the run, not from a probe. The first cold run that waits for a
   reader teaches the process; the next cold approval offers the hint and the
   empty-password route. The record resets when pi exits.
2. Re-arm the command timeout when sudo's password prompt appears, so PAM time
   is not charged to the command.
3. The root-side fingerprint tweak is documented, never applied by pi-sudo.
4. Plan saved here; `package.json` goes 0.3.0 → 0.4.0; independent review with
   `gpt-6-luna`/high is approved (cost gate waived by the user).

## Background / Grounding

Observed on this machine during planning (with the user's permission; nothing is
read at runtime):

- `/etc/pam.d/sudo` runs `auth sufficient pam_fprintd.so`, then
  `auth include system-auth` (ending in `pam_unix.so`). The password prompt
  therefore appears only after `pam_fprintd` gives up.
- `pam_fprintd` defaults here: `timeout=30`, `max-tries=3` (`man pam_fprintd`).
  A timed-out verify returns `PAM_AUTHINFO_UNAVAIL` at once and does not consume
  a try (`pam_fprintd.c:632-634`), so an untouched reader costs **30 s**, once,
  before `pam_unix`. `max-tries` only counts wrong-finger matches, each of which
  returns as soon as the finger is read.
- The module is skipped immediately (no wait) when the session is remote, the
  device is absent, no prints are enrolled, or `Claim` fails because another
  client holds the sensor (`pam_fprintd.c:205,823`).
- `pam_fprintd` prints nothing before a touch. On give-up it sends
  `Verification timed out`; a mismatched finger sends
  `Failed to match fingerprint`. PAM info/error text reaches sudo's **stdout**
  (`SUDO_CONV_INFO_MSG`, `fp = stdout`), and `LC_ALL=C` (`src/executor.ts:150`,
  `:291`) makes both strings English. A successful touch sends a
  driver-specific message and then no prompt at all.

Sudo behaviour (sudo 1.9.17p2 source, fetched from the sudo project):

- With `-S`, `tgetpass()` reads stdin and writes the prompt to stderr.
- `tgetpass` prints `no password was provided` on EOF (`src/tgetpass.c:93`).
- `-n` fails before PAM runs (`check.c`, noninteractive branch), so the probe can
  never authenticate with a fingerprint.
- `SUDO_ASKPASS` is unset and `/etc/sudo.conf` has no askpass, so PAM-only mode
  fails cleanly at `pam_unix` instead of opening a GUI helper.

pi-sudo facts:

- `NO_PROMPT_MS = 5000` (`src/executor.ts:12`) ends sudo's stdin 5 s after spawn
  (`src/executor.ts:425-430`); the prompt handler then refuses to write because
  `stdinEnded` is set (`src/executor.ts:400`). That is the defect: PAM asks 30 s
  too late.
- The payload is `exec 2>&1; <command>` (`src/executor.ts:209-211`), so the
  command inherits sudo's stdin.
- The dialog refuses an empty password when the ticket is cold
  (`src/dialog.ts:431-439`) and turns the prompt red (`#passwordAlert`).
- `sudo_exec` calls `askApproval` (`src/index.ts:523`) and `runCold`
  (`src/index.ts:555`).

## Design

### Password path

Stop closing stdin early. The nonce latch already guarantees the secret is
written only when sudo itself asked, so the pipe can stay open until sudo exits.
The timer is removed rather than lengthened: any finite value races PAM again.

The command must not inherit that pipe, so the payload becomes
`exec 2>&1 0</dev/null; <command>`. This keeps the current property that
`sudo_exec cat` sees EOF; today that relies on the 5 s end. A root command can
never read a stray secret from stdin.

Authentication time is not command time. Keep the timeout armed from spawn and
re-arm it when the nonce prompt appears, so the 30 s fingerprint wait does not
consume the command's budget. Worst case wall time is `authWait + timeoutSec`.

### Fingerprint-only approval

An empty password from the dialog means "PAM only": spawn `sudo -S` with stdin
ended immediately. `pam_fprintd` authenticates on touch; if it fails, `pam_unix`
prompts and reads EOF, and sudo reports `no password was provided`. No new spawn
shape, no askpass, no PTY.

Nothing runs without a touch, and the existing "scroll to the end before the
options appear" gate still forces the command to be read before Enter works.

### Learning from the run

The first cold run is the probe. Two kinds of evidence, both taken from the run
that just happened:

1. **Prompt delay.** `promptDelayMs = promptSeenAt - startedAt`. sudo's own
   password prompt normally arrives in well under a second; a value of 5000 ms
   or more means some PAM module held authentication back.
2. **PAM marker.** The stdout captured up to the moment the prompt appears is
   searched for `Verification timed out` or `Failed to match fingerprint`. The
   snapshot is taken before the command starts, so command output cannot fake it.
   This catches short configured fingerprint timeouts that the delay threshold
   would miss.

Either one sets `readerLearned` for the process. A successful empty-password run
also sets it, since touching the reader is proof. An empty-password run that
fails with `no password was provided` sets `readerRejected`, which hides the hint
again and is cleared by a session start with reason `new`, `resume`, or `fork`.

`readerLearned` is a machine fact, not an approval, so it survives session
switches and dies with the pi process (or an extension reload).

Consequences, accepted by the user:

- The very first cold run after a pi start still waits 30 s unless the user
  touches the reader; the 3 s status line tells them they can.
- A machine that always waits for something slow (fingerprint or a slow directory)
  shows the hint from the second cold run. If the reader is not what waited, the
  first empty-password run fails fast and `readerRejected` stops offering it.
- macOS needs no special code: `pam_tid` produces a delay (and possibly no marker,
  which is fine), so the delay path works there too. The marker list is a bonus,
  not a requirement.

Rejected alternatives: reading `/etc/pam.d` (vetoed; outside the workspace);
`fprintd-list` or `bioutil` probes (extra process, per-platform table, unverified
on macOS); our own D-Bus client, askpass helper, FIFO; an `Authenticator` seam;
`su`/polkit (asks for a different secret).

### Reader hint matrix

The hint and the empty-password route are the same flag, so they cannot drift:

```text
showReader = !warm && readerLearned && !readerRejected && errorText === undefined
```

| # | Ticket | `readerLearned` | `readerRejected` | Retry (`errorText`) | Hint row | Empty Enter |
|---|---|---|---|---|---|---|
| 1 | warm | any | any | any | none — no password row | approves warm run |
| 2 | cold | yes | no | no | shown | approves fingerprint run |
| 3 | cold | yes | yes | no | hidden | red alert, dialog stays |
| 4 | cold | no | any | no | hidden | red alert, dialog stays |
| 5 | cold | yes | no | yes | hidden | red alert, dialog stays |
| 6 | cold | any | any | yes | hidden | red alert, dialog stays |
| 7 | not TUI, or no UI | — | — | — | no dialog; tool fails closed | — |

While the command preview has not been read to the end, the hint row is reserved
as blank space, like the options and the password row, so the frame keeps its
height. The 3 s auth-wait status line is independent of this matrix: it fires on
any cold run that has prompted nothing.

## Steps

Sizes are changed lines including tests.

### 1. `fix-auth-stdin` — keep the auth pipe usable

Files: `src/executor.ts`, `test/executor.test.ts`, `test/index.test.ts`,
`test/integration.test.ts`.

- Delete `NO_PROMPT_MS`, the `noPromptMs` option and seam docs
  (`src/executor.ts:12`, `:56-57`, `:274`), the `promptTimer` variable and its
  `clearTimers` entry (`:313`, `:318-321`), the prompt-clear block in the stderr
  handler (`:404-407`), and the `else` branch that armed the timer
  (`:424-430`). Keep `endStdin()` for warm runs.
- Payload:
  ```diff
  -  return `exec 2>&1; ${command}`;
  +  return `exec 2>&1 0</dev/null; ${command}`;
  ```
- Extract the timeout arming into `armTimeout()` and call it at spawn and from
  the stderr handler after `promptSeen = true`:
  ```ts
  // Authentication is not command time: give the command its full budget.
  const armTimeout = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1, timeoutSec * 1000));
    timeoutTimer.unref?.();
  };
  ```
- Update the design comment on `buildPayload` and the `SpawnRunOptions` docs.
- Tests: payload strings in `executor.test.ts:111-173`, `index.test.ts:553-592`,
  `integration.test.ts:577-580`; drop every `noPromptMs` argument
  (`executor.test.ts:164,216,236,255,274,331,347,366`). Replace the
  "ends stdin without writing when the prompt never appears" test with two:
  (a) no prompt → after `tick(60)` `stdin.ended === false` and `writes` empty,
  then `finish(1)` → no retry, `ok:false`; (b) prompt arriving "late" (emit after
  `tick(60)`) still writes `[password, "\n"]` and ends stdin.
- New test: `timeoutSec: 1`, prompt at ~600 ms, close at ~1400 ms → `ok:true`,
  `timedOut:false` (fails before the re-arm).

Acceptance: `npm run check` clean; executor and integration suites pass.
Dependencies: none. Risk: low.

### 2. `record-auth-evidence` — report what the auth phase showed

Files: `src/executor.ts`, `test/executor.test.ts`.

- New constants near the other sudo strings:
  ```ts
  const SLOW_AUTH_MS = 5000;
  const FINGERPRINT_MARKERS = /Verification timed out|Failed to match fingerprint/;
  ```
- Track `promptDelayMs: number | null` (set once when the nonce is seen) and
  snapshot stdout at that instant:
  ```ts
  promptSeen = true;
  promptDelayMs = Date.now() - startedAt;
  authStdout = stdout; // before the command exists, so it cannot be faked
  ```
- `ExecResult` gains:
  ```ts
  /** ms from spawn to sudo's password prompt; null when it never appeared. */
  promptDelayMs: number | null;
  /** The run itself showed evidence that a biometric module held PAM up. */
  authEvidence: boolean;
  ```
  `authEvidence` is true when `promptDelayMs !== null && promptDelayMs >= SLOW_AUTH_MS`
  or `FINGERPRINT_MARKERS.test(authStdout)`. For a run without a prompt it is
  `false`; the caller upgrades it to true for a successful empty-password run.
- Tests: prompt at ~10 ms → `promptDelayMs` small, `authEvidence:false`; prompt
  after a simulated 5 s (inject the clock with `Date.now` stub or set
  `SLOW_AUTH_MS` low via a seam) → `authEvidence:true`; stdout containing
  `Verification timed out` before the prompt → `authEvidence:true`; the same
  text printed by the command (stdout after the prompt) → `authEvidence:false`;
  no prompt → `promptDelayMs:null`.

Acceptance: unit tests pass; no real sudo involved.
Dependencies: 1. Risk: low.

### 3. `wire-fingerprint-run` — hint, empty password, and the learned record

Files: `src/dialog.ts`, `src/executor.ts`, `src/index.ts`, tests for all three.

Dialog:

- `ApprovalDialogOptions` gains `fingerprint?: boolean`; `askApproval`'s options
  gain the same field and pass it through.
- New constant, rendered as one wrapped dim row above the password row, in both
  the closed-gate reservation and the open state:
  ```ts
  const HINT_FINGERPRINT =
    "empty password: authenticate with the fingerprint reader · typed password: fallback if the reader times out";
  ```
- Row math: `const extraRows = this.#warm ? 0 : this.#fingerprint ? 2 : 1;` used in
  `blockRows` (`OPTION_LABELS.length + extraRows + 1`) and in `pad`
  (`blockRows - 1 - hint.length - extraRows`). Draw the hint only when
  `this.#fingerprint && !this.#warm`.
- `#submit()`: keep `#passwordAlert` for the not-offered case, and approve with
  the empty buffer when offered:
  ```ts
  const secret = this.field.take();
  if (secret.length === 0) {
    if (this.#fingerprint) {
      this.#finish({ approved: true, mode, password: secret });
      return;
    }
    this.#passwordAlert = true;
    this.#requestRender();
    return;
  }
  ```
- Tests: hint only when cold and flagged; empty Enter approves only when flagged;
  empty Enter still alerts otherwise; closed-gate height unchanged in both cases.

Executor:

- `RunColdOptions.password` documented as: an empty buffer means no password,
  PAM authenticates.
- `runOnce`: `const passwordOnly = password !== undefined && password.length > 0;`
  Use `-S` whenever `password !== undefined`, `-n` otherwise. End stdin
  immediately when `password === undefined || password.length === 0`. Guard the
  stderr latch with `passwordOnly`.
- `warm` becomes
  `password === undefined || password.length === 0 || (!promptSeen && code === 0 && …)`
  so a successful fingerprint run is not reported warm.
- Tests: empty buffer spawns `-S`, never writes, ends stdin at once, reports
  `warm:false`; non-empty buffer keeps the latch tests.

Index:

- `SudoExecDetails` gains `auth?: "password" | "fingerprint"`.
- Module-level, next to `spawnImpl`:
  ```ts
  let readerLearned = false;
  let readerRejected = false;
  ```
  `readerLearned` survives session switches; both die with the process or a
  reload. `readerRejected` is cleared in the `session_start` handler for reasons
  `new`, `resume`, and `fork`.
- Before each cold dialog attempt:
  ```ts
  const showReader = !warm && readerLearned && !readerRejected && lastError === undefined;
  ```
- After a cold run: if `answer.password.length === 0` and the run succeeded, set
  `readerLearned = true`; if it failed with `no password was provided`, set
  `readerRejected = true` and return the fixed text:
  ```ts
  const FINGERPRINT_FAILED_TEXT =
    "Fingerprint authentication did not succeed and no password was typed; nothing ran. sudo may not accept this reader. Call sudo_exec again and type the sudo password, or touch the reader when it asks.";
  ```
  For a password run, set `readerLearned ||= outcome.result.authEvidence`. One
  attempt only; no dialog loop for the empty route.
- Set `auth: answer.password.length > 0 ? "password" : "fingerprint"` on a cold
  run.
- Status line via `onUpdate` about 3 s into a cold run that has not prompted:
  ```ts
  const AUTH_WAIT_TEXT =
    "\n[pi-sudo] waiting for sudo authentication: fingerprint reader or password prompt\n";
  ```
  UI only, never in the model-facing result.
- Tests: a password run with `authEvidence:true` makes the next dialog receive
  `fingerprint:true`; an empty answer runs `-S` with no writes, `auth:"fingerprint"`,
  and sets `readerLearned`; a failed empty answer sets `readerRejected` and the
  next dialog gets `fingerprint:false`; a retry (errorText set) never gets the
  hint; `readerLearned` survives a session switch and `readerRejected` does not.

Acceptance: full suite passes.
Dependencies: 1, 2. Risk: medium (dialog row math, the state machine).

### 4. `docs-and-version` — README, DESIGN, TESTING

Files: `README.md`, `DESIGN.md`, `TESTING.md`, `package.json`.

- README: "Fingerprint and other PAM delays" — the 30 s wait, the empty-password
  approval, the typed-password fallback, how pi-sudo learns (first cold run, next
  dialog offers the reader, resets on exit), the fast failure when the reader is
  not what waited, and the optional root-side `pam_fprintd.so timeout=5
  max-tries=1` tweak marked as the user's own change.
- DESIGN: replace the "No exit code trust for the prompt" bullet; document
  `0</dev/null`; document the timeout re-arm; add "PAM latency and biometrics"
  with the evidence rules, `SLOW_AUTH_MS`, the marker strings, the snapshot rule,
  the record lifetimes, and the empty-Enter rule; update the rejected-alternatives
  biometric entry.
- TESTING: rows for touch → instant; ignore the reader → command runs after 30 s,
  hint on the next dialog; empty Enter → runs on touch only; empty Enter on a
  machine without a reader → fast failure and no further hint; `cat` sees EOF.
- `package.json`: `0.4.0`.

Dependencies: 1–3. Risk: low.

### 5. `verify-suite` — automated gate

Run in `/home/papa/Work/pi/pi-sudo`: `npm run check` and `npm test`. Both are
read-only outside temp dirs. Acceptance: both exit 0; no new warnings.

Dependencies: 1–4.

### 6. `review-auth-path` — independent review

Review the diff from steps 1–4 (security-sensitive: secret delivery, stdin
inheritance, approval semantics, the learned state). Model `gpt-6-luna`, effort
high (cost gate waived in Decision 4). Scope: the password path, the
empty-password branch, the dialog gate, the payload change, and that no file is
read and no probe is spawned. Required findings are fixed before close; nitpicks
are reported, not required.

Dependencies: 5.

## Edge cases & failure modes

| Case | Behaviour |
|---|---|
| Fingerprint ignored, password typed, first cold run | Prompt at ~30 s, password written, command runs; next dialog offers the reader |
| Fingerprint touched | `pam_fprintd` sufficient, no prompt, buffer zeroed unwritten |
| Empty password, reader touched | PAM authenticates, `readerLearned` set, no secret exists |
| Empty password, reader not used | sudo reads EOF, `no password was provided`, nothing runs, hint hidden (`readerRejected`) |
| Slow directory (LDAP/SSSD), no reader | Evidence set by delay; empty run fails fast; hint hidden afterwards |
| Reader timeout configured below 5 s | Marker path (`Verification timed out`) still sets the record |
| Fast touch on every run | No prompt, no delay, no record — and none needed |
| Sensor busy or remote session | No wait; password prompt at once |
| Lid closed (omarchy guard) | fprintd skipped by PAM; password path unchanged |
| Warm ticket | No password row, no hint; unchanged |
| sudo never prompts (warm despite probe) | stdin stays open but the command's stdin is `/dev/null`; run ends at the timeout |
| Command reads stdin | Immediate EOF from `/dev/null` |
| Abort/timeout | `terminate()`, buffer zeroed on close; the re-armed timer is cleared |
| Wrong password | Unchanged `Sorry, try again.` loop, up to 3 |

## Risks

| Risk | Severity | Mitigation / gate |
|---|---|---|
| First cold run per pi process still waits 30 s | medium | The 3 s status line tells the user to touch; accepted by the user |
| Delay evidence from a slow non-biometric PAM source offers a wrong hint | low | One failed empty run sets `readerRejected`; nothing executes |
| Marker strings change in a future pam_fprintd | low | Delay path is independent; worst case the hint appears only for waits ≥5 s |
| Removing the 5 s end lets a prompt-less run last to the timeout | low | Timeout still armed; `0</dev/null` prevents command-side effects |
| Empty Enter approves something the user did not read | low | Options appear only after scrolling to the end; nothing runs without a touch |
| Dialog row math drifts and the frame jumps | low | Gate tests plus new hint tests; manual check |
| Re-armed timeout extends wall time | low | Documented; `timeout` parameter still caps the command |

## Verification

1. `npm run check` and `npm test` in `pi-sudo` (step 5).
2. Manual, on this machine (`TESTING.md` rows): cold run with a typed password
   and no touch → command runs after ~30 s, and the next dialog shows the hint;
   tap the reader on that next run → instant; empty Enter → runs on touch only;
   warm run → no hint; `sudo_exec cat` → exits 0. These exercise the tool; no
   verification step reads a path outside the repo.
3. Review (step 6) closes with no required findings, and explicitly confirms no
   file read and no probe process.

## Rollback

Each step is file-local and reversible: step 1 restores `NO_PROMPT_MS` and the
timer, step 2 drops the two `ExecResult` fields, step 3 reverts the
dialog/executor/index hunks, step 4 reverts docs and the version. No migration,
no persisted state.

## Out of scope / follow-ups

- `fprintd-list` / `bioutil` probes (rejected: extra process, per-platform,
  unverified on macOS).
- Persisting the learned record across pi restarts.
- Skip-fingerprint marker guard via `pam_exec` (root-side, invocation scoped).
- Applying the root-side PAM tweak automatically.
