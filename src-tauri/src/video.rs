use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Mutex,
    time::Duration,
};

pub struct VideoServer {
    origin: String,
    token: String,
}

// WebKit のカスタムスキームからは HTTP Referer が送られない。
// ループバック上の小さな HTML にプレイヤーを置き、通常の iframe と同じ
// 参照元を送る。ノートやファイルを配信する経路は持たない。
impl VideoServer {
    fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|_| "動画プレイヤーを準備できませんでした。")?;
        let address = listener.local_addr().map_err(|_| "動画のアドレスを取得できませんでした。")?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| "動画プレイヤーを初期化できませんでした。")?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let prefix = format!("/{token}/youtube/");
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let _ = serve(&mut stream, &prefix);
            }
        });
        Ok(Self { origin: format!("http://{address}"), token })
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn serve(stream: &mut TcpStream, prefix: &str) -> std::io::Result<()> {
    let mut request = [0; 8192];
    let mut count = 0;
    while count < request.len() {
        let received = stream.read(&mut request[count..])?;
        if received == 0 { break; }
        count += received;
        if request[..count].windows(4).any(|part| part == b"\r\n\r\n") { break; }
    }
    let line = String::from_utf8_lossy(&request[..count]);
    let mut parts = line.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let id = path.strip_prefix(prefix).unwrap_or("");
    let (status, body) = if method == "GET" && valid_id(id) {
        ("200 OK", include_str!("video.html").replace("{{VIDEO_ID}}", id))
    } else {
        ("404 Not Found", String::from("Not Found"))
    };
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nContent-Security-Policy: default-src 'none'; frame-src https://www.youtube-nocookie.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\r\nConnection: close\r\n\r\n{body}", body.len())?;
    stream.flush()
}

#[tauri::command]
pub fn video_url(id: String, state: tauri::State<'_, Mutex<Option<VideoServer>>>) -> Result<String, String> {
    if !valid_id(&id) { return Err("動画 ID が不正です。".into()); }
    let mut server = state.lock().map_err(|_| "動画プレイヤーを利用できませんでした。")?;
    if server.is_none() { *server = Some(VideoServer::start()?); }
    let server = server.as_ref().ok_or("動画プレイヤーを起動できませんでした。")?;
    Ok(format!("{}/{}/youtube/{id}", server.origin, server.token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_video_ids_are_accepted() {
        assert!(valid_id("M7lc1UVf-VE"));
        assert!(!valid_id("../notes.md"));
        assert!(!valid_id("<script>x</script>"));
    }

    #[test]
    fn serves_only_the_player_document() {
        let server = VideoServer::start().unwrap();
        let address = server.origin.strip_prefix("http://").unwrap();
        for (path, expected) in [(format!("/{}/youtube/M7lc1UVf-VE", server.token), "200 OK"), (String::from("/settings.json"), "404 Not Found")] {
            let mut stream = TcpStream::connect(address).unwrap();
            write!(stream, "GET {path} HTTP/1.1\r\nHost: {address}\r\n\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            assert!(response.contains(expected));
            if expected == "200 OK" { assert!(response.contains("youtube-nocookie.com/embed/M7lc1UVf-VE")); }
        }
    }
}
