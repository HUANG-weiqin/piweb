import { describe, expect, it } from "vitest";

import { compressLineStream } from "../src/index.js";

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function numberedLine(index: number, width: number, suffix = ""): string {
  return `line ${String(index).padStart(3, "0")} ${suffix}${"x".repeat(width)}`;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("compressLineStream", () => {
  it("returns short ordinary text and low-benefit candidates exactly unchanged", () => {
    expect(compressLineStream("one\ntwo\nthree")).toBe("one\ntwo\nthree");

    const lowBenefit = `${"x".repeat(20)}\n${"x".repeat(20)}`;
    expect(compressLineStream(lowBenefit)).toBe(lowBenefit);
  });

  it("removes common ANSI CSI and OSC sequences and folds consecutive repeated lines", () => {
    const repeated = `result ${"x".repeat(50)}`;
    const input = `\u001B[31mgreen\u001B[0m\n${Array(20).fill(repeated).join("\n")}\n\u001B]0;title\u0007\u001B]2;status\u001B\\done`;

    expect(compressLineStream(input)).toBe(
      `green\n${repeated}\n[previous line repeated 19 more times]\ndone`,
    );
  });

  it("does not fold matching lines separated by another line", () => {
    const input = `same\nother\nsame\n${"tail ".repeat(60)}`;
    const output = compressLineStream(input);

    expect(output).not.toContain("[previous line repeated");
    expect(output).toBe(input);
  });

  it("retains the fixed windows and error neighborhood in order while omitting ordinary middle lines", () => {
    const input = Array.from({ length: 200 }, (_, index) =>
      numberedLine(index, 90, index === 100 ? "ERROR target " : ""),
    ).join("\n");
    const output = compressLineStream(input);

    expect(output).toContain(numberedLine(0, 90));
    expect(output).toContain(numberedLine(19, 90));
    expect(output).toContain(numberedLine(98, 90));
    expect(output).toContain(numberedLine(100, 90, "ERROR target "));
    expect(output).toContain(numberedLine(102, 90));
    expect(output).toContain(numberedLine(120, 90));
    expect(output).toContain(numberedLine(199, 90));
    expect(output).toContain("[... omitted 78 lines ...]");
    expect(output).toContain("[... omitted 17 lines ...]");
    expect(output).not.toContain(numberedLine(50, 90));
    expect(output.indexOf(numberedLine(19, 90))).toBeLessThan(
      output.indexOf(numberedLine(100, 90, "ERROR target ")),
    );
    expect(output.indexOf(numberedLine(100, 90, "ERROR target "))).toBeLessThan(
      output.indexOf(numberedLine(199, 90)),
    );
  });

  it("uses deterministic uniform sampling when protected lines leave a byte budget", () => {
    const input = Array.from({ length: 1000 }, (_, index) => numberedLine(index, 48)).join("\n");
    const output = compressLineStream(input);

    expect(bytes(output)).toBeLessThanOrEqual(8192);
    expect(output).toContain(numberedLine(0, 48));
    expect(output).toContain(numberedLine(999, 48));
    expect(output).toContain("[... omitted");
    expect(output).not.toContain(numberedLine(500, 48));
  });

  it("keeps every error neighborhood when required content exceeds the byte target", () => {
    const errorIndices = Array.from({ length: 18 }, (_, index) => 30 + index * 10);
    const lines = Array.from({ length: 300 }, (_, index) =>
      numberedLine(index, 100, errorIndices.includes(index) ? `error-${index} ` : ""),
    );
    const output = compressLineStream(lines.join("\n"));

    expect(bytes(output)).toBeGreaterThan(8192);
    for (const errorIndex of errorIndices) {
      for (let index = errorIndex - 2; index <= errorIndex + 2; index += 1) {
        expect(output).toContain(lines[index]);
      }
    }
    expect(output).toContain("[... omitted");
    expect(output).not.toContain(lines[25]);
  });

  it("keeps expanded diagnostic neighborhoods in a large stream", () => {
    const diagnostics = [
      "warning",
      "timeout",
      "timed out",
      "segmentation fault",
      "segfault",
      "access violation",
      "out of memory",
      "OOM",
      "deadlock",
    ];
    const diagnosticIndices = diagnostics.map((_, index) => 120 + index * 20);
    const lines = Array.from({ length: 400 }, (_, index) => {
      const diagnostic = diagnostics[diagnosticIndices.indexOf(index)];
      return numberedLine(index, 100, diagnostic ? `${diagnostic} target ` : "");
    });
    const output = compressLineStream(lines.join("\n"));

    for (const diagnosticIndex of diagnosticIndices) {
      for (let index = diagnosticIndex - 2; index <= diagnosticIndex + 2; index += 1) {
        expect(output).toContain(lines[index]);
      }
    }
    expect(output).toContain("[... omitted");
    expect(output).not.toContain(lines[50]);
  });

  it("handles a huge multi-line stream without retrying increasingly smaller samples", () => {
    const lines = Array.from({ length: 100_000 }, (_, index) => String(index).padStart(6, "0"));
    const output = compressLineStream(lines.join("\n"));

    expect(output).toContain(lines[0]);
    expect(output).toContain(lines.at(-1));
    expect(output).toContain("[... omitted");
  });

  it("passes a single oversized line through unchanged", () => {
    const input = "x".repeat(20_000);
    expect(compressLineStream(input)).toBe(input);
  });

  it("preserves Unicode text without corrupting UTF-8", () => {
    const input = Array(30).fill("构建完成：你好，世界 🌏").join("\n");
    const output = compressLineStream(input);

    expect(output).toContain("构建完成：你好，世界 🌏");
    expect(bytes(output)).toBeLessThan(bytes(input));
  });

  it("is deterministic", () => {
    const input = Array.from({ length: 500 }, (_, index) => numberedLine(index, 50)).join("\n");
    const first = compressLineStream(input);

    expect(compressLineStream(input)).toBe(first);
    expect(compressLineStream(first)).toBe(first);
  });

  it("never expands a fixed-seed generated corpus and retains every error line", () => {
    const random = seededRandom(0x5eed1234);
    const errors: string[] = [];
    const input = Array.from({ length: 300 }, (_, index) => {
      const payload = Array.from({ length: 64 }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join("");
      const line = index % 67 === 0 ? `error-${index} ${payload}` : `info-${index} ${payload}`;
      if (line.startsWith("error-")) {
        errors.push(line);
      }
      return line;
    }).join("\n");
    const output = compressLineStream(input);

    expect(bytes(output)).toBeLessThanOrEqual(bytes(input));
    if (output !== input) {
      expect(bytes(output) * 10).toBeLessThanOrEqual(bytes(input) * 9);
    }
    for (const error of errors) {
      expect(output).toContain(error);
    }
  });
});
