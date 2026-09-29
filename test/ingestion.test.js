/**
 * test/ingestion.test.js
 *
 * Unit tests for data/seed.js:
 *   - CSV parsing and validation
 *   - Idempotent insertion
 *   - Source and team upserts
 *   - Invalid row handling
 *
 * Uses node:test + node:assert (Node.js ≥18, no extra installs).
 * Uses an in-memory SQLite DB so tests never touch the real database.
 */

import { test } from "node:test";
import assert   from "node:assert/strict";
import path     from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { applySchema }        from "../db/schema.js";
import {
  upsertSource,
  upsertCompetition,
  upsertSeason,
  upsertVenue,
  upsertTeam,
  insertMatch,
  parseCSV,
  ingest,
}                             from "../data/seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH  = path.join(__dirname, "../data/seed/football_historical.csv");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh in-memory DB with schema applied. */
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applySchema(db);
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV parsing
// ─────────────────────────────────────────────────────────────────────────────

test("parseCSV: returns an array with at least 90 rows", async () => {
  const rows = await parseCSV(CSV_PATH);
  assert.ok(rows.length >= 90, `Expected ≥90 rows, got ${rows.length}`);
});

test("parseCSV: each row has required typed fields", async () => {
  const rows = await parseCSV(CSV_PATH);
  for (const row of rows) {
    assert.ok(typeof row.match_date === "string",    "match_date must be string");
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.match_date), "match_date must be YYYY-MM-DD");
    assert.ok(typeof row.home_team   === "string",   "home_team must be string");
    assert.ok(typeof row.away_team   === "string",   "away_team must be string");
    assert.ok(typeof row.home_goals  === "number",   "home_goals must be number");
    assert.ok(typeof row.away_goals  === "number",   "away_goals must be number");
    assert.ok(row.home_goals >= 0,                   "home_goals must be non-negative");
    assert.ok(row.away_goals >= 0,                   "away_goals must be non-negative");
    assert.ok(["H","A","D"].includes(row.result),    "result must be H/A/D");
  }
});

test("parseCSV: result field is correctly derived", async () => {
  const rows = await parseCSV(CSV_PATH);
  for (const row of rows) {
    const expected =
      row.home_goals > row.away_goals ? "H" :
      row.away_goals > row.home_goals ? "A" : "D";
    assert.equal(row.result, expected, `Row ${row.match_date} ${row.home_team} vs ${row.away_team}: result mismatch`);
  }
});

test("ingest: throws on non-existent CSV path", async () => {
  // ingest() pre-checks the path with existsSync and throws a clear error
  let caught = null;
  try {
    await ingest({ csvPath: "/non/existent/path.csv" });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, "Should have thrown");
  assert.ok(/CSV not found/i.test(caught.message), `Expected 'CSV not found', got: ${caught.message}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Upsert functions
// ─────────────────────────────────────────────────────────────────────────────

test("upsertSource: inserts and returns an id", () => {
  const db = makeDb();
  const id = upsertSource(db, {
    name: "test-source",
    url: "https://example.com/data.csv",
    retrieved_at: "2024-01-01",
    license: "public domain",
    notes: null,
  });
  assert.ok(typeof id === "number" && id > 0, "Should return a positive integer id");
});

test("upsertSource: is idempotent (same id on second call)", () => {
  const db = makeDb();
  const meta = { name: "dup-source", url: "https://x.com", retrieved_at: "2024-01-01", license: null, notes: null };
  const id1 = upsertSource(db, meta);
  const id2 = upsertSource(db, meta);
  assert.equal(id1, id2, "Should return the same id on duplicate insert");
});

test("upsertCompetition: inserts and is idempotent", () => {
  const db = makeDb();
  const id1 = upsertCompetition(db, "English Premier League");
  const id2 = upsertCompetition(db, "English Premier League");
  assert.equal(id1, id2);
  assert.ok(id1 > 0);
});

test("upsertTeam: inserts and is idempotent", () => {
  const db = makeDb();
  const id1 = upsertTeam(db, "Arsenal");
  const id2 = upsertTeam(db, "Arsenal");
  assert.equal(id1, id2);
  assert.ok(id1 > 0);
});

test("upsertVenue: returns null for empty name", () => {
  const db = makeDb();
  assert.equal(upsertVenue(db, null), null);
  assert.equal(upsertVenue(db, ""),   null);
});

test("upsertVenue: inserts and is idempotent", () => {
  const db = makeDb();
  const id1 = upsertVenue(db, "Emirates Stadium");
  const id2 = upsertVenue(db, "Emirates Stadium");
  assert.equal(id1, id2);
  assert.ok(id1 > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// insertMatch
// ─────────────────────────────────────────────────────────────────────────────

test("insertMatch: inserts a match and returns its id", () => {
  const db = makeDb();
  const compId  = upsertCompetition(db, "Test League");
  const seasId  = upsertSeason(db, compId, "2024/25");
  const homeId  = upsertTeam(db, "Team Alpha");
  const awayId  = upsertTeam(db, "Team Beta");

  const matchId = insertMatch(db, {
    match_date:    "2024-03-01",
    competition_id: compId,
    season_id:     seasId,
    home_team_id:  homeId,
    away_team_id:  awayId,
    venue_id:      null,
    home_goals:    2,
    away_goals:    1,
    result:        "H",
    home_shots: null, away_shots: null,
    home_shots_on_target: null, away_shots_on_target: null,
    home_corners: null, away_corners: null,
    home_fouls: null, away_fouls: null,
    home_yellow_cards: null, away_yellow_cards: null,
    home_red_cards: null, away_red_cards: null,
  });

  assert.ok(matchId !== null && matchId > 0, "Should return a positive id");
});

test("insertMatch: returns null on duplicate (idempotent)", () => {
  const db = makeDb();
  const compId  = upsertCompetition(db, "Test League");
  const seasId  = upsertSeason(db, compId, "2024/25");
  const homeId  = upsertTeam(db, "Team Alpha");
  const awayId  = upsertTeam(db, "Team Beta");
  const row = {
    match_date: "2024-03-01", competition_id: compId, season_id: seasId,
    home_team_id: homeId, away_team_id: awayId, venue_id: null,
    home_goals: 2, away_goals: 1, result: "H",
    home_shots: null, away_shots: null,
    home_shots_on_target: null, away_shots_on_target: null,
    home_corners: null, away_corners: null,
    home_fouls: null, away_fouls: null,
    home_yellow_cards: null, away_yellow_cards: null,
    home_red_cards: null, away_red_cards: null,
  };
  insertMatch(db, row);
  const second = insertMatch(db, row);
  assert.equal(second, null, "Duplicate insert should return null");
});

// ─────────────────────────────────────────────────────────────────────────────
// Full ingest (in-memory)
// ─────────────────────────────────────────────────────────────────────────────

test("ingest: inserts rows and reports counts", async () => {
  // Use a temp file DB so ingest() can create its own connection
  const os   = await import("node:os");
  const fs   = await import("node:fs");
  const tmpDb = path.join(os.default.tmpdir(), `test_ingest_${Date.now()}.db`);
  try {
    const result = await ingest({ dbPath: tmpDb });
    assert.ok(result.inserted > 0,   `Expected inserted > 0, got ${result.inserted}`);
    assert.equal(result.errors.length, 0, `Expected 0 errors, got: ${result.errors.join(", ")}`);
  } finally {
    try { fs.default.unlinkSync(tmpDb); } catch {}
  }
});

test("ingest: is idempotent — second run inserts 0", async () => {
  const os   = await import("node:os");
  const fs   = await import("node:fs");
  const tmpDb = path.join(os.default.tmpdir(), `test_idem_${Date.now()}.db`);
  try {
    await ingest({ dbPath: tmpDb });
    const result2 = await ingest({ dbPath: tmpDb });
    assert.equal(result2.inserted, 0, "Second run should insert 0 (all rows are duplicates)");
    assert.ok(result2.skipped > 0,    "Second run should skip all rows");
  } finally {
    try { fs.default.unlinkSync(tmpDb); } catch {}
  }
});

test("ingest: dry-run does not write to DB", async () => {
  const os   = await import("node:os");
  const fs   = await import("node:fs");
  const tmpDb = path.join(os.default.tmpdir(), `test_dry_${Date.now()}.db`);
  try {
    const result = await ingest({ dbPath: tmpDb, dryRun: true });
    assert.equal(result.inserted, 0, "Dry run should insert 0");
    assert.ok(!fs.default.existsSync(tmpDb), "Dry run should not create the DB file");
  } finally {
    try { fs.default.unlinkSync(tmpDb); } catch {}
  }
});
