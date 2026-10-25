import {
  Input,
  Key,
  matchesKey,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { PASSWORD_PROMPT, PasswordField } from "./password-field.js";

export type DialogTheme = Pick<Theme, "fg">;

const MAX_PREVIEW_LINES = 10;
const COMMAND_INDENT = "  ";
/** Frame title shown above the command preview. */
const TITLE = "\u03c0 sudo: Requesting root privilege";
const REASON_LABEL = "Reason: ";
const DENIAL_PLACEHOLDER = "enter reason for denial (optional)";
// While the preview is not fully read, the options are not rendered at all: the
// footer carries the requirement instead, so there is nothing to choose yet.
const HINT_READ =
  "You must read the full command to make a decision: scroll to the bottom.";
const HINT_READ_KEYS = "shift+↑↓ scroll · PgUp/PgDn · End · esc deny";
const HINT_KEYS = "↑↓ navigate · enter confirm · esc deny";

/** Columns taken by the frame itself: "│ " + " │". */
const FRAME_CHROME = 4;
const MIN_INNER = 12;

function innerWidth(width: number): number {
  return Math.max(MIN_INNER, width - FRAME_CHROME);
}

/** Pads with spaces to `width`; the caller truncates anything longer first. */
function padToWidth(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/**
 * One content row. Pad from the visible width so ANSI styling cannot shift the
 * right border; a terminal narrower than MIN_INNER clips the row instead of
 * letting it overflow the screen.
 */
function frameRow(content: string, width: number): string {
  const inner = innerWidth(width);
  return truncateToWidth(`│ ${padToWidth(truncateToWidth(content, inner), inner)} │`, width);
}

/** "╭─ title ─…─╮": chrome is 5 columns, the rest is dashes up to the corner. */
function topRule(theme: DialogTheme, width: number): string {
  const title = truncateToWidth(theme.fg("accent", TITLE), Math.max(1, width - 6));
  const dashes = Math.max(1, width - visibleWidth(title) - 5);
  return truncateToWidth(`╭─ ${title} ${"─".repeat(dashes)}╮`, width);
}

function bottomRule(width: number): string {
  return truncateToWidth(`╰${"─".repeat(Math.max(1, width - 2))}╯`, width);
}

function divider(width: number): string {
  return truncateToWidth(`├${"─".repeat(Math.max(1, width - 2))}┤`, width);
}

/** Unicode format characters that can hide or reorder the text shown to the user. */
function isFormatCodePoint(cp: number): boolean {
  return (
    cp === 0x00ad ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/**
 * Render model-supplied text so what the user reads is what runs: every byte
 * that cannot be displayed becomes a visible marker instead of disappearing.
 * Dropping escape-sequence bodies would let a command hide whole shell lines
 * from the approver while `/bin/sh` still executed them, so nothing is removed.
 */
export function sanitizeForDisplay(command: string): string {
  let out = "";
  for (const ch of command) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\t") {
      out += "  ";
    } else if (ch === "\r") {
      out += "<CR>";
    } else if (ch === "\n") {
      out += "<LF>";
    } else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || isFormatCodePoint(cp)) {
      out += `<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>`;
    } else {
      out += ch;
    }
  }
  return out;
}

export type ApprovalMode = "once" | "ticket";
/** Resolved answer. `password` is empty when the ticket is warm, since sudo would ignore it. */
export type ApprovalOutcome =
  | { approved: true; mode: ApprovalMode; password: Buffer }
  | { approved: false; note: string };

const OPTION_LABELS = ["Yes, once", "Yes, until sudo asks again", "No"] as const;
const NO_INDEX = 2;

export interface ApprovalDialogOptions {
  command: string;
  reason: string;
  errorText?: string;
  warm: boolean;
  /** Terminal rows; the preview grows on tall terminals instead of scrolling a stub. */
  rows?: number;
  theme: DialogTheme;
  done: (result: ApprovalOutcome) => void;
  requestRender?: () => void;
}

/**
 * One approval screen drawn in a bordered frame: the model's rationale, an
 * optional sudo error, a scrollable command preview, and three stacked
 * options. ↑/↓ move between options, shift+↑/↓ page the preview, Enter
 * confirms, Esc denies. The denial reason Input hangs off the No row, so a
 * reason can never ride along with an approval. The secret never leaves
 * `take()`.
 */
export class ApprovalDialog implements Component, Focusable {
  readonly field = new PasswordField();
  readonly #command: string;
  readonly #reasonText: string;
  readonly #errorText: string | undefined;
  readonly #theme: DialogTheme;
  readonly #done: (result: ApprovalOutcome) => void;
  readonly #requestRender: () => void;
  readonly #scroll: ScrollView;
  readonly #warm: boolean;
  readonly #rows: number | undefined;
  readonly #note = new Input({
    prompt: "[ ",
    placeholder: DENIAL_PLACEHOLDER,
    placeholderStyle: (text: string) => this.#theme.fg("dim", text),
  });
  #choice: 0 | 1 | 2 = 0;
  #focused = true;
  #wrappedWidth = -1;
  #wrappedLines: string[] = [""];
  #contentHeight = 0;
  #viewport = MAX_PREVIEW_LINES;
  /** A blocked Enter turns the hint red until the next key, so the gate answers back. */
  #gateAlert = false;
  /** An empty-password Enter turns the prompt red instead of denying the request. */
  #passwordAlert = false;
  #sawEnd = true;
  #closed = false;

  constructor(options: ApprovalDialogOptions) {
    this.#command = options.command;
    this.#theme = options.theme;
    this.#done = options.done;
    this.#requestRender = options.requestRender ?? (() => {});
    this.#warm = options.warm;
    this.#rows = options.rows;
    this.#reasonText = sanitizeForDisplay(options.reason);
    this.#errorText =
      options.errorText === undefined ? undefined : sanitizeForDisplay(options.errorText);
    this.#scroll = new ScrollView(
      {
        render: (width: number) => this.#wrap(width),
        invalidate: () => {},
      },
      // No scrollbar: pi-tui draws the thumb in its own layout pass, which a
      // dialog rendered by hand never reaches, so "auto" here would do nothing.
      { scrollbar: "hidden" },
    );
    this.field.onSubmit = () => {
      this.#submit();
    };
    this.field.onEscape = () => {
      this.#finish({ approved: false, note: "" });
    };
    this.#syncInput();
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    if (this.#focused === value) return;
    this.#focused = value;
    this.#syncInput();
    this.#requestRender();
  }

  /** True once the whole preview is visible (always true when it fits). */
  get sawEnd(): boolean {
    return this.#sawEnd;
  }

  render(width: number): string[] {
    const theme = this.#theme;
    const inner = innerWidth(width);
    const previewWidth = Math.max(1, inner - COMMAND_INDENT.length);
    const content = this.#scroll.render(previewWidth);
    const reasonLines = wrapTextWithAnsi(
      `${theme.fg("dim", REASON_LABEL)}${this.#reasonText}`,
      inner,
    );
    const errorLines =
      this.#errorText === undefined
        ? []
        : wrapTextWithAnsi(theme.fg("error", `sudo: ${this.#errorText}`), inner);
    // Every row the preview does not own: borders, reason, command header,
    // error, divider, options, the cold password row, the blank row above the
    // footer, and the footer itself.
    const reserved =
      2 +
      reasonLines.length +
      errorLines.length +
      1 +
      1 +
      OPTION_LABELS.length +
      (this.#warm ? 0 : 1) +
      1 +
      1;
    const previewRows = Math.min(
      24,
      Math.max(MAX_PREVIEW_LINES, (this.#rows ?? 0) - reserved),
    );

    const height = content.length;
    this.#contentHeight = height;
    this.#viewport = previewRows;
    // ScrollView owns scroll state and clamping; its clipping normally comes
    // from the layout pass, so this non-layout dialog windows the lines here.
    this.#scroll.updateLayout(height, previewRows, this.#requestRender);

    const overflow = height > previewRows;
    const top = Math.min(this.#scroll.scrollTop, Math.max(0, height - previewRows));
    this.#sawEnd = !overflow || top >= height - previewRows;
    const range = overflow
      ? ` (lines ${top + 1}-${Math.min(top + previewRows, height)} of ${height})`
      : "";

    const lines: string[] = [topRule(theme, width)];
    lines.push(...reasonLines.map((line) => frameRow(line, width)));
    if (errorLines.length > 0) {
      lines.push(...errorLines.map((line) => frameRow(line, width)));
    }
    lines.push(frameRow(theme.fg("dim", `Command${range}:`), width));
    for (const line of content.slice(top, top + previewRows)) {
      lines.push(frameRow(`${COMMAND_INDENT}${line}`, width));
    }
    // The divider is drawn in both states so the frame does not change shape
    // when the gate opens.
    lines.push(divider(width));
    if (!this.#sawEnd) {
      // Nothing can be chosen until the whole command has been on screen, so the
      // options and the password row are not drawn. Blank rows hold their place:
      // the closed gate is exactly as tall as the open one, so the centred
      // overlay does not jump when the last line arrives.
      const blockRows = OPTION_LABELS.length + (this.#warm ? 0 : 1) + 1;
      const hint = wrapTextWithAnsi(
        theme.fg(this.#gateAlert ? "error" : "warning", HINT_READ),
        Math.max(1, inner - COMMAND_INDENT.length),
      );
      const pad = Math.max(1, blockRows - 1 - hint.length - (this.#warm ? 0 : 1));
      lines.push(frameRow("", width));
      lines.push(...hint.map((line) => frameRow(`${COMMAND_INDENT}${line}`, width)));
      for (let row = 0; row < pad; row += 1) lines.push(frameRow("", width));
      if (!this.#warm) lines.push(frameRow("", width));
      lines.push(frameRow(theme.fg("dim", HINT_READ_KEYS), width));
    } else {
      lines.push(...this.#optionLines(inner).map((line) => frameRow(line, width)));
      // A warm ticket makes sudo ignore any typed password, so no row at all.
      if (this.#choice !== NO_INDEX && !this.#warm) {
        const prompt = theme.fg("error", PASSWORD_PROMPT);
        const [field = ""] = this.field.render(
          Math.max(1, inner - 2),
          this.#passwordAlert ? prompt : undefined,
        );
        lines.push(frameRow(`${COMMAND_INDENT}${field}`, width));
      }
      // A blank row keeps the footer from crowding the options.
      lines.push(frameRow("", width));
      lines.push(frameRow(theme.fg("dim", HINT_KEYS), width));
    }
    lines.push(bottomRule(width));
    return lines;
  }

  /** Stacked like the escalation options: the arrow marks what Enter would confirm. */
  #optionLines(inner: number): string[] {
    return OPTION_LABELS.map((label, index) => {
      if (index !== this.#choice) return this.#theme.fg("dim", `  ${label}`);
      if (index === NO_INDEX) return this.#noLine(inner);
      return this.#theme.fg("accent", `→ ${label}`);
    });
  }

  /** The reason Input only exists on the No row, so it can never ride along with Yes. */
  #noLine(inner: number): string {
    const no = this.#theme.fg("accent", "→ No");
    const prefix = `${no}  `;
    const [field = ""] = this.#note.render(
      Math.max(12, inner - visibleWidth(prefix) - 1),
    );
    return `${prefix}${field.replace(/\s+$/, "")} ]`;
  }

  handleInput(data: string): void {
    if (this.#closed || data.length === 0) return;
    if (matchesKey(data, Key.escape)) {
      this.#finish({ approved: false, note: "" });
      return;
    }
    if (!matchesKey(data, Key.enter)) {
      this.#gateAlert = false;
      this.#passwordAlert = false;
    }
    if (matchesKey(data, "shift+up") || matchesKey(data, Key.pageUp)) {
      this.#scrollBy(-this.#viewport);
      return;
    }
    if (matchesKey(data, "shift+down") || matchesKey(data, Key.pageDown)) {
      this.#scrollBy(this.#viewport);
      return;
    }
    if (matchesKey(data, Key.home)) {
      const before = this.#scroll.scrollTop;
      this.#scroll.scrollToStart();
      this.#afterScroll(before);
      return;
    }
    if (matchesKey(data, Key.end)) {
      const before = this.#scroll.scrollTop;
      this.#scroll.scrollToEnd();
      this.#afterScroll(before);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.#select(Math.max(0, this.#choice - 1));
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#select(Math.min(NO_INDEX, this.#choice + 1));
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (!this.#sawEnd) {
        // A long command must be read to its end before approval.
        this.#gateAlert = true;
        this.#requestRender();
        return;
      }
      this.#submit();
      return;
    }
    // Keys other than the navigation keys only ever edit the selected field.
    if (this.#choice === NO_INDEX) {
      this.#note.handleInput(data);
      return;
    }
    if (!this.#warm) this.field.handleInput(data);
  }

  invalidate(): void {
    this.#scroll.invalidate();
    this.field.invalidate();
    this.#note.invalidate();
  }

  dispose(): void {
    this.field.clear();
    this.#note.setValue("");
  }

  #wrap(width: number): string[] {
    if (width === this.#wrappedWidth) return this.#wrappedLines;
    this.#wrappedWidth = width;
    const lines = wrapTextWithAnsi(sanitizeForDisplay(this.#command), width);
    this.#wrappedLines = lines.length > 0 ? lines : [""];
    return this.#wrappedLines;
  }

  #scrollBy(delta: number): void {
    const before = this.#scroll.scrollTop;
    this.#scroll.scrollBy(delta);
    this.#afterScroll(before);
  }

  #afterScroll(before: number): void {
    if (this.#scroll.scrollTop === before) return;
    const maxTop = Math.max(0, this.#contentHeight - this.#viewport);
    this.#sawEnd = this.#contentHeight <= this.#viewport || this.#scroll.scrollTop >= maxTop;
    this.#requestRender();
  }

  #select(choice: number): void {
    // Clamped here so ↑/↓ can pass raw arithmetic without a cast at each call site.
    const next = Math.max(0, Math.min(NO_INDEX, choice)) as 0 | 1 | 2;
    if (this.#choice === next) return;
    this.#choice = next;
    this.#passwordAlert = false;
    this.#syncInput();
    this.#requestRender();
  }

  /** Focus follows the selection: the reason only takes keys while No is marked. */
  #syncInput(): void {
    this.field.focused = this.#focused && this.#choice !== NO_INDEX && !this.#warm;
    this.#note.focused = this.#focused && this.#choice === NO_INDEX;
  }

  #submit(): void {
    if (this.#choice === NO_INDEX) {
      this.#finish({ approved: false, note: sanitizeNote(this.#note.getValue()) });
      return;
    }
    const mode: ApprovalMode = this.#choice === 0 ? "once" : "ticket";
    if (this.#warm) {
      this.#finish({ approved: true, mode, password: Buffer.alloc(0) });
      return;
    }
    const secret = this.field.take();
    if (secret.length === 0) {
      // An empty password cannot be approved, but denying on it would look like a
      // slip of the finger: keep the dialog open and mark the prompt instead.
      this.#passwordAlert = true;
      this.#requestRender();
      return;
    }
    this.#finish({ approved: true, mode, password: secret });
  }

  #finish(outcome: ApprovalOutcome): void {
    if (this.#closed) return;
    this.#closed = true;
    // The reason is only ever returned on a denial, so drop it whatever happened.
    this.#note.setValue("");
    // An approval has already taken (and zeroed) the password; a denial clears it.
    if (!outcome.approved) this.field.clear();
    this.#done(outcome);
  }
}

export function createApprovalDialog(options: ApprovalDialogOptions): ApprovalDialog {
  return new ApprovalDialog(options);
}

/**
 * Show the approval dialog. Resolves with the chosen lifetime and the password
 * bytes on approval (`password` is empty when warm), or the optional denial
 * reason on refusal. Nothing is notified, logged, or stringified.
 */
/** Both dialogs are centred overlays: 80% of the terminal wide, 90% tall. */
const OVERLAY = {
  overlay: true,
  overlayOptions: { anchor: "center" as const, width: "80%" as const, maxHeight: "90%" as const },
};

/** Rows the frame may draw: the overlay's maxHeight, so its math and the TUI agree. */
function overlayRows(tui: TUI): number {
  const rows = tui.terminal?.rows;
  // One row of slack: the frame's total equals this budget, and the overlay
  // clips at maxHeight, so landing exactly on the limit would cut the bottom border.
  return Number.isFinite(rows) && rows > 0 ? Math.max(10, Math.floor(rows * 0.9) - 1) : 24;
}

export async function askApproval(
  ctx: ExtensionContext,
  command: string,
  reason: string,
  options: { warm?: boolean; errorText?: string } = {},
): Promise<ApprovalOutcome> {
  return ctx.ui.custom<ApprovalOutcome>(
    (tui, theme, _keybindings, done) => {
      return new ApprovalDialog({
        command,
        reason,
        errorText: options.errorText,
        warm: options.warm ?? false,
        rows: overlayRows(tui),
        theme,
        done,
        requestRender: () => {
          tui.requestRender();
        },
      });
    },
    OVERLAY,
  );
}

/** Escalation confirmation shown before the password dialog. */
const ESCALATION_TITLE = "\u03c0 sudo: lasting privilege change";
const ESCALATION_WARNING =
  "This command can grant lasting root privilege (sudoers, PAM, account files, SUID/ACL/capability changes, or /etc and /root writes).";
const ESCALATION_QUESTION = "Run it anyway?";
const NOTE_PLACEHOLDER = "optional note for the model";
const HINT_APPROVE = "Enter confirms · Esc denies · → or Tab writes a note";
const HINT_DECLINE = "Enter declines with note · Tab back to Yes · Esc declines";
const MAX_NOTE_LENGTH = 500;

export interface EscalationAnswer {
  approved: boolean;
  /** Sanitised, single-line note; empty unless the user declined. */
  note: string;
}

export interface EscalationDialogOptions {
  theme: DialogTheme;
  done: (answer: EscalationAnswer) => void;
  requestRender?: () => void;
}

/**
 * One confirmation screen for a command that can leave lasting root privilege
 * behind. The options are stacked, Yes is preselected, and the note field hangs
 * off the No line and only appears once No is selected. It also only takes
 * keystrokes then, so a note can never ride along with an approval. Enter
 * confirms the highlighted option; Esc denies without a note.
 */
export class EscalationDialog implements Component, Focusable {
  readonly #theme: DialogTheme;
  readonly #done: (answer: EscalationAnswer) => void;
  readonly #requestRender: () => void;
  readonly #input = new Input({ prompt: "[ ", placeholder: NOTE_PLACEHOLDER });
  #selected = 0;
  #focused = true;
  #closed = false;

  constructor(options: EscalationDialogOptions) {
    this.#theme = options.theme;
    this.#done = options.done;
    this.#requestRender = options.requestRender ?? (() => {});
    this.#syncInput();
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    if (this.#focused === value) return;
    this.#focused = value;
    this.#syncInput();
    this.#requestRender();
  }

  render(width: number): string[] {
    const theme = this.#theme;
    const lines = [
      truncateToWidth(theme.fg("accent", ESCALATION_TITLE), width),
      ...wrapTextWithAnsi(
        theme.fg("error", `${ESCALATION_WARNING} ${ESCALATION_QUESTION}`),
        width,
      ),
      "",
      truncateToWidth(this.#yesLine(), width),
      truncateToWidth(this.#noLine(width), width),
      "",
      truncateToWidth(
        theme.fg("dim", this.#selected === 1 ? HINT_DECLINE : HINT_APPROVE),
        width,
      ),
    ];
    return lines;
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (matchesKey(data, Key.escape)) {
      this.#finish(false, false);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.#finish(this.#selected === 0, true);
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
      this.#select(this.#selected === 0 ? 1 : 0);
      return;
    }
    if (this.#selected === 0) {
      if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) this.#select(1);
      return;
    }
    // No is selected: every other key edits the note.
    this.#input.handleInput(data);
    this.invalidate();
  }

  invalidate(): void {}

  dispose(): void {
    this.#input.setValue("");
  }

  #yesLine(): string {
    return this.#selected === 0
      ? this.#theme.fg("accent", "→ Yes")
      : this.#theme.fg("dim", "  Yes");
  }

  /** The note field only exists on the No line, so it can never ride along with Yes. */
  #noLine(width: number): string {
    const no =
      this.#selected === 1
        ? this.#theme.fg("accent", "→ No")
        : this.#theme.fg("dim", "  No");
    if (this.#selected !== 1) return no;
    const prefix = `${no}  `;
    const [field = ""] = this.#input.render(
      Math.max(12, width - visibleWidth(prefix) - 1),
    );
    return `${prefix}${field.replace(/\s+$/, "")} ]`;
  }

  #select(index: number): void {
    if (this.#selected === index) return;
    this.#selected = index;
    this.#syncInput();
    this.#requestRender();
  }

  #syncInput(): void {
    this.#input.focused = this.#focused && this.#selected === 1;
  }

  #finish(approved: boolean, keepNote: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    const note =
      approved || !keepNote || this.#selected !== 1
        ? ""
        : sanitizeNote(this.#input.getValue());
    this.#input.setValue("");
    this.#done({ approved, note });
  }
}

/** Single line, no control or format characters, bounded length. */
export function sanitizeNote(value: string): string {
  return sanitizeForDisplay(value)
    .replace(/<CR>|<LF>|<TAB>|<U\+[0-9A-F]{4}>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_LENGTH);
}

export function createEscalationDialog(options: EscalationDialogOptions): EscalationDialog {
  return new EscalationDialog(options);
}

/** Ask whether a lasting-privilege command should run, with an optional note. */
export async function askEscalationConfirm(ctx: ExtensionContext): Promise<EscalationAnswer> {
  return ctx.ui.custom<EscalationAnswer>(
    (tui, theme, _keybindings, done) => {
      return new EscalationDialog({
        theme,
        done,
        requestRender: () => {
          tui.requestRender();
        },
      });
    },
    // Same placement as the approval dialog, so the two screens do not jump.
    OVERLAY,
  );
}
