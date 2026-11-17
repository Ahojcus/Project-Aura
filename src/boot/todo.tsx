import { createRoot } from "react-dom/client";
import { TodoModule } from "../modules/todo/TodoModule";
import { setupSettingsSync } from "../lib/sync";
import "../styles/base.css";

document.body.dataset.module = "todo";

void setupSettingsSync("todo").then(() => {
  createRoot(document.getElementById("root")!).render(<TodoModule />);
});
