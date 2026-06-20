-- ============================================================
-- Alpha Bot — Supabase Database Setup
-- Run this once in the Supabase SQL Editor.
-- Dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- Enable UUID extension (usually already enabled)
create extension if not exists "uuid-ossp";

-- ── bot_state ─────────────────────────────────────────────
-- One row per user. Stores RUNNING | STOPPED | PAUSED.
create table if not exists bot_state (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  status      text not null default 'STOPPED',
  updated_at  timestamptz not null default now(),
  unique(user_id)
);

-- ── settings ──────────────────────────────────────────────
-- Key-value store per user. One row per setting key.
create table if not exists settings (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null,
  value       jsonb,
  updated_at  timestamptz not null default now(),
  unique(user_id, key)
);

-- ── trades ────────────────────────────────────────────────
-- One row per paper trade (keyed by trade_id from the bot).
create table if not exists trades (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  trade_id    text not null,
  data        jsonb,
  updated_at  timestamptz not null default now(),
  unique(trade_id)
);

-- ── notes ─────────────────────────────────────────────────
-- Per-trade journal notes.
create table if not exists notes (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  trade_id    text not null,
  note        text,
  updated_at  timestamptz not null default now(),
  unique(user_id, trade_id)
);

-- ── Row Level Security ─────────────────────────────────────
-- Users can only read/write their own rows.

alter table bot_state enable row level security;
alter table settings   enable row level security;
alter table trades     enable row level security;
alter table notes      enable row level security;

-- bot_state policies
create policy "bot_state: own rows" on bot_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- settings policies
create policy "settings: own rows" on settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- trades policies
create policy "trades: own rows" on trades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- notes policies
create policy "notes: own rows" on notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Indexes ────────────────────────────────────────────────
create index if not exists idx_settings_user   on settings(user_id);
create index if not exists idx_trades_user     on trades(user_id);
create index if not exists idx_trades_trade_id on trades(trade_id);
create index if not exists idx_notes_user      on notes(user_id);

-- ── Enable Realtime ────────────────────────────────────────
-- Also enable via: Supabase Dashboard → Database → Replication
-- → Toggle on: bot_state, settings, trades, notes

alter publication supabase_realtime add table bot_state;
alter publication supabase_realtime add table settings;
alter publication supabase_realtime add table trades;
alter publication supabase_realtime add table notes;
