// ============================================================
// Alpha Bot — useCloudSync.js
// Supabase real-time sync for settings, trades, notes,
// bot state. Single source of truth across all devices.
//
// Tables expected in Supabase (create via dashboard or SQL):
//
//   bot_state   (id uuid pk default uuid_generate_v4(),
//                user_id uuid, status text, updated_at timestamptz)
//
//   settings    (id uuid pk default uuid_generate_v4(),
//                user_id uuid, key text, value jsonb,
//                updated_at timestamptz,
//                unique(user_id, key))
//
//   trades      (id uuid pk default uuid_generate_v4(),
//                user_id uuid, trade_id text unique, data jsonb,
//                updated_at timestamptz)
//
//   notes       (id uuid pk default uuid_generate_v4(),
//                user_id uuid, trade_id text unique, note text,
//                updated_at timestamptz)
//
// Enable Realtime on all four tables in the Supabase dashboard.
// ============================================================
import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "../auth/AuthContext.jsx";

const OFFLINE_QUEUE_KEY = "alpha_bot_offline_queue";

// ── Offline queue helpers ───────────────────────────────────
function loadQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]"); } catch { return []; }
}
function saveQueue(q) {
  try { localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q)); } catch {}
}

export function useCloudSync({ userId, onBotStateChange, onTradesChange, onSettingsChange }) {
  const IS_CONFIGURED = Boolean(supabase && userId);

  const [syncStatus, setSyncStatus]       = useState("idle");     // idle | syncing | synced | offline | error
  const [lastSynced, setLastSynced]       = useState(null);
  const [pendingChanges, setPendingChanges] = useState(0);

  const channelsRef  = useRef([]);
  const offlineQueue = useRef(loadQueue());
  const isMounted    = useRef(true);

  // Update pending count whenever queue changes
  const refreshPending = useCallback(() => {
    setPendingChanges(offlineQueue.current.length);
  }, []);

  // ── Generic upsert with offline fallback ─────────────────
  const upsert = useCallback(async (table, rowFinder, data) => {
    if (!IS_CONFIGURED) return;
    if (!navigator.onLine) {
      offlineQueue.current.push({ table, rowFinder, data, ts: Date.now() });
      saveQueue(offlineQueue.current);
      refreshPending();
      setSyncStatus("offline");
      return;
    }
    setSyncStatus("syncing");
    try {
      await supabase.from(table).upsert(data, { onConflict: rowFinder });
      if (isMounted.current) {
        setSyncStatus("synced");
        setLastSynced(new Date());
      }
    } catch (e) {
      console.warn("[CloudSync] upsert failed:", table, e.message);
      offlineQueue.current.push({ table, rowFinder, data, ts: Date.now() });
      saveQueue(offlineQueue.current);
      refreshPending();
      setSyncStatus("error");
    }
  }, [IS_CONFIGURED, refreshPending]);

  // ── Drain offline queue when back online ─────────────────
  const drainQueue = useCallback(async () => {
    if (!IS_CONFIGURED || offlineQueue.current.length === 0) return;
    setSyncStatus("syncing");
    const remaining = [];
    for (const item of offlineQueue.current) {
      try {
        await supabase.from(item.table).upsert(item.data, { onConflict: item.rowFinder });
      } catch {
        remaining.push(item);
      }
    }
    offlineQueue.current = remaining;
    saveQueue(remaining);
    refreshPending();
    if (isMounted.current) {
      setSyncStatus(remaining.length === 0 ? "synced" : "error");
      if (remaining.length === 0) setLastSynced(new Date());
    }
  }, [IS_CONFIGURED, refreshPending]);

  // ── Load all settings on mount ────────────────────────────
  const loadInitialSettings = useCallback(async () => {
    if (!IS_CONFIGURED) return;
    try {
      const { data, error } = await supabase
        .from("settings")
        .select("key, value")
        .eq("user_id", userId);
      if (error || !data) return;
      const map = {};
      data.forEach(row => { try { map[row.key] = typeof row.value === "string" ? JSON.parse(row.value) : row.value; } catch { map[row.key] = row.value; } });
      if (Object.keys(map).length > 0) onSettingsChange("__all__", map);
    } catch {}
  }, [IS_CONFIGURED, userId, onSettingsChange]);

  // ── Load initial trades on mount ─────────────────────────
  const loadInitialTrades = useCallback(async () => {
    if (!IS_CONFIGURED) return;
    try {
      const { data, error } = await supabase
        .from("trades")
        .select("trade_id, data")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(200);
      if (error || !data) return;
      onTradesChange("__init__", data.map(r => r.data));
    } catch {}
  }, [IS_CONFIGURED, userId, onTradesChange]);

  // ── Load initial bot state ────────────────────────────────
  const loadInitialBotState = useCallback(async () => {
    if (!IS_CONFIGURED) return;
    try {
      const { data } = await supabase
        .from("bot_state")
        .select("status")
        .eq("user_id", userId)
        .maybeSingle();
      if (data?.status) onBotStateChange(data.status);
    } catch {}
  }, [IS_CONFIGURED, userId, onBotStateChange]);

  // ── Subscribe to realtime ─────────────────────────────────
  useEffect(() => {
    isMounted.current = true;
    if (!IS_CONFIGURED) return;

    // Load existing data first
    loadInitialSettings();
    loadInitialTrades();
    loadInitialBotState();

    // Bot state channel
    const botCh = supabase
      .channel(`bot_state:${userId}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "bot_state",
        filter: `user_id=eq.${userId}`,
      }, payload => {
        const status = payload.new?.status;
        if (status && isMounted.current) onBotStateChange(status);
      })
      .subscribe();

    // Settings channel
    const settingsCh = supabase
      .channel(`settings:${userId}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "settings",
        filter: `user_id=eq.${userId}`,
      }, payload => {
        if (!isMounted.current) return;
        const key = payload.new?.key;
        let val = payload.new?.value;
        try { val = typeof val === "string" ? JSON.parse(val) : val; } catch {}
        if (key) onSettingsChange(key, val);
      })
      .subscribe();

    // Trades channel
    const tradesCh = supabase
      .channel(`trades:${userId}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "trades",
        filter: `user_id=eq.${userId}`,
      }, payload => {
        if (!isMounted.current) return;
        onTradesChange(payload.eventType, payload.new?.data);
      })
      .subscribe();

    channelsRef.current = [botCh, settingsCh, tradesCh];

    // Online → drain queue
    const onOnline  = () => drainQueue();
    const onOffline = () => { if (isMounted.current) setSyncStatus("offline"); };
    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      isMounted.current = false;
      channelsRef.current.forEach(ch => supabase.removeChannel(ch));
      window.removeEventListener("online",  onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [IS_CONFIGURED, userId]); // eslint-disable-line

  // ── Public sync functions ─────────────────────────────────

  /** Sync a single setting key → value */
  const syncSetting = useCallback((key, value) => {
    upsert("settings", "user_id,key", {
      user_id: userId,
      key,
      value: JSON.stringify(value),
      updated_at: new Date().toISOString(),
    });
  }, [userId, upsert]);

  /** Sync bot state (RUNNING | STOPPED | PAUSED) */
  const syncBotState = useCallback((status) => {
    upsert("bot_state", "user_id", {
      user_id: userId,
      status,
      updated_at: new Date().toISOString(),
    });
  }, [userId, upsert]);

  /** Sync array of trade objects */
  const syncTrades = useCallback((trades = []) => {
    if (!IS_CONFIGURED || !trades.length) return;
    // batch: upsert each trade individually (Supabase handles conflicts via trade_id unique)
    const rows = trades.map(t => ({
      user_id: userId,
      trade_id: t.id,
      data: t,
      updated_at: new Date().toISOString(),
    }));
    // Chunk to avoid payload size limits
    const CHUNK = 50;
    for (let i = 0; i < rows.length; i += CHUNK) {
      upsert("trades", "trade_id", rows.slice(i, i + CHUNK));
    }
  }, [IS_CONFIGURED, userId, upsert]);

  /** Sync a single trade note */
  const syncNote = useCallback((tradeId, note) => {
    upsert("notes", "user_id,trade_id", {
      user_id: userId,
      trade_id: tradeId,
      note,
      updated_at: new Date().toISOString(),
    });
  }, [userId, upsert]);

  /** Force sync: drain offline queue + reload everything */
  const forceSync = useCallback(() => {
    drainQueue();
    loadInitialSettings();
    loadInitialTrades();
    loadInitialBotState();
  }, [drainQueue, loadInitialSettings, loadInitialTrades, loadInitialBotState]);

  return {
    syncStatus,
    lastSynced,
    pendingChanges,
    syncSetting,
    syncBotState,
    syncTrades,
    syncNote,
    forceSync,
    isConfigured: IS_CONFIGURED,
  };
}
