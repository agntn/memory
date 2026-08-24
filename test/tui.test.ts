import { describe, expect, it } from "vitest";
import {
  describeToolCall,
  describeToolResult,
  renderStatusLine,
  renderToolResult,
  sanitizeTerminalText,
} from "../packages/shared/tui.ts";

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const C1 = String.fromCharCode(155);

/** A theme that marks every color, so a test can see what got painted. */
const painted = {
  fg: (color: string, text: string) => `<${color}>${text}`,
  bold: (text: string) => `<b>${text}`,
};

/** Both theme methods are optional, so a bare object has to render too. */
const plain = {};

describe("call lines", () => {
  it("leads with the question and keeps the profile as a fact", () => {
    const line = describeToolCall("Recall", {
      namespace: "default",
      profile: "oritwoen",
      query: "what do I know about TUI rendering",
      thinkingLevel: "medium",
    });

    expect(line.title).toBe("Recall");
    expect(line.description).toBe("what do I know about TUI rendering");
    expect(line.meta).toEqual(["default/oritwoen", "thinkingLevel=medium"]);
  });

  it("falls back to the profile when the call has no subject of its own", () => {
    const line = describeToolCall("List Memories", {
      namespace: "default",
      profile: "oritwoen",
      limit: 25,
    });

    expect(line.description).toBe("default/oritwoen");
    expect(line.meta).toEqual(["limit=25"]);
  });

  it("describes a namespace call by its namespace alone", () => {
    const line = describeToolCall("Create Memory Namespace", { namespace: "scratch" });

    expect(line.description).toBe("scratch");
    expect(line.meta).toBeUndefined();
  });

  it("counts the messages handed to ingestion", () => {
    const line = describeToolCall("Ingest Messages", {
      namespace: "default",
      profile: "oritwoen",
      messages: [{ content: "one" }, { content: "two" }, { content: "three" }],
    });

    expect(line.meta).toEqual(["messages 3"]);
  });

  it("carries no icon when the harness reports no state", () => {
    expect(describeToolCall("Recall", { query: "q" }).icon).toBeUndefined();
  });

  it("reads the running state from either harness", () => {
    expect(describeToolCall("Recall", {}, { isPartial: true }).icon).toBe("pending");
    expect(describeToolCall("Recall", {}, { isPartial: true, spinnerFrame: 2 }).icon).toBe(
      "running",
    );
    expect(describeToolCall("Recall", {}, { isPartial: true, executionStarted: true }).icon).toBe(
      "running",
    );
    expect(describeToolCall("Recall", {}, { isPartial: false }).icon).toBe("done");
  });

  it("cuts a long subject down to one field", () => {
    const line = describeToolCall("Recall", { query: "słowo ".repeat(60) });

    expect(line.description).toHaveLength(72);
    expect(line.description?.endsWith("…")).toBe(true);
  });

  it("survives arguments that are not an object", () => {
    expect(describeToolCall("Recall", "not an object").description).toBeUndefined();
    expect(describeToolCall("Recall", undefined).title).toBe("Recall");
  });

  it("strips terminal control sequences out of model arguments", () => {
    const line = describeToolCall("Recall", {
      query: `${ESC}[31mred${ESC}]0;title${BEL}${NUL}text`,
    });

    expect(line.description).toBe("red text");
  });
});

describe("result lines", () => {
  it("names what the service assigned to a stored memory", () => {
    const line = describeToolResult(
      {
        content: [{ type: "text", text: "{}" }],
        details: { id: "01M0", type: "fact", sessionId: "claude-memory-1", summary: "s" },
      },
      false,
    );

    expect(line.icon).toBe("done");
    expect(line.meta).toEqual(["01M0", "type=fact", "sessionId=claude-memory-1"]);
  });

  it("counts a page and says when another one waits", () => {
    const line = describeToolResult(
      { content: [], details: { memories: [{ id: "a" }, { id: "b" }], hasMore: true } },
      false,
    );

    expect(line.meta).toEqual(["memories 2", "more pages"]);
  });

  it("reports a cascade delete, including the counts it could not get", () => {
    const removed = (details: Record<string, unknown>) =>
      describeToolResult({ content: [], details }, false).meta;

    expect(removed({ removedMemories: 0, removedAtLeast: false })).toEqual(["removed 0"]);
    expect(removed({ removedMemories: 5, removedAtLeast: true })).toEqual(["removed at least 5"]);
    expect(removed({ removedMemories: null, removedAtLeast: null })).toEqual([
      "removed an unknown number",
    ]);
  });

  it("puts the failure first and keeps the tool name out of the line", () => {
    const line = describeToolResult(
      { content: [{ type: "text", text: "Memory not found\nid: 01M0" }] },
      true,
    );

    expect(line.icon).toBe("error");
    expect(line.badge).toBe("failed");
    expect(line.description).toBe("Memory not found");
    expect(line.title).toBeUndefined();
  });

  it("ignores details that are not a record", () => {
    expect(describeToolResult({ content: [], details: "text" }, false).meta).toBeUndefined();
  });
});

describe("status line rendering", () => {
  it("paints the icon, the title and the facts", () => {
    const text = renderStatusLine(
      { icon: "done", title: "Recall", description: "q", meta: ["default/oritwoen"] },
      painted,
    );

    expect(text).toBe("<success>✓ <toolTitle><b>Recall <dim>q <muted>default/oritwoen");
  });

  it("animates the spinner from the frame the harness reports", () => {
    expect(renderStatusLine({ icon: "running", spinnerFrame: 12 }, plain)).toBe("⠹");
    expect(renderStatusLine({ icon: "running" }, plain)).toBe("·");
  });

  it("reads without a theme", () => {
    expect(renderStatusLine({ icon: "error", description: "boom", badge: "failed" }, plain)).toBe(
      "✗ boom (failed)",
    );
  });
});

describe("result rendering", () => {
  const body = (lines: number) =>
    Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n");

  it("previews ten lines and counts the rest", () => {
    const text = renderToolResult({ content: [{ text: body(14) }] }, false, {}, plain);
    const rendered = text.split("\n");

    expect(rendered).toHaveLength(12);
    expect(rendered[1]).toBe("  line 1");
    expect(rendered.at(-1)).toBe("  … 4 more lines");
  });

  it("shows every line once the user expands the result", () => {
    const text = renderToolResult(
      { content: [{ text: body(14) }] },
      false,
      { expanded: true },
      plain,
    );

    expect(text.split("\n")).toHaveLength(15);
    expect(text).not.toContain("more lines");
  });

  it("cuts a long line down in the preview and shows it whole once expanded", () => {
    const memory = `{"content":"${"z".repeat(900)}"}`;
    const collapsed = renderToolResult({ content: [{ text: memory }] }, false, {}, plain);
    const opened = renderToolResult(
      { content: [{ text: memory }] },
      false,
      { expanded: true },
      plain,
    );

    expect(collapsed.split("\n")[1]).toHaveLength(202);
    expect(collapsed.endsWith("…")).toBe(true);
    expect(opened.split("\n")[1]).toHaveLength(memory.length + 2);
  });

  it("keeps the indentation a listing depends on", () => {
    const text = renderToolResult(
      { content: [{ text: "memories:\n    - id: 01M0\n    - id: 01M1" }] },
      false,
      {},
      plain,
    );

    expect(text.split("\n")[1]).toBe("  memories:");
    expect(text.split("\n")[2]).toBe("      - id: 01M0");
  });

  it("does not reprint an error line the header showed in full", () => {
    /** 85 raw characters, 55 once the header collapses the padding. */
    const padded = `${"  ".repeat(10)}Failed to reach the memory service after three attempts${"  ".repeat(5)}`;

    const text = renderToolResult(
      { content: [{ text: `${padded}\nsecond line` }] },
      true,
      {},
      plain,
    );

    expect(text).toBe(
      "✗ Failed to reach the memory service after three attempts (failed)\n  second line",
    );
  });

  it("still prints an error line the header had to cut short", () => {
    const text = renderToolResult(
      { content: [{ text: `${"e".repeat(100)}\nsecond` }] },
      true,
      {},
      plain,
    );

    expect(text.split("\n")[1]).toBe(`  ${"e".repeat(100)}`);
  });

  it("does not print the first error line twice", () => {
    const text = renderToolResult(
      { content: [{ text: "Memory not found\nid: 01M0" }] },
      true,
      {},
      plain,
    );

    expect(text).toBe("✗ Memory not found (failed)\n  id: 01M0");
  });

  it("prints a header alone when the tool returned no text", () => {
    expect(renderToolResult({ content: [], details: { id: "01M0" } }, false, {}, plain)).toBe(
      "✓ 01M0",
    );
  });

  it("strips control bytes out of the stored text it prints", () => {
    const text = renderToolResult(
      { content: [{ text: `${ESC}[2J${NUL}wiped` }] },
      false,
      {},
      plain,
    );

    expect(text.split("\n")[1]).toBe("   wiped");
  });

  it("skips result parts that carry no text", () => {
    const text = renderToolResult(
      {
        content: [
          { type: "image", data: "..." },
          { type: "text", text: "kept" },
        ],
      },
      false,
      {},
      plain,
    );

    expect(text.split("\n")[1]).toBe("  kept");
  });
});

describe("surrogate safety", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("replaces an unpaired code unit the model sent", () => {
    expect(sanitizeTerminalText(`start${String.fromCharCode(0xd800)}end`)).toBe("start end");
    expect(sanitizeTerminalText(`a${String.fromCharCode(0xdc00)}b`)).toBe("a b");
  });

  it("keeps a real pair whole", () => {
    expect(sanitizeTerminalText(`a${"\u{1F600}"}b`)).toBe(`a${"\u{1F600}"}b`);
  });

  it("never cuts a status field through a pair", () => {
    const line = describeToolCall("Recall", { query: `${"q".repeat(70)}${"\u{1F600}"}rest` });

    expect(lone.test(line.description!)).toBe(false);
  });

  it("never cuts a preview line through a pair", () => {
    const body = `${"y".repeat(198)}${"\u{1F600}"}${"z".repeat(50)}`;
    const preview = renderToolResult({ content: [{ text: body }] }, false, {}, plain).split(
      "\n",
    )[1];

    expect(lone.test(preview!)).toBe(false);
  });
});

describe("field sanitization", () => {
  it("drops a lone C1 introducer together with the sequence it opens", () => {
    expect(sanitizeTerminalText(`${C1}31mplain`)).toBe("plain");
  });

  it("collapses a value into one line", () => {
    expect(sanitizeTerminalText("  two\n\nlines  ")).toBe("two lines");
  });

  it("accepts values the schema never promised", () => {
    expect(sanitizeTerminalText(42)).toBe("42");
    expect(sanitizeTerminalText(null)).toBe("null");
  });
});
