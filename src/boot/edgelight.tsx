import { createRoot } from "react-dom/client";
import { EdgeLightApp } from "../modules/edgelight/EdgeLightApp";
import { disableModuleContextMenu } from "../lib/contextMenu";
import { hydrateSharedSettings } from "../store/settings";
import "../styles/base.css";

document.body.dataset.module = "edgelight";
disableModuleContextMenu();

void hydrateSharedSettings().then(() => {
  createRoot(document.getElementById("root")!).render(<EdgeLightApp />);
});
