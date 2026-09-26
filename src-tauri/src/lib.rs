//! LayerDeck - 透過PNG リアルタイム重ね合わせプレビュー
//!
//! Rust 側の役割は少ない。監視フォルダの管理、ファイル一覧、空き物理メモリの実測、
//! プロジェクト設定の読み書き、フォルダの中身が変わったことの通知、ログの記録だけ。
//! 画像の読み書きと合成はすべて WebView 側（ui/app.js, ui/tiler.js）が行う。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_fs::FsExt;

const PROJECT_NAME: &str = "layerdeck.project.json";
const EXPORT_DIR: &str = "_export";
const IMAGE_EXTS: [&str; 6] = ["png", "webp", "jpg", "jpeg", "gif", "bmp"];
/// フォルダの中身を見に行く間隔。OS の変更通知は書き込み途中にも飛んでくるうえ
/// ネットワークドライブで取りこぼすことがあるので、素直に見に行くほうが確実。
const WATCH_INTERVAL: Duration = Duration::from_millis(300);
/// ログがこれを超えたら 1 世代だけ残して新しくする
const LOG_LIMIT: u64 = 1_000_000;

#[derive(Default)]
struct AppState {
    dir: Mutex<Option<PathBuf>>,
}

#[derive(Serialize, Clone, PartialEq)]
struct FileInfo {
    name: String,
    mtime: u64,
    size: u64,
}

#[derive(Serialize, Clone)]
struct MemInfo {
    total: u64,
    avail: u64,
}

#[derive(Serialize)]
struct StateInfo {
    dir: Option<String>,
    sep: String,
    files: Vec<FileInfo>,
    project: Option<serde_json::Value>,
    mem: Option<MemInfo>,
}

// ---------------------------------------------------------------------
// 空き物理メモリ（タイル保持量の自動調整に使う）
// ---------------------------------------------------------------------
#[cfg(windows)]
mod sysmem {
    #[repr(C)]
    pub struct MemoryStatusEx {
        pub dw_length: u32,
        pub dw_memory_load: u32,
        pub ull_total_phys: u64,
        pub ull_avail_phys: u64,
        pub ull_total_page_file: u64,
        pub ull_avail_page_file: u64,
        pub ull_total_virtual: u64,
        pub ull_avail_virtual: u64,
        pub ull_avail_extended_virtual: u64,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }

    pub fn status() -> Option<(u64, u64)> {
        let mut m = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            dw_memory_load: 0,
            ull_total_phys: 0,
            ull_avail_phys: 0,
            ull_total_page_file: 0,
            ull_avail_page_file: 0,
            ull_total_virtual: 0,
            ull_avail_virtual: 0,
            ull_avail_extended_virtual: 0,
        };
        if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 {
            Some((m.ull_total_phys, m.ull_avail_phys))
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
mod sysmem {
    pub fn status() -> Option<(u64, u64)> {
        // Linux: /proc/meminfo
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        let mut total = None;
        let mut avail = None;
        for line in text.lines() {
            let (k, v) = line.split_once(':')?;
            let kb: u64 = v.trim().split_whitespace().next()?.parse().ok()?;
            match k {
                "MemTotal" => total = Some(kb * 1024),
                "MemAvailable" => avail = Some(kb * 1024),
                _ => {}
            }
        }
        Some((total?, avail.unwrap_or(0)))
    }
}

fn mem_info() -> Option<MemInfo> {
    sysmem::status().map(|(total, avail)| MemInfo { total, avail })
}

// ---------------------------------------------------------------------
// フォルダの中身
// ---------------------------------------------------------------------
fn list_images(dir: &Path) -> Vec<FileInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !is_image {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        out.push(FileInfo { name, mtime, size: meta.len() });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn read_project(dir: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(dir.join(PROJECT_NAME)).ok()?;
    serde_json::from_str(&text).ok()
}

fn snapshot(state: &AppState) -> StateInfo {
    let dir = state.dir.lock().unwrap().clone();
    StateInfo {
        sep: std::path::MAIN_SEPARATOR.to_string(),
        files: dir.as_deref().map(list_images).unwrap_or_default(),
        project: dir.as_deref().and_then(read_project),
        dir: dir.map(|d| d.to_string_lossy().into_owned()),
        mem: mem_info(),
    }
}

fn current(state: &AppState) -> Result<PathBuf, String> {
    state
        .dir
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "フォルダ未選択".to_string())
}

// ---------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------
#[tauri::command]
fn get_state(state: State<'_, AppState>) -> StateInfo {
    snapshot(&state)
}

#[tauri::command]
fn current_dir(state: State<'_, AppState>) -> Option<String> {
    state
        .dir
        .lock()
        .unwrap()
        .as_ref()
        .map(|d| d.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_files(state: State<'_, AppState>) -> Vec<FileInfo> {
    let dir = state.dir.lock().unwrap().clone();
    dir.as_deref().map(list_images).unwrap_or_default()
}

#[tauri::command]
fn mem_status() -> Option<MemInfo> {
    mem_info()
}

/// 前回開いていたフォルダの記録先
fn last_dir_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("last_dir.txt"))
}

fn apply_dir(app: &tauri::AppHandle, state: &AppState, path: PathBuf) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("フォルダが見つかりません: {}", path.display()));
    }
    // WebView から触れてよい場所を最小限にする:
    //   ・作業フォルダの直下（パーツPNGを読む）
    //   ・その中の _export（確認用の書き出しを書く）
    // 下の階層までは許可しない。うっかり C:\ などを選んでも、ドライブ全体を開けない。
    let scope = app.fs_scope();
    scope.allow_directory(&path, false).map_err(|e| e.to_string())?;
    scope
        .allow_directory(path.join(EXPORT_DIR), false)
        .map_err(|e| e.to_string())?;
    *state.dir.lock().unwrap() = Some(path);
    Ok(())
}

#[tauri::command]
fn set_dir(app: tauri::AppHandle, state: State<'_, AppState>, dir: String) -> Result<StateInfo, String> {
    apply_dir(&app, &state, PathBuf::from(&dir))?;
    // 次に開いたときも同じフォルダで始められるように覚えておく
    if let Some(f) = last_dir_file(&app) {
        let _ = std::fs::write(f, &dir);
    }
    Ok(snapshot(&state))
}

#[tauri::command]
fn write_project(state: State<'_, AppState>, json: String) -> Result<(), String> {
    let dir = current(&state)?;
    // 書きかけが読まれないよう、一時ファイルに書いてから差し替える
    let tmp = dir.join(format!("{PROJECT_NAME}.tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(PROJECT_NAME)).map_err(|e| e.to_string())
}

/// 確認用の書き出し先（作業フォルダの _export）を用意して、その場所を返す。
/// フォルダを開いただけで _export ができてしまわないよう、書き出す直前に作る。
#[tauri::command]
fn prepare_export(state: State<'_, AppState>) -> Result<String, String> {
    let out = current(&state)?.join(EXPORT_DIR);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------
// ログ（不具合が起きたときに状況を追えるように）
// ---------------------------------------------------------------------
fn log_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("layerdeck.log"))
}

/// 1 行追記する。日時は画面側が現地時刻で付けて渡す（Rust の標準機能には時差の情報がないため）。
#[tauri::command]
fn append_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    let f = log_file(&app).ok_or("ログの置き場所を作れません")?;
    if std::fs::metadata(&f).map(|m| m.len() > LOG_LIMIT).unwrap_or(false) {
        let _ = std::fs::rename(&f, f.with_file_name("layerdeck.old.log"));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&f)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", line.replace(['\r', '\n'], " ")).map_err(|e| e.to_string())
}

#[tauri::command]
fn log_path(app: tauri::AppHandle) -> Option<String> {
    let f = log_file(&app)?;
    if !f.exists() {
        let _ = std::fs::File::create(&f);
    }
    Some(f.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------
// WebView2 の「ブラウザらしさ」を消す
// ---------------------------------------------------------------------
/// 既定の右クリックメニュー（戻る・最新の情報に更新・印刷…）と、
/// ブラウザのショートカット（F5 で再読み込み、Ctrl+P で印刷、Ctrl+F で検索…）を止める。
/// どちらも WebView2 の既定では有効で、Tauri の設定からは変えられない。
#[cfg(windows)]
fn harden_webview(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;
    let _ = window.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
}

#[cfg(not(windows))]
fn harden_webview(_window: &tauri::WebviewWindow) {}

// ---------------------------------------------------------------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 二重起動したら新しく開かず、今ある窓を前に出す（同じ設定ファイルを取り合わないように）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // ウィンドウの大きさと位置を覚える
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_state,
            current_dir,
            list_files,
            mem_status,
            set_dir,
            write_project,
            prepare_export,
            append_log,
            log_path
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            if let Some(w) = app.get_webview_window("main") {
                harden_webview(&w);
            }

            // 前回開いていたフォルダがあれば、そのまま復帰する
            if let Some(saved) = last_dir_file(&handle)
                .and_then(|f| std::fs::read_to_string(f).ok())
                .map(|s| PathBuf::from(s.trim()))
            {
                let _ = apply_dir(&handle, &handle.state::<AppState>(), saved);
            }

            std::thread::spawn(move || {
                let mut last: Vec<FileInfo> = Vec::new();
                loop {
                    std::thread::sleep(WATCH_INTERVAL);
                    let state = handle.state::<AppState>();
                    let dir = state.dir.lock().unwrap().clone();
                    let Some(dir) = dir else {
                        last.clear();
                        continue;
                    };
                    let now = list_images(&dir);
                    if now != last {
                        last = now;
                        let _ = handle.emit("files-changed", ());
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("LayerDeck の起動に失敗しました");
}
