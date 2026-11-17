/**
 * Overlay modules are part of the desktop surface, not a browser tab. Their
 * WebView2 default context menu (Reload, Save as, Inspect, …) is not part of
 * the product, so right-click must not open it anywhere on those pages.
 *
 * Settings keeps its normal context menu so text fields still offer cut/copy/
 * paste.
 */
export function disableModuleContextMenu() {
  if (typeof document === "undefined") return;
  document.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
    },
    { capture: true },
  );
}
