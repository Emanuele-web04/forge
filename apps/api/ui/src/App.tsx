// FILE: ui/src/App.tsx
// Purpose: Route table for the ceremony pages.
// Layer: Account UI routing
// Depends on: react-router-dom, page components.

import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Callback } from "./pages/Callback";
import { Device } from "./pages/Device";
import { NotFound } from "./pages/NotFound";
import { ResetPassword } from "./pages/ResetPassword";
import { SignIn } from "./pages/SignIn";
import { SignUp } from "./pages/SignUp";
import { VerifyEmail } from "./pages/VerifyEmail";

export function App(): ReactNode {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<SignIn />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/device" element={<Device />} />
      <Route path="/callback" element={<Callback />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
