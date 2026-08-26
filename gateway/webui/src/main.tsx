import { render } from "preact";
import "./styles/tokens/design-foundation-v2.css";
import "./styles/tokens/compatibility.css";
import "./styles/components.css";
import "./components/common/foundation.css";
import "./components/settings/settings-shell.css";
import "./components/settings/sidebar/sidebar.css";
import "./components/settings/apply-bar/apply-bar.css";
import "./components/settings/panes/panes.css";
import "./components/common/dialog.css";
import "./components/chat/chat-messages.css";
import "./components/sessions/drawer.css";
import "./components/permission/permission-dialog.css";
import { App } from "./app.tsx";

function init(): void {
  const appRoot = document.getElementById("app");
  if (!appRoot) throw new Error("Root #app element not found");
  render(<App />, appRoot);
}

init();
