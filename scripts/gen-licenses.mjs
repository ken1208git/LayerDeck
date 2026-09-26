// 実行ファイルに入っているオープンソースのライセンス文を集めて ui/licenses.txt に書く。
// MIT や Apache-2.0 は、配布物に著作権表示とライセンス文を含めることを求めているため。
//
//   node scripts/gen-licenses.mjs
//
// Cargo の依存関係から「通常の依存」だけを辿る（ビルド時にしか使わないものは除く）。
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(execSync(
  'cargo metadata --format-version 1 --filter-platform x86_64-pc-windows-msvc',
  { cwd: path.join(root, 'src-tauri'), maxBuffer: 512 * 1024 * 1024 },
).toString());

const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const rootId = meta.resolve.root;

const used = new Set();
const stack = [rootId];
while (stack.length) {
  const node = nodes.get(stack.pop());
  if (!node) continue;
  for (const d of node.deps) {
    const normal = d.dep_kinds.some((k) => k.kind === null);
    if (!normal || used.has(d.pkg)) continue;
    used.add(d.pkg);
    stack.push(d.pkg);
  }
}

const list = [...used].map((id) => pkgs.get(id)).filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const firstSeen = new Map();   // 文面のハッシュ -> 最初に出てきたパッケージ名
const out = [];
const rule = '-'.repeat(72);
out.push('LayerDeck で使っているオープンソース ソフトウェア');
out.push('');
out.push('LayerDeck は以下のオープンソース ソフトウェアを利用しています。');
out.push('それぞれの著作権表示とライセンス文を、以下に掲載します。');
out.push(`（${list.length} パッケージ）`);
out.push('');

let missing = 0;
for (const p of list) {
  const dir = path.dirname(p.manifest_path);
  const files = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (/^(licen[cs]e|copying|notice|copyright)/i.test(f) && fs.statSync(path.join(dir, f)).isFile()) files.add(f);
  }
  if (p.license_file) files.add(p.license_file);

  out.push(rule);
  out.push(`${p.name} ${p.version}`);
  out.push(`ライセンス: ${p.license || '（ファイルを参照）'}`);
  if (p.repository) out.push(`入手先: ${p.repository}`);
  out.push(rule);
  if (!files.size) {
    missing++;
    out.push(`（このパッケージにはライセンス文のファイルが含まれていません。${p.license || ''} の標準の文面が適用されます）`);
  }
  for (const f of [...files].sort()) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    text = text.replace(/\r\n/g, '\n').trim();
    const h = crypto.createHash('sha1').update(text).digest('hex');
    if (firstSeen.has(h)) {
      out.push(`[${f}] ${firstSeen.get(h)} の同名ファイルと同じ文面`);
    } else {
      firstSeen.set(h, `${p.name} ${p.version}`);
      out.push(`[${f}]`);
      out.push(text);
    }
    out.push('');
  }
  out.push('');
}

// パッケージにライセンス文のファイルが入っていないものへ、標準の本文を補う
out.push(rule);
out.push('標準のライセンス本文（ライセンス文のファイルが同梱されていないパッケージ向け）');
out.push(rule);
out.push('Apache License 2.0 の全文は、上記の tauri などに含まれる LICENSE-APACHE の文面と同じです。');
out.push('Mozilla Public License 2.0 の全文: https://mozilla.org/MPL/2.0/');
out.push('（MPL-2.0 のパッケージは改変せずに使用しています。ソースコードは各パッケージの入手先から取得できます）');
out.push('');
out.push(`[MIT License]
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`);
out.push('');
out.push(`[BSD 3-Clause License]
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`);
out.push('');

const dest = path.join(root, 'ui', 'licenses.txt');
fs.writeFileSync(dest, out.join('\n'), 'utf8');
console.log(`${list.length} パッケージ / 文面 ${firstSeen.size} 種類 / ファイル無し ${missing} 件`);
console.log(`→ ${path.relative(root, dest)}  ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`);
