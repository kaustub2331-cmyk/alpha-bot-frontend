// ============================================================
// Alpha Bot — LoginScreen.jsx
// Full-page auth UI. Supports:
//   • Email + password login
//   • Sign-up with email + password
//   • Magic link (passwordless)
//   • Password reset
//   • "Use without account" local bypass
// ============================================================
import { useState } from "react";
import { useAuth } from "./AuthContext.jsx";

const S = {
  root: {
    minHeight: "100vh",
    background: "#060b14",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'Space Mono', 'Courier New', monospace",
    padding: "16px",
  },
  card: {
    width: "100%",
    maxWidth: 380,
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 12,
    padding: "32px 28px",
    boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginBottom: 28,
  },
  logoIcon: {
    width: 34,
    height: 34,
    background: "linear-gradient(135deg, rgba(0,255,157,0.18), rgba(77,184,255,0.18))",
    border: "1px solid rgba(0,255,157,0.35)",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
  },
  logoText: {
    fontFamily: "'Syne', sans-serif",
    fontWeight: 800,
    fontSize: 20,
    color: "#e5e7eb",
    letterSpacing: "-0.01em",
  },
  logoVersion: {
    fontSize: 9,
    color: "#374151",
    marginLeft: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: 700,
    color: "#9ca3af",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    marginBottom: 20,
  },
  label: {
    fontSize: 9,
    color: "#6b7280",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    marginBottom: 4,
    display: "block",
  },
  input: {
    width: "100%",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 6,
    padding: "10px 12px",
    color: "#e5e7eb",
    fontSize: 12,
    fontFamily: "'Space Mono', monospace",
    outline: "none",
    boxSizing: "border-box",
    marginBottom: 14,
    transition: "border-color 0.15s",
  },
  btn: (color = "#00ff9d") => ({
    width: "100%",
    padding: "12px 0",
    borderRadius: 6,
    border: `1px solid ${color}33`,
    background: `${color}12`,
    color: color,
    fontSize: 11,
    fontWeight: 700,
    fontFamily: "'Space Mono', monospace",
    letterSpacing: "0.08em",
    cursor: "pointer",
    marginBottom: 8,
    transition: "background 0.15s",
  }),
  btnGhost: {
    width: "100%",
    padding: "10px 0",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.06)",
    background: "transparent",
    color: "#4b5563",
    fontSize: 10,
    fontFamily: "'Space Mono', monospace",
    letterSpacing: "0.06em",
    cursor: "pointer",
    marginBottom: 6,
    transition: "color 0.15s",
  },
  divider: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "16px 0",
    color: "#374151",
    fontSize: 9,
    letterSpacing: "0.08em",
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: "rgba(255,255,255,0.06)",
  },
  error: {
    padding: "8px 12px",
    borderRadius: 6,
    background: "rgba(255,69,102,0.08)",
    border: "1px solid rgba(255,69,102,0.2)",
    color: "#ff4566",
    fontSize: 10,
    lineHeight: 1.5,
    marginBottom: 14,
  },
  success: {
    padding: "8px 12px",
    borderRadius: 6,
    background: "rgba(0,255,157,0.06)",
    border: "1px solid rgba(0,255,157,0.2)",
    color: "#00ff9d",
    fontSize: 10,
    lineHeight: 1.5,
    marginBottom: 14,
  },
  link: {
    color: "#4db8ff",
    cursor: "pointer",
    background: "none",
    border: "none",
    fontFamily: "'Space Mono', monospace",
    fontSize: 10,
    padding: 0,
    textDecoration: "underline",
  },
};

// Tabs: LOGIN | SIGNUP | MAGIC | RESET
export function LoginScreen() {
  const { signIn, signUp, signInMagic, resetPassword } = useAuth();

  const [tab, setTab]         = useState("login");   // login | signup | magic | reset
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [success, setSuccess] = useState("");

  const clear = () => { setError(""); setSuccess(""); };

  async function handleLogin() {
    clear(); setLoading(true);
    try {
      await signIn(email, password);
      // Auth state change in AuthContext handles redirect
    } catch (e) {
      setError(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSignUp() {
    clear(); setLoading(true);
    try {
      await signUp(email, password);
      setSuccess("Account created! Check your email to confirm.");
    } catch (e) {
      setError(e.message || "Sign up failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleMagic() {
    clear(); setLoading(true);
    try {
      await signInMagic(email);
      setSuccess("Magic link sent! Check your inbox.");
    } catch (e) {
      setError(e.message || "Failed to send magic link");
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    clear(); setLoading(true);
    try {
      await resetPassword(email);
      setSuccess("Password reset link sent! Check your inbox.");
    } catch (e) {
      setError(e.message || "Failed to send reset link");
    } finally {
      setLoading(false);
    }
  }

  function handleLocalMode() {
    try { localStorage.setItem("alpha_bot_local_mode", "true"); } catch {}
    document.dispatchEvent(new Event("alpha-bot-local-mode"));
  }

  const onKey = (e) => {
    if (e.key !== "Enter") return;
    if (tab === "login") handleLogin();
    else if (tab === "signup") handleSignUp();
    else if (tab === "magic") handleMagic();
    else handleReset();
  };

  const tabTitle = { login: "SIGN IN", signup: "CREATE ACCOUNT", magic: "MAGIC LINK", reset: "RESET PASSWORD" };

  return (
    <div style={S.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@800&display=swap');
        * { box-sizing: border-box; }
        input:focus { border-color: rgba(0,255,157,0.4) !important; }
      `}</style>

      <div style={S.card}>
        {/* Logo */}
        <div style={S.logo}>
          <div style={S.logoIcon}>⚡</div>
          <div>
            <span style={S.logoText}>ALPHA BOT</span>
            <span style={S.logoVersion}>v34.EL</span>
          </div>
        </div>

        <div style={S.title}>{tabTitle[tab]}</div>

        {/* Feedback */}
        {error   && <div style={S.error}>{error}</div>}
        {success && <div style={S.success}>{success}</div>}

        {/* Email field (all tabs) */}
        <label style={S.label}>Email</label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={onKey}
          placeholder="you@example.com"
          autoFocus
          style={S.input}
        />

        {/* Password field (login + signup only) */}
        {(tab === "login" || tab === "signup") && (
          <>
            <label style={S.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={onKey}
              placeholder="••••••••"
              style={S.input}
            />
          </>
        )}

        {/* Primary action */}
        {tab === "login"  && <button style={S.btn()} onClick={handleLogin}  disabled={loading}>{loading ? "SIGNING IN..." : "→ SIGN IN"}</button>}
        {tab === "signup" && <button style={S.btn("#4db8ff")} onClick={handleSignUp} disabled={loading}>{loading ? "CREATING..." : "→ CREATE ACCOUNT"}</button>}
        {tab === "magic"  && <button style={S.btn("#ffd700")} onClick={handleMagic}  disabled={loading}>{loading ? "SENDING..." : "→ SEND MAGIC LINK"}</button>}
        {tab === "reset"  && <button style={S.btn("#c084fc")} onClick={handleReset}  disabled={loading}>{loading ? "SENDING..." : "→ SEND RESET LINK"}</button>}

        {/* Tab switchers */}
        <div style={S.divider}><div style={S.dividerLine} />OR<div style={S.dividerLine} /></div>

        {tab !== "login"  && <button style={S.btnGhost} onClick={() => { setTab("login");  clear(); }}>Sign in with password</button>}
        {tab !== "signup" && <button style={S.btnGhost} onClick={() => { setTab("signup"); clear(); }}>Create new account</button>}
        {tab !== "magic"  && <button style={S.btnGhost} onClick={() => { setTab("magic");  clear(); }}>Passwordless magic link</button>}
        {tab !== "reset"  && <button style={S.btnGhost} onClick={() => { setTab("reset");  clear(); }}>Forgot password</button>}

        {/* Local bypass */}
        <div style={S.divider}><div style={S.dividerLine} />OR<div style={S.dividerLine} /></div>
        <button style={S.btnGhost} onClick={handleLocalMode}>
          Use without account (local only)
        </button>

        <div style={{ marginTop: 20, fontSize: 9, color: "#374151", lineHeight: 1.6, textAlign: "center" }}>
          Cloud sync requires Supabase. Configure<br />
          VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in .env
        </div>
      </div>
    </div>
  );
}
