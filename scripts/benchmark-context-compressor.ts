import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { compressLineStream } from "@piweb/context-compressor";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function benchmark(sessionsDirectory: string): Promise<void> {
  const summary = {
    files: 0,
    toolResults: 0,
    inputBytes: 0,
    outputBytes: 0,
    changedCount: 0,
    invalidRecords: 0,
  };
  const entries = await readdir(sessionsDirectory, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    summary.files += 1;

    const content = await readFile(join(sessionsDirectory, entry.name), "utf8");
    for (const line of content.split("\n")) {
      if (!line) {
        continue;
      }

      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        summary.invalidRecords += 1;
        continue;
      }
      if (!isRecord(record) || !isRecord(record.message)) {
        continue;
      }

      const message = record.message;
      if (
        message.role !== "toolResult" ||
        (message.toolName !== "bash" && message.toolName !== "grep")
      ) {
        continue;
      }

      summary.toolResults += 1;
      let changed = false;
      for (const text of textParts(message.content)) {
        const output = compressLineStream(text);
        summary.inputBytes += byteLength(text);
        summary.outputBytes += byteLength(output);
        changed ||= output !== text;
      }
      if (changed) {
        summary.changedCount += 1;
      }
    }
  }

  const ratio = summary.inputBytes === 0 ? 1 : summary.outputBytes / summary.inputBytes;
  console.log(
    JSON.stringify({
      ...summary,
      ratio: Number(ratio.toFixed(6)),
    }),
  );
}

const [sessionsDirectory, ...extraArguments] = process.argv.slice(2);
if (!sessionsDirectory || extraArguments.length > 0) {
  console.error("usage: npm run context-compressor:benchmark -- <pi-sessions-directory>");
  process.exitCode = 1;
} else {
  benchmark(resolve(sessionsDirectory)).catch(() => {
    console.error("context compressor benchmark failed");
    process.exitCode = 1;
  });
}
