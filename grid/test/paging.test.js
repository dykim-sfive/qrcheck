import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLayout, stepOffset, pageNumber, pageCount } from "../paging.js";
import { levelToIntensity, drawPage } from "../draw.js";
import { makeLayout } from "../format.js";

const base = { cellPx: 4, levels: 2, rsRatio: 0.2 };

test("computeLayout works in device pixels", () => {
  const a = computeLayout({ cssW: 1200, cssH: 700, dpr: 1.5, ...base });
  assert.equal(a.pxW, 1800);
  assert.equal(a.pxH, 1050);
  assert.equal(a.layout.cols, 450);
  assert.equal(a.layout.rows, 262);
  const b = computeLayout({ cssW: 1001, cssH: 700, dpr: 1.25, ...base });
  assert.equal(b.pxW, 1251);
  assert.ok(Number.isInteger(b.pxW) && Number.isInteger(b.pxH));
  assert.equal(b.layout.cols, Math.floor(1251 / 4));
});

test("computeLayout returns null below the minimum grid", () => {
  assert.equal(computeLayout({ cssW: 300, cssH: 200, dpr: 1, ...base }), null);
});

test("stepOffset clamps to the first and last page", () => {
  const pb = 100, total = 350; // 페이지 시작: 0,100,200,300
  assert.equal(stepOffset(0, pb, -1, total), 0);
  assert.equal(stepOffset(300, pb, +1, total), 300);
  assert.equal(stepOffset(100, pb, +1, total), 200);
  assert.equal(stepOffset(100, pb, -1, total), 0);
  assert.equal(stepOffset(250, pb, +1, total), 300); // 정렬 안 된 offset 도 clamp
  assert.equal(stepOffset(250, pb, -1, total), 150);
  assert.equal(stepOffset(0, pb, +1, 50), 0);
});

test("pageNumber and pageCount at boundaries", () => {
  assert.equal(pageCount(100, 100), 1);
  assert.equal(pageCount(101, 100), 2);
  assert.equal(pageCount(0, 100), 1);
  assert.equal(pageNumber(0, 100), 1);
  assert.equal(pageNumber(250, 100), 3);
});

test("levelToIntensity spans 0..255", () => {
  assert.equal(levelToIntensity(0, 4), 0);
  assert.equal(levelToIntensity(1, 2), 255);
  assert.equal(levelToIntensity(1, 4), 85);
  assert.equal(levelToIntensity(7, 8), 255);
});

test("drawPage paints whole pixels aligned to the cell size", () => {
  const layout = makeLayout(90, 20, 2);
  const cells = new Uint8Array(90 * 20 * 3);
  const calls = [];
  const ctx = { fillStyle: "", fillRect: (...a) => calls.push([this_fill(ctx), ...a]) };
  const this_fill = (c) => c.fillStyle;
  drawPage(ctx, layout, cells, 4, 400, 100);
  assert.deepEqual(calls[0].slice(1), [0, 0, 400, 100]); // 검정 배경
  assert.equal(calls[0][0], "rgb(0,0,0)");
  assert.ok(calls.length > 1);
  for (const [, x, y, w, h] of calls.slice(1)) {
    assert.ok(Number.isInteger(x) && Number.isInteger(y));
    assert.equal(x % 4, 0);
    assert.equal(y % 4, 0);
    assert.equal(w, 4);
    assert.equal(h, 4);
  }
});
