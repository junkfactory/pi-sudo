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

Run these right after a real password was typed, with the session still open.

```bash
# The password must not reach persisted sessions, logs, or ad-hoc files.
grep -R --binary-files=text -F '<password>' ~/.pi/agent/sessions            # no match
grep -R --binary-files=text -F '<password>' ~/.pi/agent                      # no match
grep -R --binary-files=text -F '<password>' /tmp                             # no match

# ... and it must not be visible in process arguments while a run is active.
ps -eo args | grep -F '<password>'                                          # no match
ps -eo args | grep -F sudo                                                  # only pi's own argv
```

Expected: `no match` everywhere, and no `sudo` process whose argv carries the password. The password travels to `sudo` over stdin, never through argv or the environment.

## Manual acceptance

Confirm each row in a fresh session with `pi -ne -e /home/papa/Work/pi/pi-sudo`. Use `/tmp` paths for anything written, so no check leaves system state behind.

| #  | Check           | How                                                                                                   | Expected                                                                                                                                                                                                                                |
|----|-----------------|-------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1  | Cold run        | Ask for a `/tmp` file owned by root: "use sudo_exec to write /tmp/pi-sudo-accept with root ownership" | One password dialog showing the exact command and the model's reason; hidden bullets while typing; exit 0; `ls -l` shows `root root`                                                                                                    |
| 2  | Warm run        | Immediately ask for a second privileged command                                                       | No dialog; result marked warm; the first ticket is reused, because sudo owns the timestamp                                                                                                                                              |
| 3  | Reuse ends      | Run `/sudo-forget`, then ask again                                                                    | Dialog appears, and the command fails if the dialog is dismissed                                                                                                                                                                        |
| 4  | Denial          | Press Esc in the password dialog; repeat and press Enter with an empty field                          | Model receives the denial text, nothing ran, no file or process left behind                                                                                                                                                             |
| 5  | Escalation gate | Ask for a write under `/etc/sudoers.d/`                                                               | `π sudo: lasting privilege change` appears first: red warning, stacked `Yes`/`No`, note field only on the `No` line. Decline with a note → nothing ran and `The user added: …` reaches the model. Approve → the password dialog follows |
| 6  | Bash guard      | Ask the model to run `sudo id` in bash; then `jj status pi-sudo`                                      | The first is blocked with a pointer to `sudo_exec`; the second runs normally                                                                                                                                                            |
| 7  | Leak checks     | Run the commands above while the session is open                                                      | No match, and no sudo argv carrying the password                                                                                                                                                                                        |
| 8  | Wrong password  | Type a wrong password three times                                                                     | The dialog reopens with sudo's error each time; the final result says the password was rejected, the command did not run, and the model is told not to retry blindly                                                                    |
| 9  | Long command    | Ask for a 20-line command                                                                             | The preview scrolls; Enter does not approve until the last line was seen; no escape sequences in the dialog                                                                                                                             |
| 10 | Prompt junk     | Ask for `printf '[pi-sudo] password:' >&2; cat`                                                       | The password never reaches the child; stdin sees EOF; nothing is echoed                                                                                                                                                                 |
| 11 | Paste           | Paste a password that carries a trailing newline                                                      | The run succeeds and leaves no stray bytes in the output                                                                                                                                                                                |
| 12 | Policy refusal  | Ask for a command touching a path your config denies (for example `cat ~/.ssh/id_rsa`)                | Refused before any dialog, with the policy reason                                                                                                                                                                                       |
| 13 | Non-TUI         | `pi -p "use sudo_exec to run id"`                                                                     | Error result that names the missing TUI; no hang, no spawn                                                                                                                                                                              |
| 14 | Interrupt       | Start `sleep 300` through the tool, then press Ctrl+C                                                 | sudo and the child terminate; `pgrep` finds no survivors                                                                                                                                                                                |

## Notes from the last full run

pi 1.4.0, sudo 1.9.17p2, Arch, user in `wheel`, `timestamp_type=tty`, `timestamp_timeout=5` minutes. All rows passed.

Two findings worth keeping:

- One intermittent double prompt appeared after a deliberate three-failure test. The most likely cause is `pam_faillock` refusing the login immediately after the lockout, not a pi-sudo defect: every cold run since has been clean. If it recurs, check `faillock --user "$USER"` before blaming the dialog.
- Item 4 and item 5 exercise the same denial path. A broken focus or key-gating layer shows up there first, as a dialog that denies every approval.

## Resetting state between runs

```bash
rm -rf /tmp/pi-sudo-accept*          # test files the checks create
```

`/sudo-forget` clears sudo's ticket when a cold start is needed. pi-sudo never runs `sudo -k` on its own.
