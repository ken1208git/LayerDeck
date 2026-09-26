/* LayerDeck 縁取り表示の下調べワーカー
 *
 * 表示中のレイヤーを原寸で重ね、S×S ピクセルのマスごとに
 *   maxA : いちばん濃い不透明度 → 1px のゴミや薄いにじみも残る
 *   minA : いちばん薄い不透明度 → 1px の塗り残し（穴）も残る
 * を集めて返す。表示用の縮小版は平均をとるので、1〜2px のゴミは消えてしまう。
 *
 * 原寸のマス目を 1024px ずつ重ねては読み、すぐ手放すので、使うメモリは
 * 「1024px 四方 × レイヤー数」程度で済む。
 */
'use strict';

const CHUNK = 1024;
let latest = 0;

self.onmessage = (e) => {
  const job = e.data || {};
  latest = job.id;   // 新しい依頼が来たら、計算中の古い依頼は次の区切りでやめる
  run(job).catch((err) => self.postMessage({
    type: 'error', id: job.id, message: String((err && err.message) || err),
  }));
};

async function run({ id, dw, dh, S, layers }) {
  const cw = Math.ceil(dw / S), ch = Math.ceil(dh / S);
  const maxA = new Uint8Array(cw * ch);
  const minA = new Uint8Array(cw * ch).fill(255);
  const cv = new OffscreenCanvas(CHUNK, CHUNK);
  const g = cv.getContext('2d', { willReadFrequently: true });
  const cols = Math.ceil(dw / CHUNK), rows = Math.ceil(dh / CHUNK);
  const cellX = new Int32Array(CHUNK);
  let done = 0;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (id !== latest) return;
      const ox = cx * CHUNK, oy = cy * CHUNK;
      const w = Math.min(CHUNK, dw - ox), h = Math.min(CHUNK, dh - oy);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.clearRect(0, 0, CHUNK, CHUNK);

      // 不透明度だけを見るので、合成モードは使わず「通常」で重ねる
      for (const L of layers) {
        const need = L.tiles.filter((t) => hits(L, t, ox, oy, w, h));
        if (!need.length) continue;
        const bmps = await Promise.all(need.map((t) => createImageBitmap(t.blob)));
        if (id !== latest) { bmps.forEach((b) => b.close()); return; }
        g.setTransform(1, 0, 0, 1, -ox, -oy);
        g.translate(L.x, L.y);
        if (L.flipH) { g.translate(L.w * L.scale, 0); g.scale(-1, 1); }
        g.scale(L.scale, L.scale);
        g.imageSmoothingEnabled = L.scale !== 1;   // 等倍ならピクセルをそのまま置く
        g.globalAlpha = L.opacity;
        need.forEach((t, i) => {
          g.drawImage(bmps[i], 0, 0, t.w, t.h, t.c * L.tile, t.r * L.tile, t.w, t.h);
          bmps[i].close();
        });
      }

      const d = g.getImageData(0, 0, w, h).data;
      for (let x = 0; x < w; x++) cellX[x] = ((ox + x) / S) | 0;
      for (let y = 0; y < h; y++) {
        const row = (((oy + y) / S) | 0) * cw;
        let p = y * w * 4 + 3;
        for (let x = 0; x < w; x++, p += 4) {
          const a = d[p], i = row + cellX[x];
          if (a > maxA[i]) maxA[i] = a;
          if (a < minA[i]) minA[i] = a;
        }
      }
      done++;
      self.postMessage({ type: 'progress', id, done, total: cols * rows });
    }
  }
  self.postMessage({ type: 'done', id, S, cw, ch, maxA, minA }, [maxA.buffer, minA.buffer]);
}

/** レイヤーのマス目 t が、画像の範囲 [ox, ox+w) × [oy, oy+h) に掛かるか */
function hits(L, t, ox, oy, w, h) {
  const s = L.scale;
  const u0 = t.c * L.tile, u1 = u0 + t.w;
  const x0 = L.flipH ? L.x + (L.w - u1) * s : L.x + u0 * s;
  const x1 = L.flipH ? L.x + (L.w - u0) * s : L.x + u1 * s;
  const y0 = L.y + t.r * L.tile * s, y1 = y0 + t.h * s;
  return x1 > ox && x0 < ox + w && y1 > oy && y0 < oy + h;
}
