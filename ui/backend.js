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

  // この画面が開いているフォルダ。サーバーが別のフォルダで起動し直されたら、画面を読み込み直す
  // （古い画面が新しいフォルダの画像を自分のものとして扱い、設定や履歴を混ぜてしまうため）
  let pageDir = null;

  const httpBackend = {
    kind: 'http',
    /** フォルダ変更の即時通知は無い（画面側のポーリングに任せる） */
    pushesChanges: false,

    async getState() {
      const s = await j('/api/state');
      pageDir = s.dir || null;
      return { dir: s.dir, files: s.files || [], project: s.project || null, mem: s.mem || null };
    },
    async listFiles() {
      const s = await j('/api/files');
      if (pageDir && s.dir !== pageDir) { location.reload(); return []; }
      return s.files || [];
    },
    async pickFolder() {
      const s = await j('/api/pick', { method: 'POST' });
      if (s.cancelled || !s.dir) return null;
      pageDir = s.dir;
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
    /** dir = 画面が開いているフォルダ。サーバーが別のフォルダに切り替わっていたら断られる */
    async saveProject(obj, dir) {
      await j('/api/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Layerdeck-Dir': enc(dir || '') },
        body: JSON.stringify(obj),
      });
    },
    /** 履歴（上書きされる前の版）。rel は「作業フォルダのID/ファイル名」 */
    hist: {
      async read(rel) {
        const r = await fetch(`/api/hist/read?rel=${enc(rel)}`, { cache: 'no-store' });
        return r.ok && r.status !== 204 ? await r.arrayBuffer() : null;
      },
      async write(rel, data) {
        const r = await fetch(`/api/hist/write?rel=${enc(rel)}`, { method: 'POST', body: data });
        if (!r.ok) throw new Error('履歴を書けません: ' + rel);
      },
      async remove(rel) {
        await fetch(`/api/hist/remove?rel=${enc(rel)}`, { method: 'POST' });
      },
      async list() { return (await j('/api/hist/list')).dirs || []; },
      async stats() { const s = await j('/api/hist/stats'); return { used: s.used, free: s.free }; },
    },

    /** アプリ全体の設定（作業フォルダをまたいで共通） */
    async loadSettings() {
      return (await j('/api/settings')).settings || null;
    },
    async saveSettings(obj) {
      await j('/api/settings', {
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
    /** kind: 'folder' | 'export' | 'log' */
    async reveal(kind) {
      const sub = kind === 'export' ? '_export' : '';
      await fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ sub }) }).catch(() => {});
    },
    log(line) { console.info(line); },
    async version() { return '開発版'; },
    async setTitle(title) { document.title = title; },
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
    let curFiles = [];
    let lastExport = null;
    const join = (...p) => p.join(sep);

    const adopt = (s) => {
      if (s && s.sep) sep = s.sep;
      if (s && 'dir' in s) curDir = s.dir;
      if (s && Array.isArray(s.files)) curFiles = s.files;
      return s;
    };
    // 現在のフォルダは毎回 Rust に聞く。こちらで覚えておくと、覚えた値が古くなったときに
    // 別のフォルダから読んでしまう（実際に起きた）。読み書きは頻繁ではないので問い合わせで十分。
    const needDir = async () => {
      curDir = await invoke('current_dir');
      if (!curDir) throw new Error('フォルダ未選択');
      return curDir;
    };

    return {
      kind: 'tauri',
      /** OS のファイル変更通知が飛んでくる */
      pushesChanges: true,

      async getState() { return adopt(await invoke('get_state')); },
      async listFiles() { curFiles = await invoke('list_files'); return curFiles; },

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

      /** 履歴。%LOCALAPPDATA%\com.layerdeck.desktop\history\ の中。画像はバイト列のまま渡す */
      hist: {
        async read(rel) {
          try { return await invoke('history_read', { rel }); } catch { return null; }
        },
        async write(rel, data) {
          const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
            : typeof data === 'string' ? new TextEncoder().encode(data)
            : new Uint8Array(data);
          await invoke('history_write', bytes, { headers: { 'x-rel': rel } });
        },
        async remove(rel) { await invoke('history_remove', { rel }); },
        async list() { return await invoke('history_list'); },
        async stats() { return await invoke('history_stats'); },
      },

      /** アプリ全体の設定。%APPDATA%\com.layerdeck.desktop\settings.json */
      async loadSettings() {
        const s = await invoke('load_settings');
        try { return s ? JSON.parse(s) : null; } catch { return null; }
      },
      async saveSettings(obj) { await invoke('save_settings', { json: JSON.stringify(obj) }); },

      async saveExport(name, blob) {
        const outDir = await invoke('prepare_export');   // _export を Rust 側で作ってもらう
        const path = join(outDir, name);
        await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
        lastExport = path;
        return path;
      },

      /**
       * エクスプローラーで表示する。フォルダそのものではなく中のファイルを選んだ状態で開く
       * （Tauri の既定の権限で許されているのが「ファイルをフォルダ内で表示」なので）。
       */
      async reveal(kind) {
        let target = null;
        if (kind === 'export') target = lastExport;
        else if (kind === 'log') target = await invoke('log_path');
        else {
          const dir = await needDir();
          target = curFiles.length ? join(dir, curFiles[0].name) : dir;
        }
        if (target && opener) await opener.revealItemInDir(target);
      },

      log(line) { invoke('append_log', { line }).catch(() => {}); },
      async version() { return await T.app.getVersion(); },
      async setTitle(title) {
        try { await T.window.getCurrentWindow().setTitle(title); } catch { /* 無くても困らない */ }
      },

      onChange(cb) { event.listen('files-changed', () => cb()); },
    };
  }

  window.Backend = T && T.core ? makeTauriBackend() : httpBackend;
})();
