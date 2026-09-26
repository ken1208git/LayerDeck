"""履歴（シークバー）を試すための、作業の再現スクリプト

パーツPNGを作業フォルダに置き、数秒おきに「キャラを動かす」「ゴミを付ける」「色を変える」
「1枚消してまた戻す」といった修正を順に上書きしていく。LayerDeck を開いたまま実行すると、
上書きのたびに履歴が記録される。

ファイルの更新日時は「3日前から数時間おき」に書き換えるので、シークバーには実際の作業らしい
日時が並ぶ。Python の標準ライブラリだけで動く。

使い方:
    python scripts/simulate-edits.py _testhistory            # 作って、全部の手順を流す
    python scripts/simulate-edits.py _testhistory --delay 8  # 手順の間隔（秒）を変える
    python scripts/simulate-edits.py _testhistory --reset    # 中身を消して最初から
"""
from __future__ import annotations

import argparse
import math
import os
import struct
import sys
import time
import zlib
from pathlib import Path

# A3 横・150dpi。A2 より小さくして、読み込みを速くする
W, H = 2480, 1754
DPI = 150


# ---------------------------------------------------------------------
# 描画（行ごとに色の範囲をまとめて塗る）
# ---------------------------------------------------------------------
def new():
    return [bytearray(W * 4) for _ in range(H)]


def span(img, y, x0, x1, rgba):
    if not (0 <= y < H):
        return
    x0, x1 = max(0, x0), min(W, x1)
    if x1 > x0:
        img[y][x0 * 4:x1 * 4] = bytes(rgba) * (x1 - x0)


def rect(img, x, y, w, h, rgba):
    for yy in range(y, y + h):
        span(img, yy, x, x + w, rgba)


def ellipse(img, cx, cy, rx, ry, rgba):
    for y in range(cy - ry, cy + ry + 1):
        t = 1 - ((y - cy) / ry) ** 2
        if t < 0:
            continue
        dx = int(rx * math.sqrt(t))
        span(img, y, cx - dx, cx + dx + 1, rgba)


def save(img, path: Path, mtime: float):
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ppm = round(DPI / 0.0254)
    raw = b''.join(b'\0' + bytes(r) for r in img)
    data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
            + chunk(b'pHYs', struct.pack('>IIB', ppm, ppm, 1))
            + chunk(b'IDAT', zlib.compress(raw, 1)) + chunk(b'IEND', b''))
    # 書きかけを読まれないよう、一時ファイルに書いてから差し替える
    tmp = path.with_suffix('.tmp')
    tmp.write_bytes(data)
    os.replace(tmp, path)
    os.utime(path, (mtime, mtime))


# ---------------------------------------------------------------------
# パーツ
# ---------------------------------------------------------------------
def background(ground=(70, 110, 60, 255)):
    img = new()
    for y in range(H):   # 空のグラデーション
        k = y / H
        span(img, y, 0, W, (int(40 + 120 * k), int(60 + 90 * k), int(140 + 60 * k), 255))
    rect(img, 0, int(H * 0.72), W, H - int(H * 0.72), ground)
    return img


def chara(x=900, speck=False, arm=False):
    img = new()
    ellipse(img, x, 1000, 170, 330, (40, 90, 150, 255))   # 体
    ellipse(img, x, 590, 120, 120, (240, 200, 170, 255))  # 顔
    if arm:
        rect(img, x + 150, 880, 260, 46, (40, 90, 150, 255))
    if speck:   # 消し忘れのゴミ
        rect(img, x + 330, 520, 3, 3, (30, 30, 30, 255))
        rect(img, x - 360, 1180, 2, 2, (30, 30, 30, 90))
    return img


def prop(x=1800, color=(240, 200, 40, 255)):
    img = new()
    ellipse(img, x, 900, 140, 140, color)
    rect(img, x - 12, 1040, 24, 300, (90, 140, 70, 255))
    return img


# (説明, [(ファイル名, 絵 または None=消す)])
STEPS = [
    ('最初の3枚', [('01_背景.png', lambda: background()),
                   ('02_キャラ.png', lambda: chara()),
                   ('03_小物.png', lambda: prop())]),
    ('キャラを右へ動かす', [('02_キャラ.png', lambda: chara(x=1050))]),
    ('小物の色を変える', [('03_小物.png', lambda: prop(color=(230, 90, 120, 255)))]),
    ('キャラにゴミが付く', [('02_キャラ.png', lambda: chara(x=1050, speck=True))]),
    ('地面の色を変える', [('01_背景.png', lambda: background(ground=(110, 90, 60, 255)))]),
    ('小物を消す', [('03_小物.png', None)]),
    ('小物を別の位置に戻す', [('03_小物.png', lambda: prop(x=1950, color=(230, 90, 120, 255)))]),
    ('キャラのゴミを消して腕を足す', [('02_キャラ.png', lambda: chara(x=1050, arm=True))]),
]


def main():
    ap = argparse.ArgumentParser(description='履歴を試すための作業の再現')
    ap.add_argument('dir')
    ap.add_argument('--delay', type=float, default=6.0, help='手順の間隔（秒）')
    ap.add_argument('--reset', action='store_true', help='最初に中のPNGを消す')
    a = ap.parse_args()

    d = Path(a.dir)
    d.mkdir(parents=True, exist_ok=True)
    if a.reset:
        for p in d.glob('*.png'):
            p.unlink()

    # 3日前から、3時間ずつ進んだ日時として記録する
    base = time.time() - 3 * 24 * 3600
    for i, (label, files) in enumerate(STEPS):
        mtime = base + i * 3 * 3600 + (i * 7 % 50) * 60
        stamp = time.strftime('%m/%d %H:%M', time.localtime(mtime))
        for name, make in files:
            p = d / name
            if make is None:
                if p.exists():
                    p.unlink()
            else:
                save(make(), p, mtime)
        print(f'[{i + 1}/{len(STEPS)}] {stamp}  {label}', flush=True)
        if i < len(STEPS) - 1:
            time.sleep(a.delay)
    print('終わり')


if __name__ == '__main__':
    sys.exit(main())
