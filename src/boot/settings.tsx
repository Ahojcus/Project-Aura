import { createRoot } from "react-dom/client";
import { SettingsApp } from "../modules/settings/SettingsApp";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";

document.body.dataset.module = "settings";

void setupSettingsSync().then(() => {
  createRoot(document.getElementById("root")!).render(<SettingsApp />);
});
