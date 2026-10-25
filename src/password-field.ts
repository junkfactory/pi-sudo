import { CURSOR_MARKER, renderFakeCursor, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";

export const PASSWORD_PROMPT = "Password: ";
const PROMPT = PASSWORD_PROMPT;
const BULLET = "•";
const ELLIPSIS = "…";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const CR = 0x0d;
const LF = 0x0a;
const BACKSPACE = 0x7f;

/**
 * Number of UTF-8 code points in `buf`: every byte that is not a continuation
 * byte starts one. Approximate for invalid sequences, which is all the masked
 * field needs (it never decodes the bytes back to text).
 */
export function codePoints(buf: Buffer): number {
  let count = 0;
  for (const byte of buf) {
    if ((byte & 0xc0) !== 0x80) count += 1;
  }
  return count;
}

type Escape = { length: number } | "incomplete";

/**
 * Length of the escape sequence starting at `start`, or "incomplete" when the
 * chunk ends inside a sequence (the caller keeps the tail as pending input).
 */
function escapeSequenceAt(data: string, start: number): Escape {
  if (start + 1 >= data.length) return "incomplete";
  const kind = data[start + 1];
  if (kind === "[") {
    // CSI: parameter and intermediate bytes, then one final byte in 0x40-0x7e.
    for (let i = start + 2; i < data.length; i += 1) {
      const code = data.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return { length: i - start + 1 };
      if (code < 0x20 || code > 0x3f) return { length: i - start }; // malformed prefix
    }
    return "incomplete";
  }
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
    // OSC/APC/PM strings end with BEL or ST (ESC \).
    for (let i = start + 2; i < data.length; i += 1) {
      const code = data.charCodeAt(i);
      if (code === 0x07) return { length: i - start + 1 };
      if (code === 0x1b) {
        if (i + 1 >= data.length) return "incomplete";
        return { length: data[i + 1] === "\\" ? i - start + 2 : i - start };
      }
    }
    return "incomplete";
  }
  if (kind === "O") {
    // SS3: ESC O <final byte>.
    return start + 2 >= data.length ? "incomplete" : { length: 3 };
  }
  const code = data.charCodeAt(start + 1);
  if (code >= 0x20 && code <= 0x7e) return { length: 2 }; // Alt+key
  return { length: 1 };
}

/**
 * Buffer-backed masked password field. The bytes are never converted back to a
 * string; rendering counts code points and `take()` hands the caller the raw
 * bytes once.
 */
export class PasswordField implements Component, Focusable {
  #bytes: Buffer = Buffer.alloc(0);
  /** Tail of a chunk that ended inside an escape or UTF-8 sequence. */
  #pending = "";
  #pasting = false;
  #focused = false;

  onSubmit?: () => void;
  onEscape?: () => void;

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
  }

  handleInput(data: string): void {
    if (data.length === 0) return;
    const input = this.#pending + data;
    this.#pending = "";
    let text = "";
    const flushText = (): void => {
      if (text.length === 0) return;
      const values = text;
      text = "";
      const last = values.charCodeAt(values.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        // High surrogate split across chunks: wait for its pair.
        this.#pending = values.slice(-1) + this.#pending;
        this.#append(values.slice(0, -1));
        return;
      }
      this.#append(values);
    };

    let i = 0;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      if (code === 0x1b) {
        if (i === input.length - 1) {
          // pi-tui hands a lone ESC chunk to components as the Escape key.
          flushText();
          this.clear();
          this.onEscape?.();
          i += 1;
          continue;
        }
        const seq = escapeSequenceAt(input, i);
        if (seq === "incomplete") {
          this.#pending = input.slice(i);
          i = input.length;
          break;
        }
        if (input.startsWith(PASTE_START, i)) this.#pasting = true;
        else if (input.startsWith(PASTE_END, i)) this.#pasting = false;
        i += seq.length; // other escape sequences (arrows, home, ...) are ignored
        continue;
      }
      if (this.#pasting) {
        // Pasted text is taken literally, CR/LF included; take() truncates at the first one.
        text += input[i];
        i += 1;
        continue;
      }
      if (code === BACKSPACE || code === 0x08) {
        flushText();
        this.#dropLastSequence();
        i += 1;
        continue;
      }
      if (code === 0x15) {
        flushText();
        this.clear();
        i += 1;
        continue;
      }
      if (code === CR || code === LF) {
        flushText();
        i += 1;
        this.onSubmit?.();
        continue;
      }
      if (code < 0x20) {
        i += 1; // other control keys are not printable text
        continue;
      }
      text += input[i];
      i += 1;
    }
    flushText();
  }

  invalidate(): void {
    // Nothing cached.
  }

  render(width: number, prompt: string = PROMPT): string[] {
    const n = codePoints(this.#bytes);
    const room = Math.max(1, width - PROMPT.length - 2);
    const bullets = BULLET.repeat(Math.min(n, room)) + (n > room ? ELLIPSIS : "");
    const cursor = this.#focused ? CURSOR_MARKER + renderFakeCursor(" ") : "";
    return [truncateToWidth(`${prompt}${bullets}${cursor}`, width)];
  }

  /** Bytes typed so far, cut at the first CR/LF. The field is zeroed either way. */
  take(): Buffer {
    const end = this.#bytes.findIndex((b) => b === LF || b === CR);
    const secret = Buffer.from(end === -1 ? this.#bytes : this.#bytes.subarray(0, end));
    this.#bytes.fill(0);
    this.#bytes = Buffer.alloc(0);
    return secret;
  }

  clear(): void {
    this.#bytes.fill(0);
    this.#bytes = Buffer.alloc(0);
  }

  #append(text: string): void {
    if (text.length === 0) return;
    const added = Buffer.from(text, "utf8");
    const previous = this.#bytes;
    this.#bytes = Buffer.concat([previous, added]);
    // Buffer.concat copies, so the two inputs are dead weight: clear them.
    previous.fill(0);
    added.fill(0);
  }

  #dropLastSequence(): void {
    const bytes = this.#bytes;
    let end = bytes.length;
    if (end === 0) return;
    end -= 1;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    this.#bytes = Buffer.from(bytes.subarray(0, end));
    bytes.fill(0);
  }
}
