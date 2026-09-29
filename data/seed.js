/**
 * data/seed.js
 * Idempotent ingestion script — imports football_historical.csv into SQLite.
 *
 * Usage:
 *   node data/seed.js                        # uses default DB path
 *   DB_PATH=./custom.db node data/seed.js    # custom DB path
 *   node data/seed.js --dry-run              # validate CSV only, no writes
 *
 * The script is idempotent: a match row identified by
 * (match_date, home_team, away_team) will be skipped if it already exists.
 *
 * Exit codes:
 *   0 — success (new rows inserted or nothing to do)
 *   1 — fatal error (missing file, schema mismatch, etc.)
 */

import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import { getDb } from "../db/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRY_RUN   = process.argv.includes("--dry-run");
const CSV_PATH  = path.join(__dirname, "seed", "football_historical.csv");
const SOURCE_META = {
  name:         "football_historical.csv",
  url:          "https://github.com/your-org/sports-prediction-app/blob/main/data/seed/football_historical.csv",
  retrieved_at: "2024-07-15",
  license:      "Public domain — match results are factual events",
  notes:        "Curated fixture covering EPL 2022/23 & 2023/24, UEFA Euro 2024, UCL 2023/24, FIFA Qualifiers 2023/24",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toInt(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function deriveResult(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return "H";
  if (awayGoals > homeGoals) return "A";
  return "D";
}

/**
 * Validate a parsed CSV row and return a typed object or throw with a message.
 * @param {Record<string,string>} row
 * @param {number} lineNum
 * @returns {object}
 */
function validateRow(row, lineNum) {
  const required = ["match_date","competition","season","home_team","away_team","home_goals","away_goals"];
  for (const f of required) {
    if (!row[f] || String(row[f]).trim() === "") {
      throw new Error(`Line ${lineNum}: missing required field "${f}"`);
    }
  }

  const matchDate = String(row.match_date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(matchDate)) {
    throw new Error(`Line ${lineNum}: match_date "${matchDate}" must be YYYY-MM-DD`);
  }

  const homeGoals = toInt(row.home_goals);
  const awayGoals = toInt(row.away_goals);
  if (homeGoals === null || awayGoals === null || homeGoals < 0 || awayGoals < 0) {
    throw new Error(`Line ${lineNum}: home_goals and away_goals must be non-negative integers`);
  }

  return {
    match_date:            matchDate,
    competition:           String(row.competition).trim(),
    season:                String(row.season).trim(),
    home_team:             String(row.home_team).trim(),
    away_team:             String(row.away_team).trim(),
    home_goals:            homeGoals,
    away_goals:            awayGoals,
    result:                deriveResult(homeGoals, awayGoals),
    venue:                 row.venue ? String(row.venue).trim() : null,
    notes:                 row.notes ? String(row.notes).trim() : null,
    home_shots:            toInt(row.home_shots),
    away_shots:            toInt(row.away_shots),
    home_shots_on_target:  toInt(row.home_shots_on_target),
    away_shots_on_target:  toInt(row.away_shots_on_target),
    home_corners:          toInt(row.home_corners),
    away_corners:          toInt(row.away_corners),
    home_fouls:            toInt(row.home_fouls),
    away_fouls:            toInt(row.away_fouls),
    home_yellow_cards:     toInt(row.home_yellow_cards),
    away_yellow_cards:     toInt(row.away_yellow_cards),
    home_red_cards:        toInt(row.home_red_cards),
    away_red_cards:        toInt(row.away_red_cards),
  };
}

// ─── Core ingestion ───────────────────────────────────────────────────────────

/**
 * Read and validate all rows from the CSV. Returns an array of typed objects.
 * Does not touch the database.
 * @param {string} csvPath
 * @returns {Promise<object[]>}
 */
export async function parseCSV(csvPath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let lineNum = 1; // header is line 1

    createReadStream(csvPath)
      .pipe(parse({ columns: true, skip_empty_lines: true, trim: true }))
      .on("data", (row) => {
        lineNum++;
        try {
          rows.push(validateRow(row, lineNum));
        } catch (err) {
          reject(err);
        }
      })
      .on("error", reject)
      .on("end", () => resolve(rows));
  });
}

/**
 * Upsert a single source record and return its id.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} meta
 * @returns {number}
 */
export function upsertSource(db, meta) {
  const existing = db.prepare("SELECT id FROM sources WHERE name = $name").get({ name: meta.name });
  if (existing) return existing.id;
  const result = db.prepare(`
    INSERT INTO sources (name, url, retrieved_at, license, notes)
    VALUES ($name, $url, $retrieved_at, $license, $notes)
  `).run({ name: meta.name, url: meta.url, retrieved_at: meta.retrieved_at, license: meta.license ?? null, notes: meta.notes ?? null });
  return result.lastInsertRowid;
}

/**
 * Get or create a competition row by code. Returns its id.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} name
 * @returns {number}
 */
export function upsertCompetition(db, name) {
  const code = name.toUpperCase().replace(/\s+/g, "_");
  const existing = db.prepare("SELECT id FROM competitions WHERE code = $code").get({ code });
  if (existing) return existing.id;
  const result = db.prepare("INSERT INTO competitions (code, name) VALUES ($code, $name)").run({ code, name });
  return result.lastInsertRowid;
}

/**
 * Get or create a season row. Returns its id.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {number} competitionId
 * @param {string} label
 * @returns {number}
 */
export function upsertSeason(db, competitionId, label) {
  const existing = db.prepare(
    "SELECT id FROM seasons WHERE competition_id = $competitionId AND label = $label"
  ).get({ competitionId, label });
  if (existing) return existing.id;
  const result = db.prepare("INSERT INTO seasons (competition_id, label) VALUES ($competitionId, $label)").run({ competitionId, label });
  return result.lastInsertRowid;
}

/**
 * Get or create a venue row. Returns its id or null if name is falsy.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string|null} name
 * @returns {number|null}
 */
export function upsertVenue(db, name) {
  if (!name) return null;
  const existing = db.prepare("SELECT id FROM venues WHERE name = $name COLLATE NOCASE").get({ name });
  if (existing) return existing.id;
  const result = db.prepare("INSERT INTO venues (name) VALUES ($name)").run({ name });
  return result.lastInsertRowid;
}

/**
 * Get or create a team row. Returns its id.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} name
 * @returns {number}
 */
export function upsertTeam(db, name) {
  const existing = db.prepare("SELECT id FROM teams WHERE name = $name COLLATE NOCASE").get({ name });
  if (existing) return existing.id;
  const result = db.prepare("INSERT INTO teams (name) VALUES ($name)").run({ name });
  return result.lastInsertRowid;
}

/**
 * Insert a match row and return its id, or return null if the match already exists.
 * Idempotency key: (match_date, home_team_id, away_team_id)
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} row
 * @returns {number|null}
 */
export function insertMatch(db, row) {
  const existing = db.prepare(
    "SELECT id FROM matches WHERE match_date = $match_date AND home_team_id = $home_team_id AND away_team_id = $away_team_id"
  ).get({ match_date: row.match_date, home_team_id: row.home_team_id, away_team_id: row.away_team_id });
  if (existing) return null; // skip duplicate

  const result = db.prepare(`
    INSERT INTO matches (
      match_date, competition_id, season_id,
      home_team_id, away_team_id, venue_id,
      home_goals, away_goals, result,
      home_shots, away_shots, home_shots_on_target, away_shots_on_target,
      home_corners, away_corners, home_fouls, away_fouls,
      home_yellow_cards, away_yellow_cards, home_red_cards, away_red_cards,
      record_date
    ) VALUES (
      $match_date, $competition_id, $season_id,
      $home_team_id, $away_team_id, $venue_id,
      $home_goals, $away_goals, $result,
      $home_shots, $away_shots, $home_shots_on_target, $away_shots_on_target,
      $home_corners, $away_corners, $home_fouls, $away_fouls,
      $home_yellow_cards, $away_yellow_cards, $home_red_cards, $away_red_cards,
      $match_date
    )
  `).run({
    match_date:            row.match_date,
    competition_id:        row.competition_id ?? null,
    season_id:             row.season_id ?? null,
    home_team_id:          row.home_team_id,
    away_team_id:          row.away_team_id,
    venue_id:              row.venue_id ?? null,
    home_goals:            row.home_goals,
    away_goals:            row.away_goals,
    result:                row.result,
    home_shots:            row.home_shots ?? null,
    away_shots:            row.away_shots ?? null,
    home_shots_on_target:  row.home_shots_on_target ?? null,
    away_shots_on_target:  row.away_shots_on_target ?? null,
    home_corners:          row.home_corners ?? null,
    away_corners:          row.away_corners ?? null,
    home_fouls:            row.home_fouls ?? null,
    away_fouls:            row.away_fouls ?? null,
    home_yellow_cards:     row.home_yellow_cards ?? null,
    away_yellow_cards:     row.away_yellow_cards ?? null,
    home_red_cards:        row.home_red_cards ?? null,
    away_red_cards:        row.away_red_cards ?? null,
  });

  return result.lastInsertRowid;
}

/**
 * Main ingestion function. Parses CSV, validates rows, and writes to DB.
 * @param {object} options
 * @param {string} [options.csvPath]
 * @param {string} [options.dbPath]
 * @param {boolean} [options.dryRun]
 * @returns {Promise<{ inserted: number, skipped: number, errors: string[] }>}
 */
export async function ingest({ csvPath = CSV_PATH, dbPath, dryRun = false } = {}) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  const rows = await parseCSV(csvPath);

  if (dryRun) {
    console.log(`[seed] Dry run — ${rows.length} rows validated, no writes.`);
    return { inserted: 0, skipped: 0, errors: [], total: rows.length };
  }

  const db = getDb(dbPath);
  const sourceId = upsertSource(db, SOURCE_META);

  let inserted = 0;
  let skipped  = 0;
  const errors = [];

  // Wrap entire ingestion in one transaction for speed and atomicity
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      try {
        const competitionId = upsertCompetition(db, row.competition);
        const seasonId      = upsertSeason(db, competitionId, row.season);
        const venueId       = upsertVenue(db, row.venue);
        const homeTeamId    = upsertTeam(db, row.home_team);
        const awayTeamId    = upsertTeam(db, row.away_team);

        const matchId = insertMatch(db, {
          match_date:            row.match_date,
          competition_id:        competitionId,
          season_id:             seasonId,
          home_team_id:          homeTeamId,
          away_team_id:          awayTeamId,
          venue_id:              venueId,
          home_goals:            row.home_goals,
          away_goals:            row.away_goals,
          result:                row.result,
          home_shots:            row.home_shots,
          away_shots:            row.away_shots,
          home_shots_on_target:  row.home_shots_on_target,
          away_shots_on_target:  row.away_shots_on_target,
          home_corners:          row.home_corners,
          away_corners:          row.away_corners,
          home_fouls:            row.home_fouls,
          away_fouls:            row.away_fouls,
          home_yellow_cards:     row.home_yellow_cards,
          away_yellow_cards:     row.away_yellow_cards,
          home_red_cards:        row.home_red_cards,
          away_red_cards:        row.away_red_cards,
        });

        if (matchId === null) {
          skipped++;
        } else {
          // Link match to source
          db.prepare(
            "INSERT OR IGNORE INTO match_sources (match_id, source_id) VALUES ($match_id, $source_id)"
          ).run({ match_id: matchId, source_id: sourceId });

          // Insert notes for semantic retrieval if present
          if (row.notes) {
            db.prepare(
              "INSERT INTO match_notes (match_id, content, source_id) VALUES ($match_id, $content, $source_id)"
            ).run({ match_id: matchId, content: row.notes, source_id: sourceId });
          }

          // Invalidate form cache for both teams
          db.prepare("DELETE FROM team_form_cache WHERE team_id = $teamId").run({ teamId: homeTeamId });
          db.prepare("DELETE FROM team_form_cache WHERE team_id = $teamId").run({ teamId: awayTeamId });

          inserted++;
        }
      } catch (err) {
        errors.push(`Row ${row.match_date} ${row.home_team} vs ${row.away_team}: ${err.message}`);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { inserted, skipped, errors, total: rows.length };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  console.log(`[seed] Starting ingestion from ${CSV_PATH}`);
  if (DRY_RUN) console.log("[seed] DRY RUN — no database writes will be made");

  ingest({ dryRun: DRY_RUN })
    .then(({ inserted, skipped, errors, total }) => {
      console.log(`[seed] Done. Total: ${total} | Inserted: ${inserted} | Skipped (duplicate): ${skipped}`);
      if (errors.length) {
        console.error(`[seed] ${errors.length} row error(s):`);
        errors.forEach(e => console.error("  ·", e));
        process.exit(1);
      }
    })
    .catch(err => {
      console.error("[seed] Fatal:", err.message);
      process.exit(1);
    });
}
