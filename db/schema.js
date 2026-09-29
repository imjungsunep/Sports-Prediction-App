/**
 * db/schema.js
 * Defines the normalised SQLite schema and creates all tables.
 * Safe to call multiple times (CREATE TABLE IF NOT EXISTS + idempotent migrations).
 * Uses the built-in node:sqlite module (Node.js ≥22.5, available in Node 24).
 *
 * Tables
 * ──────
 *   sources          — data provenance: where each record came from
 *   competitions     — league / cup / tournament
 *   seasons          — season within a competition (e.g. EPL 2023/24)
 *   venues           — stadium/ground metadata
 *   teams            — canonical team names + metadata
 *   matches          — one row per played match
 *   match_sources    — join: which source(s) back each match row
 *   team_form_cache  — pre-computed rolling form (invalidated on new match insert)
 *   match_notes      — free-text match reports / notes for semantic retrieval
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Open (or create) the SQLite database at dbPath.
 * @param {string} [dbPath]
 * @returns {DatabaseSync}
 */
export function openDb(dbPath) {
  const resolved = dbPath ?? process.env.DB_PATH ?? path.join(__dirname, "../data/football.db");
  // Ensure the directory exists
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(resolved);

  // WAL mode for better concurrent-read performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  return db;
}

/**
 * Apply the schema to an open database connection.
 * Idempotent — safe to call on every startup.
 * @param {DatabaseSync} db
 */
export function applySchema(db) {
  db.exec(`
    -- ── Sources ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sources (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      url           TEXT    NOT NULL,
      retrieved_at  TEXT    NOT NULL,
      license       TEXT,
      notes         TEXT
    );

    -- ── Competitions ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS competitions (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      code  TEXT    NOT NULL UNIQUE,
      name  TEXT    NOT NULL,
      sport TEXT    NOT NULL DEFAULT 'football'
    );

    -- ── Seasons ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS seasons (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      competition_id INTEGER NOT NULL REFERENCES competitions(id),
      label          TEXT    NOT NULL,
      start_date     TEXT,
      end_date       TEXT,
      UNIQUE (competition_id, label)
    );

    -- ── Venues ───────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS venues (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT    NOT NULL,
      city     TEXT,
      country  TEXT,
      capacity INTEGER
    );

    -- ── Teams ────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS teams (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      short_name   TEXT,
      country      TEXT,
      home_venue_id INTEGER REFERENCES venues(id)
    );

    -- ── Matches ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS matches (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      match_date      TEXT    NOT NULL,
      competition_id  INTEGER REFERENCES competitions(id),
      season_id       INTEGER REFERENCES seasons(id),
      home_team_id    INTEGER NOT NULL REFERENCES teams(id),
      away_team_id    INTEGER NOT NULL REFERENCES teams(id),
      venue_id        INTEGER REFERENCES venues(id),
      home_goals      INTEGER NOT NULL,
      away_goals      INTEGER NOT NULL,
      result          TEXT    NOT NULL CHECK(result IN ('H','A','D')),
      home_shots      INTEGER,
      away_shots      INTEGER,
      home_shots_on_target INTEGER,
      away_shots_on_target INTEGER,
      home_corners    INTEGER,
      away_corners    INTEGER,
      home_fouls      INTEGER,
      away_fouls      INTEGER,
      home_yellow_cards INTEGER,
      away_yellow_cards INTEGER,
      home_red_cards  INTEGER,
      away_red_cards  INTEGER,
      record_date     TEXT,
      inserted_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_matches_home ON matches(home_team_id);
    CREATE INDEX IF NOT EXISTS idx_matches_away ON matches(away_team_id);
    CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date);
    CREATE INDEX IF NOT EXISTS idx_matches_competition ON matches(competition_id, season_id);

    -- ── Match ↔ Source provenance ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS match_sources (
      match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES sources(id),
      PRIMARY KEY (match_id, source_id)
    );

    -- ── Free-text match notes (for semantic retrieval) ────────────────────────
    CREATE TABLE IF NOT EXISTS match_notes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      content   TEXT    NOT NULL,
      source_id INTEGER REFERENCES sources(id)
    );

    CREATE INDEX IF NOT EXISTS idx_notes_match ON match_notes(match_id);

    -- ── Team form cache ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS team_form_cache (
      team_id        INTEGER NOT NULL REFERENCES teams(id),
      as_of_date     TEXT    NOT NULL,
      last_n         INTEGER NOT NULL,
      wins           INTEGER NOT NULL,
      draws          INTEGER NOT NULL,
      losses         INTEGER NOT NULL,
      goals_for      INTEGER NOT NULL,
      goals_against  INTEGER NOT NULL,
      computed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, last_n)
    );
  `);
}

/**
 * Open the DB and apply the schema in one call.
 * @param {string} [dbPath]
 * @returns {DatabaseSync}
 */
export function getDb(dbPath) {
  const db = openDb(dbPath);
  applySchema(db);
  return db;
}
