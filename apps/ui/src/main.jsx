import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";
import "./shell/forest.css";
import "./shell/glass.css";
import "./shell/panel-layout.css";

createRoot(document.getElementById("root")).render(<App />);
