# pi-sudo

`pi-sudo` adds one model-callable pi tool, `sudo_exec`. The tool shows a masked approval dialog in the terminal, asks for the sudo password there, and then runs the approved command as root itself. The model never receives the password.

## Install

From GitHub:

```bash
pi install git:github.com/junkfactory/pi-sudo
```

From a local checkout:

```bash
pi install /home/papa/Work/pi/pi-sudo
```

To try the package for one invocation without touching your settings, load it explicitly and skip every other extension:

```bash
pi -ne -e /home/papa/Work/pi/pi-sudo
```

`-ne` is `--no-extensions`, which disables discovered, configured, and built-in extensions; the explicit `-e` path still loads. With the permission system disabled this way, the policy checks report `policyChecked: false` and only the dialog gates the command.

Start a new pi session after installing. The package registers its extension from `./extensions/index.ts`, which re-exports `./src/index.ts`, through the `pi.extensions` entry in `package.json`.

## Usage

`sudo_exec` takes `command` (required), `reason` (required), and `timeout` in seconds (optional; default 120, clamped to 1-600). The command is trimmed and run through `/bin/sh -c` as root. Do not put `sudo` in front of it.

The approval dialog shows:

- The header `π sudo: approve root command`.
- The sanitized command. ANSI/OSC/CSI escapes and control bytes are removed, tabs become spaces, CR and LF become visible `<CR>` and `<LF>` markers, and invisible/format characters become visible `U+XXXX` markers.
- `Reason:` followed by the model's one-line reason for the request, sanitized like the command and shortened to one display line.
- A masked password field that renders bullets, never the typed text.
- On a retry, sudo's first error line above the field.
- A footer with the available action.

When the wrapped command preview fits in 10 lines, the whole command is visible and Enter approves and runs it. When it is longer, Enter is disabled until the preview has been scrolled to the last line. Use Up/Down, PgUp/PgDn, Home, or End to scroll.

Esc denies the request. Enter with an empty password also denies it. A denial runs nothing and returns an error result that tells the model not to retry the same command and to explain why root was needed.

A wrong password reopens the dialog with sudo's error for up to three attempts. Only sudo's `Sorry, try again.` response is retried; other failures fail immediately. After the third rejection the result states that nothing was executed and asks the agent to confirm the password with the user instead of retrying blindly.

### Escalation confirmation

Commands that can leave lasting root privilege behind get one extra confirmation before the password dialog:

```text
π sudo: lasting privilege change
This command can grant lasting root privilege (sudoers, PAM, account files,
SUID/ACL/capability changes, or /etc and /root writes). Run it anyway?

→ Yes
  No

Enter confirms · Esc denies · → or Tab writes a note
```

`Yes` is preselected. Select `No` and a note field appears on that line:

```text
  Yes
→ No  [ why does /opt/app need root? ]

Enter declines with note · Tab back to Yes · Esc declines
```

The note only reaches the model when you decline with it, as `The user added: …` after the standard denial text. It is stripped of control and format characters, collapsed to one line, and capped at 500 characters. Esc denies without a note. The patterns cover sudoers, PAM, account files and account commands, SUID/ACL/capability changes, destructive file changes, and non-read-only commands carrying paths under `/etc` or `/root`.

### Tickets and `/sudo-forget`

Sudo owns the ticket. After one authenticated run, later `sudo_exec` calls inside sudo's window skip the password dialog, exactly like a terminal that has already run sudo. Permission checks and escalation confirmations still run on every call. `/sudo-forget` runs `sudo -k` and is the only way this extension clears the ticket.

Only one approval can be open in a pi process at a time. A second concurrent `sudo_exec` call is rejected before any dialog or spawn.

## Design and limits

[`DESIGN.md`](./DESIGN.md) explains how the password path, the warm probe, the escalation gate, and the bash guard work, and lists the guarantees and the boundaries that are intentional for this version. Read the boundaries before relying on the tool: other extensions can see keystrokes, a root command can phish the shared terminal, the bash guard is a nudge, path checks are heuristic, and the ticket window is sudo's to choose.

## Running the tests

From the package directory:

```bash
cd /home/papa/Work/pi/pi-sudo
npm install
npm run check
npm test
```

`npm run check` runs `tsc --noEmit`. `npm test` runs the Node test runner through `jiti` over `test/**/*.test.ts`. The executor tests use an injected fake spawn function, so they do not need sudo or a password. CI runs both on the latest Node LTS for every push and pull request.

The [manual acceptance checklist](./TESTING.md) covers what the suite cannot: a real password, the dialogs, ticket reuse, denials, and the leak checks.
