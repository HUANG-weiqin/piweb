const MAX_OUTPUT_BYTES = 8192;
const ANSI_CSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const PROTECTED_LINE = /error|exception|failed|failure|fatal|panic|assert|warning|timeout|timed out|segmentation fault|\bsegfault\b|access violation|out of memory|\boom\b|deadlock/i;
const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function collapseRepeatedLines(lines: string[]): string[] {
  const collapsed: string[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    let next = index + 1;
    while (next < lines.length && lines[next] === line) {
      next += 1;
    }

    collapsed.push(line);
    if (next - index > 1) {
      collapsed.push(`[previous line repeated ${next - index - 1} more times]`);
    }
    index = next;
  }

  return collapsed;
}

function renderSelection(lines: string[], selected: ReadonlySet<number>): string {
  const rendered: string[] = [];

  for (let index = 0; index < lines.length; ) {
    if (selected.has(index)) {
      rendered.push(lines[index]);
      index += 1;
      continue;
    }

    const start = index;
    while (index < lines.length && !selected.has(index)) {
      index += 1;
    }
    rendered.push(`[... omitted ${index - start} lines ...]`);
  }

  return rendered.join("\n");
}

function evenlySelectedIndices(indices: readonly number[], count: number): number[] {
  const selected: number[] = [];

  for (let rank = 0; rank < count; rank += 1) {
    selected.push(indices[Math.floor(((rank + 0.5) * indices.length) / count)]);
  }

  return selected;
}

function sampleLargeStream(lines: string[]): string {
  const required = new Set<number>();

  for (let index = 0; index < Math.min(20, lines.length); index += 1) {
    required.add(index);
  }
  for (let index = Math.max(0, lines.length - 80); index < lines.length; index += 1) {
    required.add(index);
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!PROTECTED_LINE.test(lines[index])) {
      continue;
    }
    for (let neighbor = Math.max(0, index - 2); neighbor <= Math.min(lines.length - 1, index + 2); neighbor += 1) {
      required.add(neighbor);
    }
  }

  const requiredOutput = renderSelection(lines, required);
  const requiredBytes = utf8Bytes(requiredOutput);
  if (requiredBytes > MAX_OUTPUT_BYTES) {
    return requiredOutput;
  }

  const candidates: number[] = [];
  let candidateBytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!required.has(index)) {
      candidates.push(index);
      candidateBytes += utf8Bytes(lines[index]) + 1;
    }
  }

  if (candidates.length === 0) {
    return requiredOutput;
  }

  const availableBytes = MAX_OUTPUT_BYTES - requiredBytes;
  const count = Math.min(
    candidates.length,
    Math.max(1, Math.floor((availableBytes * candidates.length) / Math.max(1, candidateBytes))),
  );
  const selected = new Set(required);
  for (const index of evenlySelectedIndices(candidates, count)) {
    selected.add(index);
  }

  const output = renderSelection(lines, selected);
  return utf8Bytes(output) <= MAX_OUTPUT_BYTES ? output : requiredOutput;
}

/**
 * Deterministically compresses a text line stream without retaining state.
 * It returns the exact input unless a candidate saves at least 10% in UTF-8 bytes.
 */
export function compressLineStream(input: string): string {
  try {
    const withoutAnsi = input.replace(ANSI_OSC, "").replace(ANSI_CSI, "");
    const collapsed = collapseRepeatedLines(withoutAnsi.split(/\r\n|\r|\n/));
    let output = collapsed.join("\n");

    if (utf8Bytes(output) > MAX_OUTPUT_BYTES && collapsed.length > 1) {
      output = sampleLargeStream(collapsed);
    }

    return utf8Bytes(output) * 10 <= utf8Bytes(input) * 9 ? output : input;
  } catch {
    return input;
  }
}
