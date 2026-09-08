/* LayerDeck - 透過PNG リアルタイム重ね合わせプレビュー (client)
 *
 * 各PNGは worker が 1024px のマス目（タイル）に切り分けて PNG Blob で保持する。
 * 画面に映っているマス目だけを展開（ImageBitmap 化）するので、
 * 使用メモリは「絵の大きさ・枚数」ではなく「表示領域の広さ」で決まる。
 * 展開量の上限は、サーバが実測した空き物理メモリから自動で決める。
 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MB = 1 << 20;

const BLENDS = [
  ['source-over', '通常'],
  ['multiply', '乗算'],
  ['screen', 'スクリーン'],
  ['overlay', 'オーバーレイ'],
  ['darken', '比較(暗)'],
  ['lighten', '比較(明)'],
  ['color-dodge', '覆い焼き'],
  ['color-burn', '焼き込み'],
  ['hard-light', 'ハードライト'],
  ['soft-light', 'ソフトライト'],
  ['difference', '差の絶対値'],
  ['exclusion', '除外'],
  ['lighter', '加算(発光)'],
  ['hue', '色相'],
  ['saturation', '彩度'],
  ['color', 'カラー'],
  ['luminosity', '輝度'],
];
const BG_MODES = ['checker', 'white', 'gray', 'black'];

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */
const state = {
  dir: null,
  layers: [],            // index 0 = 最下層
  dpi: 350,
  bleed: 3,
  exportScale: 1,        // 書き出しの倍率。用紙の物理サイズは変えず解像度だけ下げる
  view: { zoom: 1, panX: 0, panY: 0, flipH: false, gray: false, bg: 0, guide: false, fitted: false },
};

/** name -> タイルセット */
const tilesets = new Map();
/** "name|level|col|row" -> { bmp, bytes, used, pin } 展開済みマス目 */
const decoded = new Map();
const pending = new Set();
let decodedBytes = 0, clock = 0;

/** 展開してよい量。空き物理メモリから自動で決まる */
let budget = 256 * MB;
let mem = null;

/** name -> "mtime_size" 前回のポーリングで見えた版（書き込み途中の検出用） */
const seen = new Map();

const newLayer = (name) => ({
  name, visible: true, opacity: 1, blend: 'source-over',
  x: 0, y: 0, scale: 1, flipH: false, open: false, missing: false,
});

const newTileset = (name, ver) => ({
  name, ver, w: 0, h: 0, tile: 1024, levels: [],   // 実際の値は worker の geom で上書きされる
  blobs: new Map(), blobBytes: 0,
  ready: new Set(), status: 'tiling', done: 0, total: 0, thumb: null,
});

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */
function setStatus(msg, kind = '') {
  const el = $('#status');
  el.textContent = msg || '';
  el.className = 'status ' + kind;
  // 書き出しの進行中だけ、ダイアログ側にも映す（監視中などの常時表示は映さない）
  const m = $('#exportStatus');
  if (m && busy && !$('#exportModal').hidden) {
    m.textContent = msg || '';
    m.className = 'status ' + kind;
  }
}

const fmtBytes = (n) => n >= (1 << 30) ? (n / (1 << 30)).toFixed(2) + ' GB'
  : n >= MB ? (n / MB).toFixed(0) + ' MB'
  : (n / 1024).toFixed(0) + ' KB';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** ドキュメント寸法 = 各レイヤーの最大幅・最大高さ */
function docSize() {
  let w = 0, h = 0;
  for (const L of state.layers) {
    const ts = tilesets.get(L.name);
    if (ts && ts.w) { w = Math.max(w, ts.w); h = Math.max(h, ts.h); }
  }
  return { w, h };
}

/* ------------------------------------------------------------------ */
/* タイル生成ワーカー                                                    */
/* ------------------------------------------------------------------ */
const WORKER_COUNT = 2;
const workers = [];
const jobQueue = [];

function initWorkers() {
  for (let i = 0; i < WORKER_COUNT; i++) {
    const w = new Worker('tiler.js');
    const slot = { w, busy: false };
    w.onmessage = (e) => onWorkerMessage(slot, e.data);
    w.onerror = () => { slot.busy = false; pumpJobs(); };
    workers.push(slot);
  }
}

function enqueueTiling(name, ver) {
  const old = tilesets.get(name);
  if (old) dropTileset(name);
  tilesets.set(name, newTileset(name, ver));
  jobQueue.push({ name, ver });
  pumpJobs();
  renderLayers();
}

function pumpJobs() {
  for (const slot of workers) {
    if (slot.busy || !jobQueue.length) continue;
    const job = jobQueue.shift();
    const ts = tilesets.get(job.name);
    if (!ts || ts.ver !== job.ver) continue;   // すでに新しい版が来ている
    slot.busy = true;
    slot.job = job;
    // worker はバックエンドを直接触れないので、本体側で読んで転送する
    Backend.readImage(job.name, job.ver).then((buf) => {
      const cur = tilesets.get(job.name);
      if (!cur || cur.ver !== job.ver) { slot.busy = false; pumpJobs(); return; }
      slot.w.postMessage({ name: job.name, ver: job.ver, buf }, [buf]);
    }).catch((e) => {
      setStatus(`${job.name}: ${e.message || e}`, 'err');
      const cur = tilesets.get(job.name);
      if (cur && cur.ver === job.ver) cur.status = 'error';   // 「切り分け中」のまま止まらせない
      slot.busy = false;
      renderLayers();
      pumpJobs();
    });
  }
  updateStatusLine();
}

function onWorkerMessage(slot, m) {
  const ts = tilesets.get(m.name);
  const stale = !ts || ts.ver !== m.ver;

  if (m.type === 'geom') {
    if (stale) return;
    Object.assign(ts, { w: m.w, h: m.h, tile: m.tile, levels: m.levels, total: m.total });
    state.view.fitted = state.view.fitted && !!docSize().w;
    renderLayers(); requestRender();
    return;
  }

  if (m.type === 'tiles') {
    if (stale) return;
    for (const it of m.items) {
      ts.blobs.set(`${m.level}|${it.x}|${it.y}`, { blob: it.blob, w: it.w, h: it.h });
      ts.blobBytes += it.blob.size;
    }
    ts.done = m.done;
    if (m.level === ts.levels.length - 1 && !ts.thumb) makeThumb(ts);
    requestRender();
    return;
  }

  if (m.type === 'level') {
    if (stale) return;
    ts.ready.add(m.level);
    ts.done = m.done;
    updateStatusLine();
    requestRender();
    return;
  }

  if (m.type === 'done' || m.type === 'error') {
    slot.busy = false; slot.job = null;
    if (!stale) {
      ts.status = m.type === 'done' ? 'ready' : 'error';
      if (m.type === 'error') setStatus(`${m.name}: ${m.message}`, 'err');
      renderLayers();
    }
    pumpJobs();
    requestRender();
  }
}

function dropTileset(name) {
  const ts = tilesets.get(name);
  if (!ts) return;
  for (const [k, d] of [...decoded.entries()]) {
    if (k.startsWith(name + '|')) { d.bmp.close(); decoded.delete(k); decodedBytes -= d.bytes; }
  }
  ts.blobs.clear();
  tilesets.delete(name);
}

async function makeThumb(ts) {
  const top = ts.levels.length - 1;
  const rec = ts.blobs.get(`${top}|0|0`);
  if (!rec) return;
  try {
    const bmp = await createImageBitmap(rec.blob);
    const S = 76;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const s = Math.min(S / ts.levels[top].w, S / ts.levels[top].h);
    const w = ts.levels[top].w * s, h = ts.levels[top].h * s;
    g.drawImage(bmp, 0, 0, ts.levels[top].w, ts.levels[top].h, (S - w) / 2, (S - h) / 2, w, h);
    bmp.close();
    ts.thumb = c.toDataURL('image/png');
    renderLayers();
  } catch { /* サムネは無くても困らない */ }
}

/* ------------------------------------------------------------------ */
/* 展開済みマス目の管理（LRU、上限は空きメモリ連動）                       */
/* ------------------------------------------------------------------ */
function getTile(ts, level, col, row, request) {
  const key = `${ts.name}|${level}|${col}|${row}`;
  const d = decoded.get(key);
  if (d) { d.used = ++clock; return d.bmp; }
  if (!request || pending.has(key)) return null;
  const rec = ts.blobs.get(`${level}|${col}|${row}`);
  if (!rec) return null;

  pending.add(key);
  createImageBitmap(rec.blob).then((bmp) => {
    pending.delete(key);
    if (tilesets.get(ts.name) !== ts) { bmp.close(); return; }
    const bytes = bmp.width * bmp.height * 4;
    decoded.set(key, { bmp, bytes, used: ++clock, pin: level >= ts.levels.length - 2 });
    decodedBytes += bytes;
    // 描画のたびに解放しているが、タブが裏にあると requestAnimationFrame が
    // 止まるので描画が来ない。ここでも念のため上限を見ておく。
    if (decodedBytes > budget * 1.2) evict();
    requestRender();
  }).catch(() => pending.delete(key));
  return null;
}

function evict() {
  const limit = document.hidden ? 48 * MB : budget;
  if (decodedBytes <= limit) return;
  const items = [...decoded.entries()].filter(([, d]) => !d.pin);
  items.sort((a, b) => a[1].used - b[1].used);
  for (const [k, d] of items) {
    if (decodedBytes <= limit * 0.85) break;
    d.bmp.close(); decoded.delete(k); decodedBytes -= d.bytes;
  }
}

async function refreshMem() {
  try {
    mem = await Backend.memStatus();
    if (mem) budget = clamp(Math.round(mem.avail * 0.25), 96 * MB, 1536 * MB);
  } catch { /* 取れなければ前回値のまま */ }
  updateMemHint();
}

function updateMemHint() {
  let blobBytes = 0;
  for (const ts of tilesets.values()) blobBytes += ts.blobBytes;
  const parts = [`展開 ${fmtBytes(decodedBytes)} / ${fmtBytes(budget)}`];
  if (blobBytes) parts.push(`圧縮 ${fmtBytes(blobBytes)}`);
  if (mem) parts.push(`空き ${(mem.avail / (1 << 30)).toFixed(1)}GB`);
  $('#memHint').textContent = parts.join(' ・ ');
}

/* ------------------------------------------------------------------ */
/* 監視ループ                                                           */
/* ------------------------------------------------------------------ */
async function poll() {
  if (!state.dir) return;
  let files;
  try {
    files = await Backend.listFiles();
  } catch { return; }

  const present = new Set(files.map((f) => f.name));
  let dirty = false;

  for (const f of files) {
    const ver = `${f.mtime}_${f.size}`;
    const wasSeen = seen.get(f.name);
    seen.set(f.name, ver);

    let L = state.layers.find((l) => l.name === f.name);
    if (!L) { L = newLayer(f.name); state.layers.push(L); dirty = true; }
    if (L.missing) { L.missing = false; dirty = true; }

    const ts = tilesets.get(f.name);
    // 2回続けて同じ版が見えた＝書き込み完了とみなす（巨大PNGの途中読みを防ぐ）
    if (wasSeen === ver && (!ts || ts.ver !== ver)) {
      enqueueTiling(f.name, ver);
      flashRow(f.name);
      dirty = true;
    }
  }

  for (const L of state.layers) {
    if (!present.has(L.name) && !L.missing) { L.missing = true; dirty = true; }
  }
  for (const k of [...seen.keys()]) if (!present.has(k)) seen.delete(k);

  if (dirty) { renderLayers(); requestRender(); scheduleSave(); }
}

function flashRow(name) {
  const row = document.querySelector(`.row[data-name="${CSS.escape(name)}"]`);
  if (!row) return;
  row.classList.add('updated');
  setTimeout(() => row.classList.remove('updated'), 900);
}

function updateStatusLine() {
  let working = 0, done = 0, total = 0;
  for (const ts of tilesets.values()) {
    if (ts.status === 'tiling') { working++; done += ts.done; total += ts.total; }
  }
  if (!working) { if (state.dir) setStatus('監視中', 'ok'); return; }
  const pct = total ? Math.round(done / total * 100) : 0;
  setStatus(`マス目に切り分け中 ${working}枚 (${pct}%)`, 'busy');
}

/* ------------------------------------------------------------------ */
/* 描画                                                                */
/* ------------------------------------------------------------------ */
const viewCv = $('#view');
const vctx = viewCv.getContext('2d', { alpha: false });
const stageCv = document.createElement('canvas');
const stageCtx = stageCv.getContext('2d');
const layerCv = document.createElement('canvas');
const layerCtx = layerCv.getContext('2d');

let raf = 0, vw = 0, vh = 0, saveTimer = 0, busy = false;

function requestRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}

function sizeCanvases(dpr) {
  for (const [cv, ctx] of [[viewCv, vctx], [stageCv, stageCtx], [layerCv, layerCtx]]) {
    if (cv.width !== vw * dpr || cv.height !== vh * dpr) {
      cv.width = Math.max(1, Math.round(vw * dpr));
      cv.height = Math.max(1, Math.round(vh * dpr));
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  const rect = viewCv.getBoundingClientRect();
  vw = Math.max(1, Math.round(rect.width));
  vh = Math.max(1, Math.round(rect.height));
  sizeCanvases(dpr);

  vctx.globalAlpha = 1; vctx.globalCompositeOperation = 'source-over';
  vctx.fillStyle = '#0e0f12';
  vctx.fillRect(0, 0, vw, vh);

  const { w: dw, h: dh } = docSize();
  if (!dw) { updateHud(0, 0); return; }

  const v = state.view;
  if (!v.fitted) fit(false);
  if (v.zoom <= 0) { updateHud(dw, dh); return; }

  // レイヤーごとに透明なキャンバスへ描いてから、ブレンドモードで重ねる。
  // （マス目単位でブレンドすると継ぎ目が二重に合成されてしまうため）
  stageCtx.clearRect(0, 0, vw, vh);
  stageCtx.globalAlpha = 1;
  stageCtx.globalCompositeOperation = 'source-over';

  for (const L of state.layers) {
    if (!L.visible || L.missing) continue;
    const ts = tilesets.get(L.name);
    if (!ts || !ts.w || !ts.levels.length) continue;
    layerCtx.clearRect(0, 0, vw, vh);
    drawLayer(layerCtx, L, ts);
    stageCtx.globalAlpha = clamp(L.opacity, 0, 1);
    stageCtx.globalCompositeOperation = L.blend;
    stageCtx.drawImage(layerCv, 0, 0, layerCv.width, layerCv.height, 0, 0, vw, vh);
  }
  stageCtx.globalAlpha = 1;
  stageCtx.globalCompositeOperation = 'source-over';

  const x = v.panX, y = v.panY, w = dw * v.zoom, h = dh * v.zoom;

  vctx.save();
  if (v.flipH) { vctx.translate(vw, 0); vctx.scale(-1, 1); }

  const mode = BG_MODES[v.bg];
  if (mode === 'checker') {
    vctx.fillStyle = checker(vctx);
    vctx.save(); vctx.translate(x, y); vctx.fillRect(0, 0, w, h); vctx.restore();
  } else {
    vctx.fillStyle = mode === 'white' ? '#ffffff' : mode === 'gray' ? '#808080' : '#000000';
    vctx.fillRect(x, y, w, h);
  }

  vctx.drawImage(stageCv, 0, 0, stageCv.width, stageCv.height, 0, 0, vw, vh);

  vctx.lineWidth = 1;
  vctx.strokeStyle = 'rgba(255,255,255,.35)';
  vctx.strokeRect(x + .5, y + .5, w - 1, h - 1);
  if (v.guide) drawGuides(vctx, x, y, w, h);
  vctx.restore();

  updateHud(dw, dh);
  evict();
  updateMemHint();
}

/** レイヤー1枚を、粗い段を下敷きにしてからちょうどよい段のマス目で描く */
function drawLayer(g, L, ts) {
  const maxL = ts.levels.length - 1;
  // 画面の実ピクセル密度まで含めた倍率で段を選ぶ。
  // これを入れないと高精細ディスプレイで 1 段粗いマス目を使ってしまう。
  const k = state.view.zoom * L.scale * (window.devicePixelRatio || 1);
  const target = clamp(Math.floor(Math.log2(1 / Math.max(k, 1e-9))), 0, maxL);

  // 下敷き（常駐している一番粗い段）→ 中間 → 目的の段、の順に置き換えていく。
  // 細かい段は「重ねる」のではなく、その範囲を消してから描く。重ねると
  // 線と線の隙間に下敷きのボケが残ってしまうため。
  // 下敷きと中間は仮の絵なので、多少ボケても補間ありのほうが見やすい。
  drawLevel(g, L, ts, maxL, false, false);
  if (target + 1 < maxL && ts.ready.has(target + 1)) drawLevel(g, L, ts, target + 1, true, false);
  if (target < maxL) drawLevel(g, L, ts, target, true, true);
}

function drawLevel(g, L, ts, li, replace, sharpOk) {
  const v = state.view;
  const lev = ts.levels[li];
  if (!lev) return;
  const rx = lev.w / ts.w, ry = lev.h / ts.h;
  const T = ts.tile;

  // このマス目1pxが画面の何pxになるか。1 を超える＝拡大して描いている。
  const scaleDev = (ts.w / lev.w) * v.zoom * L.scale * (window.devicePixelRatio || 1);
  // 拡大時は補間を切る。Chrome は拡大でも縮小版を混ぜてしまい、線の隙間が
  // 濁るため（実測: 隙間のアルファが 0 でなく 65 になる）。
  // 逆に縮小時は補間必須で、切ると細い線が丸ごと消える。
  g.imageSmoothingEnabled = !(sharpOk && scaleDev > 1.01);
  g.imageSmoothingQuality = 'high';

  // 画面に映っている範囲を、レイヤー自身の座標に直す
  const dx0 = -v.panX / v.zoom, dx1 = (vw - v.panX) / v.zoom;
  const dy0 = -v.panY / v.zoom, dy1 = (vh - v.panY) / v.zoom;
  let ua = (dx0 - L.x) / L.scale, ub = (dx1 - L.x) / L.scale;
  if (L.flipH) { const a = ts.w - ub, b = ts.w - ua; ua = a; ub = b; }
  const u0 = clamp(ua, 0, ts.w), u1 = clamp(ub, 0, ts.w);
  const w0 = clamp((dy0 - L.y) / L.scale, 0, ts.h), w1 = clamp((dy1 - L.y) / L.scale, 0, ts.h);
  if (u1 <= u0 || w1 <= w0) return;

  const c0 = Math.max(0, Math.floor(u0 * rx / T));
  const c1 = Math.min(lev.cols - 1, Math.floor((u1 * rx - 1e-6) / T));
  const r0 = Math.max(0, Math.floor(w0 * ry / T));
  const r1 = Math.min(lev.rows - 1, Math.floor((w1 * ry - 1e-6) / T));

  // レイヤー座標 -> 画面座標。隣り合うマス目で同じ値になるよう整数に丸めるので継ぎ目が出ない。
  const scrX = (u) => v.panX + (L.x + (L.flipH ? (ts.w - u) : u) * L.scale) * v.zoom;
  const scrY = (t) => v.panY + (L.y + t * L.scale) * v.zoom;

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const bmp = getTile(ts, li, c, r, true);
      if (!bmp) continue;
      const lx = c * T, ly = r * T;
      const sw = Math.min(T, lev.w - lx), sh = Math.min(T, lev.h - ly);
      let X0 = Math.round(scrX(lx / rx)), X1 = Math.round(scrX((lx + sw) / rx));
      if (X1 < X0) { const t = X0; X0 = X1; X1 = t; }
      const Y0 = Math.round(scrY(ly / ry)), Y1 = Math.round(scrY((ly + sh) / ry));
      const W = X1 - X0, H = Y1 - Y0;
      if (W <= 0 || H <= 0) continue;
      if (replace) g.clearRect(X0, Y0, W, H);
      if (L.flipH) {
        g.save();
        g.translate(X0 + W, 0); g.scale(-1, 1);
        g.drawImage(bmp, 0, 0, sw, sh, 0, Y0, W, H);
        g.restore();
      } else {
        g.drawImage(bmp, 0, 0, sw, sh, X0, Y0, W, H);
      }
    }
  }
}

let checkerPat = null;
function checker(g) {
  if (!checkerPat) {
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const p = c.getContext('2d');
    p.fillStyle = '#cfcfcf'; p.fillRect(0, 0, 24, 24);
    p.fillStyle = '#a8a8a8'; p.fillRect(0, 0, 12, 12); p.fillRect(12, 12, 12, 12);
    checkerPat = g.createPattern(c, 'repeat');
  }
  return checkerPat;
}

function drawGuides(g, x, y, w, h) {
  const b = state.bleed * (state.dpi / 25.4) * state.view.zoom;
  g.save();
  g.setLineDash([6, 5]);
  g.lineWidth = 1;
  if (b > 0) {
    g.strokeStyle = 'rgba(255,90,90,.85)';
    g.strokeRect(x + b, y + b, w - b * 2, h - b * 2);
  }
  g.strokeStyle = 'rgba(90,160,255,.55)';
  g.beginPath();
  g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + h);
  g.moveTo(x, y + h / 2); g.lineTo(x + w, y + h / 2);
  g.stroke();
  g.setLineDash([2, 6]);
  g.strokeStyle = 'rgba(255,255,255,.3)';
  g.beginPath();
  for (let i = 1; i < 3; i++) {
    g.moveTo(x + w * i / 3, y); g.lineTo(x + w * i / 3, y + h);
    g.moveTo(x, y + h * i / 3); g.lineTo(x + w, y + h * i / 3);
  }
  g.stroke();
  g.restore();
}

function updateHud(dw, dh) {
  $('#hudZoom').textContent = Math.round(state.view.zoom * 100) + '%';
  $('#hudSize').textContent = dw ? `${dw} × ${dh} px` : '';
  if (dw && state.dpi > 0) {
    const mm = (n) => (n / state.dpi * 25.4).toFixed(0);
    $('#hudMm').textContent = `${mm(dw)} × ${mm(dh)} mm @ ${state.dpi}dpi`;
    $('#paperNote').textContent =
      `現在の合成サイズ: ${dw} × ${dh} px ＝ ${mm(dw)} × ${mm(dh)} mm（${state.dpi}dpi 換算）`;
  } else {
    $('#hudMm').textContent = '';
    $('#paperNote').textContent = 'PNGを読み込むとここに寸法が出ます。';
  }
}

/* ------------------------------------------------------------------ */
/* ビュー操作                                                           */
/* ------------------------------------------------------------------ */
function fit(rerender = true) {
  const { w: dw, h: dh } = docSize();
  const rect = viewCv.getBoundingClientRect();
  // レイアウト確定前に呼ばれるとズーム 0 になるので、その場合はやり直させる
  if (!dw || !dh || rect.width < 8 || rect.height < 8) return;
  const z = Math.max(0.01, Math.min(rect.width / dw, rect.height / dh) * 0.94);
  state.view.zoom = z;
  state.view.panX = (rect.width - dw * z) / 2;
  state.view.panY = (rect.height - dh * z) / 2;
  state.view.fitted = true;
  if (rerender) requestRender();
}

function zoomAt(cx, cy, factor) {
  const v = state.view;
  const rect = viewCv.getBoundingClientRect();
  const mx = v.flipH ? rect.width - cx : cx;
  const docX = (mx - v.panX) / v.zoom;
  const docY = (cy - v.panY) / v.zoom;
  v.zoom = clamp(v.zoom * factor, 0.01, 32);
  v.panX = mx - docX * v.zoom;
  v.panY = cy - docY * v.zoom;
  requestRender();
}

function initViewEvents() {
  let dragging = false, lx = 0, ly = 0;

  viewCv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = viewCv.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(0.998, e.deltaY));
  }, { passive: false });

  viewCv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    dragging = true; lx = e.clientX; ly = e.clientY;
    viewCv.setPointerCapture(e.pointerId);
    viewCv.classList.add('grabbing');
  });
  viewCv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    lx = e.clientX; ly = e.clientY;
    state.view.panX += state.view.flipH ? -dx : dx;
    state.view.panY += dy;
    requestRender();
  });
  const stop = (e) => {
    dragging = false;
    viewCv.classList.remove('grabbing');
    try { viewCv.releasePointerCapture(e.pointerId); } catch {}
  };
  viewCv.addEventListener('pointerup', stop);
  viewCv.addEventListener('pointercancel', stop);
  viewCv.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (!$('#exportModal').hidden) {
      if (e.key === 'Escape') closeExportDialog();
      return;                              // ダイアログ表示中はショートカットを止める
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.code === 'Space') { e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    if (k === 'f') fit();
    else if (k === '1') { state.view.zoom = 1; requestRender(); }
    else if (k === 'h') toggleView('flipH', '#btnFlip');
    else if (k === 'g') toggleView('gray', '#btnGray');
    else if (k === 'b') { state.view.bg = (state.view.bg + 1) % BG_MODES.length; requestRender(); scheduleSave(); }
  });
  window.addEventListener('resize', () => requestRender());

  // タブが裏に回ったら展開したマス目をほとんど手放す
  document.addEventListener('visibilitychange', () => { evict(); requestRender(); });

  new ResizeObserver(() => {
    const r = viewCv.getBoundingClientRect();
    if (r.width >= 8 && r.height >= 8 && state.view.zoom <= 0) state.view.fitted = false;
    requestRender();
  }).observe($('#stage'));
}

function toggleView(key, sel) {
  state.view[key] = !state.view[key];
  $(sel).classList.toggle('on', state.view[key]);
  if (key === 'gray') viewCv.classList.toggle('gray', state.view.gray);
  requestRender(); scheduleSave();
}

/* ------------------------------------------------------------------ */
/* レイヤーパネル                                                        */
/* ------------------------------------------------------------------ */
function renderLayers() {
  const box = $('#layers');
  const openState = new Map(state.layers.map((l) => [l.name, l.open]));
  box.innerHTML = '';
  $('#layerCount').textContent = state.layers.length ? `(${state.layers.length})` : '';
  $('#empty').classList.toggle('hide', !!state.dir);

  // 画面上が最前面なので、配列とは逆順に並べる
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const L = state.layers[i];
    L.open = openState.get(L.name) || false;
    box.appendChild(layerRow(L, i));
  }
}

function layerSubtitle(L, ts) {
  if (L.missing) return '⚠ ファイルが見つかりません';
  if (!ts) return '待機中…';
  if (ts.status === 'error') return '⚠ 読み込みに失敗しました';
  if (!ts.w) return '読み込み中…';
  const pct = ts.total ? Math.round(ts.done / ts.total * 100) : 0;
  const head = ts.status === 'tiling' ? `切り分け中 ${pct}%  ` : '';
  return head + `${ts.w}×${ts.h}`
    + (L.scale !== 1 ? ` ×${L.scale.toFixed(2)}` : '')
    + (L.x || L.y ? `  ⇢ ${L.x},${L.y}` : '')
    + (L.flipH ? '  ⇄' : '');
}

function layerRow(L, idx) {
  const ts = tilesets.get(L.name);
  const row = document.createElement('div');
  row.className = 'row' + (L.missing ? ' missing' : '') + (L.open ? ' open' : '') +
    (L.visible ? '' : ' hidden-layer');
  row.dataset.name = L.name;
  row.dataset.idx = String(idx);
  row.draggable = true;

  const thumb = ts && ts.thumb;
  row.innerHTML = `
    <div class="row-main">
      <span class="grip" title="ドラッグで並べ替え">⠿</span>
      <button class="eye ${L.visible ? 'on' : ''}" title="表示/非表示（Alt+クリックでソロ）">${L.visible ? '●' : '○'}</button>
      <div class="thumb" ${thumb ? `style="background-image:url(${thumb});background-size:contain;background-repeat:no-repeat;background-position:center"` : ''}></div>
      <div class="meta">
        <div class="name" title="${escapeHtml(L.name)}">${escapeHtml(L.name)}</div>
        <div class="sub">${escapeHtml(layerSubtitle(L, ts))}</div>
      </div>
      <div class="ord">
        <button class="ob up" title="ひとつ手前へ"${idx === state.layers.length - 1 ? ' disabled' : ''}>▲</button>
        <button class="ob dn" title="ひとつ奥へ"${idx === 0 ? ' disabled' : ''}>▼</button>
      </div>
      ${L.missing ? '<button class="gear del" title="この行を消す">✕</button>'
                  : '<button class="gear" title="位置・拡大・反転">⚙</button>'}
    </div>
    <div class="row-ctl">
      <select class="blend">${BLENDS.map(([v, n]) =>
        `<option value="${v}"${v === L.blend ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <input type="range" class="op" min="0" max="100" step="1" value="${Math.round(L.opacity * 100)}">
      <span class="opv">${Math.round(L.opacity * 100)}%</span>
    </div>
    <div class="row-adv">
      <label>X<input type="number" class="ax" value="${L.x}" step="1"></label>
      <label>Y<input type="number" class="ay" value="${L.y}" step="1"></label>
      <label>倍率<input type="number" class="as" value="${L.scale}" step="0.01" min="0.01" max="10"></label>
      <button class="btn tiny fliph ${L.flipH ? 'primary' : ''}">左右反転</button>
      <button class="btn tiny reset">リセット</button>
    </div>`;

  const upd = () => { requestRender(); scheduleSave(); };

  row.querySelector('.eye').addEventListener('click', (e) => {
    if (e.altKey) {
      const solo = state.layers.filter((l) => l !== L).every((l) => !l.visible) && L.visible;
      state.layers.forEach((l) => { l.visible = solo ? true : (l === L); });
    } else L.visible = !L.visible;
    renderLayers(); upd();
  });

  const move = (d) => {
    const j = idx + d;
    if (j < 0 || j >= state.layers.length) return;
    [state.layers[idx], state.layers[j]] = [state.layers[j], state.layers[idx]];
    renderLayers(); upd();
  };
  row.querySelector('.up').addEventListener('click', () => move(1));   // 画面上＝配列の後ろ
  row.querySelector('.dn').addEventListener('click', () => move(-1));

  const gear = row.querySelector('.gear');
  if (L.missing) {
    gear.addEventListener('click', () => {
      state.layers.splice(idx, 1);
      dropTileset(L.name);
      renderLayers(); upd();
    });
  } else {
    gear.addEventListener('click', () => {
      L.open = !L.open; row.classList.toggle('open', L.open);
    });
  }

  row.querySelector('.blend').addEventListener('change', (e) => { L.blend = e.target.value; upd(); });
  row.querySelector('.op').addEventListener('input', (e) => {
    L.opacity = e.target.value / 100;
    row.querySelector('.opv').textContent = e.target.value + '%';
    upd();
  });
  const num = (sel, key, min, max) => row.querySelector(sel).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) { L[key] = clamp(v, min, max); upd(); }
  });
  num('.ax', 'x', -100000, 100000);
  num('.ay', 'y', -100000, 100000);
  num('.as', 'scale', 0.01, 10);
  row.querySelector('.fliph').addEventListener('click', () => { L.flipH = !L.flipH; renderLayers(); upd(); });
  row.querySelector('.reset').addEventListener('click', () => {
    L.x = 0; L.y = 0; L.scale = 1; L.flipH = false; renderLayers(); upd();
  });

  initRowDnd(row);
  return row;
}

function initRowDnd(row) {
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', row.dataset.idx);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    document.querySelectorAll('.row').forEach((r) => r.classList.remove('dropbefore', 'dropafter'));
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    row.classList.toggle('dropbefore', !after);
    row.classList.toggle('dropafter', after);
  });
  row.addEventListener('dragleave', () => row.classList.remove('dropbefore', 'dropafter'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
    const to = parseInt(row.dataset.idx, 10);
    if (!Number.isFinite(from) || from === to) return;
    // パネルは配列の逆順（上＝最前面）なので、
    // 「行の上半分に落とす」＝配列では to より 1 つ上（大きい index）に置く。
    const r = row.getBoundingClientRect();
    const upperHalf = (e.clientY - r.top) <= r.height / 2;
    let dest = upperHalf ? to + 1 : to;
    const [moved] = state.layers.splice(from, 1);
    if (from < dest) dest--;
    state.layers.splice(clamp(dest, 0, state.layers.length), 0, moved);
    renderLayers(); requestRender(); scheduleSave();
  });
}

/* ------------------------------------------------------------------ */
/* プロジェクト保存 / 読み込み                                            */
/* ------------------------------------------------------------------ */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 900);
}

async function saveProject() {
  if (!state.dir) return;
  const data = {
    version: 2,
    dpi: state.dpi,
    bleed: state.bleed,
    exportScale: state.exportScale,
    view: { flipH: state.view.flipH, gray: state.view.gray, bg: state.view.bg, guide: state.view.guide },
    layers: state.layers.map((L) => ({
      name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend,
      x: L.x, y: L.y, scale: L.scale, flipH: L.flipH,
    })),
  };
  try {
    await Backend.saveProject(data);
  } catch { /* 保存失敗は致命的ではないので黙って無視 */ }
}

function applyProject(p) {
  if (!p) return;
  if (Number.isFinite(p.dpi)) state.dpi = p.dpi;
  if (Number.isFinite(p.bleed)) state.bleed = p.bleed;
  if (Number.isFinite(p.exportScale) && p.exportScale > 0) state.exportScale = p.exportScale;
  if (p.view) Object.assign(state.view, {
    flipH: !!p.view.flipH, gray: !!p.view.gray,
    bg: p.view.bg | 0, guide: !!p.view.guide,
  });
  if (Array.isArray(p.layers)) {
    state.layers = p.layers.map((s) => Object.assign(newLayer(s.name), {
      visible: s.visible !== false,
      opacity: Number.isFinite(s.opacity) ? s.opacity : 1,
      blend: BLENDS.some(([v]) => v === s.blend) ? s.blend : 'source-over',
      x: s.x || 0, y: s.y || 0,
      scale: Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1,
      flipH: !!s.flipH,
      missing: true,  // ポーリングで実在が確認できたら false になる
    }));
  }
  syncUiFromState();
}

function syncUiFromState() {
  $('#inDpi').value = state.dpi;
  $('#inBleed').value = state.bleed;
  $('#btnFlip').classList.toggle('on', state.view.flipH);
  $('#btnGray').classList.toggle('on', state.view.gray);
  $('#btnGuide').classList.toggle('on', state.view.guide);
  viewCv.classList.toggle('gray', state.view.gray);
}

/* ------------------------------------------------------------------ */
/* 書き出し（原寸合成 / 元PNGから直接読む）                                */
/* ------------------------------------------------------------------ */

/** PNG のチャンク用 CRC32 */
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const u32 = (...vals) => {
  const d = new Uint8Array(vals.length * 4);
  const v = new DataView(d.buffer);
  vals.forEach((n, i) => v.setUint32(i * 4, n));
  return d;
};

/**
 * ブラウザが吐く PNG は解像度もカラープロファイルも持たないため、
 * そのままだと Photoshop 等で 72dpi 扱いになり、A2 なのに巨大な絵として開かれる。
 * IHDR の直後に pHYs（解像度）と sRGB 一式を差し込んで体裁を整える。
 */
async function stampPngMetadata(blob, dpi) {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const type = String.fromCharCode(...buf.subarray(12, 16));
    if (type !== 'IHDR') return blob;                 // 想定外の形なら触らない
    const ihdrEnd = 8 + 4 + 4 + v.getUint32(8) + 4;

    const ppm = Math.max(1, Math.round(dpi / 0.0254));  // 1メートルあたりのピクセル数
    const extra = [
      pngChunk('pHYs', new Uint8Array([...u32(ppm, ppm), 1])),   // 単位 1 = メートル
      pngChunk('sRGB', new Uint8Array([0])),                     // 0 = 知覚的
      pngChunk('gAMA', u32(45455)),                              // sRGB を書くとき推奨の値
      pngChunk('cHRM', u32(31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000)),
    ];
    const parts = [buf.subarray(0, ihdrEnd), ...extra, buf.subarray(ihdrEnd)];
    return new Blob(parts, { type: 'image/png' });
  } catch {
    return blob;   // 失敗しても画素は正しいので、そのまま出す
  }
}
async function exportComposite() {
  if (busy) return false;
  const { w: dw, h: dh } = docSize();
  if (!dw) { setStatus('レイヤーがありません', 'err'); return false; }
  const targets = state.layers.filter((L) => L.visible && !L.missing && tilesets.has(L.name));
  if (!targets.length) { setStatus('表示中のレイヤーがありません', 'err'); return false; }

  busy = true;
  $('#btnExport').disabled = true;
  try {
    const s = clamp(state.exportScale || 1, 0.01, 1);
    const outW = Math.max(1, Math.round(dw * s));
    const outH = Math.max(1, Math.round(dh * s));
    const outDpi = state.dpi * s;
    setStatus(`合成中… 0/${targets.length}`, 'busy');
    const c = document.createElement('canvas');
    c.width = outW; c.height = outH;
    const g = c.getContext('2d');
    if (!g) throw new Error('キャンバスを作れませんでした（サイズが大きすぎる可能性）');

    // 大きすぎるキャンバスをブラウザは例外なしで無効化する。描いても反映されず、
    // そのままだと真っ白なPNGが書き出されてしまうので、1px 描いて読み返して確かめる。
    // 実測の上限はおよそ 2億7千万画素（A0/350dpi は通り、A1/600dpi は通らない）。
    g.fillStyle = '#fff';
    g.fillRect(outW - 1, outH - 1, 1, 1);
    if (g.getImageData(outW - 1, outH - 1, 1, 1).data[3] !== 255) {
      throw new Error(
        `${outW}×${outH}（${Math.round(outW * outH / 1e6)}メガ画素）はブラウザで扱える上限を超えています。`
        + '書き出しの倍率を下げてください');
    }
    g.clearRect(outW - 1, outH - 1, 1, 1);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.setTransform(s, 0, 0, s, 0, 0);   // 以降はドキュメント座標のまま描ける

    let i = 0;
    for (const L of targets) {
      const ts = tilesets.get(L.name);
      const buf = await Backend.readImage(L.name, ts.ver);
      const full = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
      const w = full.width * L.scale, h = full.height * L.scale;
      g.save();
      g.globalAlpha = clamp(L.opacity, 0, 1);
      g.globalCompositeOperation = L.blend;
      g.translate(L.x, L.y);
      if (L.flipH) { g.translate(w, 0); g.scale(-1, 1); }
      g.drawImage(full, 0, 0, full.width, full.height, 0, 0, w, h);
      g.restore();
      full.close();
      setStatus(`合成中… ${++i}/${targets.length}`, 'busy');
    }

    setStatus('PNGに変換中…（大きいので少し待ちます）', 'busy');
    const raw = await new Promise((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error('PNG変換に失敗しました'))), 'image/png'));
    const blob = await stampPngMetadata(raw, outDpi);

    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
      .replace(/(\d{8})(\d{6})/, '$1_$2');
    const name = `check_${stamp}_${outW}x${outH}.png`;
    setStatus('保存中… ' + fmtBytes(blob.size), 'busy');
    await Backend.saveExport(name, blob);
    setStatus(`書き出しました: _export/${name}（${fmtBytes(blob.size)} / ${Math.round(outDpi)}dpi）`, 'ok');
    return true;
  } catch (e) {
    setStatus('書き出し失敗: ' + (e.message || e), 'err');
    return false;
  } finally {
    busy = false;
    $('#btnExport').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 書き出しダイアログ                                                    */
/* ------------------------------------------------------------------ */
const EXPORT_SCALES = [[1, '原寸'], [0.5, '1/2'], [0.25, '1/4'], [0.125, '1/8']];

function openExportDialog() {
  const { w: dw, h: dh } = docSize();
  if (!dw) { setStatus('レイヤーがありません', 'err'); return; }

  const list = $('#scaleList');
  list.innerHTML = EXPORT_SCALES.map(([sc, label]) => `
    <label class="scale-row${sc === state.exportScale ? ' on' : ''}">
      <input type="radio" name="expscale" value="${sc}"${sc === state.exportScale ? ' checked' : ''}>
      <span class="scale-name">${label}</span>
      <span class="scale-size">${Math.round(dw * sc)} × ${Math.round(dh * sc)} px 　 ${Math.round(state.dpi * sc)} dpi</span>
    </label>`).join('');
  list.querySelectorAll('input').forEach((r) => r.addEventListener('change', () => {
    state.exportScale = parseFloat(r.value) || 1;
    list.querySelectorAll('.scale-row').forEach((row) =>
      row.classList.toggle('on', row.querySelector('input').checked));
    scheduleSave();
  }));

  const mm = (n) => (n / state.dpi * 25.4).toFixed(0);
  $('#exportPaper').textContent =
    `どの倍率でも用紙サイズは ${mm(dw)} × ${mm(dh)} mm のままです（解像度だけが変わります）。`;

  const st = $('#exportStatus');
  st.textContent = ''; st.className = 'status';
  $('#btnExportGo').disabled = false;
  $('#btnExportGo').hidden = false;
  $('#btnExportClose').disabled = false;
  $('#btnExportClose').textContent = 'キャンセル';
  $('#exportModal').hidden = false;
  $('#btnExportGo').focus();
}

function closeExportDialog() {
  if (busy) return;                       // 書き出し中は閉じさせない
  $('#exportModal').hidden = true;
}

async function runExport() {
  $('#btnExportGo').disabled = true;
  $('#btnExportClose').disabled = true;
  const ok = await exportComposite();
  $('#btnExportClose').disabled = false;
  if (ok) {
    $('#btnExportGo').hidden = true;      // 済んだので押せないようにする
    $('#btnExportClose').textContent = '閉じる';
  } else {
    $('#btnExportGo').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 起動                                                                */
/* ------------------------------------------------------------------ */
async function openFolder(fromPicker) {
  try {
    const j = fromPicker ? await Backend.pickFolder() : await Backend.getState();
    if (!j || !j.dir) return;
    adoptDir(j);
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  }
}

function adoptDir(j) {
  state.dir = j.dir;
  $('#dirLabel').textContent = j.dir;
  $('#dirLabel').title = j.dir;
  for (const name of [...tilesets.keys()]) dropTileset(name);
  seen.clear();
  jobQueue.length = 0;
  state.layers = [];
  applyProject(j.project);
  if (j.mem) { mem = j.mem; budget = clamp(Math.round(mem.avail * 0.25), 96 * MB, 1536 * MB); }
  state.view.fitted = false;
  renderLayers(); requestRender();
  setStatus('監視中', 'ok');
  poll();
}

function initUi() {
  $('#btnPick').addEventListener('click', () => openFolder(true));
  $('#btnPick2').addEventListener('click', () => openFolder(true));
  $('#btnReveal').addEventListener('click', () => Backend.reveal().catch(() => {}));

  $('#btnFit').addEventListener('click', () => fit());
  $('#btnOne').addEventListener('click', () => { state.view.zoom = 1; requestRender(); });
  $('#btnFlip').addEventListener('click', () => toggleView('flipH', '#btnFlip'));
  $('#btnGray').addEventListener('click', () => toggleView('gray', '#btnGray'));
  $('#btnGuide').addEventListener('click', () => toggleView('guide', '#btnGuide'));
  $('#btnBg').addEventListener('click', () => {
    state.view.bg = (state.view.bg + 1) % BG_MODES.length; requestRender(); scheduleSave();
  });
  $('#btnExport').addEventListener('click', openExportDialog);
  $('#btnExportGo').addEventListener('click', runExport);
  $('#btnExportClose').addEventListener('click', closeExportDialog);
  $('#exportModal').addEventListener('click', (e) => {
    if (e.target === $('#exportModal')) closeExportDialog();   // 背景クリックで閉じる
  });

  $('#btnSortName').addEventListener('click', () => {
    state.layers.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
    renderLayers(); requestRender(); scheduleSave();
  });
  $('#btnAllOn').addEventListener('click', () => {
    state.layers.forEach((l) => (l.visible = true));
    renderLayers(); requestRender(); scheduleSave();
  });

  $('#inDpi').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) { state.dpi = v; requestRender(); scheduleSave(); }
  });
  $('#inBleed').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v >= 0) { state.bleed = v; requestRender(); scheduleSave(); }
  });

  initViewEvents();
}

(async function main() {
  initUi();
  initWorkers();
  syncUiFromState();
  try {
    const j = await Backend.getState();
    if (j && j.dir) adoptDir(j);
  } catch {}
  // OS からファイル変更が通知される環境では、間隔をあけた保険のみにする
  Backend.onChange(() => { poll(); setTimeout(poll, 500); });
  setInterval(poll, Backend.pushesChanges ? 2500 : 800);
  setInterval(refreshMem, 5000);
  setInterval(updateStatusLine, 500);
  setInterval(evict, 1000);   // 描画が来ないときの保険
  refreshMem();
  requestRender();
})();
