/* LayerDeck バックエンド抽象化
 *
 * 画面側はここだけを見る。実体は 2 つある:
 *   - tauri : デスクトップアプリとして動いているとき（Tauri 2 のグローバルAPI）
 *   - http  : ブラウザ + server.py で動いているとき（開発・検証用）
 *
 * どちらも同じ形の Promise を返す。
 */
'use strict';

(function () {
  const T = typeof window !== 'undefined' ? window.__TAURI__ : null;

  const enc = encodeURIComponent;

  /* ---------------- http（server.py） ---------------- */
  async function j(path, opts) {
    const r = await fetch(path, opts);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('HTTP ' + r.status);
    const o = await r.json();
    if (!r.ok && o.error) throw new Error(o.error);
    return o;
  }

  const httpBackend = {
    kind: 'http',
    /** フォルダ変更の即時通知は無い（画面側のポーリングに任せる） */
    pushesChanges: false,

    async getState() {
      const s = await j('/api/state');
      return { dir: s.dir, files: s.files || [], project: s.project || null, mem: s.mem || null };
    },
    async listFiles() {
      return (await j('/api/files')).files || [];
    },
    async pickFolder() {
      const s = await j('/api/pick', { method: 'POST' });
      if (s.cancelled || !s.dir) return null;
      return { dir: s.dir, files: s.files || [], project: s.project || null, mem: s.mem || null };
    },
    async readImage(name, ver) {
      const r = await fetch(`/file?name=${enc(name)}&v=${enc(ver)}`);
      if (!r.ok) throw new Error('画像を読めませんでした: ' + name);
      return await r.arrayBuffer();
    },
    async memStatus() {
      return (await j('/api/mem')).mem || null;
    },
    async saveProject(obj) {
      await j('/api/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj),
      });
    },
    async saveExport(name, blob) {
      const r = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'X-Layerdeck-Name': name },
        body: blob,
      });
      const o = await r.json();
      if (!o.ok) throw new Error(o.error || '保存に失敗しました');
      return o.path;
    },
    async reveal() {
      await fetch('/api/reveal', { method: 'POST', body: '{}' }).catch(() => {});
    },
    onChange() { /* 使わない */ },
  };

  /* ---------------- tauri ---------------- */
  function makeTauriBackend() {
    const invoke = T.core.invoke;
    const fs = T.fs;
    const dialog = T.dialog;
    const event = T.event;
    const opener = T.opener;

    let sep = '\\';
    let curDir = null;
    const join = (...p) => p.join(sep);

    const adopt = (s) => {
      if (s && s.sep) sep = s.sep;
      if (s && 'dir' in s) curDir = s.dir;
      return s;
    };
    // キャッシュが無ければ Rust に聞き直す。画面側の呼び順に依存しないようにするため。
    const needDir = async () => {
      if (!curDir) curDir = await invoke('current_dir');
      if (!curDir) throw new Error('フォルダ未選択');
      return curDir;
    };

    return {
      kind: 'tauri',
      /** OS のファイル変更通知が飛んでくる */
      pushesChanges: true,

      async getState() { return adopt(await invoke('get_state')); },
      async listFiles() { return await invoke('list_files'); },

      async pickFolder() {
        const picked = await dialog.open({ directory: true, multiple: false, title: 'パーツPNGの入ったフォルダを選択' });
        if (!picked) return null;
        return adopt(await invoke('set_dir', { dir: picked }));
      },

      async readImage(name) {
        const bytes = await fs.readFile(join(await needDir(), name));
        // Uint8Array -> ArrayBuffer（worker へ transfer するため）
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },

      async memStatus() { return await invoke('mem_status'); },

      async saveProject(obj) { await invoke('write_project', { json: JSON.stringify(obj) }); },

      async saveExport(name, blob) {
        const outDir = join(await needDir(), '_export');
        try { await fs.mkdir(outDir, { recursive: true }); } catch { /* 既にあるだけ */ }
        const path = join(outDir, name);
        await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
        return path;
      },

      async reveal() {
        const dir = await needDir().catch(() => null);
        if (dir && opener) await opener.openPath(dir);
      },

      onChange(cb) { event.listen('files-changed', () => cb()); },
    };
  }

  window.Backend = T && T.core ? makeTauriBackend() : httpBackend;
})();
