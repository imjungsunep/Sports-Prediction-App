/**
 * model/probabilityModel.js
 *
 * Deterministic statistical model for football win-probability estimation.
 *
 * Algorithm (Dixon–Coles inspired, simplified for local computation):
 *
 *   1. Compute base win rates from H2H records.
 *   2. Compute recent form score (-1 to +1) from last-N results.
 *   3. Apply home advantage multiplier when venue_host is known.
 *   4. Blend all three signals with fixed weights.
 *   5. Normalise to sum to exactly 100.
 *
 * IMPORTANT: This function is deterministic — same inputs always produce the
 * same output. The LLM never generates or modifies these numbers.
 *
 * Exported functions:
 *   computeProbabilities(bundle)  → ProbabilityResult
 *   formScore(formRows, team)     → number (-1 to 1)
 */

// ─── Weights ──────────────────────────────────────────────────────────────────

const WEIGHT_H2H  = 0.40;   // head-to-head historical record
const WEIGHT_FORM = 0.45;   // recent form (last N)
const WEIGHT_HOME = 0.15;   // home advantage

// Home advantage: historical EPL home win rate ≈ 46%
// We apply a +8 percentage-point boost to the hosting team's raw probability
const HOME_ADVANTAGE_BOOST = 0.08;

// Minimum raw probability floor — avoids 0% outputs
const FLOOR = 0.05;

// ─── Form score ───────────────────────────────────────────────────────────────

/**
 * Convert a list of recent-form rows (as returned by getTeamForm) into a
 * normalised score in the range [-1, 1].
 *
 * W = +1 point, D = 0 points, L = -1 point.
 * More recent matches are weighted slightly more (linear decay).
 *
 * @param {Array<{team_result: string}>} formRows  - ordered newest first
 * @returns {number}  score in [-1, 1]
 */
export function formScore(formRows) {
  if (!formRows || formRows.length === 0) return 0;
  let weightedSum = 0;
  let totalWeight = 0;
  formRows.forEach((row, i) => {
    // Recency weight: most recent (i=0) gets full weight, oldest gets 0.5
    const recencyWeight = 1.0 - (i / (formRows.length * 2));
    const result = row.team_result ?? row.result;
    const pts = result === "W" ? 1 : result === "D" ? 0 : -1;
    weightedSum += pts * recencyWeight;
    totalWeight += recencyWeight;
  });
  return totalWeight > 0 ? Math.max(-1, Math.min(1, weightedSum / totalWeight)) : 0;
}

// ─── H2H summary ─────────────────────────────────────────────────────────────

/**
 * Compute H2H win rates from a list of H2H rows.
 * @param {MatchRow[]} h2hRows
 * @param {string} teamA
 * @param {string} teamB
 * @returns {{ aWinRate: number, bWinRate: number, drawRate: number, total: number }}
 */
export function h2hRates(h2hRows, teamA, teamB) {
  const total = h2hRows.length;
  if (total === 0) {
    return { aWinRate: 1/3, bWinRate: 1/3, drawRate: 1/3, total: 0 };
  }

  let aWins = 0, bWins = 0, draws = 0;
  const aLower = teamA.toLowerCase();
  const bLower = teamB.toLowerCase();

  for (const row of h2hRows) {
    const homeIsA = row.home_team.toLowerCase() === aLower;
    const r = row.result; // H, A, D
    if (r === "D") { draws++; }
    else if ((r === "H" && homeIsA) || (r === "A" && !homeIsA)) { aWins++; }
    else { bWins++; }
  }

  return {
    aWinRate: aWins / total,
    bWinRate: bWins / total,
    drawRate:  draws / total,
    total,
  };
}

// ─── Main model ───────────────────────────────────────────────────────────────

/**
 * Compute win probabilities from a RetrievalBundle.
 *
 * @param {object} bundle - as returned by retrievalService.retrieve()
 * @returns {{ team_a_pct: number, team_b_pct: number, draw_pct: number,
 *             confidence: 'High'|'Medium'|'Low', model_inputs: object }}
 */
export function computeProbabilities(bundle) {
  const { team_a, team_b, head_to_head, team_a_form, team_b_form,
          home_form_a, away_form_b, home_form_b, away_form_a, venue_host } = bundle;

  // ── Signal 1: H2H rates ──────────────────────────────────────────────────────
  const { aWinRate: h2hA, bWinRate: h2hB, drawRate: h2hD, total: h2hTotal } =
    h2hRates(head_to_head ?? [], team_a, team_b);

  // ── Signal 2: Form scores ────────────────────────────────────────────────────
  // Use venue-specific form when we know who is hosting
  const formRowsA = venue_host === "team_a" ? (home_form_a ?? team_a_form) : team_a_form;
  const formRowsB = venue_host === "team_b" ? (home_form_b ?? team_b_form) : team_b_form;

  const fA = formScore(formRowsA ?? []);  // -1 to 1
  const fB = formScore(formRowsB ?? []);  // -1 to 1

  // Convert form scores to probability-space contributions
  // Map [-1,1] → [0.25, 0.75] for win probability estimate
  const formProbA = 0.25 + ((fA + 1) / 2) * 0.50;
  const formProbB = 0.25 + ((fB + 1) / 2) * 0.50;

  // Draw probability from form: when both teams are in similar form, draw is more likely
  const formSimilarity = 1 - Math.abs(fA - fB);
  // Base draw probability ~0.27 (EPL historical), adjusted up when forms are similar
  const formProbD = 0.20 + formSimilarity * 0.15;

  // Normalise form contributions
  const formSum = formProbA + formProbB + formProbD;
  const fNormA  = formProbA / formSum;
  const fNormB  = formProbB / formSum;
  const fNormD  = formProbD / formSum;

  // ── Signal 3: Home advantage ──────────────────────────────────────────────────
  // home/away flat base (0.46 home, 0.27 draw, 0.27 away based on EPL averages)
  let homeContribA = 1/3;
  let homeContribB = 1/3;
  let homeContribD = 1/3;

  if (venue_host === "team_a") {
    homeContribA = 0.46; homeContribD = 0.27; homeContribB = 0.27;
  } else if (venue_host === "team_b") {
    homeContribB = 0.46; homeContribD = 0.27; homeContribA = 0.27;
  }

  // ── Blend signals ────────────────────────────────────────────────────────────
  // If H2H data is sparse, reduce its weight and increase form weight
  const h2hWeight   = h2hTotal > 0 ? WEIGHT_H2H : 0;
  const formWeight  = h2hTotal > 0 ? WEIGHT_FORM : WEIGHT_FORM + WEIGHT_H2H;
  const homeWeight  = WEIGHT_HOME;

  let rawA = h2hWeight * h2hA + formWeight * fNormA + homeWeight * homeContribA;
  let rawB = h2hWeight * h2hB + formWeight * fNormB + homeWeight * homeContribB;
  let rawD = h2hWeight * h2hD + formWeight * fNormD + homeWeight * homeContribD;

  // Apply probability floor
  rawA = Math.max(FLOOR, rawA);
  rawB = Math.max(FLOOR, rawB);
  rawD = Math.max(FLOOR, rawD);

  // Normalise to sum to 1
  const total = rawA + rawB + rawD;
  rawA /= total;
  rawB /= total;
  rawD /= total;

  // Convert to integer percentages summing to exactly 100
  let pctA = Math.round(rawA * 100);
  let pctB = Math.round(rawB * 100);
  let pctD = 100 - pctA - pctB;

  // Edge-case: if rounding pushes pctD below floor, redistribute
  if (pctD < Math.round(FLOOR * 100)) {
    pctD = Math.round(FLOOR * 100);
    // Split the deficit proportionally
    const deficit = pctA + pctB + pctD - 100;
    if (pctA >= pctB) pctA -= deficit;
    else              pctB -= deficit;
  }

  // Determine confidence label
  const leader = Math.max(pctA, pctB);
  const confidence = leader >= 60 ? "High" : leader >= 50 ? "Medium" : "Low";

  return {
    team_a_pct: pctA,
    team_b_pct: pctB,
    draw_pct:   pctD,
    confidence,
    // Include model inputs for transparency / XAI
    model_inputs: {
      h2h_total:       h2hTotal,
      h2h_win_rate_a:  +h2hA.toFixed(3),
      h2h_win_rate_b:  +h2hB.toFixed(3),
      h2h_draw_rate:   +h2hD.toFixed(3),
      form_score_a:    +fA.toFixed(3),
      form_score_b:    +fB.toFixed(3),
      venue_host:      venue_host ?? "neutral",
      weights: { h2h: h2hWeight, form: formWeight, home: homeWeight },
    },
  };
}
