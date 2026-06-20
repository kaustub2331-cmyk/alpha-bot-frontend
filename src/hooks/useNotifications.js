// ============================================================
// Alpha Bot — useNotifications.js
// Web Push Notifications via Service Worker.
// Falls back gracefully when SW / Notification API unavailable.
//
// Usage in App.jsx:
//   const notifications = useNotifications();
//   notifications.tradeOpened({ direction, strategy, confidence })
//   notifications.tradeClosed({ direction, pnl, exitReason })
//   notifications.tpHit({ direction, pnl })
//   notifications.slHit({ direction, pnl })
//   notifications.botStopped(reason)
//   notifications.criticalError(msg)
//   notifications.signalAlert({ direction, strategy, confidence })
// ============================================================
import { useEffect, useRef, useCallback, useState } from "react";

const SW_PATH = "/sw.js";

// ── Notification preferences (localStorage) ───────────────
const PREF_KEY = "alpha_bot_notif_prefs";
const DEFAULT_PREFS = {
  enabled: true,
  tradeOpened:  true,
  tradeClosed:  true,
  tpHit:        true,
  slHit:        true,
  botStopped:   true,
  criticalError: true,
  signalAlert:  false,   // off by default — high frequency
};

function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; }
  catch { return DEFAULT_PREFS; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch {}
}

export function useNotifications() {
  const swRegRef   = useRef(null);
  const [permission, setPermission] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "denied"
  );
  const [prefs, setPrefs] = useState(loadPrefs);

  // ── Register service worker on mount ─────────────────────
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(SW_PATH)
      .then(reg => {
        swRegRef.current = reg;
        // If we already have permission, just store the registration
        if (Notification.permission === "granted") setPermission("granted");
      })
      .catch(err => console.warn("[Notifications] SW register failed:", err.message));
  }, []);

  // ── Request permission ────────────────────────────────────
  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") { setPermission("granted"); return true; }
    if (Notification.permission === "denied") return false;
    const result = await Notification.requestPermission();
    setPermission(result);
    return result === "granted";
  }, []);

  // ── Core fire function ────────────────────────────────────
  const fire = useCallback((title, body, options = {}) => {
    if (!prefs.enabled) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    const payload = {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      vibrate: [100, 50, 100],
      data: { url: "/", ...options.data },
      ...options,
    };

    // Use SW for persistent notifications (works when app is backgrounded)
    if (swRegRef.current) {
      swRegRef.current.showNotification(title, payload).catch(() => {
        // Fallback to basic Notification
        try { new Notification(title, payload); } catch {}
      });
    } else {
      try { new Notification(title, payload); } catch {}
    }
  }, [prefs.enabled]);

  // ── Public helpers ────────────────────────────────────────
  const tradeOpened = useCallback(({ direction, strategy, confidence, entry } = {}) => {
    if (!prefs.tradeOpened) return;
    fire(
      `📈 ${direction} Trade Opened`,
      `${strategy || "Signal"} @ ${entry ? `$${entry.toFixed(0)}` : "market"} · Conf ${confidence?.toFixed(0) ?? "—"}%`,
      { tag: "trade-open", data: { tab: "trades" } }
    );
  }, [prefs.tradeOpened, fire]);

  const tradeClosed = useCallback(({ direction, pnl, exitReason, exit } = {}) => {
    if (!prefs.tradeClosed) return;
    const pnlStr = pnl != null ? ` · PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}` : "";
    fire(
      `${pnl >= 0 ? "✅" : "❌"} ${direction} Trade Closed`,
      `${exitReason || "closed"}${exit ? ` @ $${exit.toFixed(0)}` : ""}${pnlStr}`,
      { tag: "trade-close", data: { tab: "trades" } }
    );
  }, [prefs.tradeClosed, fire]);

  const tpHit = useCallback(({ direction, pnl, exit } = {}) => {
    if (!prefs.tpHit) return;
    fire(
      `🎯 TP Hit — ${direction}`,
      `Take profit hit @ $${exit?.toFixed(0) ?? "—"} · +${pnl?.toFixed(2) ?? "—"}`,
      { tag: "tp-hit", vibrate: [200, 100, 200], data: { tab: "trades" } }
    );
  }, [prefs.tpHit, fire]);

  const slHit = useCallback(({ direction, pnl, exit } = {}) => {
    if (!prefs.slHit) return;
    fire(
      `🛑 SL Hit — ${direction}`,
      `Stop loss hit @ $${exit?.toFixed(0) ?? "—"} · ${pnl?.toFixed(2) ?? "—"}`,
      { tag: "sl-hit", vibrate: [300, 100, 300], data: { tab: "trades" } }
    );
  }, [prefs.slHit, fire]);

  const botStopped = useCallback((reason = "manual") => {
    if (!prefs.botStopped) return;
    fire(
      "⚠ Alpha Bot Stopped",
      `Reason: ${reason}`,
      { tag: "bot-stopped", data: { tab: "dashboard" } }
    );
  }, [prefs.botStopped, fire]);

  const criticalError = useCallback((msg = "Unknown error") => {
    if (!prefs.criticalError) return;
    fire(
      "🚨 Alpha Bot Error",
      msg,
      { tag: "bot-error", data: { tab: "dashboard" } }
    );
  }, [prefs.criticalError, fire]);

  const signalAlert = useCallback(({ direction, strategy, confidence } = {}) => {
    if (!prefs.signalAlert) return;
    fire(
      `⚡ ${direction} Signal — ${strategy}`,
      `Confidence ${confidence?.toFixed(0) ?? "—"}%`,
      { tag: "signal", data: { tab: "signal" } }
    );
  }, [prefs.signalAlert, fire]);

  // ── Update a pref key ─────────────────────────────────────
  const setPref = useCallback((key, val) => {
    setPrefs(prev => {
      const next = { ...prev, [key]: val };
      savePrefs(next);
      return next;
    });
  }, []);

  return {
    permission,
    requestPermission,
    prefs,
    setPref,
    tradeOpened,
    tradeClosed,
    tpHit,
    slHit,
    botStopped,
    criticalError,
    signalAlert,
  };
}
