import { createRoot } from "react-dom/client";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";
import "../styles/widgets.css";
import { TodoModule } from "../modules/todo/TodoModule";

void setupSettingsSync("todo");

createRoot(document.getElementById("root")!).render(<TodoModule />);
