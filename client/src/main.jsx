import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import RootApp from "./RootApp.jsx";
import { AuthProvider } from "./auth/AuthContext.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <RootApp />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
