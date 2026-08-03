// FILE: ui/src/main.tsx
// Purpose: Browser entry point for the account ceremony UI.
// Layer: Account UI entry
// Depends on: React DOM, react-router-dom.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
