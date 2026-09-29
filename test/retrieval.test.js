/**
 * test/retrieval.test.js
 *
 * Unit tests for db/queries.js and model/probabilityModel.js:
 *   - getTeamId, getTeamByName, getTeamForm, getHeadToHead, getTeamStats
 *   - formScore, h2hRates, computeProbabilities
 *   - Probabilities always sum to 100
 *   - Deterministic output (same inputs → same output)
 *   - Graceful handling of missing data
 */

import { test }  from "node:test";
import assert    from "node:assert/strict";
import path      from "node:path";
import os        from "node:os";
import fs        from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync }  from "node:sqlite";

import { applySchema }        from "../db/schema.js";
import {
  upsertCompetition, upsertSeason,
  upsertTeam, upsertVenue, insertMatch, upsertSource,
  ingest
}                             from "../data/seed.js";
import {
  getTeamId, getTeamByName, getAllTeams,
  getHeadToHead, getTeamForm, getTeamStats, getDataHealth
}                             from "../db/queries.js";
import {
  formScore, h2hRates, computeProbabilities
}                             from "../model/probabilityModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applySchema(db);
  return db;
}

/**
 * Seed a small in-memory DB with known Arsenal vs Chelsea matches.
 * Returns { db, arsenalId, chelseaId }.
 */
function seedTestDb() {
  const db     = makeDb();
  const compId = upsertCompetition(db, "EPL");
  const seasId = upsertSeason(db, compId, "2023/24");
  const srcId  = upsertSource(db, { name: "test", url: "http://test", retrieved_at: "2024-01-01", license: null, notes: null });

  const arsenalId = upsertTeam(db, "Arsenal");
  const chelseaId = upsertTeam(db, "Chelsea");

  const matches = [
    // Arsenal home wins
    { date: "2023-10-08", home: chelseaId, away: arsenalId, hg: 0, ag: 1, r: "A" },
    { date: "2024-04-21", home: arsenalId, away: chelseaId, hg: 5, ag: 0, r: "H" },
    // Draw
    { date: "2023-01-15", home: chelseaId, away: arsenalId, hg: 2, ag: 2, r: "D" },
    // Chelsea win
    { date: "2022-11-06", home: chelseaId, away: arsenalId, hg: 1, ag: 0, r: "H" },
    // Arsenal home
    { date: "2022-11-12", home: arsenalId, away: chelseaId, hg: 1, ag: 0, r: "H" },
  ];

  for (const m of matches) {
    const id = insertMatch(db, {
      match_date: m.date, competition_id: compId, season_id: seasId,
      home_team_id: m.home, away_team_id: m.away, venue_id: null,
      home_goals: m.hg, away_goals: m.ag, result: m.r,
      home_shots: null, away_shots: null,
      home_shots_on_target: null, away_shots_on_target: null,
      home_corners: null, away_corners: null,
      home_fouls: null, away_fouls: null,
      home_yellow_cards: null, away_yellow_cards: null,
      home_red_cards: null, away_red_cards: null,
    });
    db.prepare("INSERT INTO match_sources (match_id, source_id) VALUES (?,?)").run(id, srcId);
  }

  return { db, arsenalId, chelseaId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Team lookups
// ─────────────────────────────────────────────────────────────────────────────

test("getTeamId: returns correct id for exact name", () => {
  const { db, arsenalId } = seedTestDb();
  assert.equal(getTeamId(db, "Arsenal"), arsenalId);
});

test("getTeamId: is case-insensitive", () => {
  const { db, arsenalId } = seedTestDb();
  assert.equal(getTeamId(db, "arsenal"), arsenalId);
  assert.equal(getTeamId(db, "ARSENAL"), arsenalId);
});

test("getTeamId: returns null for unknown team", () => {
  const { db } = seedTestDb();
  assert.equal(getTeamId(db, "Nonexistent FC"), null);
});

test("getTeamByName: returns full row", () => {
  const { db } = seedTestDb();
  const row = getTeamByName(db, "Chelsea");
  assert.ok(row !== null);
  assert.equal(row.name, "Chelsea");
  assert.ok(typeof row.id === "number");
});

test("getAllTeams: returns sorted list including inserted teams", () => {
  const { db } = seedTestDb();
  const teams = getAllTeams(db);
  const names = teams.map(t => t.name);
  assert.ok(names.includes("Arsenal"));
  assert.ok(names.includes("Chelsea"));
  // Should be sorted alphabetically
  assert.deepEqual([...names].sort(), names);
});

// ─────────────────────────────────────────────────────────────────────────────
// Head-to-head
// ─────────────────────────────────────────────────────────────────────────────

test("getHeadToHead: returns all H2H matches regardless of home/away", () => {
  const { db } = seedTestDb();
  const h2h = getHeadToHead(db, "Arsenal", "Chelsea", 20);
  assert.equal(h2h.length, 5, `Expected 5 H2H matches, got ${h2h.length}`);
});

test("getHeadToHead: results are sorted newest first", () => {
  const { db } = seedTestDb();
  const h2h = getHeadToHead(db, "Arsenal", "Chelsea", 20);
  for (let i = 0; i < h2h.length - 1; i++) {
    assert.ok(h2h[i].match_date >= h2h[i+1].match_date,
      `Row ${i} (${h2h[i].match_date}) should be >= row ${i+1} (${h2h[i+1].match_date})`);
  }
});

test("getHeadToHead: returns empty array for unknown teams", () => {
  const { db } = seedTestDb();
  const h2h = getHeadToHead(db, "Nonexistent FC", "Chelsea", 20);
  assert.equal(h2h.length, 0);
});

test("getHeadToHead: limit is respected", () => {
  const { db } = seedTestDb();
  const h2h = getHeadToHead(db, "Arsenal", "Chelsea", 2);
  assert.equal(h2h.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Team form
// ─────────────────────────────────────────────────────────────────────────────

test("getTeamForm: returns matches for known team", () => {
  const { db } = seedTestDb();
  const form = getTeamForm(db, "Arsenal", 10, "all");
  assert.ok(form.length > 0, "Arsenal should have form records");
});

test("getTeamForm: each row has team_result field (W/D/L)", () => {
  const { db } = seedTestDb();
  const form = getTeamForm(db, "Arsenal", 10, "all");
  for (const row of form) {
    assert.ok(["W","D","L"].includes(row.team_result),
      `team_result must be W/D/L, got ${row.team_result}`);
  }
});

test("getTeamForm: venue='home' returns only home matches", () => {
  const { db } = seedTestDb();
  const form = getTeamForm(db, "Arsenal", 10, "home");
  for (const row of form) {
    assert.equal(row.home_team, "Arsenal", "All rows must have Arsenal as home team");
  }
});

test("getTeamForm: returns empty array for unknown team", () => {
  const { db } = seedTestDb();
  const form = getTeamForm(db, "Nonexistent FC", 5, "all");
  assert.equal(form.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Team stats
// ─────────────────────────────────────────────────────────────────────────────

test("getTeamStats: returns non-null for known team", () => {
  const { db } = seedTestDb();
  const stats = getTeamStats(db, "Arsenal", 10);
  assert.ok(stats !== null, "Should return stats for Arsenal");
});

test("getTeamStats: win+draw+loss === matches_played", () => {
  const { db } = seedTestDb();
  const stats = getTeamStats(db, "Arsenal", 10);
  assert.equal(stats.wins + stats.draws + stats.losses, stats.matches_played);
});

test("getTeamStats: win_rate is in [0,1]", () => {
  const { db } = seedTestDb();
  const stats = getTeamStats(db, "Arsenal", 10);
  assert.ok(stats.win_rate >= 0 && stats.win_rate <= 1,
    `win_rate ${stats.win_rate} must be in [0,1]`);
});

test("getTeamStats: returns null for unknown team", () => {
  const { db } = seedTestDb();
  const stats = getTeamStats(db, "Nonexistent FC", 5);
  assert.equal(stats, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Probability model — formScore
// ─────────────────────────────────────────────────────────────────────────────

test("formScore: empty form returns 0", () => {
  assert.equal(formScore([]), 0);
  assert.equal(formScore(null), 0);
});

test("formScore: all wins returns value > 0", () => {
  const rows = [{team_result:"W"},{team_result:"W"},{team_result:"W"},{team_result:"W"},{team_result:"W"}];
  const score = formScore(rows);
  assert.ok(score > 0, `Expected score > 0, got ${score}`);
});

test("formScore: all losses returns value < 0", () => {
  const rows = [{team_result:"L"},{team_result:"L"},{team_result:"L"}];
  const score = formScore(rows);
  assert.ok(score < 0, `Expected score < 0, got ${score}`);
});

test("formScore: all draws returns value near 0", () => {
  const rows = [{team_result:"D"},{team_result:"D"},{team_result:"D"}];
  const score = formScore(rows);
  assert.equal(score, 0);
});

test("formScore: output is in [-1, 1]", () => {
  const rows = [
    {team_result:"W"},{team_result:"L"},{team_result:"W"},
    {team_result:"L"},{team_result:"D"},{team_result:"W"},
  ];
  const score = formScore(rows);
  assert.ok(score >= -1 && score <= 1, `formScore ${score} out of [-1,1]`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Probability model — h2hRates
// ─────────────────────────────────────────────────────────────────────────────

test("h2hRates: empty input returns 1/3 each", () => {
  const rates = h2hRates([], "Arsenal", "Chelsea");
  assert.equal(rates.total, 0);
  assert.ok(Math.abs(rates.aWinRate - 1/3) < 0.001);
  assert.ok(Math.abs(rates.bWinRate - 1/3) < 0.001);
  assert.ok(Math.abs(rates.drawRate  - 1/3) < 0.001);
});

test("h2hRates: aWinRate + bWinRate + drawRate === 1", () => {
  const { db } = seedTestDb();
  const h2h = getHeadToHead(db, "Arsenal", "Chelsea", 20);
  const rates = h2hRates(h2h, "Arsenal", "Chelsea");
  const sum = rates.aWinRate + rates.bWinRate + rates.drawRate;
  assert.ok(Math.abs(sum - 1.0) < 0.001, `Rates should sum to 1, got ${sum}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Probability model — computeProbabilities
// ─────────────────────────────────────────────────────────────────────────────

function makeMockBundle(overrides = {}) {
  return {
    team_a: "Arsenal",
    team_b: "Chelsea",
    venue_host: null,
    head_to_head: [],
    team_a_form: [],
    team_b_form: [],
    home_form_a: [],
    away_form_b: [],
    away_form_a: [],
    home_form_b: [],
    team_a_stats: null,
    team_b_stats: null,
    ...overrides,
  };
}

test("computeProbabilities: team_a_pct + team_b_pct + draw_pct === 100", () => {
  const result = computeProbabilities(makeMockBundle());
  const sum = result.team_a_pct + result.team_b_pct + result.draw_pct;
  assert.equal(sum, 100, `Probabilities must sum to 100, got ${sum}`);
});

test("computeProbabilities: all percentages are ≥ 5", () => {
  const result = computeProbabilities(makeMockBundle());
  assert.ok(result.team_a_pct >= 5, `team_a_pct ${result.team_a_pct} must be ≥5`);
  assert.ok(result.team_b_pct >= 5, `team_b_pct ${result.team_b_pct} must be ≥5`);
  assert.ok(result.draw_pct   >= 5, `draw_pct ${result.draw_pct} must be ≥5`);
});

test("computeProbabilities: confidence is High/Medium/Low", () => {
  const result = computeProbabilities(makeMockBundle());
  assert.ok(["High","Medium","Low"].includes(result.confidence));
});

test("computeProbabilities: is deterministic (same inputs → same output)", () => {
  const bundle = makeMockBundle({
    head_to_head: [
      { home_team: "Arsenal", away_team: "Chelsea", result: "H", home_goals: 2, away_goals: 0 },
      { home_team: "Chelsea", away_team: "Arsenal", result: "H", home_goals: 1, away_goals: 0 },
      { home_team: "Arsenal", away_team: "Chelsea", result: "D", home_goals: 1, away_goals: 1 },
    ],
    team_a_form: [
      {team_result: "W"},{team_result: "W"},{team_result: "D"},{team_result: "L"},{team_result: "W"}
    ],
    team_b_form: [
      {team_result: "L"},{team_result: "D"},{team_result: "L"},{team_result: "W"},{team_result: "L"}
    ],
  });
  const r1 = computeProbabilities(bundle);
  const r2 = computeProbabilities(bundle);
  assert.equal(r1.team_a_pct, r2.team_a_pct);
  assert.equal(r1.team_b_pct, r2.team_b_pct);
  assert.equal(r1.draw_pct,   r2.draw_pct);
});

test("computeProbabilities: strong form team wins more than 50%", () => {
  const bundle = makeMockBundle({
    team_a_form: Array(10).fill({team_result: "W"}),
    team_b_form: Array(10).fill({team_result: "L"}),
  });
  const result = computeProbabilities(bundle);
  assert.ok(result.team_a_pct > result.team_b_pct,
    `Arsenal (all wins) should have higher probability than Chelsea (all losses): ${result.team_a_pct} vs ${result.team_b_pct}`);
});

test("computeProbabilities: home advantage boosts hosting team", () => {
  const base = makeMockBundle({ venue_host: null });
  const home = makeMockBundle({ venue_host: "team_a" });
  const rBase = computeProbabilities(base);
  const rHome = computeProbabilities(home);
  assert.ok(rHome.team_a_pct >= rBase.team_a_pct,
    `Home team should have >= probability: ${rHome.team_a_pct} vs ${rBase.team_a_pct}`);
});

test("computeProbabilities: includes model_inputs with h2h_total", () => {
  const result = computeProbabilities(makeMockBundle());
  assert.ok(result.model_inputs !== undefined, "model_inputs must be present");
  assert.equal(result.model_inputs.h2h_total, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Data health
// ─────────────────────────────────────────────────────────────────────────────

test("getDataHealth: returns correct counts after seed", () => {
  const { db } = seedTestDb();
  const health = getDataHealth(db);
  assert.ok(health.total_matches >= 5,   `Expected ≥5 matches, got ${health.total_matches}`);
  assert.ok(health.total_teams   >= 2,   `Expected ≥2 teams, got ${health.total_teams}`);
  assert.ok(health.total_competitions >= 1);
  assert.ok(health.earliest_match !== null);
  assert.ok(health.latest_match !== null);
});
