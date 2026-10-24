import { createRoot } from "react-dom/client";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";
import { NotchApp } from "../modules/notch/NotchApp";
import "../modules/notch/notch.css";

void setupSettingsSync("notch");

createRoot(document.getElementById("root")!).render(<NotchApp />);
