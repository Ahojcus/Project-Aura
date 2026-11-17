import { createRoot } from "react-dom/client";
import { WallpaperLayer } from "../modules/wallpaper/WallpaperLayer";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";

document.body.dataset.module = "wallpaper";

void setupSettingsSync("wallpaper").then(() => {
  createRoot(document.getElementById("root")!).render(<WallpaperLayer />);
});
