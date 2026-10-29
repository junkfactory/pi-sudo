import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createApprovalDialog,
  createEscalationDialog,
  sanitizeForDisplay,
  sanitizeNote,
  type ApprovalDialog,
  type ApprovalOutcome,
  type DialogTheme,
  type EscalationAnswer,
} from "../src/dialog.js";

const WIDTH = 60;
const CURSOR = "\u001b_pi:c";

const plainTheme: DialogTheme = {
  fg: (_color, text) => text,
};

/** pi-tui hides its fake cursor in ESC _pi:…BEL markers inside the text. */
const plain = (line: string): string => line.replace(/\u001b_pi:[^\u0007]*\u0007/g, "");

interface Harness {
  dialog: ApprovalDialog;
  settled: () => boolean;
  result: () => ApprovalOutcome | undefined;
}

function harness(
  command: string,
  reason = "free disk space",
  options: { warm?: boolean; fingerprint?: boolean } = {},
): Harness {
  let settled = false;
  let result: ApprovalOutcome | undefined;
  const dialog = createApprovalDialog({
    command,
    reason,
    warm: options.warm ?? false,
    fingerprint: options.fingerprint,
    theme: plainTheme,
    done: (value) => {
      settled = true;
      result = value;
    },
  });
  return { dialog, settled: () => settled, result: () => result };
}

const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const HOME = "\x1b[H";
const END = "\x1b[4~";

describe("sanitizeForDisplay", () => {
  it("renders escape sequences instead of hiding the text inside them", () => {
    const command = "rm -rf \x1b[2J/tmp/x\x1b[31m\x1b]0;hidden-title\x07 done";
    const sanitized = sanitizeForDisplay(command);
    assert.ok(!sanitized.includes("\x1b"), JSON.stringify(sanitized));
    assert.equal(
      sanitized,
      "rm -rf <U+001B>[2J/tmp/x<U+001B>[31m<U+001B>]0;hidden-title<U+0007> done",
    );
    // Every byte the shell will see is on screen, including OSC bodies.
    assert.ok(sanitized.includes("hidden-title"));
  });

  it("cannot hide a shell line inside an escape sequence", () => {
    // This is the shape that used to render as "true<LF>" while the shell ran
    // the hidden redirect on the next line.
    const command = "true\n\x1b]x\n: > /tmp/pi-sudo-hidden\n#\x07";
    const sanitized = sanitizeForDisplay(command);
    assert.ok(!sanitized.includes("\x1b"), JSON.stringify(sanitized));
    assert.ok(sanitized.includes(": > /tmp/pi-sudo-hidden"), sanitized);
    assert.equal(sanitized.startsWith("true<LF>"), true);
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

  it("renders C0, DEL, and C1 control bytes as markers", () => {
    assert.equal(
      sanitizeForDisplay("a\x00\x07\x7f\x9bb"),
      "a<U+0000><U+0007><U+007F><U+009B>b",
    );
  });
});

describe("ApprovalDialog", () => {
  it("renders the escaped and bidi-laden command without reordering it", () => {
    const command = "echo \x1b[2Jsafe \u202Ereversed\u202C tail";
    const { dialog } = harness(command);
    const rendered = plain(dialog.render(WIDTH).join("\n"));

    // truncateToWidth adds its own SGR resets; after removing those no escape
    // byte from the command may survive.
    const withoutSgr = rendered.replace(/\u001b\[[0-9;]*m/g, "");
    assert.ok(!withoutSgr.includes("\x1b"), withoutSgr);
    assert.ok(!/[\u202a-\u202e\u200b-\u200f\u2066-\u2069]/u.test(rendered), rendered);
    assert.ok(rendered.includes("echo <U+001B>[2Jsafe "), rendered);
    assert.ok(rendered.includes("U+202E"));
    assert.ok(rendered.indexOf("safe") < rendered.indexOf("reversed"));
    assert.ok(rendered.indexOf("reversed") < rendered.indexOf("tail"));
  });

  it("draws a bordered frame titled with the request title at a fixed width", () => {
    const { dialog } = harness("id");
    const lines = dialog.render(WIDTH).map(plain);
    assert.ok(lines[0].includes("\u03c0 sudo: Requesting root privilege"), lines[0]);
    assert.ok(lines[0].startsWith("\u256d\u2500"), lines[0]);
    // The dash run must reach the corner: a space there reads as a broken line.
    assert.ok(lines[0].endsWith("\u2500\u256e"), JSON.stringify(lines[0]));
    assert.ok(lines[lines.length - 1].startsWith("\u2570"), lines[lines.length - 1]);
    for (const line of lines) {
      assert.equal(visibleWidth(line), WIDTH, JSON.stringify(line));
    }
  });

  it("selects Yes, once by default", () => {
    const lines = harness("id").dialog.render(WIDTH).map(plain);
    assert.ok(lines.some((line) => line.includes("\u2192 Yes, once")), lines.join("\n"));
    assert.equal(lines.some((line) => line.includes("\u2192 No")), false);
  });

  it("moves the selection with up and down and clamps at both ends", () => {
    const h = harness("id");
    const selected = (): string =>
      h.dialog
        .render(WIDTH)
        .map(plain)
        .find((line) => line.includes("\u2192")) ?? "";
    assert.ok(selected().includes("\u2192 Yes, once"), selected());
    h.dialog.handleInput(UP);
    assert.ok(selected().includes("\u2192 Yes, once"), "up at the top stays on the first option");
    h.dialog.handleInput(DOWN);
    assert.ok(selected().includes("\u2192 Yes, until sudo asks again"), selected());
    h.dialog.handleInput(DOWN);
    assert.ok(selected().includes("\u2192 No"), selected());
    h.dialog.handleInput(DOWN);
    assert.ok(selected().includes("\u2192 No"), "down at the bottom stays on No");
    h.dialog.handleInput(UP);
    assert.ok(selected().includes("\u2192 Yes, until sudo asks again"), selected());
    h.dialog.handleInput(UP);
    assert.ok(selected().includes("\u2192 Yes, once"), selected());
  });

  it("scrolls the preview with shift+up/down, PgUp/PgDn, and Home without moving the selection", () => {
    const command = `echo ${"needle ".repeat(200)}`;
    const h = harness(command);
    const view = (): string[] => h.dialog.render(WIDTH).map(plain);
    const header = (): string => view().find((line) => line.includes("Command")) ?? "";
    const arrow = (): string => view().find((line) => line.includes("\u2192")) ?? "";

    const first = header();
    assert.match(first, /lines 1-/);
    h.dialog.handleInput(SHIFT_DOWN);
    assert.notEqual(header(), first);
    assert.match(header(), /lines 11-/);

    const afterShiftDown = header();
    h.dialog.handleInput(PAGE_DOWN);
    assert.notEqual(header(), afterShiftDown);

    const afterPageDown = header();
    h.dialog.handleInput(SHIFT_UP);
    assert.notEqual(header(), afterPageDown);

    const afterShiftUp = header();
    h.dialog.handleInput(PAGE_UP);
    assert.notEqual(header(), afterShiftUp);

    h.dialog.handleInput(HOME);
    assert.equal(header(), first);
    // The options only appear at the end, and the selection never moved.
    h.dialog.handleInput(END);
    assert.ok(arrow().includes("Yes, once"), "scrolling must not move the selection");
  });

  it("keeps Enter inert until the preview reaches its end", () => {
    const command = `echo ${"needle ".repeat(200)}`;
    const h = harness(command);
    const rendered = h.dialog.render(WIDTH).map(plain).join("\n");
    assert.equal(h.dialog.sawEnd, false);
    // The footer carries the requirement, and the options are not on screen yet.
    assert.ok(
      rendered.includes("You must read the full command to make a decision:"),
      rendered,
    );
    assert.equal(rendered.includes("Yes, once"), false, "options stay hidden until the end");
    // The frame keeps the same shape while the gate is closed: the divider sits
    // under the preview, then a blank row, the hint, blank rows where the options
    // and the password row will be, and the navigation footer.
    const lines = h.dialog.render(WIDTH).map(plain);
    const dividerAt = lines.findIndex((line) => line.startsWith("├"));
    const readAt = lines.findIndex((line) => line.includes("You must read the full command"));
    const keysAt = lines.findIndex((line) => line.includes("shift+↑↓ scroll"));
    assert.equal(dividerAt, readAt - 2, "the divider and a blank row sit above the hint");
    assert.equal(lines[readAt].startsWith("│   You must read"), true, "hint aligns with the option labels");
    // The whole sentence survives a narrow terminal instead of being truncated.
    assert.ok(
      lines.slice(readAt, readAt + 3).join(" ").includes("scroll to the bottom"),
      "the hint must ask for a scroll to the bottom",
    );
    assert.equal(keysAt, readAt + 4, "two blank rows and the password slot sit above the footer");
    assert.equal(lines[keysAt + 1].startsWith("╰"), true);
    // Opening the gate must not resize the frame, on its own dialog so the scroll
    // position of this one stays where the assertions below expect it.
    const growth = harness(command);
    const gatedHeight = growth.dialog.render(WIDTH).length;
    growth.dialog.handleInput(END);
    assert.equal(growth.dialog.render(WIDTH).length, gatedHeight, "no growth when the options appear");

    h.dialog.handleInput("hunter2");
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), false, "Enter before scrolling must not approve");

    h.dialog.handleInput(PAGE_DOWN);
    h.dialog.render(WIDTH);
    assert.equal(h.dialog.sawEnd, false, "one page is not the end");
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), false);

    h.dialog.handleInput(END);
    h.dialog.render(WIDTH);
    assert.equal(h.dialog.sawEnd, true);
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), true);
    assert.deepEqual(h.result(), {
      approved: true,
      mode: "once",
      password: Buffer.from("hunter2"),
    });
  });

  it("re-arms the scroll gate after Home returns to the start", () => {
    const command = `echo ${"needle ".repeat(200)}`;
    const h = harness(command);
    h.dialog.render(WIDTH);
    h.dialog.handleInput("hunter2");
    h.dialog.handleInput(END);
    h.dialog.render(WIDTH);
    assert.equal(h.dialog.sawEnd, true);
    h.dialog.handleInput(HOME);
    h.dialog.render(WIDTH);
    assert.equal(h.dialog.sawEnd, false);
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), false);
  });

  it("starts with the password field focused, so typing fills it", () => {
    const h = harness("id");
    h.dialog.focused = true;
    assert.equal(h.dialog.field.focused, true);
    // The cursor marker proves the field, not the choice row, owns the keystrokes.
    assert.ok(plain(h.dialog.render(WIDTH).join("\n")).includes("Password:"));
    h.dialog.handleInput("hunter2");
    assert.equal(h.dialog.field.take().toString(), "hunter2");
  });

  it("approves once with the typed password on Enter", () => {
    const h = harness("id");
    h.dialog.focused = true;
    h.dialog.handleInput("hunter2");
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), true);
    assert.deepEqual(h.result(), {
      approved: true,
      mode: "once",
      password: Buffer.from("hunter2"),
    });
  });

  it("approves the ticket-wide option once down selects it", () => {
    const h = harness("id");
    h.dialog.handleInput("hunter2");
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput(ENTER);
    assert.deepEqual(h.result(), {
      approved: true,
      mode: "ticket",
      password: Buffer.from("hunter2"),
    });
  });

  it("routes typing to the reason field while No is selected", () => {
    const h = harness("id");
    h.dialog.render(WIDTH);
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput("needs an audit trail");
    const noLine = h.dialog
      .render(WIDTH)
      .map(plain)
      .find((line) => line.includes("\u2192 No"));
    assert.ok(noLine?.includes("[ needs an audit trail"), noLine);
    h.dialog.handleInput(ENTER);
    assert.deepEqual(h.result(), { approved: false, note: "needs an audit trail" });
  });

  it("shows the denial placeholder on the selected No row", () => {
    const h = harness("id");
    h.dialog.render(WIDTH);
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput(DOWN);
    const lines = h.dialog.render(WIDTH).map(plain);
    const noLine = lines.find((line) => line.includes("\u2192 No"));
    assert.ok(noLine?.includes("enter reason for denial (optional)"), noLine);
    for (const line of lines) {
      assert.equal(visibleWidth(line), WIDTH, JSON.stringify(line));
    }
  });

  it("sanitizes the typed reason to one line and caps it", () => {
    const h = harness("id");
    h.dialog.render(WIDTH);
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput("line one\u202Eline two");
    h.dialog.handleInput(ENTER);
    assert.deepEqual(h.result(), { approved: false, note: "line one line two" });

    const capped = harness("id");
    capped.dialog.render(WIDTH);
    capped.dialog.handleInput(DOWN);
    capped.dialog.handleInput(DOWN);
    capped.dialog.handleInput("x".repeat(600));
    capped.dialog.handleInput(ENTER);
    const outcome = capped.result();
    assert.ok(outcome !== undefined && !outcome.approved, "expected a denial");
    assert.equal(outcome.note.length, 500);
    assert.equal(outcome.note, "x".repeat(500));
  });

  it("keeps the typed password when switching to No and back to Yes", () => {
    const h = harness("id");
    h.dialog.render(WIDTH);
    h.dialog.handleInput("hunter2");
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput("not now");
    h.dialog.handleInput(UP);
    h.dialog.handleInput(UP);
    const passwordRow = h.dialog
      .render(WIDTH)
      .map(plain)
      .find((line) => line.includes("Password:"));
    assert.ok(passwordRow?.includes("\u2022".repeat(7)), passwordRow);
    assert.equal(passwordRow?.includes("not now"), false, passwordRow);
    h.dialog.handleInput(ENTER);
    assert.deepEqual(h.result(), {
      approved: true,
      mode: "once",
      password: Buffer.from("hunter2"),
    });
  });

  it("keeps the dialog open with a red prompt when Enter has no password", () => {
    // A slip of the finger must not deny the request: the prompt answers instead.
    const marked: DialogTheme = {
      fg: (color, text) => (color === "error" ? `[E]${text}` : text),
    };
    let result: ApprovalOutcome | undefined;
    const dialog = createApprovalDialog({
      command: "id",
      reason: "root",
      warm: false,
      theme: marked,
      done: (value) => {
        result = value;
      },
    });
    const text = (): string => dialog.render(WIDTH).map(plain).join("\n");
    dialog.render(WIDTH);
    dialog.handleInput(ENTER);
    assert.equal(result, undefined, "an empty password must not deny");
    assert.ok(text().includes("[E]Password: "), "the prompt turns red");
    dialog.handleInput("h");
    assert.equal(text().includes("[E]Password: "), false, "the alert clears on the next key");
    dialog.handleInput(ESC);
    assert.deepEqual(result, { approved: false, note: "" });
  });

  it("declines on Esc with an empty note and clears both fields", () => {
    const h = harness("id");
    h.dialog.render(WIDTH);
    h.dialog.handleInput("hunter2");
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput("half typed reason");
    h.dialog.handleInput(ESC);
    assert.equal(h.settled(), true);
    assert.deepEqual(h.result(), { approved: false, note: "" });
    assert.deepEqual(h.dialog.field.take(), Buffer.alloc(0));
    const noLine = h.dialog
      .render(WIDTH)
      .map(plain)
      .find((line) => line.includes("\u2192 No"));
    assert.ok(noLine?.includes("enter reason for denial (optional)"), noLine);
    assert.equal(noLine?.includes("half typed reason"), false, noLine);
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

  it("starts focused and propagates focus to the password field", () => {
    const h = harness("id");
    assert.equal(h.dialog.focused, true);
    assert.equal(h.dialog.field.focused, true);
    h.dialog.focused = false;
    assert.equal(h.dialog.field.focused, false);
    h.dialog.focused = true;
    assert.equal(h.dialog.field.focused, true);
  });
});

describe("ApprovalDialog (warm ticket)", () => {
  it("renders no password prompt and no masked field", () => {
    const h = harness("id", "free disk space", { warm: true });
    const rendered = plain(h.dialog.render(WIDTH).join("\n"));
    assert.equal(rendered.includes("Password:"), false, rendered);
    assert.equal(rendered.includes("\u2022"), false, rendered);
    assert.ok(rendered.includes("Yes, once"), rendered);
    assert.ok(rendered.includes("Yes, until sudo asks again"), rendered);
  });

  it("approves once with a zero-length password without typing", () => {
    const h = harness("id", "free disk space", { warm: true });
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), true);
    assert.deepEqual(h.result(), {
      approved: true,
      mode: "once",
      password: Buffer.alloc(0),
    });
  });

  it("approves the ticket-wide option after down", () => {
    const h = harness("id", "free disk space", { warm: true });
    h.dialog.handleInput(DOWN);
    h.dialog.handleInput(ENTER);
    assert.deepEqual(h.result(), {
      approved: true,
      mode: "ticket",
      password: Buffer.alloc(0),
    });
  });

  it("denies on Esc with an empty note", () => {
    const h = harness("id", "free disk space", { warm: true });
    h.dialog.handleInput(ESC);
    assert.equal(h.settled(), true);
    assert.deepEqual(h.result(), { approved: false, note: "" });
  });
});

describe("ApprovalDialog (fingerprint)", () => {
  it("shows the reader hint only when cold and flagged", () => {
    const offered = plain(harness("id", "free disk space", { fingerprint: true }).dialog.render(WIDTH).join("\n"));
    assert.ok(offered.includes("empty password: authenticate with the"), offered);
    assert.ok(offered.includes("fingerprint"), offered);
    // Wrapping may split the sentence, so only the stable prefix is asserted.
    assert.ok(offered.includes("fallback if the reader"), offered);
    assert.ok(offered.includes("Password:"), offered);
  });

  it("renders no reader hint without the flag or when the ticket is warm", () => {
    const cold = plain(harness("id").dialog.render(WIDTH).join("\n"));
    assert.equal(cold.includes("fingerprint"), false, cold);
    const warm = plain(
      harness("id", "free disk space", { warm: true, fingerprint: true }).dialog.render(WIDTH).join("\n"),
    );
    assert.equal(warm.includes("fingerprint"), false, warm);
  });

  it("approves with an empty password on Enter when the reader is offered", () => {
    const h = harness("id", "free disk space", { fingerprint: true });
    h.dialog.handleInput(ENTER);
    assert.equal(h.settled(), true);
    assert.deepEqual(h.result(), {
      approved: true,
      mode: "once",
      password: Buffer.alloc(0),
    });
  });

  it("keeps the red-prompt alert on an empty Enter without the reader flag", () => {
    const marked: DialogTheme = {
      fg: (color, text) => (color === "error" ? `[E]${text}` : text),
    };
    let result: ApprovalOutcome | undefined;
    const dialog = createApprovalDialog({
      command: "id",
      reason: "root",
      warm: false,
      fingerprint: false,
      theme: marked,
      done: (value) => {
        result = value;
      },
    });
    const text = (): string => dialog.render(WIDTH).map(plain).join("\n");
    dialog.render(WIDTH);
    dialog.handleInput(ENTER);
    assert.equal(result, undefined, "an empty password must not deny");
    assert.ok(text().includes("[E]Password: "), "the prompt turns red");
    dialog.handleInput(ESC);
    assert.deepEqual(result, { approved: false, note: "" });
  });

  it("keeps the closed gate exactly as tall as the open state, with and without the reader hint", () => {
    const command = `echo ${"needle ".repeat(200)}`;
    for (const fingerprint of [false, true]) {
      const growth = harness(command, "free disk space", { fingerprint });
      const gatedHeight = growth.dialog.render(WIDTH).length;
      growth.dialog.handleInput(END);
      assert.equal(
        growth.dialog.render(WIDTH).length,
        gatedHeight,
        `no growth when the options appear (fingerprint: ${fingerprint})`,
      );
      const open = growth.dialog.render(WIDTH).map(plain).join("\n");
      assert.equal(
        open.includes("fingerprint") === fingerprint,
        true,
        `the reader hint matches the flag (fingerprint: ${fingerprint})`,
      );
    }
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
    assert.equal(lines.some((line) => line.includes("optional note")), false);
  });

  it("stacks the options and shows the note field only on the No line", () => {
    const { dialog } = escalation();
    const lines = dialog.render(WIDTH);
    const yes = lines.findIndex((line) => line.includes("\u2192 Yes"));
    const no = lines.findIndex((line) => line.includes("  No"));
    assert.equal(no, yes + 1);

    dialog.handleInput("\u001b[B");
    const noLine = plain(dialog.render(WIDTH).find((line) => line.includes("\u2192 No")) ?? "");
    assert.ok(noLine.includes("[ optional note for the model"));
    assert.ok(noLine.trimEnd().endsWith("]"));

    dialog.handleInput("because /etc/x is shared");
    const typed = plain(dialog.render(WIDTH).find((line) => line.includes("\u2192 No")) ?? "");
    assert.ok(typed.includes("because /etc/x is shared"));
    assert.ok(typed.trimEnd().endsWith("]"));
  });

  it("approves on Enter and ignores the note", () => {
    const { dialog, answer } = escalation();
    dialog.handleInput("a stray note");
    dialog.handleInput("\r");
    assert.deepEqual(answer(), { approved: true, note: "" });
  });

  it("keeps the note field inert while Yes is selected", () => {
    const { dialog, answer } = escalation();
    dialog.handleInput("typed before choosing No");
    dialog.handleInput("\u001b[B");
    dialog.handleInput("\r");
    assert.deepEqual(answer(), { approved: false, note: "" });
  });

  it("focuses the note field only while No is selected", () => {
    const { dialog } = escalation();
    assert.equal(
      dialog.render(WIDTH).some((line) => line.includes(CURSOR)),
      false,
    );
    dialog.handleInput("\u001b[B");
    assert.equal(
      dialog.render(WIDTH).some((line) => line.includes(CURSOR)),
      true,
    );
    dialog.handleInput("\t");
    assert.equal(
      dialog.render(WIDTH).some((line) => line.includes(CURSOR)),
      false,
    );
  });

  it("returns the note only when No was the confirmed option", () => {
    const typed = escalation();
    typed.dialog.handleInput("\t");
    typed.dialog.handleInput("because /etc/x is shared");
    typed.dialog.handleInput("\r");
    assert.deepEqual(typed.answer(), {
      approved: false,
      note: "because /etc/x is shared",
    });

    const switched = escalation();
    switched.dialog.handleInput("\t");
    switched.dialog.handleInput("not if you approve");
    switched.dialog.handleInput("\t");
    switched.dialog.handleInput("\r");
    assert.deepEqual(switched.answer(), { approved: true, note: "" });
  });

  it("keeps typed text when toggling back to No", () => {
    const { dialog, answer } = escalation();
    dialog.handleInput("\t");
    dialog.handleInput("kept");
    dialog.handleInput("\t");
    dialog.handleInput("\u001b[B");
    dialog.handleInput("\r");
    assert.deepEqual(answer(), { approved: false, note: "kept" });
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
    assert.equal(sanitizeNote("a\nb\u001b[31mred"), "a b [31mred");
    assert.equal(sanitizeNote("\u202Eevil\u202C"), "evil");
    assert.equal(sanitizeNote("   "), "");
  });
});
