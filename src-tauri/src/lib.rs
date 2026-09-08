//! LayerDeck - 透過PNG リアルタイム重ね合わせプレビュー
//!
//! Rust 側の役割は少ない。監視フォルダの管理、ファイル一覧、空き物理メモリの実測、
//! プロジェクト設定の読み書き、そしてフォルダの中身が変わったことの通知だけ。
//! 画像の読み書きと合成はすべて WebView 側（ui/app.js, ui/tiler.js）が行う。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_fs::FsExt;

const PROJECT_NAME: &str = "layerdeck.project.json";
const IMAGE_EXTS: [&str; 6] = ["png", "webp", "jpg", "jpeg", "gif", "bmp"];
/// フォルダの中身を見に行く間隔。OS の変更通知は書き込み途中にも飛んでくるうえ
/// ネットワークドライブで取りこぼすことがあるので、素直に見に行くほうが確実。
const WATCH_INTERVAL: Duration = Duration::from_millis(300);

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
    // WebView から読み書きしてよい場所として、このフォルダだけを許可する
    app.fs_scope()
        .allow_directory(&path, true)
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
    let dir = state
        .dir
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "フォルダ未選択".to_string())?;
    // 書きかけが読まれないよう、一時ファイルに書いてから差し替える
    let tmp = dir.join(format!("{PROJECT_NAME}.tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(PROJECT_NAME)).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            write_project
        ])
        .setup(|app| {
            let handle = app.handle().clone();

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
