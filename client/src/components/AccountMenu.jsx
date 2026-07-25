import { CircleUserRound, Cloud, Info, LogOut, Settings, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function AccountMenu({ user, isGuest, collapsed = false, onSignOut, onClearGuestData, onBeforeAuthNavigation }) {
  const [open, setOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const rootRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  const label = isGuest ? "Guest" : user?.displayName || "MediSage user";
  const initial = isGuest ? "G" : (user?.displayName || user?.email || "M").slice(0, 1).toUpperCase();
  const go = (path) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div className={`account-menu-root ${collapsed ? "account-menu-collapsed" : ""}`} ref={rootRef}>
      <button type="button" className="account-menu-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu">
        <span className="account-avatar">{initial}</span>
        {!collapsed && <span className="account-trigger-copy"><strong>{label}</strong><small>{isGuest ? "Sign in to sync your work" : "Account and conversations"}</small></span>}
        {!collapsed && <CircleUserRound size={17} />}
      </button>
      {open && (
        <div className="account-popover" role="menu" aria-label="Account menu">
          <div className="account-popover-head"><strong>{label}</strong>{!isGuest && <span>{user?.email}</span>}</div>
          {isGuest ? (
            <>
              <button role="menuitem" onClick={() => { onBeforeAuthNavigation?.(); go("/login"); }}><CircleUserRound size={15} />Sign in</button>
              <button role="menuitem" onClick={() => { onBeforeAuthNavigation?.(); go("/register"); }}><UserPlus size={15} />Create account</button>
              <button role="menuitem" onClick={() => { setOpen(false); setAboutOpen(true); }}><Info size={15} />About guest sessions</button>
              <button role="menuitem" onClick={() => go("/account")}><Settings size={15} />Settings</button>
              <button role="menuitem" onClick={() => { setOpen(false); onClearGuestData?.(); }}><Trash2 size={15} />Clear guest data</button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => go("/account")}><Settings size={15} />Account settings</button>
              <button role="menuitem" onClick={() => go("/app")}><Cloud size={15} />Saved conversations</button>
              <button role="menuitem" onClick={() => { setOpen(false); onSignOut?.(); }}><LogOut size={15} />Sign out</button>
            </>
          )}
        </div>
      )}
      {aboutOpen && (
        <div className="guest-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}>
          <section className="guest-dialog" role="dialog" aria-modal="true" aria-labelledby="guest-dialog-title">
            <button type="button" className="guest-dialog-close" onClick={() => setAboutOpen(false)} aria-label="Close guest session information"><X size={17} /></button>
            <Info size={22} />
            <h2 id="guest-dialog-title">About guest sessions</h2>
            <p>You can use MediSage without creating an account. Conversations and extracted attachment context can stay on this device; MediSage does not upload the original files.</p>
            <p>Signing in can sync supported conversation data across devices. Important medical information should still be verified with a qualified professional.</p>
            <button type="button" className="auth-primary" onClick={() => setAboutOpen(false)}>Close</button>
          </section>
        </div>
      )}
    </div>
  );
}
