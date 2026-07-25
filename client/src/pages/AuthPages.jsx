import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import Logo from "../components/Logo.jsx";
import { useAuth } from "../auth/AuthContext.jsx";

function AuthShell({ title, subtitle, children }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <Logo />
        <div className="auth-heading">
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {children}
        <p className="auth-medical-note">
          MediSage provides medical education, not diagnosis or emergency care.
        </p>
      </section>
    </main>
  );
}

function FormError({ message }) {
  return message ? (
    <div className="auth-error" role="alert">
      {message}
    </div>
  ) : null;
}

function GoogleAuthButton({ disabled, onError, onSuccess }) {
  const { signInWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="auth-secondary"
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        onError("");
        try {
          const credential = await signInWithGoogle();
          if (credential?.user) onSuccess?.();
        } catch (error) {
          if (error.code !== "auth/popup-closed-by-user")
            onError(error.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Connecting to Google…" : "Continue with Google"}
    </button>
  );
}

export function SignInPage() {
  const { isRegisteredUser, signIn, googleSignInEnabled } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (isRegisteredUser) return <Navigate to="/app" replace />;
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signIn(email, password, remember);
      navigate(location.state?.from || "/app", { replace: true });
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your private MediSage workspace."
    >
      <FormError message={error} />
      <form className="auth-form" onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <div className="auth-options">
          <label>
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Remember me
          </label>
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
          >
            {showPassword ? "Hide password" : "Show password"}
          </button>
        </div>
        <div className="auth-row">
          <Link to="/forgot-password">Forgot password?</Link>
        </div>
        <button className="auth-primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {googleSignInEnabled && (
        <GoogleAuthButton
          disabled={busy}
          onError={setError}
          onSuccess={() =>
            navigate(location.state?.from || "/app", { replace: true })
          }
        />
      )}
      <p className="auth-switch">
        New to MediSage? <Link to="/register">Create an account</Link>
      </p>
      <p className="auth-switch"><Link to="/app">Back to MediSage</Link></p>
    </AuthShell>
  );
}

export function SignUpPage() {
  const { isRegisteredUser, signUp, googleSignInEnabled } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  if (isRegisteredUser) return <Navigate to="/app" replace />;
  async function submit(event) {
    event.preventDefault();
    if (form.password !== form.confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (!acceptedTerms) {
      setError("Accept the Terms and Privacy notice to continue.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await signUp(form.name, form.email, form.password);
      navigate("/verify-email");
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }
  const update = (key) => (event) =>
    setForm((value) => ({ ...value, [key]: event.target.value }));
  return (
    <AuthShell
      title="Create your account"
      subtitle="Your conversations and attachments stay scoped to your account."
    >
      <FormError message={error} />
      <form className="auth-form" onSubmit={submit}>
        <label>
          Name
          <input
            autoComplete="name"
            required
            value={form.name}
            onChange={update("name")}
          />
        </label>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={update("email")}
          />
        </label>
        <label>
          Password
          <input
            type={showPassword ? "text" : "password"}
            minLength="6"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={update("password")}
          />
        </label>
        <small className="password-strength">
          Password strength:{" "}
          {form.password.length >= 12 &&
          /[A-Z]/.test(form.password) &&
          /\d/.test(form.password)
            ? "Strong"
            : form.password.length >= 8
              ? "Moderate"
              : "Use 8+ characters for a stronger password"}
        </small>
        <label>
          Confirm password
          <input
            type={showPassword ? "text" : "password"}
            minLength="6"
            autoComplete="new-password"
            required
            value={form.confirm}
            onChange={update("confirm")}
          />
        </label>
        <div className="auth-options">
          <label>
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(event) => setAcceptedTerms(event.target.checked)}
              required
            />
            I accept the Terms and Privacy notice
          </label>
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
          >
            {showPassword ? "Hide passwords" : "Show passwords"}
          </button>
        </div>
        <button className="auth-primary" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
      {googleSignInEnabled && (
        <GoogleAuthButton
          disabled={busy}
          onError={setError}
          onSuccess={() => navigate("/app", { replace: true })}
        />
      )}
      <p className="auth-switch">
        Already registered? <Link to="/login">Sign in</Link>
      </p>
      <p className="auth-switch"><Link to="/app">Back to MediSage</Link></p>
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await resetPassword(email);
      setStatus(
        "If an account exists for that email, a reset message has been sent.",
      );
    } catch (nextError) {
      setError(nextError.message);
    }
  }
  return (
    <AuthShell
      title="Reset your password"
      subtitle="We’ll send password-reset instructions to your email."
    >
      <FormError message={error} />
      {status && (
        <div className="auth-success" role="status">
          {status}
        </div>
      )}
      <form className="auth-form" onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button className="auth-primary">
          Send reset email
        </button>
      </form>
      <p className="auth-switch">
        <Link to="/login">Return to sign in</Link> · <Link to="/app">Back to MediSage</Link>
      </p>
    </AuthShell>
  );
}

export function VerifyEmailPage() {
  const { user, resendVerification, signOutUser } = useAuth();
  const [status, setStatus] = useState("");
  if (!user || user.isAnonymous) return <Navigate to="/app" replace />;
  if (user.emailVerified) return <Navigate to="/app" replace />;
  return (
    <AuthShell
      title="Verify your email"
      subtitle={`We sent a verification link to ${user.email}.`}
    >
      <p className="auth-copy">
        Open the link, then refresh this page. Verification helps protect your
        private medical learning workspace.
      </p>
      {status && <div className="auth-success">{status}</div>}
      <button
        className="auth-primary"
        onClick={async () => {
          await user.reload();
          window.location.reload();
        }}
      >
        I verified my email
      </button>
      <button
        className="auth-secondary"
        onClick={() =>
          resendVerification()
            .then(() => setStatus("A new verification email was sent."))
            .catch((error) => setStatus(error.message))
        }
      >
        Resend email
      </button>
      <button className="auth-link-button" onClick={signOutUser}>
        Use another account
      </button>
    </AuthShell>
  );
}

export function RegisteredAccountRoute({ children }) {
  const { user, loading, isRegisteredUser } = useAuth();
  const location = useLocation();
  if (loading) return <main className="auth-page"><div className="auth-loading">Loading your workspace…</div></main>;
  if (!user || !isRegisteredUser)
    return (
      <AuthShell title="Keep your work available" subtitle="Sign in to sync conversations and access them from another device.">
        <div className="auth-account-actions">
          <Link className="auth-primary" to="/login" state={{ from: location.pathname }}>Sign in</Link>
          <Link className="auth-secondary" to="/register">Create account</Link>
          <Link className="auth-link-button" to="/app">Not now</Link>
        </div>
      </AuthShell>
    );
  return children;
}
