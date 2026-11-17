import { useEffect } from "react";
import { applyCssTokens, useSettings } from "../../store/settings";

/**
 * Full-screen click-through glow. The native window is shown and hidden by the
 * notch's Edge light widget; this page only paints the animated border.
 */
export function EdgeLightApp() {
  const settings = useSettings((state) => state.settings);

  useEffect(() => {
    applyCssTokens(settings);
  }, [settings.theme, settings.accent]);

  return (
    <div className="edge-light-root" aria-hidden="true">
      <div className="edge-light-glow" />
      <div className="edge-light-inner" />
    </div>
  );
}
