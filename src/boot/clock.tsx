import { createRoot } from "react-dom/client";
import { ClockModule } from "../modules/clock/ClockModule";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";

document.body.dataset.module = "clock";

void setupSettingsSync("clock").then(() => {
  createRoot(document.getElementById("root")!).render(<ClockModule />);
});
