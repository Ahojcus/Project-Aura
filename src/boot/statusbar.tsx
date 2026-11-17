import { createRoot } from "react-dom/client";
import { StatusbarApp } from "../modules/statusbar/StatusbarApp";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";

document.body.dataset.module = "statusbar";

void setupSettingsSync("statusbar").then(() => {
  createRoot(document.getElementById("root")!).render(<StatusbarApp />);
});
