//! External file drops with `dragDropEnabled: false`.
//!
//! Tauri's built-in drop handler must be disabled on Windows so HTML5 drag and
//! drop works inside the page (it replaces WebView2's `IDropTarget`). The
//! trade-off: OS file drops then reach the page as DOM drops whose `File`
//! objects carry no absolute path. The frontend forwards the dropped `File`
//! objects to the host via `chrome.webview.postMessageWithAdditionalObjects`
//! with a private prefix; this handler reads each `ICoreWebView2File`'s real
//! path and re-emits them as `creatora://external-file-drop`.

pub const EXT_DROP_EVENT: &str = "creatora://external-file-drop";
pub const MSG_PREFIX: &str = "__CREATORA_EXT_DROP__";

#[cfg(windows)]
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::{Emitter, Manager};
    use webview2_com::{
        take_pwstr, Microsoft::Web::WebView2::Win32::*, WebMessageReceivedEventHandler,
    };
    use windows_core::{Interface, PWSTR};

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let app_handle = app.clone();
    window.with_webview(move |platform| {
        unsafe {
            let core = match platform.controller().CoreWebView2() {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("external drop bridge: no CoreWebView2: {e}");
                    return;
                }
            };
            let mut token = 0i64;
            let _ = core.add_WebMessageReceived(
                &WebMessageReceivedEventHandler::create(Box::new(move |_wv, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    // All web messages flow through this event, including Tauri
                    // IPC — ignore everything that is not our prefixed drop.
                    let mut msg = PWSTR::null();
                    if args.TryGetWebMessageAsString(&mut msg).is_err() {
                        return Ok(());
                    }
                    let msg = take_pwstr(msg);
                    if !msg.starts_with(MSG_PREFIX) {
                        return Ok(());
                    }
                    let mut paths: Vec<String> = Vec::new();
                    if let Ok(args2) =
                        args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()
                    {
                        if let Ok(objects) = args2.AdditionalObjects() {
                            let mut count = 0u32;
                            let _ = objects.Count(&mut count);
                            for i in 0..count {
                                let Ok(obj) = objects.GetValueAtIndex(i) else {
                                    continue;
                                };
                                let Ok(file) = obj.cast::<ICoreWebView2File>() else {
                                    continue;
                                };
                                let mut p = PWSTR::null();
                                if file.Path(&mut p).is_ok() {
                                    let p = take_pwstr(p);
                                    if !p.is_empty() {
                                        paths.push(p);
                                    }
                                }
                            }
                        }
                    }
                    if !paths.is_empty() {
                        let _ = app_handle.emit(EXT_DROP_EVENT, paths);
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    })?;
    Ok(())
}

#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}
