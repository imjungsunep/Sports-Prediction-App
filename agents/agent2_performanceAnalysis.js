/**
 * agents/agent2_performanceAnalysis.js
 *
 * Agent 2 — Performance Analysis Agent  (pure computation, NO LLM)
 *
 * Takes a DataBundle and produces a PerformanceReport with:
 *   • Recency-weighted form score per team
 *   • Attack strength (goals scored avg, recency-weighted)
 *   • Defence strength (goals conceded avg, lower = better)
 *   • Home/away split win rates
 *   • Head-to-head metrics with recency weighting
 *   • Rest days since last match
 *   • Home-advantage factor (based on venue_host + empirical home win rates)
 *   • Data confidence label driven by DataQualityScore
 *   • All feature_values bundled for model consumption
 *
 * Input:  DataBundle       (agents/types.js)
 * Output: PerformanceReport (agents/types.js)
 */

import { MODEL_VERSION } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// EPL empirical averages (post-2015 seasons)
const EPL_HOME_WIN_RATE  = 0.454;
const EPL_DRAW_RATE      = 0.265;
const EPL_AWAY_WIN_RATE  = 0.281;

// Recency decay: weight for each game back from most recent
// Game 1 (most recent) = 1.0, game N gets max(0.3, 1 - 0.07*(N-1))
const RECENCY_DECAY_PER_GAME = 0.07;
const RECENCY_MIN_WEIGHT     = 0.30;

// H2H recency: reduce H2H relevance weight if oldest H2H match is >3 years old
const H2H_AGE_PENALTY_THRESHOLD_DAYS = 3 * 365;

// ─── Recency-weighted form ────────────────────────────────────────────────────

/**
 * Recency-decayed form score for a team. Rows must be sorted newest-first.
 * Returns [-1, 1].
 * @param {object[]} rows
 * @returns {number}
 */
export function recencyWeightedFormScore(rows) {
  if (!rows || rows.length === 0) return 0;
  let weightedSum = 0;
  let totalWeight = 0;
  rows.forEach((r, i) => {
    const w   = Math.max(RECENCY_MIN_WEIGHT, 1.0 - RECENCY_DECAY_PER_GAME * i);
    const tr  = r.team_result ?? "D";
    const pts = tr === "W" ? 1 : tr === "L" ? -1 : 0;
    weightedSum += pts * w;
    totalWeight += w;
  });
  return totalWeight > 0 ? Math.max(-1, Math.min(1, weightedSum / totalWeight)) : 0;
}

/**
 * Recency-weighted goals average. Returns 0 if no rows.
 * @param {'for'|'against'} direction
 * @param {object[]} rows
 * @returns {number}
 */
export function recencyWeightedGoals(direction, rows) {
  if (!rows || rows.length === 0) return 0;
  let wSum = 0;
  let wTotal = 0;
  rows.forEach((r, i) => {
    const w = Math.max(RECENCY_MIN_WEIGHT, 1.0 - RECENCY_DECAY_PER_GAME * i);
    const g = direction === "for"
      ? (r.goals_for     ?? (r.home_goals ?? 0))
      : (r.goals_against ?? (r.away_goals ?? 0));
    wSum   += g * w;
    wTotal += w;
  });
  return wTotal > 0 ? +(wSum / wTotal).toFixed(3) : 0;
}

// ─── Rest days ────────────────────────────────────────────────────────────────

/**
 * Days between the most-recent form match and fixture_date (or today).
 * Returns null if no form matches.
 * @param {object[]} formRows  - sorted newest-first
 * @param {string|null} fixtureDateStr
 * @returns {number|null}
 */
function restDays(formRows, fixtureDateStr) {
  if (!formRows || formRows.length === 0) return null;
  const latest    = formRows[0].match_date;
  const reference = fixtureDateStr ?? new Date().toISOString().slice(0, 10);
  const diff = (new Date(reference).getTime() - new Date(latest).getTime()) / 86_400_000;
  return Math.round(diff);
}

// ─── H2H metrics ─────────────────────────────────────────────────────────────

/**
 * Build H2HMetrics from filtered H2H rows.
 * @param {object[]} h2hRows  sorted newest-first
 * @param {string}   teamA
 * @param {string}   teamB
 * @returns {import('./types.js').H2HMetrics}
 */
export function buildH2HMetrics(h2hRows, teamA, teamB) {
  const total = h2hRows.length;
  if (total === 0) {
    return { total: 0, team_a_wins: 0, team_b_wins: 0, draws: 0,
             team_a_win_rate: 0, recency_weight: 0, sample: [] };
  }

  let aWins = 0, bWins = 0, draws = 0;
  const aLc = teamA.toLowerCase();

  for (const r of h2hRows) {
    const homeIsA = r.home_team.toLowerCase() === aLc;
    if      (r.result === "D")                          draws++;
    else if ((r.result === "H") === homeIsA)            aWins++;
    else                                                bWins++;
  }

  // Recency weight: how current is this H2H data?
  const oldest    = h2hRows[h2hRows.length - 1]?.match_date ?? "2000-01-01";
  const ageMs     = Date.now() - new Date(oldest).getTime();
  const ageDays   = ageMs / 86_400_000;
  const recencyW  = ageDays <= H2H_AGE_PENALTY_THRESHOLD_DAYS ? 1.0
                  : Math.max(0.3, 1.0 - (ageDays - H2H_AGE_PENALTY_THRESHOLD_DAYS) / (5 * 365));

  return {
    total,
    team_a_wins:      aWins,
    team_b_wins:      bWins,
    draws,
    team_a_win_rate:  total > 0 ? +(aWins / total).toFixed(3) : 0,
    recency_weight:   +recencyW.toFixed(3),
    sample:           h2hRows.slice(0, 5),
  };
}

// ─── Team metrics ─────────────────────────────────────────────────────────────

/**
 * Build TeamPerformanceMetrics for a single team from form rows.
 * @param {object[]} formRows      - all form (home + away), newest-first
 * @param {object[]} homeFormRows  - home-only form, newest-first
 * @param {object[]} awayFormRows  - away-only form, newest-first
 * @param {string|null} fixtureDateStr
 * @returns {import('./types.js').TeamPerformanceMetrics}
 */
export function buildTeamMetrics(formRows, homeFormRows, awayFormRows, fixtureDateStr) {
  const stats = formRows.reduce((acc, r) => {
    const isHome = r.team_result !== undefined;  // team_result field means getTeamForm was used
    acc.total++;
    const tr = r.team_result ?? "D";
    if (tr === "W") acc.wins++;
    else if (tr === "D") acc.draws++;
    else acc.losses++;
    acc.gf += r.goals_for     ?? 0;
    acc.ga += r.goals_against ?? 0;
    return acc;
  }, { total: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0 });

  const n = stats.total;

  return {
    form_score:       recencyWeightedFormScore(formRows),
    attack_strength:  recencyWeightedGoals("for",     formRows),
    defence_strength: recencyWeightedGoals("against", formRows),
    home_win_rate:    homeFormRows.length > 0
      ? +(homeFormRows.filter(r=>(r.team_result??"")===("W")).length / homeFormRows.length).toFixed(3)
      : 0,
    away_win_rate:    awayFormRows.length > 0
      ? +(awayFormRows.filter(r=>(r.team_result??"")===("W")).length / awayFormRows.length).toFixed(3)
      : 0,
    overall_win_rate: n > 0 ? +(stats.wins / n).toFixed(3) : 0,
    rest_days:        restDays(formRows, fixtureDateStr),
    form_string:      formRows.map(r => r.team_result ?? "?").join(""),
    matches_used:     n,
  };
}

// ─── Home-advantage factor ────────────────────────────────────────────────────

/**
 * Returns a 0..1 factor for team_a's home advantage.
 *   0.5 = neutral, >0.5 = home advantage for A, <0.5 = home advantage for B
 * @param {'team_a'|'team_b'|null} venue_host
 * @param {number} teamAHomeWinRate   - team A's actual home win rate (or 0 if unknown)
 * @returns {number}
 */
export function homeAdvantageFactor(venue_host, teamAHomeWinRate) {
  if (!venue_host) return 0.5;
  const empirical = venue_host === "team_a"
    ? Math.max(EPL_HOME_WIN_RATE, teamAHomeWinRate)
    : 1 - Math.max(EPL_HOME_WIN_RATE, teamAHomeWinRate);
  return +Math.max(0.3, Math.min(0.7, empirical)).toFixed(3);
}

// ─── Confidence from data quality ────────────────────────────────────────────

/**
 * Convert a DataQualityScore into a ConfidenceLabel.
 * @param {import('./types.js').DataQualityScore} dq
 * @returns {import('./types.js').ConfidenceLabel}
 */
function qualityToConfidence(dq) {
  if (dq.label === "Excellent" || dq.label === "Good") return "High";
  if (dq.label === "Fair")                             return "Medium";
  if (dq.label === "Sparse")                          return "Low";
  return "Insufficient";
}

// ─── Main agent ───────────────────────────────────────────────────────────────

/**
 * @param {import('./types.js').DataBundle} bundle
 * @returns {import('./types.js').PerformanceReport}
 */
export function performanceAnalysisAgent(bundle) {
  const {
    team_a, team_b, venue_host, fixture_date,
    team_a_form, team_b_form,
    home_form_a, away_form_a,
    home_form_b, away_form_b,
    head_to_head, data_quality,
  } = bundle;

  const metricsA = buildTeamMetrics(
    team_a_form, home_form_a, away_form_a, fixture_date
  );
  const metricsB = buildTeamMetrics(
    team_b_form, home_form_b, away_form_b, fixture_date
  );
  const h2h      = buildH2HMetrics(head_to_head, team_a, team_b);
  const homeAdv  = homeAdvantageFactor(venue_host, metricsA.home_win_rate);
  const conf     = qualityToConfidence(data_quality);

  return {
    team_a_metrics:         metricsA,
    team_b_metrics:         metricsB,
    h2h_metrics:            h2h,
    home_advantage_factor:  homeAdv,
    data_confidence:        conf,
    feature_values: {
      team_a_form_score:        metricsA.form_score,
      team_b_form_score:        metricsB.form_score,
      team_a_attack:            metricsA.attack_strength,
      team_b_attack:            metricsB.attack_strength,
      team_a_defence:           metricsA.defence_strength,
      team_b_defence:           metricsB.defence_strength,
      team_a_home_win_rate:     metricsA.home_win_rate,
      team_b_away_win_rate:     metricsB.away_win_rate,
      team_a_away_win_rate:     metricsA.away_win_rate,
      team_b_home_win_rate:     metricsB.home_win_rate,
      h2h_total:                h2h.total,
      h2h_team_a_win_rate:      h2h.team_a_win_rate,
      h2h_recency_weight:       h2h.recency_weight,
      home_advantage_factor:    homeAdv,
      team_a_rest_days:         metricsA.rest_days,
      team_b_rest_days:         metricsB.rest_days,
      data_quality_score:       data_quality.score,
    },
  };
}
