# pi-sudo

`pi-sudo` adds one model-callable pi tool, `sudo_exec`. The tool shows an approval dialog in the terminal, asks for the sudo password there when sudo needs one, and then runs the approved command as root itself. The model never receives the password.

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

- A centred overlay, 80% wide and 90% tall, in a bordered frame titled `π sudo: Requesting root privilege`.
- The whole command, sanitized so nothing is dropped: an escape sequence cannot hide a line of shell. It scrolls when it does not fit.
- The model's reason, sudo's error line after a wrong password, and a dim key hint.

Three choices: `Yes, once` (the default), `Yes, until sudo asks again`, and `No`. `↑/↓` move the selection, `Enter` confirms it, `Esc` denies; there is no Tab and no focus mode. `No` takes an optional reason, which reaches the model as `The user added: …` after the standard denial. A [DESIGN.md](./DESIGN.md#approval-versus-lifetime) section covers the keymap, the password-less warm shape, and why a reason can never ride along with an approval.

The preview is 10 to 24 lines, sized to the terminal. A command too long for it hides the options until you reach the last line: the footer reads `You must read the full command to make a decision: scroll to the bottom.` above the scroll keys, and blank rows hold the options' place so the frame keeps its size. `End` jumps to the last line, `shift+↑/↓` pages.

Esc denies the request. Enter with an empty password does not: the `Password:` label turns red and the dialog waits, so a stray Enter cannot throw away the request. A denial runs nothing: the pre-dialog probe runs only `true` as root, to learn whether sudo will prompt, so your command never starts before you approve it. The denial returns an error result that tells the model not to retry the same command and to explain why root was needed.

A wrong password reopens the dialog with sudo's error, up to three attempts; only sudo's `Sorry, try again.` is retried.

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

### Approval and sudo's ticket

Approval belongs to the extension; lifetime belongs to sudo. Every `sudo_exec` asks unless you chose `Yes, until sudo asks again`, which stops asking until sudo wants a password again — on this machine five minutes after the last sudo use. The grant lives in memory for the pi process and is cleared by a warm run that finds sudo asking, by `/sudo-forget`, and by `/new`, `/resume`, or `/fork`, which also run `sudo -k`. Your own terminal's ticket is a separate record and is untouched; `reload` keeps the grant.

pi-sudo never sets, shortens, or extends sudo's ticket. The measured window, why a session switch needs its own `sudo -k`, and the risk that ticket mode carries are in [DESIGN.md](./DESIGN.md#approval-versus-lifetime).

## Design and limits

[`DESIGN.md`](./DESIGN.md) explains how the password path, the probe, the escalation gate, and the bash guard work, and lists the guarantees and the boundaries that are intentional for this version. Read the boundaries before relying on the tool: other extensions can see keystrokes, a root command can print a fake prompt, the bash guard is a nudge, path checks are heuristic, and the ticket window is sudo's to choose.

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
