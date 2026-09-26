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
/** 書き出し倍率 */
const EXPORT_SCALES = [[1, '原寸'], [0.5, '1/2'], [0.25, '1/4'], [0.125, '1/8']];

const svg = (body, extra = '') =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
const ICON = {
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  flip: svg('<path d="M12 3v18"/><path d="M8 7l-5 5 5 5z"/><path d="M16 7l5 5-5 5z"/>'),
  gray: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  alpha: svg('<circle cx="12" cy="12" r="5" fill="currentColor"/><circle cx="12" cy="12" r="9" stroke-dasharray="2.5 2.5"/>'),
  edge: svg('<path d="M12 7.5c2.4 0 4 1.8 4 4.3S14 16.5 12 16.5 8 14.3 8 11.8 9.6 7.5 12 7.5z" fill="currentColor" stroke="none"/><path d="M12 3.5c4.3 0 7.5 3.4 7.5 8.3S15.8 20.5 12 20.5 4.5 16.7 4.5 11.8 7.7 3.5 12 3.5z"/>'),
  guide: svg('<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 3"/><path d="M12 7v10M7 12h10" stroke-width="1.5"/>'),
  bg: svg('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h8V4M12 20v-8h8" fill="currentColor" stroke="none" opacity=".55"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  export: svg('<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>'),
  settings: svg('<path d="M10.2 2.6 L13.8 2.6 L14.1 5.2 L15.3 5.7 L17.4 4.0 L20.0 6.6 L18.3 8.7 L18.8 9.9 L21.4 10.2 L21.4 13.8 L18.8 14.1 L18.3 15.3 L20.0 17.4 L17.4 20.0 L15.3 18.3 L14.1 18.8 L13.8 21.4 L10.2 21.4 L9.9 18.8 L8.7 18.3 L6.6 20.0 L4.0 17.4 L5.7 15.3 L5.2 14.1 L2.6 13.8 L2.6 10.2 L5.2 9.9 L5.7 8.7 L4.0 6.6 L6.6 4.0 L8.7 5.7 L9.9 5.2Z"/><circle cx="12" cy="12" r="2.8"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.2-2.6 4"/><circle cx="12" cy="17.3" r=".6" fill="currentColor"/>'),
  caret: svg('<path d="M7 10l5 5 5-5"/>', 'stroke-width="2.4"'),
  eye: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  eyeOff: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" opacity=".35"/><path d="M4 4l16 16"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>', 'stroke-width="2.6"'),
  down: svg('<path d="M6 9l6 6 6-6"/>', 'stroke-width="2.6"'),
  tune: svg('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
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
  // 印刷所が「絵」とみなす不透明度（%）。カットライン予想・縁取り表示の薄い部分・透明チェックで共通。
  // 印刷所は公開していないので仮の値
  artPct: 10,
  guides: { trim: true, center: true, thirds: true, cut: false },
  exportScale: 1,          // 書き出しの倍率。用紙の物理サイズは変えず解像度だけ下げる
  // 縁取り表示：ゴミ・薄いにじみ・塗り残しを、縁取りでふくらませて目で探せるようにする
  edge: {
    width: 2,              // 太さ（mm）。ゴミ探しは 1〜3、切り抜きの白いふちの確認は 10
    side: 'out',           // 'out'=絵の外側 / 'in'=絵の内側（塗り残しの穴が点で出る）
    color: '#7dff3a',      // 縁取りの色（カットライン予想の水色と見分けがつくよう黄緑）
    faintColor: '#ff285a', // 薄い部分の色（透明チェックの「ほぼ透明」と同じ）
    dim: true,             // 縁取りを目立たせるため、絵を暗くする
  },
  view: { zoom: 1, panX: 0, panY: 0, flipH: false, gray: false, alphaCheck: false, edge: false,
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

/**
 * ソロ中のレイヤー名（DAW のソロと同じ）。目のアイコン（＝ミュート）の状態とは別に持ち、
 * ソロを全部解除すれば元の表示にそのまま戻る。設定ファイルには保存しない。
 */
const solo = new Set();
/** 画面に出すか。ソロ中はソロのレイヤーだけ（非表示にしていたものでも出す） */
const shown = (L) => !L.missing && (solo.size ? solo.has(L.name) : L.visible);
let allowManyLayers = false;

let raf = 0, layersRaf = 0, vw = 0, vh = 0, saveTimer = 0, busy = false;
let saveFailed = false, lastLoggedErr = '';

/** カットライン予想の計算結果 */
const cut = { key: '', path: null, stats: null, timer: 0, running: false, waiting: false };

/** 縁取り表示の下調べと、そこから作った重ね絵 */
const edgeJob = {
  worker: null, jobId: 0, runningKey: '', running: false, waiting: false, failed: false, progress: 0,
  map: null,    // { key, S, cw, ch, maxA, minA } 原寸を S×S のマスに縮めた「いちばん濃い／薄い不透明度」
  look: null,   // { key, pad, W, H, S, under, over, faintCount } map と設定から作った重ね絵
  timer: 0, lookTimer: 0,
};

const newLayer = (name) => ({
  name, visible: true, opacity: 1, blend: 'source-over',
  x: 0, y: 0, scale: 1, flipH: false, open: false, missing: false, goneAt: 0,
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
  // 書き出しの進行中だけ、ダイアログ側にも映す（「最新の状態」などの常時表示は映さない）
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
/** 「絵」とみなす不透明度を 0〜255 で */
const artAlpha = () => clamp(Math.round(state.artPct * 2.55), 1, 255);

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
    // 合っている行には何も足さない（全体の判定は「用紙・解像度」欄に一行で出す）
    return { ok: true, short: note, detail: `${pm.label}・${state.dpi}dpi の ${ex.w}×${ex.h}px と一致` + note };
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
    lines.push(`作るキャンバスの大きさ <b>${ex.w} × ${ex.h} px</b>`);
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

/** ファイルが見えなくなってから一覧から外すまでの猶予。保存のしかたによっては上書きの途中で一瞬消えるため */
const GONE_GRACE_MS = 1500;

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
    L.goneAt = 0;

    const ts = tilesets.get(f.name);
    // 2回続けて同じ版が見えた＝書き込み完了とみなす（巨大PNGの途中読みを防ぐ）
    if (wasSeen === ver && (!ts || ts.ver !== ver)) {
      enqueueTiling(f.name, ver);
      flashRow(f.name);
      dirty = true;
    }
  }

  // 消えたファイルは、少し待ってから黙って一覧から外す。設定は state.layers に残して保存もし、
  // 同じ名前のファイルが戻ってきたら元の位置・設定のまま一覧に戻す
  const now = Date.now();
  for (const L of state.layers) {
    if (present.has(L.name) || L.missing) continue;
    if (!L.goneAt) { L.goneAt = now; setTimeout(poll, GONE_GRACE_MS + 100); continue; }
    if (now - L.goneAt < GONE_GRACE_MS) continue;
    L.missing = true; L.goneAt = 0;
    solo.delete(L.name);
    dropTileset(L.name);
    log('info', `ファイルが無くなったので一覧から外す: ${L.name}`);
    dirty = true;
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
  // 見つけたが書き込み完了を待っていて、まだ読み込みを始めていないものも数える。
  // 数えないと、保存した直後に一瞬「最新の状態」と出てしまう
  for (const [name, ver] of seen) {
    const ts = tilesets.get(name);
    if (!ts || ts.ver !== ver) working++;
  }
  if (!working) { if (state.dir) setStatus('✓ 最新の状態', 'ok'); return; }
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
    if (!shown(L)) continue;
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
  else if (v.edge && state.edge.dim) {
    // 絵のある所だけを暗くする（透明な所はそのまま）
    stageCtx.globalCompositeOperation = 'source-atop';
    stageCtx.fillStyle = 'rgba(0,0,0,.6)';
    stageCtx.fillRect(0, 0, vw, vh);
    stageCtx.globalCompositeOperation = 'source-over';
  }

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

  // 縁取りは絵の下に敷き、薄い部分の色と内側の縁取りは絵の上に重ねる
  const look = v.edge ? edgeJob.look : null;
  if (look && look.under) drawEdgeLook(look.under, look);
  vctx.drawImage(stageCv, 0, 0, stageCv.width, stageCv.height, 0, 0, vw, vh);
  if (look) drawEdgeLook(look.over, look);

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
  const d = img.data, T = artAlpha();
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;                                          // 透明 → 市松が見える
    if (a >= 250) { d[i] = 70; d[i + 1] = 74; d[i + 2] = 84; }      // 不透明
    else if (a >= T) { d[i] = 255; d[i + 1] = 150; d[i + 2] = 40; }  // 半透明
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
  const vis = state.layers.filter((L) => shown(L) && L.opacity > 0);
  return JSON.stringify([state.dpi, state.cutMargin, state.artPct, dw, dh,
    vis.map((L) => [L.name, tilesets.get(L.name)?.ver, L.x, L.y, L.scale, L.flipH, L.opacity])]);
}

function scheduleCut() {
  // 縁取り表示も同じもの（表示中のレイヤー）から作るので、一緒に予約する
  scheduleEdge();
  clearTimeout(cut.timer);
  if (!(state.view.guide && state.guides.cut)) { updateCutInfo(); return; }
  cut.timer = setTimeout(computeCut, 350);
}

async function computeCut() {
  if (!(state.view.guide && state.guides.cut) || cut.running) return;
  const { w: dw, h: dh } = docSize();
  if (!dw) { cut.path = null; cut.stats = null; updateCutInfo(); return; }
  const vis = state.layers.filter((L) => shown(L) && L.opacity > 0);
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
    const inside = new Uint8Array(W * H), T = artAlpha();
    let any = false;
    for (let y = 0; y < gh; y++) {
      const row = (y + pad) * W + pad;
      for (let x = 0; x < gw; x++) if (px[(y * gw + x) * 4 + 3] >= T) { inside[row + x] = 1; any = true; }
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
  // 結果はプレビュー左上に出す（ガイド表示中で、カットライン予想を選んでいるときだけ）
  $('#cutLegend').hidden = !(state.view.guide && state.guides.cut);
  const box = $('#cutInfo');
  if (!state.guides.cut) { box.innerHTML = ''; return; }
  if (!state.view.guide) { box.innerHTML = '画面右上のガイドのボタンを押すと表示・計算します'; return; }
  if (cut.waiting) { box.innerHTML = '読み込みが終わってから計算します…'; return; }
  if (cut.running) { box.innerHTML = '計算中…'; return; }
  const s = cut.stats;
  if (!s) { box.innerHTML = ''; return; }
  if (s.empty) { box.innerHTML = '表示中のレイヤーに不透明な部分がありません'; return; }

  // プレビューの上に重ねて出すので、結果は短く、説明は小さな注記にする
  const mm = (px) => pxToMm(Math.max(0, px));
  const lines = [];
  lines.push(s.pieces === 1
    ? '<span class="ok">✓ 1つながりの形</span>'
    : `<span class="bad">⚠ ${s.pieces}つに分かれています</span>`);
  const names = { top: '上', bottom: '下', left: '左', right: '右' };
  const over = Object.entries(s.over).filter(([, v]) => mm(v) >= 0.5);
  if (over.length) {
    lines.push(`<span class="bad">⚠ はみ出し：${over.map(([k, v]) => `${names[k]} ${mm(v).toFixed(1)}mm`).join('・')}</span>`);
  } else {
    const gaps = Object.values(s.over).map((v) => mm(-v));
    lines.push(`<span class="ok">✓ キャンバス内</span>（端まで最短 ${Math.min(...gaps).toFixed(1)}mm）`);
  }
  const notes = [`絵の ${state.cutMargin}mm 外側・不透明度${state.artPct}%以上を絵として計算。実際の線は印刷所が作ります`];
  if (s.pieces > 1) notes.unshift('離れた部分は、別に切り抜かれるか無視されます');
  if (over.length) notes.unshift('用紙に収めるなら、その辺の絵を内側へ寄せてください');
  box.innerHTML = lines.join('<br>') + `<div class="legend-note">${notes.join('<br>')}</div>`;
}

/* ------------------------------------------------------------------ */
/* 縁取り表示                                                           */
/*   絵に太い縁取りをかけて、1px のゴミや薄いにじみ・塗り残しを、目で探せる     */
/*   大きさにふくらませる。ペイントソフトで縁取りをかけて探すのと同じ考え方。     */
/*   白・10mm にすると、切り抜いたときの白いふちの見え方になる。               */
/* ------------------------------------------------------------------ */
const visibleLayers = () => state.layers.filter((L) => shown(L) && L.opacity > 0);

/** 下調べをやり直す必要があるかの目印。重ねる順番は不透明度に効かないので名前順にそろえる */
function edgeKey() {
  const { w: dw, h: dh } = docSize();
  const vis = visibleLayers().map((L) => [L.name, tilesets.get(L.name)?.ver, L.x, L.y, L.scale, L.flipH, L.opacity]);
  vis.sort((a, b) => byName(a[0], b[0]));
  return JSON.stringify([dw, dh, vis]);
}

function scheduleEdge() {
  clearTimeout(edgeJob.timer);
  if (!state.view.edge) { updateEdgeLegend(); return; }
  edgeJob.timer = setTimeout(computeEdgeMap, 300);
}

/** 原寸の下調べを worker に頼む（数秒）。太さや色を変えただけなら、やり直さない */
function computeEdgeMap() {
  if (!state.view.edge) return;
  const { w: dw, h: dh } = docSize();
  const vis = visibleLayers();
  const sets = vis.map((L) => tilesets.get(L.name));
  if (!dw || !vis.length) {
    edgeJob.map = null; edgeJob.look = null; edgeJob.waiting = false;
    updateEdgeLegend(); requestRender();
    return;
  }
  if (sets.some((ts) => !ts || ts.status === 'tiling')) { edgeJob.waiting = true; updateEdgeLegend(); return; }
  edgeJob.waiting = false;
  const key = edgeKey();
  if (edgeJob.map && edgeJob.map.key === key) { buildEdgeLook(); return; }
  if (edgeJob.running && edgeJob.runningKey === key) return;

  // 1マス＝S×S ピクセル。A2・250dpi（5846px）で S=4（約0.4mm）
  const S = Math.max(1, Math.round(Math.max(dw, dh) / 1500));
  const layers = [];
  vis.forEach((L, i) => {
    const ts = sets[i];
    if (!ts || ts.status !== 'ready') return;   // 読み込みに失敗したものは飛ばす
    const lev = ts.levels[0];
    const tiles = [];
    for (let r = 0; r < lev.rows; r++) {
      for (let c = 0; c < lev.cols; c++) {
        const rec = ts.blobs.get(`0|${c}|${r}`);
        if (rec) tiles.push({ c, r, w: rec.w, h: rec.h, blob: rec.blob });
      }
    }
    layers.push({ w: ts.w, h: ts.h, tile: ts.tile, x: L.x, y: L.y, scale: L.scale,
      flipH: L.flipH, opacity: clamp(L.opacity, 0, 1), tiles });
  });

  if (!edgeJob.worker) {
    edgeJob.worker = new Worker('edger.js');
    edgeJob.worker.onmessage = onEdgeMessage;
    edgeJob.worker.onerror = (e) => {
      log('error', '縁取り表示: ' + (e.message || '作業用のスクリプト（edger.js）を読み込めませんでした'));
      edgeJob.running = false; edgeJob.failed = true; edgeJob.worker = null;
      updateEdgeLegend();
    };
  }
  edgeJob.jobId++;
  edgeJob.running = true; edgeJob.failed = false; edgeJob.runningKey = key; edgeJob.progress = 0;
  edgeJob.worker.postMessage({ id: edgeJob.jobId, dw, dh, S, layers });
  updateEdgeLegend();
}

function onEdgeMessage(e) {
  const m = e.data;
  if (m.id !== edgeJob.jobId) return;   // 途中でやめた古い依頼
  if (m.type === 'progress') { edgeJob.progress = m.done / m.total; updateEdgeLegend(); return; }
  edgeJob.running = false;
  if (m.type === 'error') {
    log('error', '縁取り表示: ' + m.message);
    edgeJob.map = null; edgeJob.look = null; edgeJob.failed = true;
    updateEdgeLegend(); requestRender();
    return;
  }
  edgeJob.map = { key: edgeJob.runningKey, S: m.S, cw: m.cw, ch: m.ch, maxA: m.maxA, minA: m.minA };
  buildEdgeLook();
  if (edgeKey() !== edgeJob.map.key) scheduleEdge();   // 計算中に何か変わっていたらやり直す
}

/** 「絵を暗くする」ときに絵の下へ敷く色 */
const EDGE_DARK = [30, 33, 41];

function edgeLookKey() {
  const E = state.edge;
  return JSON.stringify([edgeJob.map && edgeJob.map.key, state.dpi, state.artPct, E.width, E.side, E.color, E.faintColor, E.dim]);
}

/** 太さや色を打ち込んでいる途中に何度も作り直さないよう、少し待ってから作る */
function scheduleEdgeLook() {
  clearTimeout(edgeJob.lookTimer);
  edgeJob.lookTimer = setTimeout(buildEdgeLook, 150);
}

/**
 * 下調べの結果と設定から、縁取りの重ね絵を作る。
 *   外側 : 濃い部分から太さ以内 → 縁取りの色。薄い部分だけから太さ以内 → 薄い部分の色
 *   内側 : 透明（に近い）ピクセルを含むマスから太さ以内の、絵の部分 → 縁取りの色
 *          塗りの中の小さな穴が、縁取りの色の点になって見える
 *   両方 : 薄い部分そのものを、薄い部分の色で塗る
 */
function buildEdgeLook() {
  const M = edgeJob.map;
  if (!M) return;
  const key = edgeLookKey();
  if (edgeJob.look && edgeJob.look.key === key) return;
  const E = state.edge;
  const r = E.width / 25.4 * state.dpi / M.S;         // 太さをマス数で
  const pad = E.side === 'out' ? Math.ceil(r) + 1 : 1; // 外側の縁取りはキャンバスの外まで出る
  const W = M.cw + 2 * pad, H = M.ch + 2 * pad;
  const T = artAlpha();

  const strong = new Uint8Array(W * H), faint = new Uint8Array(W * H);
  let faintCount = 0;
  for (let y = 0; y < M.ch; y++) {
    const o = (y + pad) * W + pad, s = y * M.cw;
    for (let x = 0; x < M.cw; x++) {
      const a = M.maxA[s + x];
      if (a >= T) strong[o + x] = 1;
      else if (a > 0) { faint[o + x] = 1; faintCount++; }
    }
  }

  const A = hexRgb(E.color), B = hexRgb(E.faintColor);
  const under = E.side === 'out' ? new ImageData(W, H) : null;
  const over = new ImageData(W, H);
  const put = (img, i, c) => {
    const p = i * 4;
    img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
  };

  if (E.side === 'out') {
    const dS = distanceField(strong, W, H);
    const dF = faintCount ? distanceField(faint, W, H) : null;
    // 絵そのものの下：暗くするときは暗い色を敷き、半透明の部分から縁取りの色が透けないようにする。
    // 暗くしないとき（白・10mm で仕上がりを見るとき）は縁取りの色を敷く。実際のパネルも半透明の所は下地が透ける
    const base = E.dim ? EDGE_DARK : A;
    for (let i = 0; i < W * H; i++) {
      if (strong[i]) put(under, i, base);
      else if (dS[i] <= r) put(under, i, A);
      else if (dF && dF[i] <= r) put(under, i, B);
    }
  } else {
    const clear = new Uint8Array(W * H).fill(1);   // キャンバスの外も透明として扱う
    for (let y = 0; y < M.ch; y++) {
      const o = (y + pad) * W + pad, s = y * M.cw;
      for (let x = 0; x < M.cw; x++) if (M.minA[s + x] >= T) clear[o + x] = 0;
    }
    const dC = distanceField(clear, W, H);
    for (let i = 0; i < W * H; i++) if (strong[i] && dC[i] <= r) put(over, i, A);
  }
  for (let i = 0; i < W * H; i++) if (faint[i]) put(over, i, B);

  edgeJob.look = { key, pad, W, H, S: M.S, under: under && toCanvas(under), over: toCanvas(over), faintCount };
  updateEdgeLegend(); requestRender();
}

/** 重ね絵を、マス目の大きさに引き伸ばして画像の位置に描く */
function drawEdgeLook(cv, look) {
  const v = state.view, k = look.S * v.zoom;
  vctx.imageSmoothingEnabled = true;
  vctx.drawImage(cv, v.panX - look.pad * k, v.panY - look.pad * k, look.W * k, look.H * k);
}

function updateEdgeLegend() {
  const box = $('#edgeLegend');
  box.hidden = !state.view.edge;
  if (box.hidden) return;
  const E = state.edge;
  $('#edgeTitle').textContent = `縁取り表示（${E.side === 'out' ? '外側' : '内側'} ${E.width}mm）`;
  $('#edgeSwA').style.background = E.color;
  $('#edgeSwB').style.background = E.faintColor;
  $('#edgeLabelA').textContent = E.side === 'out' ? '縁取り' : '内側の縁取り（塗り残しの穴は点になって出ます）';
  $('#edgeLabelB').textContent = `薄い部分（不透明度 ${state.artPct}% 未満）`;
  let note = '';
  if (edgeJob.failed) note = '計算できませんでした（「LayerDeck について」のログに詳細）';
  else if (edgeJob.waiting) note = '読み込みが終わってから計算します…';
  else if (edgeJob.running) note = `計算中… ${Math.round(edgeJob.progress * 100)}%`;
  else if (edgeJob.look) note = edgeJob.look.faintCount ? '薄い部分があります' : '薄い部分はありません';
  $('#edgeNote').textContent = note;
}

/* ---------- ホバーで「どのレイヤーの色か」を出す（縁取り表示中だけ） ---------- */
/*   縁取りでふくらんだゴミにカーソルを乗せると、どのキャンバスを直せばいいかがわかる */
const hover = { timer: 0, seq: 0, cache: new Map() };   // cache: 原寸のマス目の展開済み画像を少しだけ持つ
const HOVER_CACHE_TILES = 8;                            // 1枚 4MB ほど

function scheduleHover(e) {
  clearTimeout(hover.timer);
  if (!state.view.edge || !edgeJob.map) { hideHoverTip(); return; }
  const r = viewCv.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  // 止まってから調べる（動かしている間に何度も読まない）
  hover.timer = setTimeout(() => probeAt(sx, sy).catch((err) => log('error', 'ホバー: ' + (err.message || err))), 120);
}

function hideHoverTip() {
  clearTimeout(hover.timer);
  hover.seq++;
  $('#hoverTip').hidden = true;
}

function clearHoverCache() {
  for (const b of hover.cache.values()) b.close();
  hover.cache.clear();
}

async function probeAt(sx, sy) {
  const seq = ++hover.seq;
  const v = state.view, M = edgeJob.map, tip = $('#hoverTip');
  if (!M) return;
  const px = ((v.flipH ? vw - sx : sx) - v.panX) / v.zoom, py = (sy - v.panY) / v.zoom;
  // 縁取りの太さの範囲を探す。細いときでも画面で 8px 分は探す
  const R = Math.max(state.edge.width / 25.4 * state.dpi, 8 / v.zoom);
  // 1) 下調べの記録で、近くに色があるかを先に見る。無ければ原寸は読まない
  if (!inkNear(M, px, py, R)) { tip.hidden = true; return; }

  // 2) レイヤーごとに、原寸でいちばん近い色のピクセルを探す
  const hits = [];
  for (const L of visibleLayers()) {
    const ts = tilesets.get(L.name);
    if (!ts || ts.status !== 'ready') continue;
    const h = await nearestInk(L, ts, px, py, R);
    if (seq !== hover.seq) return;   // その間にカーソルが動いた
    if (h) hits.push({ L, ...h });
  }
  if (!hits.length) { tip.hidden = true; return; }
  hits.sort((a, b) => a.d - b.d);
  const near = hits.filter((h) => h.d <= hits[0].d + 2);   // 同じ所に重なっていれば全部出す
  const T = artAlpha();
  tip.innerHTML = near.map((h) =>
    `<div><b>${escapeHtml(displayName(h.L.name))}</b>　不透明度 ${Math.max(1, Math.round(h.a / 2.55))}%${h.a < T ? '（薄い）' : ''}</div>`).join('');
  tip.hidden = false;
  // カーソルの右下に出す。はみ出すなら反対側へ
  const W = tip.offsetWidth, H = tip.offsetHeight;
  tip.style.left = `${sx + 16 + W > vw ? sx - 12 - W : sx + 16}px`;
  tip.style.top = `${sy + 16 + H > vh ? sy - 12 - H : sy + 16}px`;
}

/** 下調べの記録（S×S マス）で、点 (px, py) の R 以内に色のあるマスがあるか */
function inkNear(M, px, py, R) {
  const S = M.S;
  const x0 = Math.max(0, Math.floor((px - R) / S)), x1 = Math.min(M.cw - 1, Math.floor((px + R) / S));
  const y0 = Math.max(0, Math.floor((py - R) / S)), y1 = Math.min(M.ch - 1, Math.floor((py + R) / S));
  for (let y = y0; y <= y1; y++) {
    const o = y * M.cw;
    for (let x = x0; x <= x1; x++) if (M.maxA[o + x]) return true;
  }
  return false;
}

/** レイヤー L の、画像上の点 (px, py) にいちばん近い色のピクセル。R より遠ければ null */
async function nearestInk(L, ts, px, py, R) {
  const s = L.scale;
  let u0 = (px - R - L.x) / s, u1 = (px + R - L.x) / s;
  if (L.flipH) { const a = ts.w - u1, b = ts.w - u0; u0 = a; u1 = b; }
  const X0 = clamp(Math.floor(u0), 0, ts.w), X1 = clamp(Math.ceil(u1), 0, ts.w);
  const Y0 = clamp(Math.floor((py - R - L.y) / s), 0, ts.h), Y1 = clamp(Math.ceil((py + R - L.y) / s), 0, ts.h);
  const w = X1 - X0, h = Y1 - Y0;
  if (w <= 0 || h <= 0) return null;

  const cv = new OffscreenCanvas(w, h);
  const g = cv.getContext('2d', { willReadFrequently: true });
  const T = ts.tile;
  for (let r = Math.floor(Y0 / T); r <= Math.floor((Y1 - 1) / T); r++) {
    for (let c = Math.floor(X0 / T); c <= Math.floor((X1 - 1) / T); c++) {
      const bmp = await hoverTile(ts, c, r);
      if (bmp) g.drawImage(bmp, c * T - X0, r * T - Y0);
    }
  }
  const d = g.getImageData(0, 0, w, h).data;
  let best = Infinity, alpha = 0;
  for (let y = 0; y < h; y++) {
    const dy = L.y + (Y0 + y + 0.5) * s - py;
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3];
      if (!a) continue;
      const u = X0 + x + 0.5;
      const dx = L.x + (L.flipH ? ts.w - u : u) * s - px;
      const dist = dx * dx + dy * dy;
      if (dist < best) { best = dist; alpha = a; }
    }
  }
  best = Math.sqrt(best);
  return best <= R ? { d: best, a: alpha } : null;
}

/** 原寸のマス目を展開して返す。直近のいくつかだけ持っておく */
async function hoverTile(ts, c, r) {
  const key = `${ts.name}|${ts.ver}|${c}|${r}`;
  const hit = hover.cache.get(key);
  if (hit) { hover.cache.delete(key); hover.cache.set(key, hit); return hit; }   // 最近使った順に並べ直す
  const rec = ts.blobs.get(`0|${c}|${r}`);
  if (!rec) return null;
  const bmp = await createImageBitmap(rec.blob);
  const again = hover.cache.get(key);                  // 待っている間に別の問い合わせが入れていた
  if (again) { bmp.close(); return again; }
  hover.cache.set(key, bmp);
  while (hover.cache.size > HOVER_CACHE_TILES) {
    const [k, b] = hover.cache.entries().next().value;
    b.close(); hover.cache.delete(k);
  }
  return bmp;
}

const hexRgb = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function toCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
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
    hideHoverTip();
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
    if (!dragging) { scheduleHover(e); return; }
    hideHoverTip();
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
  viewCv.addEventListener('pointerleave', hideHoverTip);

  window.addEventListener('keydown', (e) => {
    const modal = document.querySelector('.modal:not([hidden])');
    if (modal) {
      if (e.key === 'Escape') closeModals();
      return;                              // ダイアログ表示中はショートカットを止める
    }
    if (e.key === 'Escape' && closePops()) return;   // 開いている小窓・メニューを先に閉じる
    if (e.key === 'Escape' && solo.size) { clearSolo(); return; }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f') fit();
    else if (k === '1') actualSize();
    else if (k === 'h') toggleView('flipH', '#btnFlip');
    else if (k === 'g') toggleView('gray', '#btnGray');
    else if (k === 't') toggleView('alphaCheck', '#btnAlpha');
    else if (k === 'e') toggleView('edge', '#btnEdge');
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
  if (key === 'edge') { scheduleEdge(); if (!state.view.edge) clearHoverCache(); }
}

function syncViewButtons() {
  const v = state.view;
  $('#btnFlip').classList.toggle('on', v.flipH);
  $('#btnGray').classList.toggle('on', v.gray);
  $('#btnAlpha').classList.toggle('on', v.alphaCheck);
  $('#btnEdge').classList.toggle('on', v.edge);
  $('#btnGuide').classList.toggle('on', v.guide);
  // 透明チェックと縁取りの色は灰色にしない
  viewCv.classList.toggle('gray', v.gray && !v.alphaCheck && !v.edge);
  $('#alphaLegend').hidden = !v.alphaCheck;
  updateEdgeLegend();
  updateCutInfo();
}

/* ------------------------------------------------------------------ */
/* レイヤーパネル                                                        */
/* ------------------------------------------------------------------ */
/**
 * レイヤー一覧の作り直し。タイル化の進行中は1枚ごとに何度も呼ばれるので、
 * 1フレームに1回へまとめる。まとめないと「呼び出し回数 × 行数」で
 * DOM構築が二乗に効いてきて、枚数が多いと操作不能になる。
 */
/* ---------- ソロ ---------- */
function toggleSolo(name) {
  if (solo.has(name)) solo.delete(name); else solo.add(name);
  onShownChanged();
}

function clearSolo() {
  if (!solo.size) return;
  solo.clear();
  onShownChanged();
}

function onShownChanged() {
  renderLayers(); requestRender(); scheduleCut();
}

/** プレビューの上の「ソロ中」の札。押すと解除 */
function updateSoloBanner() {
  const b = $('#soloBanner');
  const names = state.layers.filter((L) => solo.has(L.name) && !L.missing).map((L) => displayName(L.name));
  b.hidden = !names.length;
  if (!names.length) return;
  const head = names.slice(0, 2).join('・') + (names.length > 2 ? ` ほか${names.length - 2}枚` : '');
  b.textContent = `ソロ中：${head}（Esc で解除）`;
}

function renderLayers() {
  if (layersRaf) return;
  layersRaf = requestAnimationFrame(() => { layersRaf = 0; renderLayersNow(); });
}

function renderLayersNow() {
  const box = $('#layers');
  const openState = new Map(state.layers.map((l) => [l.name, l.open]));
  box.innerHTML = '';
  // ファイルが無いレイヤーは出さない（設定だけ裏で覚えている）
  const listed = state.layers.filter((L) => !L.missing);
  $('#layerCount').textContent = listed.length ? `(${listed.length})` : '';
  const tooMany = !$('#tooMany').classList.contains('hide');
  $('#empty').classList.toggle('hide', !!state.dir || tooMany);

  const { w: dw, h: dh } = docSize();
  const pm = dw ? paperMM(dw, dh) : null;
  // 画面上が最前面なので、配列とは逆順に並べる
  for (let i = listed.length - 1; i >= 0; i--) {
    const L = listed[i];
    L.open = openState.get(L.name) || false;
    box.appendChild(layerRow(L, i === listed.length - 1, i === 0, pm));
  }
  updateSpec();
  updateSoloBanner();
}

function layerSubtitle(L, ts, pm) {
  if (!ts) return { text: '待機中…' };
  if (ts.status === 'error') return { text: '⚠ 読み込みに失敗しました', cls: 'bad' };
  if (!ts.w) return { text: '読み込み中…' };
  const pct = ts.total ? Math.round(ts.done / ts.total * 100) : 0;
  const head = ts.status === 'tiling' ? `読み込み中 ${pct}%  ` : '';
  const extra = (L.scale !== 1 ? ` ×${L.scale.toFixed(2)}` : '') + (L.x || L.y ? `  ⇢ ${L.x},${L.y}` : '') + (L.flipH ? '  ⇄' : '');
  const j = judge(ts, pm);
  return {
    text: `${head}${ts.w}×${ts.h}${extra}${j && j.short ? '  ' + j.short : ''}`,
    title: j ? j.detail : '',
    cls: j && !j.ok ? 'bad' : '',
  };
}

function layerRow(L, isTop, isBottom, pm) {
  const ts = tilesets.get(L.name);
  const row = document.createElement('div');
  row.className = 'row' + (L.open ? ' open' : '') + (shown(L) ? '' : ' hidden-layer') +
    (solo.has(L.name) ? ' soloed' : '');
  row.dataset.name = L.name;
  row.draggable = false;   // つまみを持ったときだけ true にする（下の initRowDnd）

  const thumb = ts && ts.thumb;
  const sub = layerSubtitle(L, ts, pm);
  row.innerHTML = `
    <div class="row-main">
      <span class="grip" title="ドラッグで並べ替え">${ICON.grip}</span>
      <button class="eye ${L.visible ? 'on' : ''}" title="クリック：表示／非表示&#10;Alt+クリック：ソロ（このレイヤーだけ表示。複数可、Esc で解除）">${L.visible ? ICON.eye : ICON.eyeOff}</button>
      <div class="thumb" ${thumb ? `style="background-image:url(${thumb});background-size:contain;background-repeat:no-repeat;background-position:center"` : ''}></div>
      <div class="meta">
        <div class="name" title="${escapeHtml(L.name)}">${escapeHtml(displayName(L.name))}</div>
        <div class="sub ${sub.cls || ''}" title="${escapeHtml(sub.title || '')}">${escapeHtml(sub.text)}</div>
      </div>
      <div class="ord">
        <button class="ob up" title="ひとつ手前へ"${isTop ? ' disabled' : ''}>${ICON.up}</button>
        <button class="ob dn" title="ひとつ奥へ"${isBottom ? ' disabled' : ''}>${ICON.down}</button>
      </div>
      <button class="gear" title="位置・拡大・反転">${ICON.tune}</button>
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
    if (e.altKey) { toggleSolo(L.name); return; }
    L.visible = !L.visible;
    renderLayers(); upd();
  });

  const move = (d) => {
    // 一覧に出ていないレイヤーは飛ばして、見えている隣と入れ替える
    const i = state.layers.indexOf(L);
    let j = i + d;
    while (j >= 0 && j < state.layers.length && state.layers[j].missing) j += d;
    if (i < 0 || j < 0 || j >= state.layers.length) return;
    [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
    renderLayers(); upd();
  };
  row.querySelector('.up').addEventListener('click', () => move(1));   // 画面上＝配列の後ろ
  row.querySelector('.dn').addEventListener('click', () => move(-1));

  row.querySelector('.gear').addEventListener('click', () => {
    L.open = !L.open; row.classList.toggle('open', L.open);
  });

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
    bleed: state.bleed, cutMargin: state.cutMargin, artPct: state.artPct,
    guides: state.guides,
    exportScale: state.exportScale,
    view: { flipH: state.view.flipH, gray: state.view.gray, bg: state.view.bg, guide: state.view.guide },
    layers: state.layers.map((L) => ({
      name: L.name, visible: L.visible, opacity: L.opacity, blend: L.blend,
      x: L.x, y: L.y, scale: L.scale, flipH: L.flipH,
    })),
  };
  try {
    await Backend.saveProject(data, state.dir);
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
  if (Number.isFinite(p.artPct) && p.artPct >= 1 && p.artPct <= 100) state.artPct = p.artPct;
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

/* ---------- アプリ全体の設定（作業フォルダをまたいで共通） ---------- */
let appSaveTimer = 0;
/** 右の列の幅と、「用紙・解像度」欄の高さ（px）。null は初期の大きさ */
const layout = { sideW: null, footH: null };

async function loadAppSettings() {
  try {
    const s = await Backend.loadSettings();
    if (s && s.edge) applyEdgeSettings(s.edge);
    if (s && s.layout) { setSideWidth(s.layout.sideW); setFootHeight(s.layout.footH); }
  } catch (e) {
    log('error', 'アプリの設定を読めません: ' + (e.message || e));
  }
  syncUiFromState();
}

function applyEdgeSettings(e) {
  const E = state.edge, isHex = (c) => /^#[0-9a-f]{6}$/i.test(c);
  if (Number.isFinite(e.width) && e.width > 0) E.width = e.width;
  if (e.side === 'out' || e.side === 'in') E.side = e.side;
  if (isHex(e.color)) E.color = e.color;
  if (isHex(e.faintColor)) E.faintColor = e.faintColor;
  if (typeof e.dim === 'boolean') E.dim = e.dim;
}

function scheduleAppSave() {
  clearTimeout(appSaveTimer);
  appSaveTimer = setTimeout(async () => {
    try {
      await Backend.saveSettings({ version: 1, edge: state.edge, layout });
    } catch (e) {
      log('error', 'アプリの設定を保存できません: ' + (e.message || e));
    }
  }, 600);
}

/* ---------- 境目のドラッグで、右の列の幅と「用紙・解像度」欄の高さを変える ---------- */
function setSideWidth(w) {
  const max = Math.max(260, Math.round(window.innerWidth * 0.6));
  layout.sideW = Number.isFinite(w) && w > 0 ? clamp(Math.round(w), 260, max) : null;
  if (layout.sideW) document.documentElement.style.setProperty('--side-w', layout.sideW + 'px');
  else document.documentElement.style.removeProperty('--side-w');
  requestRender();
}

function setFootHeight(h) {
  const foot = document.querySelector('.side-foot');
  const max = Math.max(60, Math.round($('#side').getBoundingClientRect().height - 140));   // レイヤー一覧を最低限残す
  layout.footH = Number.isFinite(h) && h > 0 ? clamp(Math.round(h), 60, max) : null;
  foot.style.height = layout.footH ? layout.footH + 'px' : '';
  foot.style.maxHeight = layout.footH ? 'none' : '';
}

function initResizers() {
  const drag = (el, onMove, onReset) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* 取れなくてもドラッグはできる */ }
      el.classList.add('dragging');
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        scheduleAppSave();
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', () => { onReset(); scheduleAppSave(); });
  };
  // 右の列は画面の右端まで続くので、幅＝右端からカーソルまで
  drag($('#sideResizer'), (e) => setSideWidth(window.innerWidth - e.clientX), () => setSideWidth(null));
  drag($('#footResizer'), (e) => setFootHeight($('#side').getBoundingClientRect().bottom - e.clientY), () => setFootHeight(null));
  // ウィンドウを小さくしたときに、覚えていた大きさが収まらなくなるのを直す
  window.addEventListener('resize', () => {
    if (layout.sideW) setSideWidth(layout.sideW);
    if (layout.footH) setFootHeight(layout.footH);
  });
}

function syncUiFromState() {
  $('#selPaper').value = state.paper;
  $('#customPaper').hidden = state.paper !== 'custom';
  $('#inPaperW').value = state.customW || '';
  $('#inPaperH').value = state.customH || '';
  $('#inDpi').value = state.dpi;
  $('#inBleed').value = state.bleed;
  $('#inCutMargin').value = state.cutMargin;
  $('#inArtPct').value = state.artPct;
  $('#gTrim').checked = state.guides.trim;
  $('#gCenter').checked = state.guides.center;
  $('#gThirds').checked = state.guides.thirds;
  $('#gCut').checked = state.guides.cut;
  $('#inEdgeWidth').value = state.edge.width;
  $('#selEdgeSide').value = state.edge.side;
  $('#inEdgeColor').value = state.edge.color;
  $('#inEdgeFaintColor').value = state.edge.faintColor;
  $('#chkEdgeDim').checked = state.edge.dim;
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
  const targets = state.layers.filter((L) => shown(L) && tilesets.has(L.name));
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

/** ▾ の小窓と ？ のメニューを閉じる。開いているものがあれば true */
function closePops() {
  let any = false;
  for (const el of document.querySelectorAll('.pop, .menu')) {
    if (!el.hidden) { el.hidden = true; any = true; }
  }
  document.querySelectorAll('.caret.open').forEach((b) => b.classList.remove('open'));
  return any;
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
  solo.clear();
  clearHoverCache();
  edgeJob.jobId++;   // 前のフォルダの下調べは捨てる
  edgeJob.map = null; edgeJob.look = null; edgeJob.running = false; edgeJob.waiting = false;
  $('#tooMany').classList.add('hide');
  state.layers = [];
  applyProject(j.project);
  if (j.mem) { mem = j.mem; budget = clamp(Math.round(mem.avail * 0.25), 96 * MB, 1536 * MB); }
  state.view.fitted = false;
  renderLayers(); requestRender();
  setStatus('読み込み中…', 'busy');
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
  $('#btnEdge').addEventListener('click', () => toggleView('edge', '#btnEdge'));
  $('#btnGuide').addEventListener('click', () => toggleView('guide', '#btnGuide'));
  $('#btnBg').addEventListener('click', () => {
    state.view.bg = (state.view.bg + 1) % BG_MODES.length; requestRender(); scheduleSave();
  });

  $('#btnExport').addEventListener('click', openExportDialog);
  $('#btnExportGo').addEventListener('click', runExport);
  $('#btnExportClose').addEventListener('click', closeModals);
  $('#btnExportReveal').addEventListener('click', () => Backend.reveal('export').catch(() => {}));
  $('#btnAboutClose').addEventListener('click', closeModals);
  $('#btnHelpClose').addEventListener('click', closeModals);
  $('#btnSettingsClose').addEventListener('click', closeModals);
  $('#btnSettings').addEventListener('click', () => { closePops(); $('#settingsModal').hidden = false; });
  $('#btnLayoutReset').addEventListener('click', () => { setSideWidth(null); setFootHeight(null); scheduleAppSave(); });

  // ？ メニュー（使い方・ログ・LayerDeck について）
  const menu = $('#menu');
  $('#btnHelp').addEventListener('click', () => {
    const open = menu.hidden;
    closePops();
    menu.hidden = !open;
  });
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    if (!act) return;
    menu.hidden = true;
    if (act === 'help') $('#helpModal').hidden = false;
    else if (act === 'log') Backend.reveal('log').catch(() => {});
    else if (act === 'about') openAbout();
  });

  // ▾ で開く設定の小窓（縁取り表示・ガイド）
  const pop = (btn, box) => $(btn).addEventListener('click', () => {
    const open = $(box).hidden;
    closePops();
    $(box).hidden = !open;
    $(btn).classList.toggle('open', open);
  });
  pop('#btnEdgeOpts', '#edgePop');
  pop('#btnGuideOpts', '#guidePop');
  // 外をクリックしたら閉じる
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.pop, .menu, #btnHelp, .caret')) closePops();
  });
  $('#btnLicenses').addEventListener('click', showLicenses);
  $('#btnLog').addEventListener('click', () => Backend.reveal('log').catch(() => {}));
  document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => {
    if (e.target === m) closeModals();   // 背景クリックで閉じる
  }));

  $('#btnSortName').addEventListener('click', () => {
    state.layers.sort((a, b) => byName(a.name, b.name));
    renderLayers(); requestRender(); scheduleSave();
  });
  $('#soloBanner').addEventListener('click', clearSolo);
  $('#btnAllOn').addEventListener('click', () => {
    solo.clear();
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
  $('#inArtPct').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (!(v >= 1 && v <= 100)) return;
    // カットライン予想・縁取り表示（scheduleCut が一緒に予約する）・透明チェックが一斉に変わる
    state.artPct = v; scheduleSave(); scheduleCut(); updateEdgeLegend(); requestRender();
  });

  // 縁取り表示。設定を触ったら、表示そのものも自動で入れる
  const edgeSet = (apply) => (e) => {
    if (apply(e.target) === false) return;
    if (!state.view.edge) { state.view.edge = true; syncViewButtons(); scheduleEdge(); }
    scheduleEdgeLook(); updateEdgeLegend(); requestRender(); scheduleAppSave();
  };
  $('#inEdgeWidth').addEventListener('input', edgeSet((t) => {
    const v = parseFloat(t.value);
    if (!(v > 0 && v <= 100)) return false;
    state.edge.width = v;
  }));
  $('#selEdgeSide').addEventListener('change', edgeSet((t) => { state.edge.side = t.value; }));
  $('#inEdgeColor').addEventListener('input', edgeSet((t) => { state.edge.color = t.value; }));
  $('#inEdgeFaintColor').addEventListener('input', edgeSet((t) => { state.edge.faintColor = t.value; }));
  $('#chkEdgeDim').addEventListener('change', edgeSet((t) => { state.edge.dim = t.checked; }));

  initViewEvents();
  initResizers();
}

window.addEventListener('error', (e) =>
  log('error', `${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) =>
  log('error', '未処理の失敗: ' + ((e.reason && (e.reason.message || e.reason)) || '')));

(async function main() {
  initUi();
  initWorkers();
  await loadAppSettings();   // syncUiFromState も行う
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
