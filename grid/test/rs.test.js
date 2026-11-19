import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rsEncode } from "../rs.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url)));
const hex = (u8) => Buffer.from(u8).toString("hex");

test("rsEncode matches reedsolo for every fixture", () => {
  assert.ok(fx.rs.length >= 5);
  for (const c of fx.rs) {
    const out = rsEncode(Uint8Array.from(Buffer.from(c.data_hex, "hex")), c.nsym);
    assert.equal(hex(out), c.code_hex, `nsym=${c.nsym} len=${c.data_hex.length / 2}`);
  }
});
