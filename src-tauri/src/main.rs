// Windows のリリースビルドで余計なコンソール窓を出さないための指定
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    layerdeck_lib::run()
}
