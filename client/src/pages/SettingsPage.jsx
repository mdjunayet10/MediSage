import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";

export default function SettingsPage() {
  const { user, updateName, resetPassword, deleteAccount, signOutUser } =
    useAuth();
  const [name, setName] = useState(user?.displayName || "");
  const [theme, setTheme] = useState(
    localStorage.getItem("medisage-theme-v1") || "light",
  );
  const [language, setLanguage] = useState(
    localStorage.getItem(`medisage-language-${user?.uid}`) || "auto",
  );
  const [status, setStatus] = useState("");
  const navigate = useNavigate();
  return (
    <main className="settings-page">
      <section className="settings-card">
        <div className="settings-head">
          <div>
            <p>MediSage</p>
            <h1>Account settings</h1>
          </div>
          <Link to="/app">Back to chat</Link>
        </div>
        <div className="settings-group">
          <label>
            Display name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Email
            <input value={user?.email || ""} disabled />
          </label>
          <p>
            Email status: {user?.emailVerified ? "Verified" : "Not verified"}
          </p>
          <button
            onClick={() =>
              updateName(name.trim())
                .then(() => setStatus("Profile updated."))
                .catch((error) => setStatus(error.message))
            }
          >
            Save profile
          </button>
        </div>
        <div className="settings-group">
          <h2>Preferences</h2>
          <label>
            Theme
            <select
              value={theme}
              onChange={(event) => {
                const value = event.target.value;
                setTheme(value);
                localStorage.setItem("medisage-theme-v1", value);
                document.documentElement.dataset.theme = value;
              }}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Default answer language
            <select
              value={language}
              onChange={(event) => {
                const value = event.target.value;
                setLanguage(value);
                localStorage.setItem(`medisage-language-${user?.uid}`, value);
              }}
            >
              <option value="auto">Auto</option>
              <option value="en">English</option>
              <option value="bn">বাংলা</option>
            </select>
          </label>
        </div>
        <div className="settings-group">
          <h2>Security</h2>
          <button
            onClick={() =>
              resetPassword(user.email)
                .then(() => setStatus("Password-reset email sent."))
                .catch((error) => setStatus(error.message))
            }
          >
            Send password-reset email
          </button>
          <button onClick={() => signOutUser().then(() => navigate("/app"))}>
            Sign out
          </button>
        </div>
        <div className="settings-group danger-zone">
          <h2>Delete account</h2>
          <p>
            This permanently deletes your Firebase account. Temporary server
            attachments expire separately.
          </p>
          <button
            onClick={async () => {
              if (!window.confirm("Permanently delete your MediSage account?"))
                return;
              try {
                await deleteAccount();
                navigate("/signup");
              } catch (error) {
                setStatus(error.message);
              }
            }}
          >
            Delete my account
          </button>
        </div>
        {status && (
          <div className="auth-success" role="status">
            {status}
          </div>
        )}
      </section>
    </main>
  );
}
