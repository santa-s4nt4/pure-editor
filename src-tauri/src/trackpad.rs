#[tauri::command]
pub fn double_click_interval() -> f64 {
    #[cfg(target_os = "macos")]
    { objc2_app_kit::NSEvent::doubleClickInterval() * 1000.0 }
    #[cfg(not(target_os = "macos"))]
    { 500.0 }
}
