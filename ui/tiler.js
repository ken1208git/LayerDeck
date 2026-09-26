/* LayerDeck タイル生成ワーカー
 *
 * 巨大PNGを一度だけフルデコードし、その場でマス目（タイル）に切り分けて
 * メインスレッドへ返す。返すのは PNG に再圧縮した Blob なので、
 * 展開済み（1枚 100〜200MB 級）のビットマップはこの worker の中にしか存在せず、
 * 終わったら即座に close される。メインスレッドは一切ブロックしない。
 *
 * ついでに、画像に記録されている解像度（dpi）も読んで返す。
 * ディスクには何も書かない。Blob のメモリ／ディスク退避はブラウザに任せる。
 */
'use strict';

// マス目の大きさ。大きいほど切り分けが速く（枚数が減る）、
// 小さいほど画面に必要な分だけを細かく持てる。
// A2/350dpi 6枚での実測: 512px=257枚/約60秒/展開115MB、
//                        1024px=65枚/約20秒/展開152MB。
const TILE = 1024;

self.onmessage = async (e) => {
  const job = e.data || {};
  try {
    await run(job);
  } catch (err) {
    self.postMessage({
      type: 'error', name: job.name, ver: job.ver,
      message: String((err && err.message) || err),
    });
  }
};

/**
 * 画像ファイルに記録されている解像度を dpi で返す。記録が無ければ null。
 *   PNG  : pHYs チャンク（1メートルあたりの画素数）
 *   JPEG : JFIF の APP0（dpi または dpcm）
 */
function readDpi(buf) {
  const b = new Uint8Array(buf);
  const v = new DataView(buf);
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
    let i = 8;
    while (i + 12 <= b.length) {
      const len = v.getUint32(i);
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (type === 'pHYs' && len >= 9) {
        const x = v.getUint32(i + 8), y = v.getUint32(i + 12), unit = b[i + 16];
        return unit === 1 && x > 0 && y > 0 ? { x: x * 0.0254, y: y * 0.0254 } : null;
      }
      if (type === 'IDAT' || type === 'IEND') return null;   // pHYs は画素データより前にある決まり
      i += 12 + len;
    }
    return null;
  }
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 16 < b.length && b[i] === 0xFF) {
      const marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xE0 && b[i + 4] === 0x4A && b[i + 5] === 0x46 && b[i + 6] === 0x49 && b[i + 7] === 0x46) {
        const units = b[i + 11], x = (b[i + 12] << 8) | b[i + 13], y = (b[i + 14] << 8) | b[i + 15];
        if (units === 1 && x > 0) return { x, y };
        if (units === 2 && x > 0) return { x: x * 2.54, y: y * 2.54 };
        return null;
      }
      if (marker === 0xDA) break;   // ここから先は画素データ
      i += 2 + len;
    }
  }
  return null;
}

async function run({ name, ver, buf }) {
  const dpi = readDpi(buf);
  // 画像のバイト列は本体側から転送されてくる（worker はバックエンドを直接触れない）
  const src = await createImageBitmap(new Blob([buf]));
  const w0 = src.width, h0 = src.height;

  // 解像度の階段。0 が原寸で、数字が増えるほど粗い。
  const levels = [];
  let lw = w0, lh = h0;
  for (;;) {
    levels.push({ w: lw, h: lh, cols: Math.ceil(lw / TILE), rows: Math.ceil(lh / TILE) });
    if (Math.max(lw, lh) <= TILE || levels.length > 20) break;
    lw = Math.max(1, Math.ceil(lw / 2));
    lh = Math.max(1, Math.ceil(lh / 2));
  }
  const total = levels.reduce((n, l) => n + l.cols * l.rows, 0);

  // 幾何情報を先に返す（タイルが揃う前から描画を始められるように）
  self.postMessage({ type: 'geom', name, ver, w: w0, h: h0, tile: TILE, levels, total, dpi });

  // 粗い段を順に作る。ひとつ細かい段を半分に縮めて作ると品質が安定する。
  const srcs = new Array(levels.length);
  srcs[0] = src;
  for (let k = 1; k < levels.length; k++) {
    const lv = levels[k];
    const c = new OffscreenCanvas(lv.w, lv.h);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(srcs[k - 1], 0, 0, lv.w, lv.h);
    srcs[k] = c;
  }

  const tc = new OffscreenCanvas(TILE, TILE);
  const tg = tc.getContext('2d');
  let done = 0;

  // 粗い段から先に返す＝先に「全体がそこそこ綺麗」になる
  for (let k = levels.length - 1; k >= 0; k--) {
    const lv = levels[k];
    for (let y = 0; y < lv.rows; y++) {
      const items = [];
      for (let x = 0; x < lv.cols; x++) {
        const sx = x * TILE, sy = y * TILE;
        const sw = Math.min(TILE, lv.w - sx), sh = Math.min(TILE, lv.h - sy);
        tg.clearRect(0, 0, TILE, TILE);
        tg.drawImage(srcs[k], sx, sy, sw, sh, 0, 0, sw, sh);
        items.push({ x, y, w: sw, h: sh, blob: await tc.convertToBlob({ type: 'image/png' }) });
        done++;
      }
      // 行ごとに返すと、粗い段は即座に画面へ出る
      self.postMessage({ type: 'tiles', name, ver, level: k, items, done, total });
    }
    if (k > 0) srcs[k] = null;  // この段はもう要らない
    self.postMessage({ type: 'level', name, ver, level: k, done, total });
  }

  src.close();
  srcs[0] = null;

  self.postMessage({ type: 'done', name, ver, w: w0, h: h0, tile: TILE, levels });
}
