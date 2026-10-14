import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AppProviders } from "./app/AppProviders";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/auth.css";
import "./styles/workbench.css";
import "./styles/project-center.css";
import "./styles/profile.css";
import "./styles/membership.css";
import "./styles/settings.css";
import "./styles/skills.css";
import "./styles/community.css";
import "./styles/theme-dark.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </React.StrictMode>,
);
