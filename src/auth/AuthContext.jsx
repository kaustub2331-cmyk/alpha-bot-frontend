// ============================================================
// Alpha Bot — AuthContext.jsx
// Supabase authentication provider.
// Reads VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY from env.
// If either is missing, isConfigured = false and the app runs
// in local-only mode (no auth gate, no cloud sync).
// ============================================================
import { createContext, useContext, useEffect, useState, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

const AuthContext = createContext(null);

// ── Supabase client (singleton) ────────────────────────────
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL  || "";
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const IS_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON);

export const supabase = IS_CONFIGURED
  ? createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: {
        persistSession: true,          // stores session in localStorage
        autoRefreshToken: true,
        detectSessionInUrl: true,      // handles magic-link redirects
      },
    })
  : null;

// ── Provider ───────────────────────────────────────────────
export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);
  const listenerRef           = useRef(null);

  useEffect(() => {
    if (!IS_CONFIGURED) {
      setLoading(false);
      return;
    }

    // Restore session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth state changes (login / logout / token refresh)
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    listenerRef.current = listener;

    return () => {
      listener?.subscription?.unsubscribe();
    };
  }, []);

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signUp = async (email, password) => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
  };

  const signInMagic = async (email) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) throw error;
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setUser(null);
    // Clear local mode flag so auth gate shows again on reload
    try { localStorage.removeItem("alpha_bot_local_mode"); } catch {}
  };

  const resetPassword = async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}?reset=1`,
    });
    if (error) throw error;
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, signIn, signUp, signInMagic, signOut, resetPassword, isConfigured: IS_CONFIGURED }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ───────────────────────────────────────────────────
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
