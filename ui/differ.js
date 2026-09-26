/* LayerDeck 「今との違い」を求めるワーカー
 *
 * 過去の版と今の版の組を受け取り、ピクセルを比べて、違う所を S×S ピクセルのマスで返す。
 * どちらか片方しかないとき（その時点ではまだ無かった／今は消えている）は、絵のある所全部を違いとする。
 */
'use strict';

self.onmessage = async (e) => {
  const { id, dw, dh, S, pairs } = e.data;
  try {
    const cw = Math.ceil(dw / S), ch = Math.ceil(dh / S);
    const mask = new Uint8Array(cw * ch);
    for (const p of pairs) {
      const A = p.a ? await createImageBitmap(p.a) : null;
      const B = p.b ? await createImageBitmap(p.b) : null;
      const ref = A || B;
      if (!ref) continue;
      // 画質の設定を途中で変えた場合も比べられるよう、片方の大きさにそろえる
      const iw = ref.width, ih = ref.height;
      const pixels = (bmp) => {
        const c = new OffscreenCanvas(iw, ih);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0, iw, ih);
        return g.getImageData(0, 0, iw, ih).data;
      };
      const da = A ? pixels(A) : null, db = B ? pixels(B) : null;
      if (A) A.close();
      if (B) B.close();

      for (let y = 0; y < ih; y++) {
        const cy = Math.floor((p.y + (y + 0.5) * p.h / ih * p.scale) / S);
        if (cy < 0 || cy >= ch) continue;
        for (let x = 0; x < iw; x++) {
          const i = (y * iw + x) * 4;
          let changed;
          if (da && db) {
            const aa = da[i + 3], ab = db[i + 3];
            // ほぼ透明な所の色は当てにならないので、色は見える所だけで比べる
            // 同じ元画像を同じように縮小しているので、差が出るのは描き直した所だけ。境目は低めでよい
            changed = Math.abs(aa - ab) > 16 ||
              (Math.max(aa, ab) > 24 &&
               Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24);
          } else {
            changed = (da || db)[i + 3] > 24;
          }
          if (!changed) continue;
          const u = (x + 0.5) * p.w / iw;
          const cx = Math.floor((p.x + (p.flipH ? p.w - u : u) * p.scale) / S);
          if (cx >= 0 && cx < cw) mask[cy * cw + cx] = 1;
        }
      }
    }
    self.postMessage({ id, S, cw, ch, mask }, [mask.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
