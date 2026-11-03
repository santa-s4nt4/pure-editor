#[cfg(target_os = "macos")]
pub fn initialize(app: &tauri::App) {
    use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventPhase};
    use std::{cell::RefCell, ptr::NonNull};
    use tauri::{Emitter, Manager};
    thread_local! { static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) }; }
    let handle = app.handle().clone();
    let block = block2::RcBlock::new(move |pointer: NonNull<NSEvent>| -> *mut NSEvent {
        // Local monitors run on AppKit's main thread. Keep the original event for normal scrolling.
        let event = unsafe { pointer.as_ref() };
        let Some(mtm) = MainThreadMarker::new() else { return pointer.as_ptr(); };
        if !event.hasPreciseScrollingDeltas() { return pointer.as_ptr(); }
        let Some(native) = event.window(mtm) else { return pointer.as_ptr(); };
        for window in handle.webview_windows().values() {
            if window.ns_window().ok() != Some(Retained::as_ptr(&native).cast_mut().cast()) { continue; }
            let point = event.locationInWindow();
            let flags = event.modifierFlags();
            let _ = window.emit_to(window.label(), "pure://trackpad-scroll", serde_json::json!({
                "deltaX": -event.scrollingDeltaX(), "deltaY": -event.scrollingDeltaY(), "deltaMode": 0,
                "ctrlKey": flags.contains(NSEventModifierFlags::Control),
                "metaKey": flags.contains(NSEventModifierFlags::Command),
                "altKey": flags.contains(NSEventModifierFlags::Option),
                "shiftKey": flags.contains(NSEventModifierFlags::Shift),
                "began": event.phase().contains(NSEventPhase::Began),
                "momentum": event.momentumPhase() != NSEventPhase::None,
                "x": point.x, "yFromBottom": point.y
            }));
            break;
        }
        pointer.as_ptr()
    });
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &block) };
    MONITOR.with(|slot| *slot.borrow_mut() = monitor);
}
#[cfg(not(target_os = "macos"))]
pub fn initialize(_app: &tauri::App) {}

#[tauri::command]
pub fn double_click_interval() -> f64 {
    #[cfg(target_os = "macos")]
    { objc2_app_kit::NSEvent::doubleClickInterval() * 1000.0 }
    #[cfg(not(target_os = "macos"))]
    { 500.0 }
}
