const SERVICE: &str = "jp.pure.editor.dropbox-paper";
const ACCOUNT: &str = "oauth";
#[tauri::command]
pub fn read_paper_auth() -> Result<String, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        match security_framework::passwords::get_generic_password(SERVICE, ACCOUNT) {
            Ok(bytes) => String::from_utf8(bytes).map_err(|_| "Dropbox の接続情報を読めませんでした。".into()),
            Err(error) if error.code() == -25300 => Ok(String::new()),
            Err(_) => Err("Dropbox のキーチェーンにアクセスできませんでした。".into()),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    { Ok(String::new()) }
}
#[tauri::command]
pub fn write_paper_auth(value: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if value.is_empty() {
            return match security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == -25300 => Ok(()),
                Err(_) => Err("Dropbox の接続情報を削除できませんでした。".into()),
            };
        }
        security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, value.as_bytes())
            .map_err(|_| "Dropbox の接続情報をキーチェーンに保存できませんでした。".into())
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    { if value.is_empty() { Ok(()) } else { Err("Dropbox Paper は macOS と iOS で利用できます。".into()) } }
}
