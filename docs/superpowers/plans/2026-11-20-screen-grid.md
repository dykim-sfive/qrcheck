# Screen Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브라우저 전체를 색 칸 격자로 채워 파일을 장 단위로 보여 주고(←/→ 넘김), 폰으로 찍은 사진에서 파일을 복원하며 칸 크기×색 단계별 오류율을 리포트한다.

**Architecture:** 송신은 정적 `grid.html` + ES 모듈(`grid/*.js`, 브라우저와 node 공용). 수신은 Python(`tools/gridfmt.py` 포맷·RS, `tools/grid_decode.py` 사진→칸→파일). 포맷은 JS/Python 두 구현이며, **Python이 만든 fixture(`grid/test/fixtures.json`)로 JS 출력이 바이트 단위로 같음을 고정**한다.

**Tech Stack:** 브라우저 JS(ES modules, canvas), node ≥ 20 `node --test`, Python 3 + numpy + opencv + `reedsolo`, `unittest`.

**Spec:** `docs/superpowers/specs/2026-11-20-screen-grid-design.md`

## Global Constraints
- 칸 크기는 **기기 픽셀** 정수(2/3/4/6/8), 채널당 색 단계 L ∈ {2,4,8}, 칸당 비트 = 3·log2(L), 비트는 MSB 우선, 한 칸에 R→G→B 순.
- 색 강도 = `round(v*255/(L-1))`. 헤더·기준 색은 L과 무관하게 v∈{0, L-1}만 사용.
- 헤더는 항상 1비트/채널(3비트/칸). RS는 GF(256), `reedsolo.RSCodec` 기본값(prim 0x11d, generator 2, fcr 0), 블록 길이 255, `nsym = round(255*rsRatio)`(기본 비율 0.2 → 51).
- 창 크기/확대 변경 시 **스트림 바이트 offset 유지**, 칸 수·장당 용량은 재계산.
- 의존성 추가는 `reedsolo` 하나. 서버·빌드 없이 `grid.html` 이 열려야 한다(file:// 또는 server.py `/grid.html`).

## 포맷 정의 (모든 태스크가 따른다)
- 격자 `cols × rows`, 최소 `MIN_COLS=90`, `MIN_ROWS=20`. 칸 좌표 `(r,c)`, 읽는 순서 행 우선.
- **코너 블록** 8×8 (네 모서리): 바깥→안쪽 층 0 흰색, 1 검정, 2 흰색, 3(가운데 2×2) 검정.
- **기준 행** `r=0, 8 ≤ c < cols-8`: 패턴 `[검정, 흰색, R0..R(L-1), G0..G(L-1), B0..B(L-1)]`을 반복 (Rk = 채널 R만 단계 k, 나머지 0).
- **헤더** `r=1, 8 ≤ c < 80` (72칸). 27바이트(빅엔디언) `ver u8=1, log2L u8, cols u16, rows u16, nsym u8, fileId u32, offset u32, total u32, plen u32, crc32 u32`(앞 23바이트의 CRC32). 비트→칸은 3비트씩, 남는 비트는 0.
- **데이터 칸**: 위 예약 영역을 뺀 나머지, 행 우선. 페이로드 `nBlocks = floor(floor(dataCells*bitsPerCell/8)/255)`, `pageBytes = nBlocks*(255-nsym)`. 쓰고 남은 칸은 값 0.
- **스트림** = `u8 nameLen, name(utf-8, ≤255바이트), u32 size, file bytes`. `fileId = crc32(stream)`. 한 장은 `stream[offset : offset+pageBytes]`(부족하면 0 패딩, `plen` = 실제 바이트 수)를 `k=255-nsym` 단위 블록으로 나눠 RS 부호화 후 **바이트 인터리브**(`out[j*nBlocks+b] = block_b[j]`)해 데이터 칸에 채운다.

## Review Focus
- 빈 파일(0바이트)과 이름이 긴/비ASCII 파일명(≤255바이트 제한 초과 시 거절) → Task 2·3 테스트.
- 마지막 장이 `pageBytes`보다 짧음(0 패딩, `plen`) → Task 2·3.
- 창이 최소 격자(90×20) 미만 → `computeLayout`이 `null`, UI는 경고 표시 → Task 4.
- 소수 `devicePixelRatio`(1.25, 1.5)에서 칸 경계가 정수 기기 픽셀 → Task 4.
- 크기 변경으로 다른 격자 크기의 사진이 섞이거나, 같은 장 사진이 중복·회전됨, 다른 파일의 사진이 섞임 → Task 6.

---

### Task 1: 스캐폴딩 + RS 인코더 (JS가 reedsolo와 일치)

**Files:**
- Create: `package.json` (`"type":"module"`, `"scripts":{"test":"node --test grid/test/"}`), `grid/rs.js`, `tools/gen_grid_fixtures.py`, `grid/test/rs.test.js`, `grid/test/fixtures.json`
- Modify: `requirements.txt` (`reedsolo` 추가), `.gitignore`(`node_modules/`)

**Interfaces:**
- Produces: `rsEncode(data: Uint8Array, nsym: number): Uint8Array` — `data.length+nsym ≤ 255`, 반환은 `data`+패리티(=`RSCodec(nsym).encode(data)`)

- [ ] **Step 1: 실패 테스트** `grid/test/rs.test.js`: `fixtures.json`의 `rs` 항목(`{nsym, data_hex, code_hex}` 최소 5개: nsym 51·32, 데이터 길이 1·100·204, 0만/랜덤)에 대해 `rsEncode(...)` hex가 `code_hex`와 같음.
- [ ] **Step 2: fixture 생성** `tools/gen_grid_fixtures.py`가 위 `rs` 항목(고정 시드)을 `RSCodec(nsym).encode`로 만들어 `grid/test/fixtures.json`에 쓴다. 실행: `python3 tools/gen_grid_fixtures.py`.
- [ ] **Step 3: 실행해 실패 확인** `node --test grid/test/` → `rsEncode` 없음으로 FAIL.
- [ ] **Step 4: `grid/rs.js` 구현** GF(256) 지수/로그 표(0x11d)와 생성다항식 `∏(x - 2^i)`, i=0..nsym-1, 로 체계적 인코딩(나머지 계산).
- [ ] **Step 5: 통과 확인** `node --test grid/test/` → PASS.
- [ ] **Step 6: 커밋** `git add -A && git commit -m "grid: RS encoder matching reedsolo + fixtures"`

### Task 2: Python 포맷 `tools/gridfmt.py`

**Files:**
- Create: `tools/gridfmt.py`, `tests/test_gridfmt.py`
- Modify: `tools/gen_grid_fixtures.py` (포맷 fixture 추가)

**Interfaces:**
- Produces (모두 `tools/gridfmt.py`):
  - `@dataclass Layout(cols, rows, levels, nsym)` + 속성 `bits_per_cell, data_cells, n_blocks, page_bytes`; `make_layout(cols, rows, levels, rs_ratio=0.2) -> Layout`(`cols<90`/`rows<20`/`n_blocks<1`이면 `ValueError`)
  - `is_reserved(layout, r, c) -> bool`
  - `build_stream(name: str, data: bytes) -> bytes`, `parse_stream(stream: bytes) -> tuple[str, bytes]` (이름 utf-8 255바이트 초과 `ValueError`)
  - `encode_header(h: Header) -> bytes`, `decode_header(b: bytes) -> Header | None`(CRC 불일치/버전≠1이면 `None`), `@dataclass Header(log2l, cols, rows, nsym, file_id, offset, total, plen)`
  - `render_page(layout, stream: bytes, offset: int) -> np.ndarray` — shape `(rows, cols, 3)`, uint8 **단계 인덱스**(0..L-1)
  - `read_header_cells(cells) -> Header | None` — 행 1의 72칸에서
  - `decode_cells(cells: np.ndarray) -> PageResult` — 헤더로 Layout 복원 → 데이터 칸 → 디인터리브 → RS 복구. `PageResult(ok: bool, header, payload: bytes, rs_corrected: int, cell_error_rate: float)`. `cell_error_rate`는 복구 성공 시 `render_page`로 재생성한 칸과 입력 칸의 불일치 비율(칸 단위), 실패 시 `nan`.

- [ ] **Step 1: 실패 테스트** `tests/test_gridfmt.py`
  - `test_roundtrip_each_level`: L∈{2,4,8}, 120×40 격자, 랜덤 5KB 스트림 → `decode_cells(render_page(...))` 의 `ok`, `payload == stream[:plen]`, `rs_corrected == 0`, `cell_error_rate == 0.0`
  - `test_corrects_corrupted_cells`: 데이터 칸 2%를 임의 단계로 바꿔도 `ok`이고 `rs_corrected > 0`
  - `test_last_page_padding`: `offset` 이 끝 근처일 때 `header.plen < page_bytes` 이고 payload 길이 = `plen`
  - `test_header_crc`: 헤더 1바이트 변조 시 `decode_header is None`
  - `test_empty_file_and_long_name`: 0바이트 파일 스트림 왕복 OK, 이름 256바이트 `ValueError`
  - `test_reserved`: 네 코너 블록·기준 행·헤더 72칸이 `is_reserved`이고 나머지는 아님, 최소 크기 미만 `make_layout` → `ValueError`
- [ ] **Step 2: 실패 확인** `python3 -m unittest tests.test_gridfmt` → FAIL (모듈 없음)
- [ ] **Step 3: 구현** 위 시그니처. 인터리브·패킹·코너/기준 패턴은 "포맷 정의"대로. RS는 `reedsolo.RSCodec(nsym)`.
- [ ] **Step 4: 통과 확인** 같은 명령 → PASS
- [ ] **Step 5: fixture 추가** `tools/gen_grid_fixtures.py`가 `{levels, cols, rows, rs_ratio, name, data_hex, offset, cells_hex}`(L=2·4·8 각 1개, 100×30, 짧은 파일 하나와 offset>0 하나 포함)를 `fixtures.json`의 `pages`에 기록. 실행 후 커밋: `git commit -m "grid: python format + fixtures"`

### Task 3: JS 포맷 `grid/format.js` (fixture와 바이트 동일)

**Files:**
- Create: `grid/format.js`, `grid/test/format.test.js`

**Interfaces:**
- Consumes: `rsEncode` (Task 1), `fixtures.json` `pages` (Task 2)
- Produces: `MIN_COLS=90, MIN_ROWS=20`, `makeLayout(cols, rows, levels, rsRatio=0.2) -> Layout|null`(최소 미만/`nBlocks<1`이면 `null`; `Layout{cols,rows,levels,nsym,bitsPerCell,dataCells,nBlocks,pageBytes}`), `crc32(bytes: Uint8Array): number`, `buildStream(name: string, data: Uint8Array): Uint8Array`(이름 255바이트 초과 시 throw), `renderPage(layout, stream: Uint8Array, offset: number): { cells: Uint8Array /* rows*cols*3 단계 인덱스 */, header: {fileId, offset, total, plen} }`

- [ ] **Step 1: 실패 테스트**: `pages` 각 항목에서 `renderPage(makeLayout(...), buildStream(name, data), offset).cells` hex가 `cells_hex`와 같음; `crc32(Uint8Array.of(...'123456789'))===0xCBF43926`; 256바이트 이름은 throw; 90×19 → `makeLayout` null.
- [ ] **Step 2: 실패 확인** `node --test grid/test/` → FAIL
- [ ] **Step 3: 구현** 포맷 정의 그대로(헤더·코너·기준 행·인터리브·패킹). `crc32`는 표 기반(zlib과 동일).
- [ ] **Step 4: 통과 확인** `node --test grid/test/` → PASS
- [ ] **Step 5: 커밋** `git commit -m "grid: JS format byte-identical to python"`

### Task 4: 배치·넘김·그리기 도우미 (`grid/paging.js`, `grid/draw.js`)

**Files:**
- Create: `grid/paging.js`, `grid/draw.js`, `grid/test/paging.test.js`

**Interfaces:**
- Consumes: `makeLayout` (Task 3)
- Produces:
  - `computeLayout({cssW, cssH, dpr, cellPx, levels, rsRatio}): { layout: Layout, pxW: number, pxH: number } | null` — `pxW=floor(cssW*dpr)`, `cols=floor(pxW/cellPx)`; `layout`이 null이면 `null`
  - `stepOffset(offset, pageBytes, dir /* -1|+1 */, total): number` — `[0, lastPageStart]` 로 clamp (`lastPageStart = max(0, (ceil(total/pageBytes)-1)*pageBytes)`)
  - `pageNumber(offset, pageBytes): number`(1부터), `pageCount(total, pageBytes): number`
  - `levelToIntensity(v, levels): number` = `round(v*255/(levels-1))`
  - `drawPage(ctx, layout, cells, cellPx, pxW, pxH): void` — 캔버스 전체를 검정으로 채우고, 격자는 좌상단 정렬, 칸마다 `fillRect` 정수 좌표(여백은 흰색이 아니라 **검정**).

- [ ] **Step 1: 실패 테스트** `grid/test/paging.test.js`
  - `computeLayout({cssW:1200,cssH:700,dpr:1.5,cellPx:4,levels:2,rsRatio:0.2})` → `pxW===1800`, `layout.cols===450`; dpr 1.25(`cssW:1001`)에서 `pxW===1251` 정수·`cols===floor(1251/4)`
  - `computeLayout({cssW:300,cssH:200,...})===null`
  - `stepOffset`: 0에서 -1 → 0, 마지막 장에서 +1 → 그대로, 중간 +1 → `+pageBytes`, 임의 offset(정렬 안 됨)에서도 clamp
  - `pageNumber/pageCount` 경계(total==pageBytes 배수일 때 장 수)
  - `levelToIntensity(1,2)===255`, `(1,4)===85`, `(7,8)===255`
  - `drawPage`: 가짜 ctx로 `fillRect` 좌표가 모두 정수이고 `cellPx` 배수임을 확인
- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** `node --test grid/test/` → PASS
- [ ] **Step 5: 커밋** `git commit -m "grid: layout/paging/draw helpers"`

### Task 5: `grid.html` UI + 서버 경로

**Files:**
- Create: `grid.html`
- Modify: `server.py` (`do_GET`에 `/grid.html`, `/grid/*.js` 정적 제공: `ROOT/grid` 하위 `.js`만, 경로 탈출 거부)

**Interfaces:** Consumes `computeLayout, stepOffset, pageNumber, pageCount, drawPage` (Task 4), `buildStream, renderPage, crc32` (Task 3). 브라우저 자동 테스트는 없고 아래 수동 검증으로 대신한다.

- [ ] **Step 1: 구현** `grid.html`: 위쪽 가로 얇은 줄(높이 약 28 CSS px) — 파일 선택, 칸 크기(2/3/4/6/8), 색 단계(2/4/8), RS 비율(기본 0.2), `◀ n/N ▶`, 장당 바이트·전체 바이트·칸 수(`cols×rows`) 표시, 칸 크기·단계가 바뀌면 현재 offset을 유지한 채 재배치. 아래 영역 전체가 캔버스(`devicePixelRatio`로 기기 픽셀 크기, CSS 크기 = px/dpr, `imageSmoothingEnabled=false`). `ArrowLeft/ArrowRight`로 장 이동, `S`로 줄 숨김/표시(숨겨도 캔버스 크기 유지 → 격자 변하지 않도록 줄 자리를 비워 둠 [판단]), `resize` 이벤트(약 100ms 디바운스, 브라우저 확대 포함)에서 `computeLayout` 재계산, `null`이면 "창이 너무 작습니다 (최소 90×20칸)" 경고 표시하고 그리지 않음. 파일 이름 255바이트 초과는 알림 후 거절.
- [ ] **Step 2: 서버 경로** `/grid.html`, `/grid/<name>.js` (`Content-Type: text/javascript; charset=utf-8`).
- [ ] **Step 3: 수동 검증** `python3 server.py` → `http://127.0.0.1:8765/grid.html`: 파일 선택 후 격자 표시, ←/→로 장 번호 변화, 창 크기를 바꾸면 `cols×rows` 와 장 수가 바뀌고 장 위치(바이트)가 유지됨, 최소 크기 미만에서 경고. 결과를 사용자에게 보고.
- [ ] **Step 4: 커밋** `git commit -m "grid: sender page + server route"`

### Task 6: 사진 해독 `tools/grid_decode.py`

**Files:**
- Create: `tools/grid_decode.py`, `tests/test_grid_decode.py`

**Interfaces:**
- Consumes: `gridfmt.render_page, decode_cells, read_header_cells, make_layout, parse_stream` (Task 2)
- Produces:
  - `find_corners(img: np.ndarray) -> np.ndarray | None` — 격자 좌표 `(1,1),(cols-1,1),(cols-1,rows-1),(1,rows-1)` 에 해당하는 검정 링 바깥 모서리 4점, 순서 TL,TR,BR,BL (코너 블록의 흰색-검정-흰색-검정 중첩 구조로 탐지)
  - `sample_cells(img, corners, cols, rows, levels) -> np.ndarray` — 호모그래피 보정 후 칸 중앙 영역의 중앙값 색을, 기준 행(예상 색 ↔ 관측 색)에 대한 최소제곱 아핀 보정을 거쳐 가장 가까운 단계로 분류한 `(rows, cols, 3)` 단계 인덱스
  - `read_photo(img: np.ndarray) -> PageResult | None` — 4방향 회전 × (칸 수 추정 ±8% 후보) 를 헤더 CRC로 검증하며 탐색 (추정 `cols ≈ 1 + 상단 변 길이 / (6칸 링 폭/6)`)
  - `assemble(results: list[PageResult]) -> Report` — `file_id` 가 다수인 것만 사용, offset 기준 병합(서로 다른 격자 크기 혼합·중복 허용), `Report(name, data|None, missing_ranges, per_page: list[...])`
  - CLI: `python3 tools/grid_decode.py PHOTO... -o OUT_DIR` — 복원 파일 저장, 장별 `cols×rows, L, rs_corrected, cell_error_rate` 표, 누락 구간, 성공 여부 출력

- [ ] **Step 1: 실패 테스트** `tests/test_grid_decode.py` (합성 이미지: `render_page` 결과를 cv2로 칸 크기 6px로 그리고 흰 여백 추가)
  - `test_clean_image`: 단계 2/4/8 각각 `read_photo` → `ok`, payload 일치
  - `test_perspective_color_noise`: 원근 변환(약 8°), 감마·색 틴트(R×0.9,B×1.1), 가우시안 블러 σ=1, 노이즈 → L=2는 `ok`
  - `test_rotated_180`: 180° 회전 이미지도 `ok`
  - `test_assemble_mixed`: 같은 파일을 두 가지 격자 크기로 렌더한 서로 다른 offset 장들을 섞고 중복·다른 파일 사진 하나를 끼워도 `data == 원본`; 한 장을 빼면 `data is None` 이고 `missing_ranges` 가 그 구간을 포함
  - `test_no_markers`: 빈 이미지 → `read_photo is None`
- [ ] **Step 2: 실패 확인** `python3 -m unittest tests.test_grid_decode` → FAIL
- [ ] **Step 3: 구현** 위 시그니처. 마커 탐지는 `cv2.findContours`(계층)로 중첩 사각형 후보 → 모서리 4개를 극값으로 선택.
- [ ] **Step 4: 통과 확인** 같은 명령 → PASS (L=4·8 의 노이즈 테스트는 요구하지 않음 — 한계는 실측 대상)
- [ ] **Step 5: 커밋** `git commit -m "grid: photo decoder + CLI"`

### Task 7: 종단 검증 + 문서

**Files:** Modify `README.md`

- [ ] **Step 1: 화면 캡처로 종단 확인** `grid.html`에서 약 200KB 파일을 보내고(L=2, 칸 4px) 장 하나를 화면 캡처 → `python3 tools/grid_decode.py capture.png -o /tmp/out` 로 장 하나가 `ok` 인지 확인. 결과를 사용자에게 보고.
- [ ] **Step 2: README** 새 절 "화면 전체 격자 전송 (실험)" — 사용법, 폰 촬영 팁(장마다 정지 사진, 정면에서 격자 전체가 나오게), 오류율 표 읽는 법, 한계(칸당 카메라 3px 이상).
- [ ] **Step 3: 전체 테스트** `node --test grid/test/ && python3 -m unittest discover -s tests` → 모두 PASS
- [ ] **Step 4: 커밋** `git commit -m "grid: docs"`

---

## Self-Review
- **스펙 커버리지:** 격자·헤더·기준 색·RS(Task 2·3), UI(위쪽 줄·←/→·S·칸 크기/단계, Task 5), resize offset 유지(Task 4·5), 사진 복원+오류율(Task 6), 성공 기준 1~3(Task 6·7 + 수동). 빠진 항목 없음.
- **타입 일관성:** `Layout`·`pageBytes`·`renderPage` 시그니처가 Task 2↔3↔4↔5에서 같음. 헤더 필드명은 Python `snake_case`/JS `camelCase`만 다름.
- **비례:** 스펙 대비 길지만 두 언어 구현과 이미지 파이프라인을 포함하므로 시그니처·테스트 중심으로 유지.
