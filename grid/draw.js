// 격자를 canvas 2D 컨텍스트에 그린다. 칸은 정수 기기 픽셀, 보간 없음.
export function levelToIntensity(v, levels) {
  return Math.round((v * 255) / (levels - 1));
}

/** 전체를 검정으로 채운 뒤 격자를 좌상단 정렬로 그린다. cells = rows*cols*3 단계 인덱스. */
export function drawPage(ctx, layout, cells, cellPx, pxW, pxH) {
  ctx.fillStyle = "rgb(0,0,0)";
  ctx.fillRect(0, 0, pxW, pxH);
  const { cols, rows, levels } = layout;
  const lut = Array.from({ length: levels }, (_, v) => levelToIntensity(v, levels));
  let last = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      const style = `rgb(${lut[cells[i]]},${lut[cells[i + 1]]},${lut[cells[i + 2]]})`;
      if (style !== last) {
        ctx.fillStyle = style;
        last = style;
      }
      ctx.fillRect(c * cellPx, r * cellPx, cellPx, cellPx);
    }
  }
}
