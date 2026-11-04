mod github_auth;
mod paper_auth;
mod trackpad;
const KEYCHAIN_SERVICE: &str = "jp.pure.editor.r2";
const KEYCHAIN_ACCOUNT: &str = "secret-access-key";
mod video;
mod images;
mod presentation;

#[tauri::command]
fn read_secret() -> Result<String, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(bytes) => String::from_utf8(bytes).map_err(|_| "アクセスキーを読み込めませんでした。".into()),
            Err(error) if error.code() == -25300 => Ok(String::new()),
            Err(_) => Err("キーチェーンにアクセスできませんでした。".into()),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Ok(String::new())
    }
}

#[tauri::command]
fn write_secret(secret: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if read_secret()? == secret {
            return Ok(());
        }
        if secret.is_empty() {
            return match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == -25300 => Ok(()),
                Err(_) => Err("アクセスキーを削除できませんでした。".into()),
            };
        }
        security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, secret.as_bytes())
            .map_err(|_| "アクセスキーをキーチェーンに保存できませんでした。".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        if secret.is_empty() { Ok(()) } else { Err("R2 同期は macOS と iOS で利用できます。".into()) }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Mutex::new(None::<video::VideoServer>))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| { presentation::initialize(app); trackpad::initialize(app); Ok(()) })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::ScaleFactorChanged { scale_factor, .. } = event {
                presentation::scale_changed(window, *scale_factor);
            }
        })
        .invoke_handler(tauri::generate_handler![read_secret, write_secret, github_auth::read_github_token, github_auth::write_github_token, video::video_url, images::encode_webp, presentation::refresh_display, trackpad::double_click_interval, paper_auth::read_paper_auth, paper_auth::write_paper_auth])
        .run(tauri::generate_context!())
        .expect("pure を起動できませんでした");
}
