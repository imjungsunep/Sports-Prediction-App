/**
 * agents/agent1_dataCollection.js
 *
 * Agent 1 — Data Collection Agent
 *
 * Responsibilities:
 *   • Retrieve historical records from local SQLite
 *   • Enforce date-leakage guard: exclude the fixture being predicted and
 *     any matches on or after fixture_date
 *   • Report coverage (team known, H2H count, form depth)
 *   • Report freshness (days since most-recent match in the dataset)
 *   • Build DataQualityScore and SourceCitation list
 *   • NEVER calls an LLM
 *
 * Input:  PredictionInput  (agents/types.js)
 * Output: DataBundle       (agents/types.js)
 */

import { getDb }                  from "../db/schema.js";
import {
  getTeamId,
  getHeadToHead,
  getTeamForm,
  getTeamStats,
  getMatchNotes,
}                                  from "../db/queries.js";
import { computeDataQualityScore } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const H2H_LIMIT   = 20;
const FORM_WINDOW = 10;

// ─── Date-leakage guard ───────────────────────────────────────────────────────

/**
 * Filter rows to only include matches strictly BEFORE cutoffDate.
 * Excludes the fixture itself and any match played on the same day.
 * @param {object[]} rows
 * @param {string|null} cutoffDate - ISO-8601 "YYYY-MM-DD"
 * @returns {object[]}
 */
function excludeLeakage(rows, cutoffDate) {
  if (!cutoffDate) return rows;          // no cutoff → pass all
  return rows.filter(r => r.match_date < cutoffDate);
}

// ─── Freshness ────────────────────────────────────────────────────────────────

/**
 * Compute days between the most-recent match date in allRows and today.
 * @param {object[]} allRows
 * @returns {number}  days (0 = today, Infinity if no rows)
 */
function freshnessDays(allRows) {
  if (!allRows || allRows.length === 0) return Infinity;
  const maxDate = allRows.reduce((best, r) =>
    r.match_date > best ? r.match_date : best, "0000-00-00");
  const msPerDay = 86_400_000;
  return Math.round((Date.now() - new Date(maxDate).getTime()) / msPerDay);
}

// ─── Semantic ranking (keyword overlap) ──────────────────────────────────────

function rankNotes(notes, teamA, teamB, topK = 5) {
  const keywords = [teamA, teamB, ...teamA.split(" "), ...teamB.split(" ")]
    .map(k => k.toLowerCase());
  return notes
    .map(n => {
      const text  = n.content.toLowerCase();
      const score = keywords.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0);
      return { ...n, score };
    })
    .filter(n => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── Source citations ─────────────────────────────────────────────────────────

function buildSourceCitations(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.source_name) continue;
    if (!map.has(r.source_name)) {
      map.set(r.source_name, {
        source_id:    r.source_name,
        source_name:  r.source_name,
        url:          r.source_url   ?? null,
        retrieved_at: r.retrieved_at ?? null,
        records_used: 0,
      });
    }
    map.get(r.source_name).records_used++;
  }
  return Array.from(map.values());
}

// ─── Main agent ───────────────────────────────────────────────────────────────

/**
 * @param {import('./types.js').PredictionInput} input
 * @returns {import('./types.js').DataBundle}
 */
export function dataCollectionAgent(input) {
  const { team_a, team_b, venue_host = null, fixture_date = null, dbPath } = input;

  const db       = getDb(dbPath);
  const warnings = [];

  // ── 1. Team resolution ───────────────────────────────────────────────────────
  const idA = getTeamId(db, team_a);
  const idB = getTeamId(db, team_b);
  if (idA === null) warnings.push(`"${team_a}" not found in historical records.`);
  if (idB === null) warnings.push(`"${team_b}" not found in historical records.`);

  // ── 2. Raw retrieval ─────────────────────────────────────────────────────────
  const rawH2H     = getHeadToHead(db, team_a, team_b, H2H_LIMIT);
  const rawFormA   = getTeamForm(db, team_a, FORM_WINDOW, "all");
  const rawFormB   = getTeamForm(db, team_b, FORM_WINDOW, "all");
  const rawHomeA   = getTeamForm(db, team_a, FORM_WINDOW, "home");
  const rawAwayB   = getTeamForm(db, team_b, FORM_WINDOW, "away");
  const rawAwayA   = getTeamForm(db, team_a, FORM_WINDOW, "away");
  const rawHomeB   = getTeamForm(db, team_b, FORM_WINDOW, "home");

  // ── 3. Date-leakage guard ────────────────────────────────────────────────────
  // Exclude any match on or after fixture_date to prevent future-data contamination
  const h2h    = excludeLeakage(rawH2H,   fixture_date);
  const formA  = excludeLeakage(rawFormA, fixture_date);
  const formB  = excludeLeakage(rawFormB, fixture_date);
  const homeFA = excludeLeakage(rawHomeA, fixture_date);
  const awayFB = excludeLeakage(rawAwayB, fixture_date);
  const awayFA = excludeLeakage(rawAwayA, fixture_date);
  const homeFB = excludeLeakage(rawHomeB, fixture_date);

  const leakedH2H  = rawH2H.length  - h2h.length;
  const leakedFormA = rawFormA.length - formA.length;
  const leakedFormB = rawFormB.length - formB.length;
  if (leakedH2H > 0)   warnings.push(`Excluded ${leakedH2H} H2H match(es) on/after fixture date (leakage guard).`);
  if (leakedFormA > 0) warnings.push(`Excluded ${leakedFormA} ${team_a} match(es) on/after fixture date.`);
  if (leakedFormB > 0) warnings.push(`Excluded ${leakedFormB} ${team_b} match(es) on/after fixture date.`);

  // ── 4. Coverage warnings ─────────────────────────────────────────────────────
  if (h2h.length === 0)     warnings.push(`No H2H records for "${team_a}" vs "${team_b}". Prediction relies on individual form only.`);
  else if (h2h.length < 3)  warnings.push(`Only ${h2h.length} H2H record(s). H2H signal has low reliability.`);
  if (formA.length === 0)   warnings.push(`No form records found for "${team_a}".`);
  else if (formA.length < 3) warnings.push(`Only ${formA.length} form match(es) for "${team_a}".`);
  if (formB.length === 0)   warnings.push(`No form records found for "${team_b}".`);
  else if (formB.length < 3) warnings.push(`Only ${formB.length} form match(es) for "${team_b}".`);

  // ── 5. Stats (post-leakage) ──────────────────────────────────────────────────
  // getTeamStats re-queries; we pass fixture_date so it can filter internally.
  // Since getTeamStats uses getTeamForm internally and doesn't accept a cutoff,
  // we compute stats directly from the already-filtered form rows.
  const statsA = formA.length > 0 ? computeStatsFromForm(formA, team_a) : null;
  const statsB = formB.length > 0 ? computeStatsFromForm(formB, team_b) : null;

  // ── 6. Semantic retrieval ────────────────────────────────────────────────────
  const allIds = [...new Set([...h2h.map(r=>r.id), ...formA.map(r=>r.id), ...formB.map(r=>r.id)])];
  const rawNotes = getMatchNotes(db, allIds);
  const notes    = rawNotes.length > 0 ? rankNotes(rawNotes, team_a, team_b) : [];
  if (rawNotes.length === 0 && allIds.length > 0) {
    warnings.push("No match report text available for semantic context.");
  }

  // ── 7. Freshness ─────────────────────────────────────────────────────────────
  const allRows    = [...h2h, ...formA, ...formB];
  const freshDays  = freshnessDays(allRows);

  // ── 8. Data quality score ────────────────────────────────────────────────────
  const dataQuality = computeDataQualityScore(
    h2h.length, formA.length, formB.length,
    isFinite(freshDays) ? freshDays : 9999
  );
  // Merge leakage-specific warnings into quality score warnings
  dataQuality.warnings.push(...warnings.filter(w => w.includes("leakage")));

  // ── 9. Source citations ───────────────────────────────────────────────────────
  const sources = buildSourceCitations(allRows);

  return {
    found:          idA !== null && idB !== null && (formA.length > 0 || formB.length > 0),
    team_a,
    team_b,
    venue_host,
    fixture_date,
    head_to_head:   h2h,
    team_a_form:    formA,
    team_b_form:    formB,
    home_form_a:    homeFA,
    away_form_b:    awayFB,
    away_form_a:    awayFA,
    home_form_b:    homeFB,
    team_a_stats:   statsA,
    team_b_stats:   statsB,
    relevant_notes: notes,
    data_quality:   dataQuality,
    sources,
    data_warnings:  warnings,
    coverage: {
      team_a_known:  idA !== null,
      team_b_known:  idB !== null,
      h2h_total:     h2h.length,
      team_a_form_count: formA.length,
      team_b_form_count: formB.length,
      freshness_days: isFinite(freshDays) ? freshDays : null,
    },
  };
}

// ─── Stats from filtered form rows ───────────────────────────────────────────

/**
 * Compute aggregate stats from an already-filtered form rows array.
 * This avoids re-querying and bypasses the leakage filter gap.
 * @param {object[]} rows   - from getTeamForm, filtered by date
 * @param {string}   team
 * @returns {object}
 */
function computeStatsFromForm(rows, team) {
  let wins = 0, draws = 0, losses = 0;
  let goalsFor = 0, goalsAgainst = 0;
  let homeWins = 0, homeMatches = 0;
  let awayWins = 0, awayMatches = 0;

  for (const r of rows) {
    const isHome = r.home_team.toLowerCase() === team.toLowerCase();
    if (isHome) {
      homeMatches++;
      if (r.result === "H") { wins++; homeWins++; }
      else if (r.result === "D") draws++;
      else losses++;
    } else {
      awayMatches++;
      if (r.result === "A") { wins++; awayWins++; }
      else if (r.result === "D") draws++;
      else losses++;
    }
    goalsFor     += r.goals_for     ?? (isHome ? r.home_goals : r.away_goals);
    goalsAgainst += r.goals_against ?? (isHome ? r.away_goals : r.home_goals);
  }

  const n = rows.length;
  const dates = rows.map(r => r.match_date).sort();
  const formStr = rows.map(r => r.team_result ?? (
    (r.home_team.toLowerCase() === team.toLowerCase())
      ? (r.result === "H" ? "W" : r.result === "D" ? "D" : "L")
      : (r.result === "A" ? "W" : r.result === "D" ? "D" : "L")
  )).join("");

  return {
    team,
    matches_played:    n,
    wins, draws, losses,
    goals_for:         goalsFor,
    goals_against:     goalsAgainst,
    goals_for_avg:     n > 0 ? +(goalsFor / n).toFixed(2)     : 0,
    goals_against_avg: n > 0 ? +(goalsAgainst / n).toFixed(2) : 0,
    win_rate:          n > 0 ? +(wins / n).toFixed(3)          : 0,
    home_win_rate:     homeMatches > 0 ? +(homeWins / homeMatches).toFixed(3) : 0,
    away_win_rate:     awayMatches > 0 ? +(awayWins / awayMatches).toFixed(3) : 0,
    home_matches:      homeMatches,
    away_matches:      awayMatches,
    form_string:       formStr,
    data_range_start:  dates[0] ?? null,
    data_range_end:    dates[dates.length - 1] ?? null,
  };
}
