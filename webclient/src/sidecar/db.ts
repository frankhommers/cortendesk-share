// The sidecar's own data, in one SQLite file. CortenDesk's database is never
// touched.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';

export type Rights = { control: boolean; clipboard: boolean; files: boolean; audio: boolean; chat: boolean };

export type LinkRow = {
  id: number;
  kind: 'share' | 'preview';
  token_hash: string;
  label: string;
  device_id: string;
  device_name: string;
  display: number | null;
  rights: string;
  max_viewers: number;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
};

export type SessionRow = {
  id: number;
  link_id: number;
  guest_name: string;
  ip: string;
  user_agent: string;
  conn: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  dropped: number;
};

let db: DatabaseSync;

export function openDb(): DatabaseSync {
  mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(join(config.dataDir, 'share.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS device_passwords (
      device_id TEXT PRIMARY KEY,
      secret TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'share',
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL DEFAULT '',
      display INTEGER,
      rights TEXT NOT NULL,
      max_viewers INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      guest_name TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      conn TEXT NOT NULL DEFAULT 'default',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      end_reason TEXT,
      dropped INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sessions_link ON sessions(link_id);
  `);
  // Sessions still open from before a restart ended with it.
  db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'restart' WHERE ended_at IS NULL").run(now());
  // Preview links are throwaway.
  db.prepare("DELETE FROM links WHERE kind = 'preview' AND expires_at < ?").run(now() - 3600);
  return db;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function kvGet(k: string): string | null {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return r?.v ?? null;
}

export function kvSet(k: string, v: string | null): void {
  if (v === null) db.prepare('DELETE FROM kv WHERE k = ?').run(k);
  else db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

export function getDevicePassword(deviceId: string): string | null {
  const r = db.prepare('SELECT secret FROM device_passwords WHERE device_id = ?').get(deviceId) as { secret: string } | undefined;
  return r?.secret ?? null;
}

export function setDevicePassword(deviceId: string, secret: string | null): void {
  if (secret === null) db.prepare('DELETE FROM device_passwords WHERE device_id = ?').run(deviceId);
  else
    db.prepare(
      'INSERT INTO device_passwords (device_id, secret, updated_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at',
    ).run(deviceId, secret, now());
}

export function devicesWithPassword(): Set<string> {
  return new Set((db.prepare('SELECT device_id FROM device_passwords').all() as { device_id: string }[]).map((r) => r.device_id));
}

export function insertLink(l: Omit<LinkRow, 'id' | 'revoked_at' | 'last_used_at' | 'created_at'>): number {
  const r = db
    .prepare(
      'INSERT INTO links (kind, token_hash, label, device_id, device_name, display, rights, max_viewers, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(l.kind, l.token_hash, l.label, l.device_id, l.device_name, l.display, l.rights, l.max_viewers, l.expires_at, now(), l.created_by);
  return Number(r.lastInsertRowid);
}

export function linkByTokenHash(hash: string): LinkRow | null {
  return (db.prepare('SELECT * FROM links WHERE token_hash = ?').get(hash) as LinkRow | undefined) ?? null;
}

export function linkById(id: number): LinkRow | null {
  return (db.prepare('SELECT * FROM links WHERE id = ?').get(id) as LinkRow | undefined) ?? null;
}

export function linkUsable(l: LinkRow | null): l is LinkRow {
  return !!l && l.revoked_at === null && l.expires_at > now();
}

export function activeLinks(): LinkRow[] {
  return db
    .prepare("SELECT * FROM links WHERE kind = 'share' AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
    .all(now()) as LinkRow[];
}

export function revokeLink(id: number): void {
  db.prepare('UPDATE links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id);
}

export function touchLink(id: number): void {
  db.prepare('UPDATE links SET last_used_at = ? WHERE id = ?').run(now(), id);
}

export function startSession(s: { link_id: number; guest_name: string; ip: string; user_agent: string; conn: string }): number {
  const r = db
    .prepare('INSERT INTO sessions (link_id, guest_name, ip, user_agent, conn, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(s.link_id, s.guest_name, s.ip, s.user_agent, s.conn, now());
  return Number(r.lastInsertRowid);
}

export function endSession(id: number, reason: string, dropped: number): void {
  db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ?, dropped = ? WHERE id = ? AND ended_at IS NULL').run(now(), reason, dropped, id);
}

export function recentSessions(limit = 100): (SessionRow & { label: string; device_name: string; kind: string })[] {
  return db
    .prepare(
      'SELECT s.*, l.label, l.device_name, l.kind FROM sessions s JOIN links l ON l.id = s.link_id ORDER BY s.started_at DESC LIMIT ?',
    )
    .all(limit) as (SessionRow & { label: string; device_name: string; kind: string })[];
}
