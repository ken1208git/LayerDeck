/* LayerDeck - 透過PNG リアルタイム重ね合わせプレビュー (client)
 *
 * 各PNGは worker が 1024px のマス目（タイル）に切り分けて PNG Blob で保持する。
 * 画面に映っているマス目だけを展開（ImageBitmap 化）するので、
 * 使用メモリは「絵の大きさ・枚数」ではなく「表示領域の広さ」で決まる。
 * 展開量の上限は、実測した空き物理メモリから自動で決める。
 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MB = 1 << 20;

/* ------------------------------------------------------------------ */
/* 定数                                                                */
/* ------------------------------------------------------------------ */
const BLENDS = [
  ['source-over', '通常'],
  ['multiply', '乗算'],
  ['screen', 'スクリーン'],
  ['overlay', 'オーバーレイ'],
  ['darken', '比較（暗）'],
  ['lighten', '比較（明）'],
  ['color-dodge', '覆い焼きカラー'],
  ['color-burn', '焼き込みカラー'],
  ['hard-light', 'ハードライト'],
  ['soft-light', 'ソフトライト'],
  ['difference', '差の絶対値'],
  ['exclusion', '除外'],
  ['lighter', '加算'],
  ['hue', '色相'],
  ['saturation', '彩度'],
  ['color', 'カラー'],
  ['luminosity', '輝度'],
];
const BG_MODES = ['checker', 'white', 'gray', 'black'];

/** 用紙（mm、縦向きの値）。B判は JIS */
const PAPERS = [
  { key: 'none', label: '指定なし' },
  { key: 'A0', w: 841, h: 1189 }, { key: 'A1', w: 594, h: 841 }, { key: 'A2', w: 420, h: 594 },
  { key: 'A3', w: 297, h: 420 }, { key: 'A4', w: 210, h: 297 }, { key: 'A5', w: 148, h: 210 },
  { key: 'A6', w: 105, h: 148 },
  { key: 'B0', w: 1030, h: 1456 }, { key: 'B1', w: 728, h: 1030 }, { key: 'B2', w: 515, h: 728 },
  { key: 'B3', w: 364, h: 515 }, { key: 'B4', w: 257, h: 364 }, { key: 'B5', w: 182, h: 257 },
  { key: 'B6', w: 128, h: 182 },
  { key: 'custom', label: '自由入力' },
];

/** これを超える枚数のフォルダは、確認するまで読み込まない */
const MAX_AUTO_LAYERS = 60;
/** カットライン予想で「絵」とみなす不透明度（0〜255）。10% 程度 */
const CUT_ALPHA = 26;
/** 書き出し倍率 */
const EXPORT_SCALES = [[1, '原寸'], [0.5, '1/2'], [0.25, '1/4'], [0.125, '1/8']];

const svg = (body, extra = '') =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
const ICON = {
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  flip: svg('<path d="M12 3v18"/><path d="M8 7l-5 5 5 5z"/><path d="M16 7l5 5-5 5z"/>'),
  gray: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  alpha: svg('<circle cx="12" cy="12" r="5" fill="currentColor"/><circle cx="12" cy="12" r="9" stroke-dasharray="2.5 2.5"/>'),
  guide: svg('<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 3"/><path d="M12 7v10M7 12h10" stroke-width="1.5"/>'),
  bg: svg('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h8V4M12 20v-8h8" fill="currentColor" stroke="none" opacity=".55"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  eye: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  eyeOff: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" opacity=".35"/><path d="M4 4l16 16"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>', 'stroke-width="2.6"'),
  down: svg('<path d="M6 9l6 6 6-6"/>', 'stroke-width="2.6"'),
  tune: svg('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>', 'fill="currentColor" stroke="none"'),
};

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */
const state = {
  dir: null,
  layers: [],              // index 0 = 最下層
  paper: 'none',           // PAPERS の key
  customW: 0, customH: 0,  // 自由入力の用紙（mm）
  dpi: 350,
  dpiSource: 'default',    // 'png'=画像から読み取り / 'manual'=手入力 / 'default'=仮の値
  bleed: 0,                // 四角く刷るときの塗り足し（mm）
  cutMargin: 10,           // カットライン予想：絵の何mm外側で切るか（プリオは約10mm）
  guides: { trim: true, center: true, thirds: true, cut: false },
  exportScale: 1,          // 書き出しの倍率。用紙の物理サイズは変えず解像度だけ下げる
  view: { zoom: 1, panX: 0, panY: 0, flipH: false, gray: false, alphaCheck: false,
          bg: 0, guide: false, fitted: false },
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
let allowManyLayers = false;

let raf = 0, layersRaf = 0, vw = 0, vh = 0, saveTimer = 0, busy = false;
let saveFailed = false, lastLoggedErr = '';

/** カットライン予想の計算結果 */
const cut = { key: '', path: null, stats: null, timer: 0, running: false, waiting: false };

const newLayer = (name) => ({
  name, visible: true, opacity: 1, blend: 'source-over',
  x: 0, y: 0, scale: 1, flipH: false, open: false, missing: false,
});

const newTileset = (name, ver) => ({
  name, ver, w: 0, h: 0, tile: 1024, levels: [], dpi: null,   // 実際の値は worker の geom で上書き
  blobs: new Map(), blobBytes: 0,
  ready: new Set(), status: 'tiling', done: 0, total: 0, thumb: null,
});

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */
const pad2 = (n) => String(n).padStart(2, '0');
/** 現地時刻（ファイル名用） 20260927_143012 */
const fileStamp = (d = new Date()) =>
  `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
/** 現地時刻（ログ用） 2026-09-27 14:30:12 */
const logStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

function log(level, msg) {
  try { Backend.log(`${logStamp()} [${level}] ${msg}`); } catch { /* ログは失敗しても困らない */ }
}

function setStatus(msg, kind = '', noLog = false) {
  const el = $('#status');
  el.textContent = msg || '';
  el.className = 'status ' + kind;
  if (kind === 'err' && msg && !noLog && msg !== lastLoggedErr) { lastLoggedErr = msg; log('error', msg); }
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

/** 一覧に出す名前（拡張子は省く） */
const displayName = (name) => name.replace(/\.(png|webp|jpe?g|gif|bmp)$/i, '');
const byName = (a, b) => a.localeCompare(b, 'ja', { numeric: true });

/** ドキュメント寸法 = 各レイヤーの最大幅・最大高さ */
function docSize() {
  let w = 0, h = 0;
  for (const L of state.layers) {
    const ts = tilesets.get(L.name);
    if (ts && ts.w) { w = Math.max(w, ts.w); h = Math.max(h, ts.h); }
  }
  return { w, h };
}

const pxToMm = (px) => px / state.dpi * 25.4;

/* ------------------------------------------------------------------ */
/* 用紙と規格チェック                                                    */
/* ------------------------------------------------------------------ */
/** 選んだ用紙を、絵の向き（縦長・横長）に合わせて mm で返す。指定なしなら null */
function paperMM(dw, dh) {
  let w = 0, h = 0, label = state.paper;
  if (state.paper === 'custom') { w = state.customW; h = state.customH; label = '指定の用紙'; }
  else {
    const p = PAPERS.find((x) => x.key === state.paper);
    if (!p || !p.w) return null;
    w = p.w; h = p.h;
  }
  if (!(w > 0 && h > 0)) return null;
  const small = Math.min(w, h), large = Math.max(w, h);
  const landscape = dw > dh;
  return landscape ? { w: large, h: small, label, landscape } : { w: small, h: large, label, landscape };
}

/** その用紙・dpi・塗り足しで作るべきピクセル数 */
function expectedPx(pm) {
  const b = state.bleed || 0;
  return {
    w: Math.round((pm.w + 2 * b) / 25.4 * state.dpi),
    h: Math.round((pm.h + 2 * b) / 25.4 * state.dpi),
  };
}

/** 1枚の画像がその規格に合っているか */
function judge(ts, pm) {
  if (!pm || !ts || !ts.w) return null;
  const ex = expectedPx(pm);
  let note = '';
  if (ts.dpi && Math.abs(ts.dpi.x - state.dpi) > 0.5) note = `（画像の記録は ${Math.round(ts.dpi.x)}dpi）`;
  if (Math.abs(ts.w - ex.w) <= 2 && Math.abs(ts.h - ex.h) <= 2) {
    return { ok: true, short: '✓ 規格どおり' + note, detail: `${pm.label}・${state.dpi}dpi の ${ex.w}×${ex.h}px と一致` + note };
  }
  // 用紙ぴったりで、塗り足しの分だけ足りない（よくある取り違え）
  if (state.bleed > 0) {
    const bare = { w: Math.round(pm.w / 25.4 * state.dpi), h: Math.round(pm.h / 25.4 * state.dpi) };
    if (Math.abs(ts.w - bare.w) <= 2 && Math.abs(ts.h - bare.h) <= 2) {
      return { ok: false, short: `⚠ 塗り足し${state.bleed}mmが無い`,
        detail: `${pm.label}ぴったりの ${ts.w}×${ts.h}px です。塗り足し込みなら ${ex.w}×${ex.h}px。切り抜き（ダイカット）なら塗り足しを 0 に` };
    }
  }
  const inW = (pm.w + 2 * state.bleed) / 25.4, inH = (pm.h + 2 * state.bleed) / 25.4;
  const dW = ts.w / inW, dH = ts.h / inH;
  if (Math.abs(dW - dH) / Math.max(dW, dH) > 0.01) {
    return { ok: false, short: '⚠ 縦横比が用紙と違う',
      detail: `${ts.w}×${ts.h}px は ${pm.label} の比率と合いません（規格どおりなら ${ex.w}×${ex.h}px）` };
  }
  const eff = Math.round((dW + dH) / 2);
  return { ok: false, short: `⚠ ${pm.label}だと約${eff}dpi`,
    detail: `規格どおりなら ${ex.w}×${ex.h}px。この ${ts.w}×${ts.h}px を ${pm.label} で刷ると約${eff}dpi になります` + note };
}

/** 画像に記録された dpi を使う（手入力されていない場合） */
function autoDpi() {
  const vals = [...tilesets.values()].map((t) => t.dpi && Math.round(t.dpi.x)).filter(Boolean);
  if (state.dpiSource !== 'manual' && vals.length) {
    const count = new Map();
    for (const v of vals) count.set(v, (count.get(v) || 0) + 1);
    const best = [...count].sort((a, b) => b[1] - a[1])[0][0];
    if (state.dpi !== best || state.dpiSource !== 'png') {
      state.dpi = best; state.dpiSource = 'png';
      syncUiFromState(); scheduleSave(); requestRender(); scheduleCut();
    }
  }
  updateSpec();
}

function updateSpec() {
  const { w: dw, h: dh } = docSize();
  const recorded = [...new Set([...tilesets.values()].map((t) => t.dpi && Math.round(t.dpi.x)).filter(Boolean))];

  // dpi の出どころ
  const src = $('#dpiSource');
  if (state.dpiSource === 'png') src.textContent = `画像から読み取り（${recorded.join(' / ')}dpi）`;
  else if (state.dpiSource === 'manual') src.textContent = '手入力';
  else src.textContent = dw ? '画像に記録なし（仮の値）' : '画像を読み込むと自動で入ります';
  $('#btnDpiAuto').hidden = !(state.dpiSource === 'manual' && recorded.length);

  const box = $('#specResult');
  if (!dw) { box.innerHTML = ''; return; }
  const mm = (n) => pxToMm(n).toFixed(0);
  const pm = paperMM(dw, dh);
  const lines = [];
  if (!pm) {
    lines.push(`いまの大きさ <b>${dw} × ${dh} px</b> ＝ ${mm(dw)} × ${mm(dh)} mm（${state.dpi}dpi）`);
    lines.push('用紙を選ぶと、サイズが合っているか判定します');
  } else {
    const ex = expectedPx(pm);
    const orient = pm.landscape ? '横' : '縦';
    lines.push(`ibis で作る大きさ <b>${ex.w} × ${ex.h} px</b>`);
    lines.push(`（${pm.label}・${orient}向き・${state.dpi}dpi${state.bleed > 0 ? `・塗り足し${state.bleed}mm込み` : ''}）`);
    const loaded = state.layers.filter((L) => !L.missing && tilesets.get(L.name)?.w);
    const bad = loaded.filter((L) => !judge(tilesets.get(L.name), pm).ok);
    if (loaded.length) {
      lines.push(bad.length
        ? `<span class="bad">⚠ ${bad.length}枚のサイズが違います（一覧の黄色の行）</span>`
        : `<span class="ok">✓ ${loaded.length}枚すべて規格どおり</span>`);
    }
  }
  if (recorded.length > 1) lines.push(`<span class="warn">⚠ 画像によって記録された dpi が違います（${recorded.join(' / ')}）</span>`);
  box.innerHTML = lines.join('<br>');
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
    w.onerror = (e) => { log('error', 'worker: ' + (e.message || e)); slot.busy = false; pumpJobs(); };
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
      // 画面には分かる言葉で、詳しい原因はログへ
      log('error', `読み込み失敗 ${job.name}: ${e.message || e}`);
      setStatus(`${displayName(job.name)} を読み込めませんでした（詳しくは「LayerDeck について」→ログ）`, 'err', true);
      const cur = tilesets.get(job.name);
      if (cur && cur.ver === job.ver) cur.status = 'error';   // 「読み込み中」のまま止まらせない
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
    Object.assign(ts, { w: m.w, h: m.h, tile: m.tile, levels: m.levels, total: m.total, dpi: m.dpi || null });
    state.view.fitted = state.view.fitted && !!docSize().w;
    autoDpi();
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
      if (m.type === 'error') {
        log('error', `画像を開けません ${m.name}: ${m.message}`);
        setStatus(`${displayName(m.name)} を画像として開けませんでした（壊れているか、対応していない形式）`, 'err', true);
      }
      renderLayers();
      scheduleCut();
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
}

/* ------------------------------------------------------------------ */
/* 監視ループ                                                           */
/* ------------------------------------------------------------------ */
/** 新しいファイルは名前順の位置に入れる（番号の小さいものが下） */
function insertByName(L) {
  const i = state.layers.findIndex((x) => byName(x.name, L.name) > 0);
  if (i < 0) state.layers.push(L); else state.layers.splice(i, 0, L);
}

async function poll() {
  if (!state.dir) return;
  let files;
  try {
    files = await Backend.listFiles();
  } catch { return; }

  if (files.length > MAX_AUTO_LAYERS && !allowManyLayers) { showTooMany(files.length); return; }

  const present = new Set(files.map((f) => f.name));
  let dirty = false;

  for (const f of files) {
    const ver = `${f.mtime}_${f.size}`;
    const wasSeen = seen.get(f.name);
    seen.set(f.name, ver);

    let L = state.layers.find((l) => l.name === f.name);
    if (!L) { L = newLayer(f.name); insertByName(L); dirty = true; }
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

  if (dirty) { renderLayers(); requestRender(); scheduleSave(); scheduleCut(); }
}

/** 画像が多すぎるフォルダを掴んだときは、読み込みを止めて選び直させる */
function showTooMany(n) {
  clearTimeout(saveTimer);                 // うっかり空の設定を保存しない
  jobQueue.length = 0;
  for (const name of [...tilesets.keys()]) dropTileset(name);
  state.layers = [];
  $('#tooManyCount').textContent = n;
  $('#tooMany').classList.remove('hide');
  $('#empty').classList.add('hide');
  renderLayersNow();
  requestRender();
  setStatus(`画像が ${n} 枚あるため読み込みを止めました`, 'err');
}

function flashRow(name) {
  const row = document.querySelector(`.row[data-name="${CSS.escape(name)}"]`);
  if (!row) return;
  row.classList.add('updated');
  setTimeout(() => row.classList.remove('updated'), 900);
}

function updateStatusLine() {
  if (busy) return;
  if (saveFailed) { setStatus('⚠ 設定を保存できません（フォルダに書き込めない可能性）', 'err'); return; }
  let working = 0, done = 0, total = 0;
  for (const ts of tilesets.values()) {
    if (ts.status === 'tiling') { working++; done += ts.done; total += ts.total; }
  }
  if (!working) { if (state.dir) setStatus('監視中', 'ok'); return; }
  const pct = total ? Math.round(done / total * 100) : 0;
  setStatus(`読み込み中 ${working}枚 (${pct}%)`, 'busy');
}

/* ------------------------------------------------------------------ */
/* 描画                                                                */
/* ------------------------------------------------------------------ */
const viewCv = $('#view');
const vctx = viewCv.getContext('2d', { alpha: false });
const stageCv = document.createElement('canvas');
const stageCtx = stageCv.getContext('2d', { willReadFrequently: false });
const layerCv = document.createElement('canvas');
const layerCtx = layerCv.getContext('2d');

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

  if (v.alphaCheck) paintAlphaCheck();

  const x = v.panX, y = v.panY, w = dw * v.zoom, h = dh * v.zoom;

  vctx.save();
  if (v.flipH) { vctx.translate(vw, 0); vctx.scale(-1, 1); }

  const mode = v.alphaCheck ? 'checker' : BG_MODES[v.bg];
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
  if (v.guide) drawGuides(vctx, x, y, w, h, dw, dh);
  vctx.restore();

  updateHud(dw, dh);
  evict();
}

/**
 * 透明チェック：合成結果の不透明度を色分けする。
 * 切り抜きの形は「透明でない部分」から作られるので、ぼかしのにじみや
 * ほとんど見えない薄い部分が、形に含まれてしまわないかを確かめるためのもの。
 */
function paintAlphaCheck() {
  const W = stageCv.width, H = stageCv.height;
  const img = stageCtx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;                                          // 透明 → 市松が見える
    if (a >= 250) { d[i] = 70; d[i + 1] = 74; d[i + 2] = 84; }      // 不透明
    else if (a >= CUT_ALPHA) { d[i] = 255; d[i + 1] = 150; d[i + 2] = 40; }  // 半透明
    else { d[i] = 255; d[i + 1] = 40; d[i + 2] = 90; }             // ほぼ透明
    d[i + 3] = 255;
  }
  stageCtx.putImageData(img, 0, 0);
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

function guideLabel(g, text, x, y, color) {
  g.save();
  g.setLineDash([]);
  g.font = '11px "Yu Gothic UI", Meiryo, sans-serif';
  const w = g.measureText(text).width + 8;
  g.fillStyle = 'rgba(12,13,16,.8)';
  g.fillRect(x, y, w, 16);
  g.fillStyle = color;
  g.fillText(text, x + 4, y + 12);
  g.restore();
}

function drawGuides(g, x, y, w, h, dw, dh) {
  const v = state.view, G = state.guides;
  g.save();
  g.lineWidth = 1;

  if (G.trim && state.bleed > 0) {
    const b = state.bleed * (state.dpi / 25.4) * v.zoom;
    g.setLineDash([6, 5]);
    g.strokeStyle = 'rgba(255,90,90,.9)';
    g.strokeRect(x + b, y + b, w - b * 2, h - b * 2);
    if (!v.flipH) guideLabel(g, '仕上がり線', x + b + 4, y + b + 4, '#ff8a8a');
  }
  if (G.center) {
    g.setLineDash([6, 5]);
    g.strokeStyle = 'rgba(90,160,255,.6)';
    g.beginPath();
    g.moveTo(x + w / 2, y); g.lineTo(x + w / 2, y + h);
    g.moveTo(x, y + h / 2); g.lineTo(x + w, y + h / 2);
    g.stroke();
  }
  if (G.thirds) {
    g.setLineDash([2, 6]);
    g.strokeStyle = 'rgba(255,255,255,.35)';
    g.beginPath();
    for (let i = 1; i < 3; i++) {
      g.moveTo(x + w * i / 3, y); g.lineTo(x + w * i / 3, y + h);
      g.moveTo(x, y + h * i / 3); g.lineTo(x + w, y + h * i / 3);
    }
    g.stroke();
  }
  if (G.cut && cut.path) {
    g.setLineDash([]);
    g.save();
    g.translate(v.panX, v.panY);
    g.scale(v.zoom, v.zoom);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = 4 / v.zoom; g.strokeStyle = 'rgba(0,0,0,.6)'; g.stroke(cut.path);
    g.lineWidth = 2 / v.zoom; g.strokeStyle = '#00e0ff'; g.stroke(cut.path);
    g.restore();
    const t = cut.stats && cut.stats.topPt;
    if (t && !v.flipH) guideLabel(g, `カットライン予想（+${state.cutMargin}mm）`,
      v.panX + t.x * v.zoom + 8, v.panY + t.y * v.zoom - 22, '#7fefff');
  }
  g.restore();
}

function updateHud(dw, dh) {
  const dpr = window.devicePixelRatio || 1;
  // 100% ＝ 画面の実ピクセル1つに画像の1ピクセル（ペイントソフトと同じ意味）
  $('#hudZoom').textContent = Math.round(state.view.zoom * dpr * 100) + '%';
  $('#hudSize').textContent = dw ? `${dw} × ${dh} px` : '';
  $('#hudMm').textContent = dw && state.dpi > 0
    ? `${pxToMm(dw).toFixed(0)} × ${pxToMm(dh).toFixed(0)} mm @ ${state.dpi}dpi` : '';
}

/* ------------------------------------------------------------------ */
/* カットライン予想                                                      */
/*   印刷所（プリオなど）は、透明でない部分の輪郭から一定の距離だけ外側に       */
/*   カットラインを作る。その形を粗い解像度で再現する。                       */
/* ------------------------------------------------------------------ */
function cutKey() {
  const { w: dw, h: dh } = docSize();
  const vis = state.layers.filter((L) => L.visible && !L.missing && L.opacity > 0);
  return JSON.stringify([state.dpi, state.cutMargin, dw, dh,
    vis.map((L) => [L.name, tilesets.get(L.name)?.ver, L.x, L.y, L.scale, L.flipH, L.opacity])]);
}

function scheduleCut() {
  clearTimeout(cut.timer);
  if (!(state.view.guide && state.guides.cut)) { updateCutInfo(); return; }
  cut.timer = setTimeout(computeCut, 350);
}

async function computeCut() {
  if (!(state.view.guide && state.guides.cut) || cut.running) return;
  const { w: dw, h: dh } = docSize();
  if (!dw) { cut.path = null; cut.stats = null; updateCutInfo(); return; }
  const vis = state.layers.filter((L) => L.visible && !L.missing && L.opacity > 0);
  const sets = vis.map((L) => tilesets.get(L.name));
  if (sets.some((ts) => !ts || ts.status === 'tiling')) { cut.waiting = true; updateCutInfo(); return; }
  const key = cutKey();
  if (key === cut.key) return;

  cut.running = true; cut.waiting = false; updateCutInfo();
  try {
    const mmPerPx = 25.4 / state.dpi;
    const cellPx = Math.max(1, Math.ceil(Math.max(dw, dh) / 1600));   // 解析の1マス＝画像の何px
    const R = state.cutMargin / (cellPx * mmPerPx);                     // 余白をマス数で
    const pad = Math.ceil(R) + 2;
    const gw = Math.ceil(dw / cellPx), gh = Math.ceil(dh / cellPx);
    const W = gw + 2 * pad, H = gh + 2 * pad;

    // 1) 表示中のレイヤーを粗い解像度で重ね、不透明度だけを取り出す
    const cv = new OffscreenCanvas(gw, gh);
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    for (let i = 0; i < vis.length; i++) {
      const L = vis[i], ts = sets[i];
      if (!ts || ts.status !== 'ready') continue;
      const need = L.scale / cellPx;
      let li = 0;
      for (let k = ts.levels.length - 1; k >= 0; k--) if (ts.levels[k].w / ts.w >= need) { li = k; break; }
      const lev = ts.levels[li];
      g.save();
      g.setTransform(1 / cellPx, 0, 0, 1 / cellPx, 0, 0);
      g.globalAlpha = clamp(L.opacity, 0, 1);
      g.translate(L.x, L.y);
      if (L.flipH) { g.translate(ts.w * L.scale, 0); g.scale(-1, 1); }
      g.scale(L.scale * ts.w / lev.w, L.scale * ts.h / lev.h);
      for (let r = 0; r < lev.rows; r++) {
        for (let c = 0; c < lev.cols; c++) {
          const rec = ts.blobs.get(`${li}|${c}|${r}`);
          if (!rec) continue;
          const bmp = await createImageBitmap(rec.blob);
          g.drawImage(bmp, 0, 0, rec.w, rec.h, c * ts.tile, r * ts.tile, rec.w, rec.h);
          bmp.close();
        }
      }
      g.restore();
    }
    const px = g.getImageData(0, 0, gw, gh).data;

    // 2) 「絵」とみなす部分
    const inside = new Uint8Array(W * H);
    let any = false;
    for (let y = 0; y < gh; y++) {
      const row = (y + pad) * W + pad;
      for (let x = 0; x < gw; x++) if (px[(y * gw + x) * 4 + 3] >= CUT_ALPHA) { inside[row + x] = 1; any = true; }
    }
    if (!any) { cut.path = null; cut.stats = { empty: true }; cut.key = key; return; }

    // 3) 絵からの距離 → 余白以内が切り抜かれる範囲。内側の穴は埋める（細かい穴は切れないため）
    const dist = distanceField(inside, W, H);
    const region = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) region[i] = dist[i] <= R ? 1 : 0;
    const outside = floodOutside(region, W, H);
    const f = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) f[i] = outside[i] ? R - dist[i] : Math.max(R - dist[i], 0.5);

    // 4) 外周だけを線にする（画像の座標に直す）
    const toDoc = (gx) => (gx - pad + 0.5) * cellPx;
    const path = new Path2D();
    const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let topPt = null;
    marchingSquares(f, W, H, (ax, ay, bx, by) => {
      const x1 = toDoc(ax), y1 = toDoc(ay), x2 = toDoc(bx), y2 = toDoc(by);
      path.moveTo(x1, y1); path.lineTo(x2, y2);
      for (const [px2, py2] of [[x1, y1], [x2, y2]]) {
        if (px2 < bb.x0) bb.x0 = px2; if (px2 > bb.x1) bb.x1 = px2;
        if (py2 < bb.y0) { bb.y0 = py2; topPt = { x: px2, y: py2 }; }
        if (py2 > bb.y1) bb.y1 = py2;
      }
    });

    // 5) いくつの塊に分かれているか
    const pieces = countPieces(outside, W, H);

    cut.path = path;
    cut.stats = {
      pieces, topPt,
      over: { top: -bb.y0, bottom: bb.y1 - dh, left: -bb.x0, right: bb.x1 - dw },
    };
    cut.key = key;
  } catch (e) {
    log('error', 'カットライン予想: ' + (e.message || e));
    cut.path = null; cut.stats = null;
  } finally {
    cut.running = false;
  }
  updateCutInfo(); requestRender();
  if (cutKey() !== cut.key) scheduleCut();   // 計算中に何か変わっていたらやり直す
}

/** 2値画像の各マスから、いちばん近い「1」のマスまでのユークリッド距離（Felzenszwalb の方法） */
function distanceField(inside, W, H) {
  const INF = 1e20;
  const grid = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) grid[i] = inside[i] ? 0 : INF;
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const pass = (len) => {
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; const t = q - v[k]; d[q] = t * t + f[v[k]]; }
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x];
    pass(H);
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) f[x] = grid[o + x];
    pass(W);
    for (let x = 0; x < W; x++) grid[o + x] = d[x];
  }
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

/** 外周から、region に当たらずに辿り着けるマス＝外側 */
function floodOutside(region, W, H) {
  const out = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (i) => { if (!out[i] && !region[i]) { out[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp) {
    const i = stack[--sp], x = i % W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (i >= W) push(i - W);
    if (i < W * (H - 1)) push(i + W);
  }
  return out;
}

/** 外側でないマスのつながりの数 */
function countPieces(outside, W, H) {
  const seenCell = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let count = 0;
  for (let s = 0; s < W * H; s++) {
    if (outside[s] || seenCell[s]) continue;
    count++;
    let sp = 0; stack[sp++] = s; seenCell[s] = 1;
    while (sp) {
      const i = stack[--sp], x = i % W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < W * (H - 1) ? i + W : -1];
      for (const j of nb) if (j >= 0 && !outside[j] && !seenCell[j]) { seenCell[j] = 1; stack[sp++] = j; }
    }
  }
  return count;
}

/** 値が 0 を横切る線を、マスごとの線分として返す（マーチングスクエア法） */
function marchingSquares(f, W, H, emit) {
  const t = (a, b) => a / (a - b);
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = f[y * W + x], b = f[y * W + x + 1], c = f[(y + 1) * W + x + 1], d = f[(y + 1) * W + x];
      const idx = (a >= 0 ? 8 : 0) | (b >= 0 ? 4 : 0) | (c >= 0 ? 2 : 0) | (d >= 0 ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = () => [x + t(a, b), y], Rr = () => [x + 1, y + t(b, c)];
      const B = () => [x + t(d, c), y + 1], Lf = () => [x, y + t(a, d)];
      const seg = (p, q) => emit(p[0], p[1], q[0], q[1]);
      switch (idx) {
        case 1: case 14: seg(Lf(), B()); break;
        case 2: case 13: seg(B(), Rr()); break;
        case 3: case 12: seg(Lf(), Rr()); break;
        case 4: case 11: seg(T(), Rr()); break;
        case 6: case 9: seg(T(), B()); break;
        case 7: case 8: seg(Lf(), T()); break;
        case 5: if ((a + b + c + d) / 4 >= 0) { seg(Lf(), T()); seg(B(), Rr()); } else { seg(Lf(), B()); seg(T(), Rr()); } break;
        case 10: if ((a + b + c + d) / 4 >= 0) { seg(T(), Rr()); seg(Lf(), B()); } else { seg(Lf(), T()); seg(B(), Rr()); } break;
      }
    }
  }
}

function updateCutInfo() {
  const box = $('#cutInfo');
  if (!state.guides.cut) { box.innerHTML = ''; return; }
  if (!state.view.guide) { box.innerHTML = '画面右上のガイドのボタンを押すと表示・計算します'; return; }
  if (cut.waiting) { box.innerHTML = '読み込みが終わってから計算します…'; return; }
  if (cut.running) { box.innerHTML = '計算中…'; return; }
  const s = cut.stats;
  if (!s) { box.innerHTML = ''; return; }
  if (s.empty) { box.innerHTML = '表示中のレイヤーに不透明な部分がありません'; return; }

  const mm = (px) => pxToMm(Math.max(0, px));
  const lines = [];
  lines.push(s.pieces === 1
    ? '<span class="ok">✓ 1つながりの形です</span>'
    : `<span class="bad">⚠ ${s.pieces}つに分かれています</span>（離れた部分は別に切り抜かれるか、無視されます）`);
  const names = { top: '上', bottom: '下', left: '左', right: '右' };
  const over = Object.entries(s.over).filter(([, v]) => mm(v) >= 0.5);
  if (over.length) {
    lines.push(`<span class="bad">⚠ キャンバスからはみ出します：${over.map(([k, v]) => `${names[k]} ${mm(v).toFixed(1)}mm`).join('・')}</span>`);
    lines.push('用紙の中に収める必要がある場合は、その辺の絵を内側へ寄せてください');
  } else {
    const gaps = Object.values(s.over).map((v) => mm(-v));
    lines.push(`<span class="ok">✓ キャンバス内に収まっています</span>（端まで最短 ${Math.min(...gaps).toFixed(1)}mm）`);
  }
  lines.push(`絵の ${state.cutMargin}mm 外側で計算（不透明度10%以上を絵とみなす）。実際の線は印刷所が作ります`);
  box.innerHTML = lines.join('<br>');
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

/** 指定の倍率にする。cx, cy（画面上の位置）を中心に拡大縮小。省略時は画面の中央 */
function zoomTo(z, cx, cy) {
  const v = state.view;
  const rect = viewCv.getBoundingClientRect();
  if (cx === undefined) { cx = rect.width / 2; cy = rect.height / 2; }
  const mx = v.flipH ? rect.width - cx : cx;
  const docX = (mx - v.panX) / v.zoom;
  const docY = (cy - v.panY) / v.zoom;
  v.zoom = clamp(z, 0.01, 32);
  v.panX = mx - docX * v.zoom;
  v.panY = cy - docY * v.zoom;
  v.fitted = true;
  requestRender();
}

const zoomAt = (cx, cy, factor) => zoomTo(state.view.zoom * factor, cx, cy);
/** 実寸：画面の実ピクセル1つ＝画像の1ピクセル */
const actualSize = () => zoomTo(1 / (window.devicePixelRatio || 1));

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

  window.addEventListener('keydown', (e) => {
    const modal = document.querySelector('.modal:not([hidden])');
    if (modal) {
      if (e.key === 'Escape') closeModals();
      return;                              // ダイアログ表示中はショートカットを止める
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f') fit();
    else if (k === '1') actualSize();
    else if (k === 'h') toggleView('flipH', '#btnFlip');
    else if (k === 'g') toggleView('gray', '#btnGray');
    else if (k === 't') toggleView('alphaCheck', '#btnAlpha');
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
  syncViewButtons();
  requestRender(); scheduleSave();
  if (key === 'guide') scheduleCut();
}

function syncViewButtons() {
  const v = state.view;
  $('#btnFlip').classList.toggle('on', v.flipH);
  $('#btnGray').classList.toggle('on', v.gray);
  $('#btnAlpha').classList.toggle('on', v.alphaCheck);
  $('#btnGuide').classList.toggle('on', v.guide);
  viewCv.classList.toggle('gray', v.gray && !v.alphaCheck);   // 透明チェックの色は灰色にしない
  $('#alphaLegend').hidden = !v.alphaCheck;
}

/* ------------------------------------------------------------------ */
/* レイヤーパネル                                                        */
/* ------------------------------------------------------------------ */
/**
 * レイヤー一覧の作り直し。タイル化の進行中は1枚ごとに何度も呼ばれるので、
 * 1フレームに1回へまとめる。まとめないと「呼び出し回数 × 行数」で
 * DOM構築が二乗に効いてきて、枚数が多いと操作不能になる。
 */
function renderLayers() {
  if (layersRaf) return;
  layersRaf = requestAnimationFrame(() => { layersRaf = 0; renderLayersNow(); });
}

function renderLayersNow() {
  const box = $('#layers');
  const openState = new Map(state.layers.map((l) => [l.name, l.open]));
  box.innerHTML = '';
  $('#layerCount').textContent = state.layers.length ? `(${state.layers.length})` : '';
  const tooMany = !$('#tooMany').classList.contains('hide');
  $('#empty').classList.toggle('hide', !!state.dir || tooMany);

  const { w: dw, h: dh } = docSize();
  const pm = dw ? paperMM(dw, dh) : null;
  // 画面上が最前面なので、配列とは逆順に並べる
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const L = state.layers[i];
    L.open = openState.get(L.name) || false;
    box.appendChild(layerRow(L, i, pm));
  }
  updateSpec();
}

function layerSubtitle(L, ts, pm) {
  if (L.missing) return { text: '⚠ ファイルが見つかりません', cls: 'bad' };
  if (!ts) return { text: '待機中…' };
  if (ts.status === 'error') return { text: '⚠ 読み込みに失敗しました', cls: 'bad' };
  if (!ts.w) return { text: '読み込み中…' };
  const pct = ts.total ? Math.round(ts.done / ts.total * 100) : 0;
  const head = ts.status === 'tiling' ? `読み込み中 ${pct}%  ` : '';
  const extra = (L.scale !== 1 ? ` ×${L.scale.toFixed(2)}` : '') + (L.x || L.y ? `  ⇢ ${L.x},${L.y}` : '') + (L.flipH ? '  ⇄' : '');
  const j = judge(ts, pm);
  return {
    text: `${head}${ts.w}×${ts.h}${extra}${j ? '  ' + j.short : ''}`,
    title: j ? j.detail : '',
    cls: j ? (j.ok ? 'ok' : 'bad') : '',
  };
}

function layerRow(L, idx, pm) {
  const ts = tilesets.get(L.name);
  const row = document.createElement('div');
  row.className = 'row' + (L.missing ? ' missing' : '') + (L.open ? ' open' : '') +
    (L.visible ? '' : ' hidden-layer');
  row.dataset.name = L.name;
  row.dataset.idx = String(idx);
  row.draggable = false;   // つまみを持ったときだけ true にする（下の initRowDnd）

  const thumb = ts && ts.thumb;
  const sub = layerSubtitle(L, ts, pm);
  row.innerHTML = `
    <div class="row-main">
      <span class="grip" title="ドラッグで並べ替え">${ICON.grip}</span>
      <button class="eye ${L.visible ? 'on' : ''}" title="表示/非表示（Alt+クリックでこのレイヤーだけ表示）">${L.visible ? ICON.eye : ICON.eyeOff}</button>
      <div class="thumb" ${thumb ? `style="background-image:url(${thumb});background-size:contain;background-repeat:no-repeat;background-position:center"` : ''}></div>
      <div class="meta">
        <div class="name" title="${escapeHtml(L.name)}">${escapeHtml(displayName(L.name))}</div>
        <div class="sub ${sub.cls || ''}" title="${escapeHtml(sub.title || '')}">${escapeHtml(sub.text)}</div>
      </div>
      <div class="ord">
        <button class="ob up" title="ひとつ手前へ"${idx === state.layers.length - 1 ? ' disabled' : ''}>${ICON.up}</button>
        <button class="ob dn" title="ひとつ奥へ"${idx === 0 ? ' disabled' : ''}>${ICON.down}</button>
      </div>
      ${L.missing ? `<button class="gear del" title="一覧から消す（ファイルは消しません）">${ICON.close}</button>`
                  : `<button class="gear" title="位置・拡大・反転">${ICON.tune}</button>`}
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

  const upd = () => { requestRender(); scheduleSave(); scheduleCut(); };

  row.querySelector('.eye').addEventListener('click', (e) => {
    if (e.altKey) {
      const solo = state.layers.filter((l) => l !== L).every((l) => !l.visible) && L.visible;
      state.layers.forEach((l) => { l.visible = solo ? true : (l === L); });
    } else L.visible = !L.visible;
    renderLayers(); upd();
  });

  const move = (d) => {
    const i = state.layers.indexOf(L);
    const j = i + d;
    if (i < 0 || j < 0 || j >= state.layers.length) return;
    [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
    renderLayers(); upd();
  };
  row.querySelector('.up').addEventListener('click', () => move(1));   // 画面上＝配列の後ろ
  row.querySelector('.dn').addEventListener('click', () => move(-1));

  const gear = row.querySelector('.gear');
  if (L.missing) {
    gear.addEventListener('click', () => {
      const i = state.layers.indexOf(L);
      if (i >= 0) state.layers.splice(i, 1);
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
  // つまみを押している間だけ行をドラッグ可能にする。常に可能にしておくと
  // 中のスライダーをつかんだときに行のドラッグが始まり、値を変えられなくなる。
  const grip = row.querySelector('.grip');
  const release = () => { row.draggable = false; };
  grip.addEventListener('pointerdown', () => {
    row.draggable = true;
    // 掴んだまま外で離された場合にも必ず戻す
    window.addEventListener('pointerup', release, { once: true });
  });

  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', row.dataset.name);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.draggable = false;
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
    const from = state.layers.findIndex((l) => l.name === e.dataTransfer.getData('text/plain'));
    const to = state.layers.findIndex((l) => l.name === row.dataset.name);
    if (from < 0 || to < 0 || from === to) return;
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
    version: 3,
    paper: state.paper, customW: state.customW, customH: state.customH,
    dpi: state.dpi, dpiSource: state.dpiSource,
    bleed: state.bleed, cutMargin: state.cutMargin,
    guides: state.guides,
    exportScale: state.exportScale,
    view: { flipH: state.view.flipH, gray: state.view.gray, bg: state.view.bg, guide: state.view.guide },
    layers: state.layers.map((L) => ({
      name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend,
      x: L.x, y: L.y, scale: L.scale, flipH: L.flipH,
    })),
  };
  try {
    await Backend.saveProject(data);
    if (saveFailed) { saveFailed = false; updateStatusLine(); }
  } catch (e) {
    // 黙って失敗すると、設定が消えたことに気づけない
    if (!saveFailed) log('error', '設定の保存に失敗: ' + (e.message || e));
    saveFailed = true;
    updateStatusLine();
  }
}

function applyProject(p) {
  if (!p) return;
  if (PAPERS.some((x) => x.key === p.paper)) state.paper = p.paper;
  if (p.customW > 0) state.customW = p.customW;
  if (p.customH > 0) state.customH = p.customH;
  if (Number.isFinite(p.dpi) && p.dpi > 0) state.dpi = p.dpi;
  // 以前の版の設定には dpiSource が無い。画像に記録があればそちらを優先させる
  state.dpiSource = ['png', 'manual'].includes(p.dpiSource) ? p.dpiSource : 'default';
  if (Number.isFinite(p.bleed) && p.bleed >= 0) state.bleed = p.bleed;
  if (Number.isFinite(p.cutMargin) && p.cutMargin >= 0) state.cutMargin = p.cutMargin;
  if (p.guides) Object.assign(state.guides, {
    trim: p.guides.trim !== false, center: p.guides.center !== false,
    thirds: p.guides.thirds !== false, cut: !!p.guides.cut,
  });
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
  $('#selPaper').value = state.paper;
  $('#customPaper').hidden = state.paper !== 'custom';
  $('#inPaperW').value = state.customW || '';
  $('#inPaperH').value = state.customH || '';
  $('#inDpi').value = state.dpi;
  $('#inBleed').value = state.bleed;
  $('#inCutMargin').value = state.cutMargin;
  $('#gTrim').checked = state.guides.trim;
  $('#gCenter').checked = state.guides.center;
  $('#gThirds').checked = state.guides.thirds;
  $('#gCut').checked = state.guides.cut;
  syncViewButtons();
  updateSpec();
  updateCutInfo();
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
      const full = await createImageBitmap(new Blob([buf]));
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

    const name = `check_${fileStamp()}_${outW}x${outH}.png`;
    setStatus('保存中… ' + fmtBytes(blob.size), 'busy');
    await Backend.saveExport(name, blob);
    setStatus(`書き出しました: _export/${name}（${fmtBytes(blob.size)} / ${Math.round(outDpi)}dpi）`, 'ok');
    log('info', `書き出し ${name}`);
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

  const pm = paperMM(dw, dh);
  const size = `${pxToMm(dw).toFixed(0)} × ${pxToMm(dh).toFixed(0)} mm`;
  $('#exportPaper').textContent = pm
    ? `どの倍率でも用紙サイズは ${pm.label}（${size}）のままです。解像度だけが変わります。`
    : `どの倍率でも用紙サイズは ${size} のままです。解像度だけが変わります。`;

  const st = $('#exportStatus');
  st.textContent = ''; st.className = 'status';
  $('#btnExportGo').disabled = false;
  $('#btnExportGo').hidden = false;
  $('#btnExportReveal').hidden = true;
  $('#btnExportClose').disabled = false;
  $('#btnExportClose').textContent = 'キャンセル';
  $('#exportModal').hidden = false;
  $('#btnExportGo').focus();
}

function closeModals() {
  if (busy) return;                       // 書き出し中は閉じさせない
  document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
}

async function runExport() {
  $('#btnExportGo').disabled = true;
  $('#btnExportClose').disabled = true;
  const ok = await exportComposite();
  $('#btnExportClose').disabled = false;
  if (ok) {
    $('#btnExportGo').hidden = true;      // 済んだので押せないようにする
    $('#btnExportReveal').hidden = false;
    $('#btnExportClose').textContent = '閉じる';
  } else {
    $('#btnExportGo').disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* このアプリについて                                                    */
/* ------------------------------------------------------------------ */
async function openAbout() {
  try { $('#aboutVersion').textContent = 'バージョン ' + await Backend.version(); } catch {}
  let blobBytes = 0;
  for (const ts of tilesets.values()) blobBytes += ts.blobBytes;
  $('#aboutMem').textContent = `メモリ使用量：表示用 ${fmtBytes(decodedBytes)}（上限 ${fmtBytes(budget)}）・読み込み済み ${fmtBytes(blobBytes)}`
    + (mem ? `・PCの空き ${(mem.avail / (1 << 30)).toFixed(1)}GB` : '');
  $('#btnLog').hidden = Backend.kind !== 'tauri';
  $('#licenseText').hidden = true;
  $('#aboutModal').hidden = false;
}

async function showLicenses() {
  const pre = $('#licenseText');
  if (!pre.hidden) { pre.hidden = true; return; }
  if (!pre.textContent) {
    try {
      const r = await fetch('licenses.txt');
      pre.textContent = r.ok ? await r.text() : 'ライセンス情報を読み込めませんでした。';
    } catch { pre.textContent = 'ライセンス情報を読み込めませんでした。'; }
  }
  pre.hidden = false;
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
  const folderName = j.dir.split(/[\\/]/).filter(Boolean).pop() || j.dir;
  Backend.setTitle(`${folderName} - LayerDeck`);
  log('info', `フォルダを開く: ${j.dir}`);
  for (const name of [...tilesets.keys()]) dropTileset(name);
  seen.clear();
  jobQueue.length = 0;
  allowManyLayers = false;
  saveFailed = false;
  cut.key = ''; cut.path = null; cut.stats = null;
  $('#tooMany').classList.add('hide');
  state.layers = [];
  applyProject(j.project);
  if (j.mem) { mem = j.mem; budget = clamp(Math.round(mem.avail * 0.25), 96 * MB, 1536 * MB); }
  state.view.fitted = false;
  renderLayers(); requestRender();
  setStatus('監視中', 'ok');
  poll();
}

function applyIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICON[el.dataset.icon] || ''; });
}

/** デスクトップアプリとして動いているときは、ブラウザの右クリックメニューを出さない */
function suppressBrowserUi() {
  if (Backend.kind !== 'tauri') return;
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  // 本命は Rust 側で WebView2 の設定を切っている。これは念のための二重化
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'F5' || e.key === 'F3' || e.key === 'F7' || e.key === 'F12' ||
        (ctrl && 'rpfgjusonhdlek'.includes(k) && k.length === 1) ||
        (ctrl && e.shiftKey && 'ijc'.includes(k) && k.length === 1) ||
        (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) e.preventDefault();
  }, true);
}

function initUi() {
  applyIcons();
  suppressBrowserUi();

  $('#btnPick').addEventListener('click', () => openFolder(true));
  $('#btnPick2').addEventListener('click', () => openFolder(true));
  $('#btnPick3').addEventListener('click', () => openFolder(true));
  $('#btnLoadAnyway').addEventListener('click', () => {
    allowManyLayers = true;
    $('#tooMany').classList.add('hide');
    setStatus('読み込みます…', 'busy');
    poll();
  });
  $('#btnReveal').addEventListener('click', () => Backend.reveal('folder').catch((e) => setStatus(String(e.message || e), 'err')));

  $('#btnFit').addEventListener('click', () => fit());
  $('#btnOne').addEventListener('click', actualSize);
  $('#btnFlip').addEventListener('click', () => toggleView('flipH', '#btnFlip'));
  $('#btnGray').addEventListener('click', () => toggleView('gray', '#btnGray'));
  $('#btnAlpha').addEventListener('click', () => toggleView('alphaCheck', '#btnAlpha'));
  $('#btnGuide').addEventListener('click', () => toggleView('guide', '#btnGuide'));
  $('#btnBg').addEventListener('click', () => {
    state.view.bg = (state.view.bg + 1) % BG_MODES.length; requestRender(); scheduleSave();
  });

  $('#btnExport').addEventListener('click', openExportDialog);
  $('#btnExportGo').addEventListener('click', runExport);
  $('#btnExportClose').addEventListener('click', closeModals);
  $('#btnExportReveal').addEventListener('click', () => Backend.reveal('export').catch(() => {}));
  $('#btnAbout').addEventListener('click', openAbout);
  $('#btnAboutClose').addEventListener('click', closeModals);
  $('#btnLicenses').addEventListener('click', showLicenses);
  $('#btnLog').addEventListener('click', () => Backend.reveal('log').catch(() => {}));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => {
    if (e.target === m) closeModals();   // 背景クリックで閉じる
  }));

  $('#btnSortName').addEventListener('click', () => {
    state.layers.sort((a, b) => byName(a.name, b.name));
    renderLayers(); requestRender(); scheduleSave();
  });
  $('#btnAllOn').addEventListener('click', () => {
    state.layers.forEach((l) => (l.visible = true));
    renderLayers(); requestRender(); scheduleSave(); scheduleCut();
  });

  // 用紙・解像度
  const sel = $('#selPaper');
  sel.innerHTML = PAPERS.map((p) =>
    `<option value="${p.key}">${p.label || `${p.key}（${p.w}×${p.h}mm）`}</option>`).join('');
  const specChanged = () => { renderLayers(); requestRender(); scheduleSave(); };
  sel.addEventListener('change', (e) => {
    state.paper = e.target.value;
    $('#customPaper').hidden = state.paper !== 'custom';
    specChanged();
  });
  $('#inPaperW').addEventListener('input', (e) => { state.customW = parseFloat(e.target.value) || 0; specChanged(); });
  $('#inPaperH').addEventListener('input', (e) => { state.customH = parseFloat(e.target.value) || 0; specChanged(); });
  $('#inDpi').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v > 0) { state.dpi = v; state.dpiSource = 'manual'; specChanged(); scheduleCut(); }
  });
  $('#btnDpiAuto').addEventListener('click', () => { state.dpiSource = 'default'; autoDpi(); specChanged(); });
  $('#inBleed').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v >= 0) { state.bleed = v; specChanged(); }
  });

  // ガイド
  const guide = (id, key) => $(id).addEventListener('change', (e) => {
    state.guides[key] = e.target.checked;
    // ガイドの種類を選んだら、表示そのものも自動で入れる
    if (e.target.checked && !state.view.guide) { state.view.guide = true; syncViewButtons(); }
    requestRender(); scheduleSave(); scheduleCut(); updateCutInfo();
  });
  guide('#gTrim', 'trim'); guide('#gCenter', 'center'); guide('#gThirds', 'thirds'); guide('#gCut', 'cut');
  $('#inCutMargin').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (v >= 0) { state.cutMargin = v; scheduleSave(); scheduleCut(); }
  });

  initViewEvents();
}

window.addEventListener('error', (e) =>
  log('error', `${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) =>
  log('error', '未処理の失敗: ' + ((e.reason && (e.reason.message || e.reason)) || '')));

(async function main() {
  initUi();
  initWorkers();
  syncUiFromState();
  try { log('info', `起動 LayerDeck ${await Backend.version()}`); } catch {}
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
