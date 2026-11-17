import { createRoot } from "react-dom/client";
import { NotchApp } from "../modules/notch/NotchApp";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";

document.body.dataset.module = "notch";

void setupSettingsSync("notch").then(() => {
  createRoot(document.getElementById("root")!).render(<NotchApp />);
});
