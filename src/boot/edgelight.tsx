import { createRoot } from "react-dom/client";
import { EdgeLightApp } from "../modules/edgelight/EdgeLightApp";
import { disableModuleContextMenu } from "../lib/contextMenu";
import "../styles/base.css";

document.body.dataset.module = "edgelight";
disableModuleContextMenu();

createRoot(document.getElementById("root")!).render(<EdgeLightApp />);
