import { createRoot } from "react-dom/client";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";
import "../styles/widgets.css";
import { ClockModule } from "../modules/clock/ClockModule";

void setupSettingsSync("clock");

createRoot(document.getElementById("root")!).render(<ClockModule />);
