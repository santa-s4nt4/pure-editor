use tauri::ipc::{InvokeBody, Request, Response};

fn encode(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || width > 1600 || height > 1600 || pixels.len() != width as usize * height as usize * 4 {
        return Err("画像のサイズが不正です。".into());
    }
    webp::Encoder::from_rgba(pixels, width, height)
        .encode_simple(false, 85.0)
        .map(|bytes| bytes.to_vec())
        .map_err(|_| "画像を WebP に変換できませんでした。".into())
}

#[tauri::command]
pub fn encode_webp(request: Request<'_>) -> Result<Response, String> {
    let dimension = |name| request.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u32>().ok()).ok_or_else(|| "画像サイズを取得できませんでした。".to_string());
    let width = dimension("x-image-width")?;
    let height = dimension("x-image-height")?;
    match request.body() {
        InvokeBody::Raw(bytes) => encode(bytes, width, height).map(Response::new),
        _ => Err("画像データを読み込めませんでした。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn creates_real_webp_from_rgba() {
        let bytes = encode(&[255, 0, 0, 255, 0, 0, 0, 0], 2, 1).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        let decoded = webp::Decoder::new(&bytes).decode().unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2, 1));
    }
    #[test]
    fn rejects_invalid_pixels() {
        assert!(encode(&[0, 1], 1600, 1600).is_err());
        assert!(encode(&[], 0, 0).is_err());
    }
}
