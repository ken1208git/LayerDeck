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

// ---------------------------------------------------------------------
// アプリ全体の設定（縁取り表示の色など。作業フォルダをまたいで共通）
// ---------------------------------------------------------------------
fn settings_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Option<String> {
    settings_file(&app).and_then(|f| std::fs::read_to_string(f).ok())
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let f = settings_file(&app).ok_or("設定の置き場所を作れません")?;
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------
// 履歴（上書きされる前の版）
//   %LOCALAPPDATA%\com.layerdeck.desktop\history\<作業フォルダのID>\ に置く。
//   何を残すか・いつ消すかは画面側が決め、ここは読み書きと削除と大きさの集計だけ。
// ---------------------------------------------------------------------
fn history_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("history");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 履歴の中の場所。英数字と . _ - / だけを許し、履歴のフォルダの外へ出られないようにする
fn history_path(app: &tauri::AppHandle, rel: &str) -> Result<PathBuf, String> {
    let ok = !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.contains("..")
        && rel.chars().all(|c| c.is_ascii_alphanumeric() || "._-/".contains(c));
    if !ok {
        return Err(format!("履歴の場所として使えない名前です: {rel}"));
    }
    Ok(history_root(app)?.join(rel))
}

/// 画像のバイト列をそのまま受け取って書く（JSON に変換すると数MBの画像では重いため）
#[tauri::command]
fn history_write(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let rel = request
        .headers()
        .get("x-rel")
        .and_then(|v| v.to_str().ok())
        .ok_or("書き込む場所の指定がありません")?
        .to_owned();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("中身がバイト列ではありません".into());
    };
    let p = history_path(&app, &rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
fn history_read(app: tauri::AppHandle, rel: String) -> Result<tauri::ipc::Response, String> {
    let p = history_path(&app, &rel)?;
    std::fs::read(&p)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn history_remove(app: tauri::AppHandle, rel: String) -> Result<(), String> {
    let p = history_path(&app, &rel)?;
    let r = if p.is_dir() {
        std::fs::remove_dir_all(&p)
    } else {
        std::fs::remove_file(&p)
    };
    match r {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn dir_size(p: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(p) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

#[derive(Serialize)]
struct HistoryDir {
    id: String,
    bytes: u64,
}

/// 作業フォルダごとの履歴の一覧と、それぞれの大きさ
#[tauri::command]
fn history_list(app: tauri::AppHandle) -> Result<Vec<HistoryDir>, String> {
    let root = history_root(&app)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        if e.path().is_dir() {
            if let Some(id) = e.file_name().to_str() {
                out.push(HistoryDir { id: id.to_owned(), bytes: dir_size(&e.path()) });
            }
        }
    }
    Ok(out)
}

#[derive(Serialize)]
struct HistoryStats {
    used: u64,
    free: Option<u64>,
}

#[tauri::command]
fn history_stats(app: tauri::AppHandle) -> Result<HistoryStats, String> {
    let root = history_root(&app)?;
    Ok(HistoryStats { used: dir_size(&root), free: disk_free(&root) })
}

/// そのドライブの空き容量（このユーザーが使える分）
#[cfg(windows)]
fn disk_free(p: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
    (unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut total, &mut free) } != 0).then_some(avail)
}

#[cfg(not(windows))]
fn disk_free(_p: &Path) -> Option<u64> {
    None
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
// 窓を画面の作業領域（タスクバーを除いた範囲）に収める
// ---------------------------------------------------------------------
/// 前回の大きさと位置は window-state プラグインが復元するが、前回の形そのものが
/// はみ出していると毎回はみ出す（初期サイズ 1360×860 は作業領域 1440×852 の PC で潜る →
/// 閉じるとその形が保存される → 次も復元される）。
/// 前回の形はできるだけ残し、はみ出した分だけ縮めて、はみ出した分だけずらす。
///
/// 最大化中も「最大化を解除したときの形」を直す必要があるので、Tauri の API ではなく
/// Win32 の GetWindowPlacement / SetWindowPlacement で直接書き換える。
#[cfg(windows)]
mod winfit {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct WindowPlacement {
        length: u32,
        flags: u32,
        show_cmd: u32,
        pt_min_position: Point,
        pt_max_position: Point,
        rc_normal_position: Rect,
    }

    #[repr(C)]
    struct MonitorInfo {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        dw_flags: u32,
    }

    const MONITOR_DEFAULTTONEAREST: u32 = 2;

    #[link(name = "user32")]
    extern "system" {
        fn GetWindowPlacement(hwnd: *mut c_void, wp: *mut WindowPlacement) -> i32;
        fn SetWindowPlacement(hwnd: *mut c_void, wp: *const WindowPlacement) -> i32;
        fn MonitorFromWindow(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(monitor: *mut c_void, mi: *mut MonitorInfo) -> i32;
    }

    /// r を area に収める。area より大きい辺だけ縮め、はみ出している分だけずらす
    pub fn fit_rect(r: Rect, area: Rect) -> Rect {
        let w = (r.right - r.left).min(area.right - area.left);
        let h = (r.bottom - r.top).min(area.bottom - area.top);
        let x = r.left.clamp(area.left, area.right - w);
        let y = r.top.clamp(area.top, area.bottom - h);
        Rect { left: x, top: y, right: x + w, bottom: y + h }
    }

    /// first_launch: 保存された形が無い（初めての起動）。このときは作業領域の中央に置く
    pub fn fit(hwnd: *mut c_void, first_launch: bool) {
        unsafe {
            let mut wp: WindowPlacement = std::mem::zeroed();
            wp.length = std::mem::size_of::<WindowPlacement>() as u32;
            if GetWindowPlacement(hwnd, &mut wp) == 0 {
                return;
            }
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut mi: MonitorInfo = std::mem::zeroed();
            mi.cb_size = std::mem::size_of::<MonitorInfo>() as u32;
            if monitor.is_null() || GetMonitorInfoW(monitor, &mut mi) == 0 {
                return;
            }
            // rcNormalPosition は画面座標ではなく「ワークスペース座標」（タスクバーの分だけずらした座標）。
            // 作業領域をその座標で表すと、モニターの左上から作業領域の幅・高さを取った範囲になる。
            // タスクバーが下や右にあるときはずれが 0 なので、画面座標と同じ
            let (m, work) = (mi.rc_monitor, mi.rc_work);
            let area = Rect {
                left: m.left,
                top: m.top,
                right: m.left + (work.right - work.left),
                bottom: m.top + (work.bottom - work.top),
            };
            if area.right <= area.left || area.bottom <= area.top {
                return;
            }
            let mut fitted = fit_rect(wp.rc_normal_position, area);
            if first_launch {
                let (w, h) = (fitted.right - fitted.left, fitted.bottom - fitted.top);
                let x = area.left + (area.right - area.left - w) / 2;
                let y = area.top + (area.bottom - area.top - h) / 2;
                fitted = Rect { left: x, top: y, right: x + w, bottom: y + h };
            }
            if fitted != wp.rc_normal_position {
                wp.rc_normal_position = fitted;
                SetWindowPlacement(hwnd, &wp);
            }
        }
    }
}

#[cfg(windows)]
fn fit_into_work_area(w: &tauri::WebviewWindow, first_launch: bool) {
    if w.is_fullscreen().unwrap_or(false) {
        return;
    }
    if let Ok(hwnd) = w.hwnd() {
        winfit::fit(hwnd.0 as *mut std::ffi::c_void, first_launch);
    }
}

#[cfg(not(windows))]
fn fit_into_work_area(_w: &tauri::WebviewWindow, _first_launch: bool) {}

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
            log_path,
            load_settings,
            save_settings,
            history_write,
            history_read,
            history_remove,
            history_list,
            history_stats
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            if let Some(w) = app.get_webview_window("main") {
                harden_webview(&w);
                // 前回の大きさ・位置が復元されたあとで、画面からはみ出していないか直す。
                // 形の保存ファイルは終了時に作られるので、無ければ初めての起動
                let first_launch = handle
                    .path()
                    .app_config_dir()
                    .map(|d| !d.join(tauri_plugin_window_state::DEFAULT_FILENAME).exists())
                    .unwrap_or(false);
                fit_into_work_area(&w, first_launch);
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
