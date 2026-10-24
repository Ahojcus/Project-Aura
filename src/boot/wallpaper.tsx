import { createRoot } from "react-dom/client";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";
import "../styles/wallpaper.css";
import { WallpaperLayer } from "../modules/wallpaper/WallpaperLayer";

void setupSettingsSync("wallpaper");

createRoot(document.getElementById("root")!).render(<WallpaperLayer />);
