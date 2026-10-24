use windows::core::{PCWSTR, w};
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, FindWindowW, GetAncestor, GetClassNameW, GetWindowLongPtrW, GetWindowRect,
    SetParent, SetWindowLongPtrW, SetWindowPos, EnumWindows, SendMessageTimeoutW,
    GWL_EXSTYLE, GWL_STYLE, GA_PARENT, HWND_BOTTOM, SMTO_NORMAL, SWP_FRAMECHANGED, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_CHILD, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_THICKFRAME,
};

const WM_SPAWN_WORKER: u32 = 0x052C;

std::thread_local! {
    static DEFVIEW_PARENT: std::cell::Cell<isize> = const { std::cell::Cell::new(0) };
}

unsafe fn class_name(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    let mut buf = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut buf);
    if n <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..n as usize]))
}

unsafe fn first_child(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    let child = windows::Win32::UI::WindowsAndMessaging::GetWindow(hwnd, windows::Win32::UI::WindowsAndMessaging::GW_CHILD).ok()?;
    class_name(child)
}

unsafe extern "system" fn enum_proc(
    hwnd: windows::Win32::Foundation::HWND,
    _lparam: LPARAM,
) -> windows::Win32::Foundation::BOOL {
    if let Some(name) = class_name(hwnd) {
        if name == "SHELLDLL_DefView" {
            let parent = GetAncestor(hwnd, GA_PARENT);
            if class_name(parent).as_deref() == Some("WorkerW") {
                DEFVIEW_PARENT.with(|c| c.set(parent.0 as isize));
                return false.into();
            }
        }
    }
    true.into()
}

/// Either embed the wallpaper webview behind the desktop icons (inside the
/// "second" WorkerW created via the Progman 0x052C trick) or restore it.
/// Returns true on success.
pub fn set_embedded(hwnd: windows::Win32::Foundation::HWND, embed: bool) -> bool {
    unsafe {
        if embed {
            do_embed(hwnd)
        } else {
            do_unembed(hwnd)
        }
    }
}

unsafe fn do_embed(hwnd: windows::Win32::Foundation::HWND) -> bool {
    let Ok(progman) = FindWindowW(w!("Progman"), PCWSTR::null()) else {
        return false;
    };
    // Ask Progman to spawn the wallpaper WorkerW.
    let _ = SendMessageTimeoutW(progman, WM_SPAWN_WORKER, WPARAM(0), LPARAM(0), SMTO_NORMAL, 1000, None);

    // Find the WorkerW that holds SHELLDLL_DefView (the icons layer).
    DEFVIEW_PARENT.with(|c| c.set(0));
    let _ = EnumWindows(Some(enum_proc), LPARAM(0));
    let keeper_raw = DEFVIEW_PARENT.with(|c| c.get());
    if keeper_raw == 0 {
        return false;
    }
    let keeper = windows::Win32::Foundation::HWND(keeper_raw as *mut core::ffi::c_void);

    // The wallpaper WorkerW is a sibling "WorkerW" that has no SHELLDLL_DefView child.
    let mut target = windows::Win32::Foundation::HWND(core::ptr::null_mut());
    let mut cur = keeper;
    loop {
        let Ok(next) = FindWindowExW(HWND(core::ptr::null_mut()), cur, w!("WorkerW"), PCWSTR::null()) else {
            break;
        };
        if next.0.is_null() {
            break;
        }
        match first_child(next) {
            Some(name) if name == "SHELLDLL_DefView" => cur = next,
            _ => {
                target = next;
                break;
            }
        }
    }
    if target.0.is_null() {
        return false;
    }

    // Make the wallpaper window a child of the wallpaper WorkerW.
    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    let clear = (WS_CAPTION.0 | WS_THICKFRAME.0) as isize;
    let new_style = (style & !clear) | (WS_CHILD.0 as isize);
    SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);
    // OS-level click-through: an embedded wallpaper must never take mouse
    // input (drag/click/steal focus) — it is a backdrop, not an app. Webview
    // ignore-cursor-events also does this, but latch it in the Win32 style so
    // nothing can re-enable interaction by touching the window later.
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    let ex_add = (WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0) as isize;
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | ex_add) as _);
    let _ = SetParent(hwnd, target);
    let mut rect = RECT::default();
    if GetWindowRect(target, &mut rect).is_err() {
        return false;
    }
    let cx = (rect.right - rect.left).max(1);
    let cy = (rect.bottom - rect.top).max(1);
    let _ = SetWindowPos(
        hwnd,
        HWND_BOTTOM,
        0,
        0,
        cx,
        cy,
        SWP_FRAMECHANGED | SWP_NOACTIVATE,
    );
    true
}

unsafe fn do_unembed(hwnd: windows::Win32::Foundation::HWND) -> bool {
    let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    if style & (WS_CHILD.0 as isize) == 0 {
        // Not currently a child of the desktop worker; nothing to do.
        return true;
    }
    SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_CHILD.0 as isize));
    // Drop the click-through/no-activate EX styles so an *un*embedded wallpaper
    // window behaves like a normal (but pinned) window again.
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    let ex_clear = (WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0) as isize;
    if ex & ex_clear != 0 {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex & !ex_clear) as _);
        let _ = SetWindowPos(
            hwnd,
            windows::Win32::Foundation::HWND::default(),
            0,
            0,
            0,
            0,
            SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_NOACTIVATE,
        );
    }
    let _ = SetParent(hwnd, windows::Win32::Foundation::HWND::default());
    let _ = SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE);
    true
}
