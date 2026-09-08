/* LayerDeck タイル生成ワーカー
 *
 * 巨大PNGを一度だけフルデコードし、その場で 512x512 のタイルに切り分けて
 * メインスレッドへ返す。返すのは PNG に再圧縮した Blob なので、
 * 展開済み（1枚 190MB 級）のビットマップはこの worker の中にしか存在せず、
 * 終わったら即座に close される。メインスレッドは一切ブロックしない。
 *
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

async function run({ name, ver, buf }) {
  // 画像のバイト列は本体側から転送されてくる（worker はバックエンドを直接触れない）
  const src = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
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
  self.postMessage({ type: 'geom', name, ver, w: w0, h: h0, tile: TILE, levels, total });

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
