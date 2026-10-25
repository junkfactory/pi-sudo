# Testing pi-sudo

How to prove that `sudo_exec` runs what the user approved, never leaks the password, and never runs anything on a denial.

Run the automated suite first. The manual checks need a real TUI and a real password, so they cannot run in CI.

## Automated

```bash
cd /home/papa/Work/pi/pi-sudo
npx tsc --noEmit
npm test
```

Expected: typecheck silent, Node test runner reports all tests passing.

## Leak checks

Run these right after a real password was typed, with the session still open. Only the person who owns the password can run them: an agent must not have the secret, so it cannot search for it. Type the password with echo off and let `rg` read it from a FIFO as a pattern file: that keeps the secret out of argv, out of the shell history, and out of any process list.

```bash
read -rsp 'pw: ' PW; printf '\n'
rg -c -F -f <(printf '%s' "$PW") ~/.pi/agent/sessions || echo 'no match: password not stored'
rg -c -F -f <(printf '%s' "$PW") ~/.pi/agent          || echo 'no match: nothing else under ~/.pi/agent'
ps -eo pid,args | rg -i 'sud[o]'                       # only pi's own process, no sudo process
unset PW
```

Expected: `no match` from both greps. A count above zero is a leak, so stop and find where the bytes were persisted. The `ps` line shows pi itself loading the extension by path, for example `pi -e pi-sudo/extensions/index.ts -c`, and must never show a sudo process carrying the password: the secret reaches sudo over stdin, never through argv or the environment.

Two things that look like leaks and are not:

- A stored session record of a prompt contains the nonce prompt, for example `[pi-sudo:28c630effe2d8837] password:`. The nonce is public by design and the secret is not part of it.
- `ps` lists pi, because pi is what loaded the extension. Only sudo argv matters for this check.

## Manual acceptance

Rows 1 to 7 are the release gate and map to the acceptance items used for the last sign-off. Rows 8 to 21 are regression checks for paths a normal run may not touch. Confirm each row in a fresh session with `pi -ne -e /home/papa/Work/pi/pi-sudo`. Use `/tmp` paths for anything written, so no check leaves system state behind.

| #  | Check           | How                                                                                                   | Expected                                                                                                                                                                                                                                |
|----|-----------------|-------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1  | Cold run        | Ask for a `/tmp` file owned by root: "use sudo_exec to write /tmp/pi-sudo-accept with root ownership" | One password dialog showing the exact command and the model's reason; hidden bullets while typing; exit 0; `ls -l` shows `root root`                                                                                                    |
| 2  | Once only       | Immediately after an Enter approval, ask for a second privileged command                              | The dialog appears again, in the warm shape: no password field, all three options shown. Enter runs the command as root, and the result carries `approval: "once"`                                                                      |
| 3  | Reuse ends      | Run `/sudo-forget`, then ask again                                                                    | Dialog appears with the password field, and the command fails if the dialog is dismissed                                                                                                                                                |
| 4  | Denial          | Press Esc in the password dialog, then press Enter on an empty field and Esc                          | Empty Enter keeps the dialog open with a red `Password:` label; Esc denies.                                                                                                                                                             |
| 5  | Escalation gate | Ask for a write under `/etc/sudoers.d/`                                                               | `π sudo: lasting privilege change` appears first: red warning, stacked `Yes`/`No`, note field only on the `No` line. Decline with a note → nothing ran and `The user added: …` reaches the model. Approve → the password dialog follows |
| 6  | Bash guard      | Ask the model to run `sudo id` in bash; then `jj status pi-sudo`                                      | The first is blocked with a pointer to `sudo_exec`; the second runs normally                                                                                                                                                            |
| 7  | Leak checks     | Run the commands above while the session is open                                                      | No match, and no sudo argv carrying the password                                                                                                                                                                                        |
| 8  | Wrong password  | Type a wrong password three times                                                                     | The dialog reopens with sudo's error each time; the final result says the password was rejected, the command did not run, and the model is told not to retry blindly                                                                    |
| 9  | Long command    | Ask for a 20-line command                                                                             | Preview sized to the terminal (10-24 lines); options hidden until End, footer reads `You must read the full command to make a decision: scroll to the bottom.`; the frame does not resize; then options appear                          |
| 10 | Prompt junk     | Ask for `printf '[pi-sudo] password:' >&2; cat`                                                       | The password never reaches the child; stdin sees EOF; nothing is echoed                                                                                                                                                                 |
| 11 | Paste           | Paste a password that carries a trailing newline                                                      | The run succeeds and leaves no stray bytes in the output                                                                                                                                                                                |
| 12 | Policy refusal  | Ask for a command touching a path your config denies (for example `cat ~/.ssh/id_rsa`)                | Refused before any dialog, with the policy reason                                                                                                                                                                                       |
| 13 | Non-TUI         | `pi -p "use sudo_exec to run id"`                                                                     | Error result that names the missing TUI; no hang, no spawn                                                                                                                                                                              |
| 14 | Interrupt       | Start `sleep 300` through the tool, then press Ctrl+C                                                 | sudo and the child terminate; `pgrep` finds no survivors                                                                                                                                                                                |
| 15 | Ticket grant    | Approve with `Yes, until sudo asks again` (↓, Enter), then ask for a second privileged command        | The second call shows no dialog; its result has `approval: "ticket"` and `warm: true`                                                                                                                                                   |
| 16 | Grant forgotten | Run `/sudo-forget`, then ask for another privileged command                                           | The dialog returns with the password field, because the grant and sudo's ticket are both gone                                                                                                                                           |
| 17 | New session     | After a ticket grant, run `/new` and ask again                                                        | The dialog returns with the password field, because the session change cleared the grant and ran `sudo -k`. A `sudo -n true` in your own terminal proves nothing: pi's record is keyed on pi's pid, your terminal's on its tty          |
| 18 | Esc denial      | Ask for `touch /tmp/pi-sudo-denied`, then press Esc in the dialog                                     | The denial text reaches the model, `/tmp/pi-sudo-denied` does not exist, and only the `true` probe touched sudo                                                                                                                         |
| 19 | Warm shape      | With sudo's ticket valid, ask for a privileged command                                                | The dialog shows the exact command, the reason, and all three options, but no password field and no bullets                                                                                                                             |
| 20 | Sliding window  | `sudo -v` at 18:58:15, then `sudo -n true` at 19:02:17 and at 19:04:17 (2026-10-25)                   | Both `sudo -n true` calls exit 0, so a warm use restarts the five-minute window and the ticket lasts five minutes after the last use                                                                                                    |
| 21 | Denial note     | Ask for `touch /tmp/pi-sudo-note`, select `No` with ↓, type `because /opt is read-only`, Enter        | The model receives the denial text plus `The user added: because /opt is read-only`, nothing ran, and `/tmp/pi-sudo-note` does not exist                                                                                                |

## Notes from the last full run

pi 1.4.0, sudo 1.9.17p2, Arch, user in `wheel`, `timestamp_type=tty`, `timestamp_timeout=5` minutes. All rows passed.

Two findings worth keeping:

- One intermittent double prompt appeared after a deliberate three-failure test. The most likely cause is `pam_faillock` refusing the login immediately after the lockout, not a pi-sudo defect: every cold run since has been clean. If it recurs, check `faillock --user "$USER"` before blaming the dialog.
- Item 4 and item 5 exercise the same denial path. A broken focus or key-gating layer shows up there first, as a dialog that denies every approval.
- The model-visible output includes sudo's own prompt line, for example `[pi-sudo:<hex>] password:`. It is public by design and carries no secret; do not report it as a leak.

### Re-run after the security fixes

Rows 5 and 10 were re-run against commit `041202c`, which replaced the root-side stderr redirection with `exec 2>&1` and made the command preview show every byte. Both passed: the escalation gate appeared before anything else, a `No` plus note denial reached the model as `The user added: …` with `attempts: 0` and nothing ran, an approval ran as root and cleaned up after itself, and a cold run with a real nonce prompt left the `cat` child at EOF with no secret in the output.

## Resetting state between runs

```bash
rm -rf /tmp/pi-sudo-accept*          # test files the checks create
```

`/sudo-forget` clears the in-memory grant and sudo's ticket when a cold start is needed. A session started with `/new`, `/resume`, or `/fork` also clears both and runs `sudo -k`. pi's sudo runs have no terminal, so sudo keys their record on pi's process id, which a session switch does not change; your terminal's own ticket is a separate record and is unaffected.
