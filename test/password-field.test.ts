import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURSOR_MARKER, renderFakeCursor } from "@earendil-works/pi-tui";
import { codePoints, PasswordField } from "../src/password-field.js";

const PROMPT = "Password: ";
const WIDTH = 80;

function body(field: PasswordField): string {
  return field.render(WIDTH)[0].slice(PROMPT.length);
}

function bullets(field: PasswordField): number {
  return [...body(field)].filter((ch) => ch === "•").length;
}

function type(field: PasswordField, value: string): void {
  for (const ch of value) field.handleInput(ch);
}

describe("codePoints", () => {
  it("counts non-continuation bytes", () => {
    assert.equal(codePoints(Buffer.alloc(0)), 0);
    assert.equal(codePoints(Buffer.from("abc", "utf8")), 3);
    assert.equal(codePoints(Buffer.from("äö€", "utf8")), 3);
    assert.equal(codePoints(Buffer.from("x", "utf8").subarray(0, 0)), 0);
  });
});

describe("PasswordField", () => {
  it("renders no character of the value, one bullet per code point", () => {
    const value = "s3cr3t-Pässwörd!€";
    const field = new PasswordField();
    type(field, value);

    const line = field.render(WIDTH)[0];
    const masked = line.slice(PROMPT.length);
    for (const ch of value) {
      assert.ok(!masked.includes(ch), `masked line leaks ${JSON.stringify(ch)}: ${masked}`);
    }
    assert.equal(bullets(field), Array.from(value).length);
    assert.equal(bullets(field), codePoints(Buffer.from(value, "utf8")));
  });

  it("takes the bytes and leaves the field empty", () => {
    const value = "correct horse battery staple";
    const field = new PasswordField();
    type(field, value);
    assert.equal(bullets(field), Array.from(value).length);

    const secret = field.take();
    assert.deepEqual(secret, Buffer.from(value, "utf8"));
    assert.equal(bullets(field), 0);
    assert.deepEqual(field.take(), Buffer.alloc(0));
  });

  it("clears the buffer on Esc and reports it", () => {
    let escapes = 0;
    const field = new PasswordField();
    field.onEscape = () => {
      escapes += 1;
    };
    type(field, "hunter2");
    assert.equal(bullets(field), 7);

    field.handleInput("\x1b");
    assert.equal(escapes, 1);
    assert.equal(bullets(field), 0);
    assert.deepEqual(field.take(), Buffer.alloc(0));
  });

  it("truncates a pasted secret at the first CR or LF", () => {
    for (const newline of ["\r", "\n"]) {
      const field = new PasswordField();
      field.handleInput(`\x1b[200~secret${newline}rest\x1b[201~`);
      assert.deepEqual(field.take(), Buffer.from("secret", "utf8"));
    }
  });

  it("reports Enter without clearing the buffer", () => {
    let submits = 0;
    const field = new PasswordField();
    field.onSubmit = () => {
      submits += 1;
    };
    type(field, "pw");
    field.handleInput("\r");
    assert.equal(submits, 1);
    assert.deepEqual(field.take(), Buffer.from("pw", "utf8"));
  });

  it("shows the cursor marker only when focused", () => {
    const field = new PasswordField();
    type(field, "pw");

    const blurred = field.render(WIDTH)[0];
    assert.ok(!blurred.includes(CURSOR_MARKER));
    assert.ok(!blurred.includes(renderFakeCursor(" ")));

    field.focused = true;
    assert.equal(field.focused, true);
    const focused = field.render(WIDTH)[0];
    assert.ok(focused.includes(CURSOR_MARKER));
    assert.ok(focused.includes(renderFakeCursor(" ")));

    field.focused = false;
    assert.ok(!field.render(WIDTH)[0].includes(CURSOR_MARKER));
  });

  it("clamps bullets to the width and stays within it", () => {
    const field = new PasswordField();
    type(field, "abcdefghijklmnopqrstuvwxyz");
    const line = field.render(20)[0];
    assert.ok(line.length <= 20);
    assert.ok(line.includes("…"));
  });

  it("keeps a split escape sequence and a split UTF-8 sequence intact", () => {
    const field = new PasswordField();
    field.handleInput("\x1b[20"); // bracketed-paste start split before its final byte
    assert.equal(bullets(field), 0);
    field.handleInput("0~pä");
    field.handleInput("ss\x1b[201~");
    assert.deepEqual(field.take(), Buffer.from("päss", "utf8"));

    const typed = new PasswordField();
    const emoji = "😀"; // surrogate pair, delivered as two chunks
    typed.handleInput(emoji.slice(0, 1));
    assert.equal(bullets(typed), 0);
    typed.handleInput(emoji.slice(1));
    assert.deepEqual(typed.take(), Buffer.from(emoji, "utf8"));
  });
});
