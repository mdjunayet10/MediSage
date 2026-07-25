import { Navigate, Route, Routes, useParams } from "react-router-dom";
import App from "./App.jsx";
import { useAuth } from "./auth/AuthContext.jsx";
import {
  ForgotPasswordPage,
  RegisteredAccountRoute,
  SignInPage,
  SignUpPage,
  VerifyEmailPage,
} from "./pages/AuthPages.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

function ChatRoute() {
  const { user, loading, isGuest, isRegisteredUser, signOutUser, hasPendingGuestMigration, resolveGuestMigration } = useAuth();
  const { conversationId } = useParams();
  if (loading || !user)
    return <main className="workspace-loading" aria-label="Opening MediSage"><div className="workspace-loading-sidebar" /><div className="workspace-loading-main"><span /><span /><span /></div></main>;
  return <App key={user.uid} user={user} isGuest={isGuest} isRegisteredUser={isRegisteredUser} onSignOut={signOutUser} routeConversationId={conversationId} hasPendingGuestMigration={hasPendingGuestMigration} onResolveGuestMigration={resolveGuestMigration} />;
}

export default function RootApp() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route path="/login" element={<SignInPage />} />
      <Route path="/signup" element={<SignUpPage />} />
      <Route path="/register" element={<SignUpPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/" element={<ChatRoute />} />
      <Route path="/app" element={<ChatRoute />} />
      <Route path="/app/chat/:conversationId" element={<ChatRoute />} />
      <Route
        path="/app/settings"
        element={
          <RegisteredAccountRoute>
            <SettingsPage />
          </RegisteredAccountRoute>
        }
      />
      <Route path="/account" element={<RegisteredAccountRoute><SettingsPage /></RegisteredAccountRoute>} />
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
