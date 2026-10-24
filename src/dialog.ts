import {
  Input,
  Key,
  matchesKey,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { PasswordField } from "./password-field.js";

export type DialogTheme = Pick<Theme, "fg">;

const MAX_PREVIEW_LINES = 10;
const COMMAND_INDENT = "  ";
/** Header shown above the command preview. */
const TITLE = "\u03c0 sudo: approve root command";
const REASON_LABEL = "Reason: ";

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
 * Remove ANSI/CSI/OSC (and APC/PM/SS3) sequences without trusting the chunk to
 * be well formed: a malformed sequence is dropped, never rendered raw.
 */
function stripEscapes(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) !== 0x1b) {
      out += text[i];
      i += 1;
      continue;
    }
    const kind = text[i + 1];
    if (kind === undefined) {
      i += 1; // lone ESC
      continue;
    }
    if (kind === "[") {
      let j = i + 2;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        j += 1;
        if (code >= 0x40 && code <= 0x7e) break; // final byte
        if (code < 0x20 || code > 0x3f) break; // malformed: stop swallowing
      }
      i = j;
      continue;
    }
    if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
      // String sequences end with BEL or ST (ESC \).
      let j = i + 2;
      while (j < text.length) {
        const code = text.charCodeAt(j);
        if (code === 0x07) {
          j += 1;
          break;
        }
        if (code === 0x1b) {
          j += text[j + 1] === "\\" ? 2 : 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    i += 2; // SS3 and other two-byte sequences
  }
  return out;
}

/**
 * Render a model-supplied command so what the user reads is what executes:
 * escapes and control bytes are removed, format characters become visible
 * markers, tabs become two spaces, and CR/LF become visible markers.
 */
export function sanitizeForDisplay(command: string): string {
  let out = "";
  for (const ch of stripEscapes(command)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\t") {
      out += "  ";
    } else if (ch === "\r") {
      out += "<CR>";
    } else if (ch === "\n") {
      out += "<LF>";
    } else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      // C0 (minus tab/CR/LF above), DEL, and C1 controls are not displayable.
    } else if (isFormatCodePoint(cp)) {
      out += `<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>`;
    } else {
      out += ch;
    }
  }
  return out;
}

export interface ApprovalDialogOptions {
  command: string;
  reason: string;
  errorText?: string;
  theme: DialogTheme;
  done: (result: Buffer | undefined) => void;
  requestRender?: () => void;
}

/**
 * One approval screen: sanitized command preview, the model's rationale, an
 * optional sudo error, and a masked password field. Enter submits only once a
 * long preview has been scrolled to its last line; Esc or an empty submit
 * denies. The secret never leaves `take()`.
 */
export class ApprovalDialog implements Component, Focusable {
  readonly field = new PasswordField();
  readonly #command: string;
  readonly #reasonText: string;
  readonly #errorText: string | undefined;
  readonly #theme: DialogTheme;
  readonly #done: (result: Buffer | undefined) => void;
  readonly #requestRender: () => void;
  readonly #scroll: ScrollView;
  #wrappedWidth = -1;
  #wrappedLines: string[] = [""];
  #contentHeight = 0;
  #viewport = MAX_PREVIEW_LINES;
  #sawEnd = true;
  #closed = false;

  constructor(options: ApprovalDialogOptions) {
    this.#command = options.command;
    this.#theme = options.theme;
    this.#done = options.done;
    this.#requestRender = options.requestRender ?? (() => {});
    this.#reasonText = sanitizeForDisplay(options.reason);
    this.#errorText =
      options.errorText === undefined ? undefined : sanitizeForDisplay(options.errorText);
    this.#scroll = new ScrollView(
      {
        render: (width: number) => this.#wrap(width),
        invalidate: () => {},
      },
      { scrollbar: "hidden" },
    );
    this.field.onSubmit = () => {
      this.#submit();
    };
    this.field.onEscape = () => {
      this.#finish(undefined);
    };
  }

  get focused(): boolean {
    return this.field.focused;
  }

  set focused(value: boolean) {
    if (this.field.focused === value) return;
    this.field.focused = value;
    this.#requestRender();
  }

  /** True once the whole preview is visible (always true when it fits). */
  get sawEnd(): boolean {
    return this.#sawEnd;
  }

  render(width: number): string[] {
    const previewWidth = Math.max(1, width - COMMAND_INDENT.length);
    const content = this.#scroll.render(previewWidth);
    const height = content.length;
    const viewport = Math.min(MAX_PREVIEW_LINES, Math.max(1, height));
    this.#contentHeight = height;
    this.#viewport = viewport;
    // ScrollView owns scroll state and clamping; its clipping normally comes
    // from the layout pass, so this non-layout dialog windows the lines here.
    this.#scroll.updateLayout(height, viewport, this.#requestRender);

    const overflow = height > viewport;
    const top = Math.min(this.#scroll.scrollTop, Math.max(0, height - viewport));
    this.#sawEnd = !overflow || top >= height - viewport;
    const range = overflow
      ? ` (lines ${top + 1}-${Math.min(top + viewport, height)} of ${height})`
      : "";

    const lines: string[] = [
      truncateToWidth(this.#theme.fg("accent", TITLE), width),
      truncateToWidth(this.#theme.fg("dim", `Command${range}:`), width),
      ...content
        .slice(top, top + viewport)
        .map((line) => truncateToWidth(`${COMMAND_INDENT}${line}`, width)),
    ];

    lines.push(this.#labelled(REASON_LABEL, this.#reasonText, width));
    if (this.#errorText !== undefined) {
      lines.push(
        truncateToWidth(this.#theme.fg("error", `sudo: ${this.#errorText}`), width),
      );
    }
    lines.push(
      this.#sawEnd
        ? truncateToWidth(this.#theme.fg("dim", "Enter approves and runs · Esc denies"), width)
        : truncateToWidth(
            this.#theme.fg(
              "warning",
              "Scroll to the last line to approve: ↑/↓, PgUp/PgDn, End.",
            ),
            width,
          ),
    );
    lines.push(this.field.render(width)[0]);
    return lines;
  }

  handleInput(data: string): void {
    if (this.#closed || data.length === 0) return;
    if (matchesKey(data, Key.escape)) {
      this.#finish(undefined);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.#scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.#scrollBy(-this.#viewport);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
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
    if (matchesKey(data, Key.enter) && !this.#sawEnd) {
      // A long command must be read to its end before approval.
      this.#requestRender();
      return;
    }
    this.field.handleInput(data);
  }

  invalidate(): void {
    this.#scroll.invalidate();
    this.field.invalidate();
  }

  dispose(): void {
    this.field.clear();
  }

  #wrap(width: number): string[] {
    if (width === this.#wrappedWidth) return this.#wrappedLines;
    this.#wrappedWidth = width;
    const lines = wrapTextWithAnsi(sanitizeForDisplay(this.#command), width);
    this.#wrappedLines = lines.length > 0 ? lines : [""];
    return this.#wrappedLines;
  }

  #labelled(label: string, text: string, width: number): string {
    const room = Math.max(1, width - visibleWidth(label));
    return truncateToWidth(
      `${this.#theme.fg("dim", label)}${truncateToWidth(text, room)}`,
      width,
    );
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

  #submit(): void {
    const secret = this.field.take();
    this.#finish(secret.length === 0 ? undefined : secret);
  }

  #finish(result: Buffer | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    if (result === undefined) this.field.clear();
    this.#done(result);
  }
}

export function createApprovalDialog(options: ApprovalDialogOptions): ApprovalDialog {
  return new ApprovalDialog(options);
}

/**
 * Show the approval dialog. Resolves with the password bytes on approval, or
 * undefined on denial. Nothing is notified, logged, or stringified.
 */
export async function askApproval(
  ctx: ExtensionContext,
  command: string,
  reason: string,
  errorText?: string,
): Promise<Buffer | undefined> {
  return ctx.ui.custom<Buffer | undefined>((tui, theme, _keybindings, done) => {
    return new ApprovalDialog({
      command,
      reason,
      errorText,
      theme,
      done,
      requestRender: () => {
        tui.requestRender();
      },
    });
  });
}

/** Escalation confirmation shown before the password dialog. */
const ESCALATION_TITLE = "\u03c0 sudo: lasting privilege change";
const ESCALATION_WARNING =
  "This command can grant lasting root privilege (sudoers, PAM, account files, SUID/ACL/capability changes, or /etc and /root writes).";
const ESCALATION_QUESTION = "Run it anyway?";
const NOTE_LABEL = "Note to the model (only sent if you decline):";
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
 * behind. Yes is preselected, matching pi's own confirm, but the note field is
 * always focused so the user can decline with a reason or question for the
 * model. Enter confirms the highlighted option; Esc denies without a note.
 */
export class EscalationDialog implements Component, Focusable {
  readonly #theme: DialogTheme;
  readonly #done: (answer: EscalationAnswer) => void;
  readonly #requestRender: () => void;
  readonly #input = new Input({ placeholder: "optional" });
  #selected = 0;
  #closed = false;

  constructor(options: EscalationDialogOptions) {
    this.#theme = options.theme;
    this.#done = options.done;
    this.#requestRender = options.requestRender ?? (() => {});
    this.#input.focused = true;
  }

  get focused(): boolean {
    return this.#input.focused;
  }

  set focused(value: boolean) {
    if (this.#input.focused === value) return;
    this.#input.focused = value;
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
      truncateToWidth(this.#options(), width),
      "",
      truncateToWidth(theme.fg("dim", NOTE_LABEL), width),
      ...this.#input.render(width),
      truncateToWidth(theme.fg("dim", "Enter confirms · Esc denies"), width),
    ];
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.#finish(false, false);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.#finish(this.#selected === 0, true);
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
      this.#select(0);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
      this.#select(1);
      return;
    }
    this.#input.handleInput(data);
  }

  invalidate(): void {}

  dispose(): void {
    this.#input.setValue("");
  }

  #options(): string {
    const theme = this.#theme;
    const yes =
      this.#selected === 0 ? theme.fg("accent", "→ Yes") : theme.fg("dim", "  Yes");
    const no = this.#selected === 1 ? theme.fg("accent", "→ No") : theme.fg("dim", "  No");
    return `${yes}    ${no}`;
  }

  #select(index: number): void {
    if (this.#selected === index) return;
    this.#selected = index;
    this.#requestRender();
  }

  #finish(approved: boolean, keepNote: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    const note = approved || !keepNote ? "" : sanitizeNote(this.#input.getValue());
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
  return ctx.ui.custom<EscalationAnswer>((tui, theme, _keybindings, done) => {
    return new EscalationDialog({
      theme,
      done,
      requestRender: () => {
        tui.requestRender();
      },
    });
  });
}
