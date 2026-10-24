import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createApprovalDialog,
  createEscalationDialog,
  sanitizeForDisplay,
  sanitizeNote,
  type ApprovalDialog,
  type DialogTheme,
  type EscalationAnswer,
} from "../src/dialog.js";

const WIDTH = 60;

const plainTheme: DialogTheme = {
  fg: (_color, text) => text,
};

interface Harness {
  dialog: ApprovalDialog;
  settled: () => boolean;
  result: () => Buffer | undefined;
}

function harness(command: string, reason = "free disk space", errorText?: string): Harness {
  let settled = false;
  let result: Buffer | undefined;
  const dialog = createApprovalDialog({
    command,
    reason,
    errorText,
    theme: plainTheme,
    done: (value) => {
      settled = true;
      result = value;
    },
  });
  return { dialog, settled: () => settled, result: () => result };
}

const PAGE_DOWN = "\x1b[6~";
const ENTER = "\r";
const ESC = "\x1b";

describe("sanitizeForDisplay", () => {
  it("strips ANSI/CSI/OSC so escapes cannot hide text", () => {
    const command = "rm -rf \x1b[2J/tmp/x\x1b[31m\x1b]0;hidden-title\x07 done";
    const sanitized = sanitizeForDisplay(command);
    assert.ok(!sanitized.includes("\x1b"), JSON.stringify(sanitized));
    assert.equal(sanitized, "rm -rf /tmp/x done");
    assert.ok(!sanitized.includes("hidden-title"));
  });

  it("renders bidi and invisible format characters as visible markers", () => {
    const command = "rm \u202Eevil\u202C \u200B\uFEFF\u2066gone\u2069 \u00ADok";
    const sanitized = sanitizeForDisplay(command);
    assert.ok(!/[\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u.test(sanitized));
    assert.ok(sanitized.includes("rm "));
    assert.ok(sanitized.includes("evil"));
    assert.ok(sanitized.includes("U+202E"));
    assert.ok(sanitized.includes("U+200B"));
    assert.ok(sanitized.includes("U+FEFF"));
    assert.ok(sanitized.indexOf("evil") > sanitized.indexOf("rm "));
  });

  it("shows CR/LF visibly and expands tabs to two spaces", () => {
    assert.equal(sanitizeForDisplay("a\tb"), "a  b");
    assert.equal(sanitizeForDisplay("a\r\nb"), "a<CR><LF>b");
  });

  it("drops C0, DEL, and C1 control bytes", () => {
    assert.equal(sanitizeForDisplay("a\x00\x07\x7f\x9bb"), "ab");
  });
});

describe("ApprovalDialog", () => {
  it("renders the escaped and bidi-laden command without reordering it", () => {
    const command = "echo \x1b[2Jsafe \u202Ereversed\u202C tail";
    const { dialog } = harness(command);
    const rendered = dialog.render(WIDTH).join("\n");

    assert.ok(!rendered.includes("\x1b"), rendered);
    assert.ok(!/[\u202a-\u202e\u200b-\u200f\u2066-\u2069]/u.test(rendered), rendered);
    assert.ok(rendered.includes("echo safe "));
    assert.ok(rendered.includes("U+202E"));
    assert.ok(rendered.indexOf("safe") < rendered.indexOf("reversed"));
    assert.ok(rendered.indexOf("reversed") < rendered.indexOf("tail"));
  });

  it("cannot approve an overflowing command until it is scrolled to the end", () => {
    const command = `echo ${"needle ".repeat(200)}`;
    const h = harness(command);
    h.dialog.render(WIDTH);
    assert.equal(h.dialog.sawEnd, false);

    h.dialog.handleInput("hunter2");
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), false, "Enter before scrolling must not approve");

    h.dialog.handleInput(PAGE_DOWN);
    h.dialog.render(WIDTH);
    assert.equal(h.dialog.sawEnd, false, "one page is not the end");
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), false);

    // Page down until the preview reaches its last line.
    for (let i = 0; i < 10 && !h.dialog.sawEnd; i += 1) {
      h.dialog.handleInput(PAGE_DOWN);
      h.dialog.render(WIDTH);
    }
    assert.equal(h.dialog.sawEnd, true);

    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), true);
    assert.deepEqual(h.result(), Buffer.from("hunter2", "utf8"));
  });

  it("resolves undefined on an empty submit", () => {
    const h = harness("id");
    h.dialog.render(WIDTH);
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), true);
    assert.equal(h.result(), undefined);
  });

  it("resolves undefined on Esc and zeroes the typed bytes", () => {
    const h = harness("id");
    h.dialog.render(WIDTH);
    h.dialog.field.handleInput("secret");
    h.dialog.handleInput(ESC);
    assert.equal(h.settled(), true);
    assert.equal(h.result(), undefined);
    assert.deepEqual(h.dialog.field.take(), Buffer.alloc(0));
  });

  it("renders the model's reason on one line", () => {
    const reason = "free disk space\nsecond line \u202Eevil\u202C";
    const h = harness("id", reason);
    const lines = h.dialog.render(100);
    const reasonLines = lines.filter((line) => line.includes("Reason:"));

    assert.equal(reasonLines.length, 1);
    assert.ok(reasonLines[0].includes("free disk space"));
    assert.ok(reasonLines[0].includes("<LF>"));
    assert.ok(reasonLines[0].includes("second line"));
    assert.ok(reasonLines[0].includes("U+202E"));
    assert.ok(!reasonLines[0].includes("\u202e"));
    assert.ok(!lines.some((line) => line.trim() === "second line"));
  });

  it("propagates focus to the password field", () => {
    const h = harness("id");
    assert.equal(h.dialog.focused, false);
    h.dialog.focused = true;
    assert.equal(h.dialog.field.focused, true);
    h.dialog.focused = false;
    assert.equal(h.dialog.field.focused, false);
  });
});

describe("EscalationDialog", () => {
  const redTheme: DialogTheme = {
    fg: (color, text) => (color === "error" ? `\u001b[31m${text}\u001b[39m` : text),
  };

  function escalation(theme: DialogTheme = plainTheme): {
    dialog: ReturnType<typeof createEscalationDialog>;
    answer: () => EscalationAnswer | undefined;
  } {
    let answer: EscalationAnswer | undefined;
    const dialog = createEscalationDialog({
      theme,
      done: (value) => {
        answer = value;
      },
    });
    return { dialog, answer: () => answer };
  }

  it("shows the pi symbol, the red warning, and a preselected Yes", () => {
    const { dialog } = escalation(redTheme);
    const lines = dialog.render(WIDTH);
    assert.equal(lines[0], "\u03c0 sudo: lasting privilege change");
    assert.ok(lines.some((line) => line.includes("Run it anyway?")));
    assert.ok(lines.some((line) => line.includes("\u001b[31m")));
    assert.ok(lines.some((line) => line.includes("\u2192 Yes")));
    assert.ok(lines.some((line) => line.includes("only sent if you decline")));
  });

  it("approves on Enter and ignores the note", () => {
    const { dialog, answer } = escalation();
    dialog.handleInput("a stray note");
    dialog.handleInput("\r");
    assert.deepEqual(answer(), { approved: true, note: "" });
  });

  it("moves to No with Down and returns the typed reason", () => {
    const { dialog, answer } = escalation();
    dialog.handleInput("\u001b[B");
    dialog.handleInput("why does /opt/app need root?");
    dialog.handleInput("\r");
    assert.deepEqual(answer(), {
      approved: false,
      note: "why does /opt/app need root?",
    });
  });

  it("denies on Esc without a note", () => {
    const { dialog, answer } = escalation();
    dialog.handleInput("half typed");
    dialog.handleInput(ESC);
    assert.deepEqual(answer(), { approved: false, note: "" });
  });

  it("strips control characters and keeps the note on one line", () => {
    assert.equal(sanitizeNote("line one\tline two"), "line one line two");
    assert.equal(sanitizeNote("a\nb\u001b[31mred"), "a bred");
    assert.equal(sanitizeNote("\u202Eevil\u202C"), "evil");
    assert.equal(sanitizeNote("   "), "");
  });
});
