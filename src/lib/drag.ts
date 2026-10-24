import type { PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { hasTauri } from "../store/settings";

/**
 * Native window drag from any press inside a "drag region" element, including
 * presses that land on nested children. Tauri's built-in
 * `data-tauri-drag-region` only fires when the *exact* target carries the
 * attribute, so clicking the clock digits / to-do text never dragged — this
 * handler accepts the whole surface instead.
 *
 * Presses on interactive controls (buttons, inputs, selects, links or any
 * element marked `data-no-drag`) are ignored so widgets stay usable.
 */
export function dragHandle(e: ReactPointerEvent) {
  if (!hasTauri() || e.button !== 0) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest("button, input, select, textarea, a, [data-no-drag]")) return;
  e.preventDefault();
  void getCurrentWebviewWindow().startDragging();
}
