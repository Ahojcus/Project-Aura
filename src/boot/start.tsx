import { createRoot } from "react-dom/client";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";
import "../styles/widgets.css";
import { StartApp } from "../modules/start/StartApp";
import "../modules/start/start.css";

void setupSettingsSync("start");

createRoot(document.getElementById("root")!).render(<StartApp />);
