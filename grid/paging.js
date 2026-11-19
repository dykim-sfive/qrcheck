// 창 크기 -> 격자 배치, 장 넘김 계산 (DOM 없음).
import { makeLayout } from "./format.js";

/** 칸 크기는 기기 픽셀 정수. 최소 격자 미만이면 null. */
export function computeLayout({ cssW, cssH, dpr, cellPx, levels, rsRatio }) {
  const pxW = Math.floor(cssW * dpr);
  const pxH = Math.floor(cssH * dpr);
  const layout = makeLayout(Math.floor(pxW / cellPx), Math.floor(pxH / cellPx), levels, rsRatio);
  return layout ? { layout, pxW, pxH } : null;
}

export function pageCount(total, pageBytes) {
  return Math.max(1, Math.ceil(total / pageBytes));
}

export function pageNumber(offset, pageBytes) {
  return Math.floor(offset / pageBytes) + 1;
}

/** dir = -1 | +1. offset 이 장 경계에 정렬돼 있지 않아도 [0, 마지막 장 시작] 안으로 clamp. */
export function stepOffset(offset, pageBytes, dir, total) {
  const last = (pageCount(total, pageBytes) - 1) * pageBytes;
  return Math.min(last, Math.max(0, offset + dir * pageBytes));
}
