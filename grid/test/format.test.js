import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIN_COLS, MIN_ROWS, makeLayout, crc32, buildStream, renderPage } from "../format.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url)));
const hex = (u8) => Buffer.from(u8).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h, "hex"));

test("renderPage is byte-identical to the python fixtures", () => {
  assert.ok(fx.pages.length >= 5);
  for (const p of fx.pages) {
    const layout = makeLayout(p.cols, p.rows, p.levels, p.rs_ratio);
    const stream = buildStream(p.name, bytes(p.data_hex));
    const { cells, header } = renderPage(layout, stream, p.offset);
    assert.equal(hex(cells), p.cells_hex, `L=${p.levels} offset=${p.offset}`);
    assert.equal(header.offset, p.offset);
    assert.equal(header.total, stream.length);
    assert.equal(header.plen, Math.min(layout.pageBytes, stream.length - p.offset));
  }
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("buildStream rejects names over 255 utf-8 bytes", () => {
  assert.throws(() => buildStream("x".repeat(256), new Uint8Array(0)));
  assert.equal(buildStream("한글.txt", new Uint8Array(2)).length, 1 + new TextEncoder().encode("한글.txt").length + 4 + 2);
});

test("makeLayout returns null below the minimum grid", () => {
  assert.equal(MIN_COLS, 90);
  assert.equal(MIN_ROWS, 20);
  assert.equal(makeLayout(90, 19, 2), null);
  assert.equal(makeLayout(89, 40, 2), null);
  const l = makeLayout(120, 40, 2);
  assert.equal(l.pageBytes, 1224);
  assert.equal(l.nsym, 51);
});
