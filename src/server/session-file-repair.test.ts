import { describe, expect, it } from "vitest";
import { inspectSessionFileRepair } from "./session-file-repair.js";

const conversationId = "repair-session";
const timestamp = "2026-01-01T00:00:00.000Z";
const header = `${JSON.stringify({
  type: "session",
  version: 3,
  id: conversationId,
  timestamp,
  cwd: "",
})}\n`;

function customEntry(
  id = "entry-1",
  parentId: string | null = null,
  data: unknown = {},
): string {
  return JSON.stringify({
    type: "custom",
    id,
    parentId,
    timestamp,
    customType: "test.entry",
    data,
  });
}

function assess(raw: Buffer | string) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return inspectSessionFileRepair(
    "session.jsonl",
    "C:/project/.piweb/sessions/session.jsonl",
    {
      path: "C:/project/.piweb/sessions/session.jsonl",
      dev: 1n,
      ino: 2n,
      size: BigInt(bytes.length),
      mtimeNs: 3n,
      ctimeNs: 4n,
    },
    bytes,
  );
}

describe("inspectSessionFileRepair", () => {
  it("proposes byte-exact NUL removal and the necessary final newline", () => {
    const validEntry = customEntry();
    const original = Buffer.concat([
      Buffer.from(header + validEntry),
      Buffer.from([0, 0]),
    ]);

    const result = assess(original);

    expect(result.repair).toEqual({
      kind: "remove_zero_tail",
      removedBytes: 2,
      retainedEntries: 1,
    });
    expect(result.replacement).toEqual(Buffer.from(`${header}${validEntry}\n`));
    expect(result.conversationId).toBe(conversationId);
  });

  it("adds only a missing newline to a fully valid final JSON record", () => {
    const validEntry = customEntry();
    const result = assess(header + validEntry);

    expect(result.repair).toEqual({
      kind: "append_newline",
      removedBytes: 0,
      retainedEntries: 1,
    });
    expect(result.replacement).toEqual(Buffer.from(`${header}${validEntry}\n`));
  });

  it("proposes discarding only one invalid unterminated tail after a strict prefix", () => {
    const prefix = `${header}${customEntry()}\n`;
    const tail = '{"type":"custom","id":';
    const result = assess(prefix + tail);

    expect(result.repair).toEqual({
      kind: "discard_incomplete_tail",
      removedBytes: Buffer.byteLength(tail),
      retainedEntries: 1,
    });
    expect(result.replacement).toEqual(Buffer.from(prefix));
  });

  const nonFiniteEntry = customEntry("entry-2", "entry-1", { value: 0 })
    .replace('"value":0', '"value":1e400');

  it("does not discard a closed Pi object followed by junk", () => {
    const prefix = `${header}${customEntry()}\n`;
    const legalEntryWithJunk = `${customEntry("entry-2", "entry-1")}junk`;
    const invalidEntryWithJunk = `${customEntry("entry-2", "missing")}junk`;

    expect(assess(prefix + legalEntryWithJunk).repair).toBeNull();
    expect(assess(prefix + invalidEntryWithJunk).repair).toBeNull();
  });

  it("recognizes an open object when braces and escapes occur inside an unfinished string", () => {
    const prefix = `${header}${customEntry()}\n`;
    const tail = [
      '{"type":"custom","id":"unfinished","parentId":"entry-1","timestamp":"',
      timestamp,
      '","customType":"test.entry","data":{"text":"brace } and escaped quote ',
      String.fromCharCode(92),
      '" still open',
    ].join("");
    const result = assess(prefix + tail);

    expect(result.repair?.kind).toBe("discard_incomplete_tail");
    expect(result.replacement).toEqual(Buffer.from(prefix));
  });

  it.each([
    ["invalid tree reference", customEntry("entry-2", "missing")],
    ["non-finite parsed number", nonFiniteEntry],
  ])("does not classify a syntactically valid but semantically invalid tail as incomplete (%s)", (_label, tail) => {
    const prefix = `${header}${customEntry()}\n`;
    const result = assess(prefix + tail);

    expect(result.diagnostic).toBeDefined();
    expect(result.repair).toBeNull();
    expect(result.replacement).toBeUndefined();
  });

  it("does not truncate a tail when an earlier complete record is corrupt", () => {
    const corruptMiddle = `${header}{"not":"a Pi entry"}\n`;
    const result = assess(corruptMiddle + '{"partial":');

    expect(result.repair).toBeNull();
    expect(result.replacement).toBeUndefined();
  });

  it("does not use replacement decoding or propose repair for invalid UTF-8 bytes", () => {
    const original = Buffer.concat([
      Buffer.from(`${header}${customEntry()}\n{"tail":"`),
      Buffer.from([0xc3, 0x28]),
    ]);
    const result = assess(original);

    expect(result.diagnostic).toBeDefined();
    expect(result.repair).toBeNull();
    expect(result.replacement).toBeUndefined();
  });
});
