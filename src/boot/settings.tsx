import { createRoot } from "react-dom/client";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";
import { SettingsApp } from "../modules/settings/SettingsApp";
import "../modules/settings/settings.css";

void setupSettingsSync();

createRoot(document.getElementById("root")!).render(<SettingsApp />);
