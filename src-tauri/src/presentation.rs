use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
fn refresh(window: &tauri::WebviewWindow, scale: f64) {
    let _ = window.with_webview(move |platform| unsafe {
        use objc2::{ClassType, msg_send};
        use objc2_app_kit::{NSScrollElasticity, NSScrollView, NSView};
        fn update(view: &NSView, scale: f64) {
            unsafe {
                let is_scroll: bool = msg_send![view, isKindOfClass: NSScrollView::class()];
                if is_scroll {
                    let scroll = &*(view as *const NSView).cast::<NSScrollView>();
                    scroll.setHasVerticalScroller(false);
                    scroll.setHasHorizontalScroller(false);
                    scroll.setAutohidesScrollers(true);
                    scroll.setVerticalScrollElasticity(NSScrollElasticity::None);
                    scroll.setHorizontalScrollElasticity(NSScrollElasticity::None);
                }
                if let Some(layer) = view.layer() { layer.setContentsScale(scale); layer.setNeedsDisplay(); }
                view.setNeedsDisplay(true);
                for child in view.subviews().iter() { update(&child, scale); }
            }
        }
        let view: &NSView = &*platform.inner().cast();
        view.viewDidChangeBackingProperties();
        update(view, scale);
    });
}

#[cfg(not(target_os = "macos"))]
fn refresh(_window: &tauri::WebviewWindow, _scale: f64) {}

pub fn initialize(app: &mut tauri::App) {
    if let Some(window) = app.get_webview_window("main") { refresh(&window, window.scale_factor().unwrap_or(1.0)); }
}

pub fn scale_changed(window: &tauri::Window, scale: f64) {
    if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
        refresh(&webview, scale);
        let _ = webview.emit("pure://display-changed", scale);
    }
}

#[tauri::command]
pub fn refresh_display(window: tauri::WebviewWindow) { refresh(&window, window.scale_factor().unwrap_or(1.0)); }
