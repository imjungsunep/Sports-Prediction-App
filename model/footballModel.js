/**
 * model/footballModel.js
 *
 * Deterministic football prediction model — Phase 2
 * Model type: "poisson_elo_blend"  Version: 2.0.0
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Algorithm
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Two independent signals are blended by data quality:
 *
 *   A. POISSON MODEL (primary, when ≥3 form matches per team)
 *      ├─ Estimate team lambda values (expected goals per match)
 *      │    λ_home = leagueAvgHome × (homeAttack / leagueAvgAttack)
 *      │                           × (awayDefence / leagueAvgDefence)
 *      │    λ_away = leagueAvgAway × (awayAttack  / leagueAvgAttack)
 *      │                           × (homeDefence / leagueAvgDefence)
 *      └─ Integrate Poisson PMF over score matrix (0–8 goals each)
 *         to get P(home win), P(draw), P(away win)
 *
 *   B. ELO-STYLE FORM BLEND (fallback/supplement)
 *      ├─ Convert recency-weighted form scores to Elo-style rating difference
 *      ├─ Apply home advantage offset
 *      └─ Logistic transform to win probability
 *
 *   BLEND WEIGHT (w):
 *      w_poisson = clamp(min(formMatchesA, formMatchesB) / 6, 0.20, 0.80)
 *      final_prob = w_poisson × poisson_result + (1 − w_poisson) × elo_result
 *
 *   H2H CORRECTION (when ≥3 H2H matches exist):
 *      final_prob = 0.85 × blended + 0.15 × h2h_historical_rates
 *      (H2H weight is scaled by recency_weight of H2H data)
 *
 * IMPORTANT: The LLM never touches these numbers. This file has no imports
 * from groq-sdk and no async functions.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { assertProbabilitiesSum, assertPercentagesSum,
         MODEL_VERSION, MODEL_TYPE } from "../agents/types.js";

// ─── League averages (EPL 2018–2024, all competitions in seed) ────────────────
const LEAGUE_AVG_HOME_GOALS  = 1.53;   // avg goals scored at home per match
const LEAGUE_AVG_AWAY_GOALS  = 1.15;   // avg goals scored away per match
const LEAGUE_AVG_HOME_WIN    = 0.454;
const LEAGUE_AVG_DRAW        = 0.265;
const LEAGUE_AVG_AWAY_WIN    = 0.281;

// Minimum probability floor for any outcome (prevents 0% probability)
const FLOOR = 0.05;

// ─── Poisson PMF ─────────────────────────────────────────────────────────────

/** Poisson probability mass function: P(X = k | λ) */
function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // Use log-space to avoid overflow for large k
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Integrate Poisson score matrix to get P(home win), P(draw), P(away win).
 * Considers all score combinations 0–maxGoals for each team.
 * @param {number} lambdaHome
 * @param {number} lambdaAway
 * @param {number} [maxGoals=8]
 * @returns {{ pHome: number, pDraw: number, pAway: number }}
 */
export function poissonMatchProbs(lambdaHome, lambdaAway, maxGoals = 8) {
  let pHome = 0, pDraw = 0, pAway = 0;
  for (let h = 0; h <= maxGoals; h++) {
    const pH = poissonPMF(lambdaHome, h);
    for (let a = 0; a <= maxGoals; a++) {
      const pA = poissonPMF(lambdaAway, a);
      const joint = pH * pA;
      if      (h > a) pHome += joint;
      else if (h < a) pAway += joint;
      else            pDraw += joint;
    }
  }
  return { pHome, pDraw, pAway };
}

// ─── Expected goals estimation ────────────────────────────────────────────────

/**
 * Estimate lambda (expected goals) for each team using Dixon-Coles-style
 * attack/defence ratings derived from recent form.
 *
 * @param {object} reportA - TeamPerformanceMetrics
 * @param {object} reportB - TeamPerformanceMetrics
 * @param {'team_a'|'team_b'|null} venueHost
 * @returns {{ lambdaA: number, lambdaB: number }}
 */
export function estimateLambdas(reportA, reportB, venueHost) {
  // Normalise attack/defence relative to league average
  const baseHome = venueHost === "team_a" ? LEAGUE_AVG_HOME_GOALS : LEAGUE_AVG_AWAY_GOALS;
  const baseAway = venueHost === "team_b" ? LEAGUE_AVG_HOME_GOALS : LEAGUE_AVG_AWAY_GOALS;

  // Attack strength: ratio of team avg scored vs league avg
  const attackA  = reportA.attack_strength  > 0
    ? reportA.attack_strength  / LEAGUE_AVG_HOME_GOALS : 1.0;
  const attackB  = reportB.attack_strength  > 0
    ? reportB.attack_strength  / LEAGUE_AVG_AWAY_GOALS : 1.0;

  // Defence strength: ratio of league avg vs team avg conceded (lower concede = higher strength)
  const defenceA = reportA.defence_strength > 0
    ? LEAGUE_AVG_AWAY_GOALS / reportA.defence_strength : 1.0;
  const defenceB = reportB.defence_strength > 0
    ? LEAGUE_AVG_HOME_GOALS / reportB.defence_strength : 1.0;

  const lambdaA = Math.max(0.1, baseHome * attackA * defenceB);
  const lambdaB = Math.max(0.1, baseAway * attackB * defenceA);

  return { lambdaA: +lambdaA.toFixed(4), lambdaB: +lambdaB.toFixed(4) };
}

// ─── Elo-style fallback ───────────────────────────────────────────────────────

/**
 * Convert form scores and home advantage into win probabilities via
 * a logistic function (Elo-style).
 *
 * @param {number} formA  - [-1, 1]
 * @param {number} formB  - [-1, 1]
 * @param {number} homeAdvantage - 0..1; 0.5 = neutral
 * @returns {{ pHome: number, pDraw: number, pAway: number }}
 */
export function eloStyleProbs(formA, formB, homeAdvantage) {
  // Convert form score to an Elo-like rating offset (scale: 400 pts = win rate 0.91)
  const ratingA = formA * 200;
  const ratingB = formB * 200;

  // Add home advantage in Elo points (roughly +50 at home)
  const homeBonus = (homeAdvantage - 0.5) * 200;
  const diff = (ratingA + homeBonus) - ratingB;

  // Logistic transform to P(A wins)
  const pAWin = 1 / (1 + Math.pow(10, -diff / 400));

  // Draw probability: peaks when ratings are equal, falls off with distance
  // Based on empirical draw rate model: P(draw) ≈ 0.27 × e^(-0.0003 × diff²)
  const pDraw = Math.max(FLOOR, LEAGUE_AVG_DRAW * Math.exp(-0.0003 * diff * diff));

  // Distribute remainder between wins
  const remainder = Math.max(0, 1 - pDraw);
  const pHome = pAWin * remainder;
  const pAway = (1 - pAWin) * remainder;

  return { pHome, pDraw, pAway };
}

// ─── Normalise to sum to 1 ────────────────────────────────────────────────────

/**
 * Apply floor and normalise three raw probabilities to sum to exactly 1.
 * @param {number} a
 * @param {number} d
 * @param {number} b
 * @returns {{ a: number, d: number, b: number }}
 */
function normalise(a, d, b) {
  const fa = Math.max(FLOOR, a);
  const fd = Math.max(FLOOR, d);
  const fb = Math.max(FLOOR, b);
  const s  = fa + fd + fb;
  return { a: fa/s, d: fd/s, b: fb/s };
}

// ─── Integer percentage rounding (sum = 100) ──────────────────────────────────

/**
 * Round three floats to integers summing to exactly 100.
 * Uses largest-remainder method.
 * @param {number} a  - 0..1
 * @param {number} d  - 0..1
 * @param {number} b  - 0..1
 * @returns {{ pctA: number, pctD: number, pctB: number }}
 */
export function toIntPercents(a, d, b) {
  const floored = [Math.floor(a*100), Math.floor(d*100), Math.floor(b*100)];
  const remainders = [a*100 - floored[0], d*100 - floored[1], b*100 - floored[2]];
  let sum = floored.reduce((x, y) => x + y, 0);
  const order = [0, 1, 2].sort((i, j) => remainders[j] - remainders[i]);
  for (const i of order) {
    if (sum >= 100) break;
    floored[i]++;
    sum++;
  }
  assertPercentagesSum(floored[0], floored[1], floored[2]);
  return { pctA: floored[0], pctD: floored[1], pctB: floored[2] };
}

// ─── Confidence from probability separation ───────────────────────────────────

/**
 * Compute confidence label from BOTH data quality AND probability separation.
 * Neither alone is sufficient.
 * @param {number}  dataQualityScore  - 0..1
 * @param {number}  separation        - |pA - pB| raw probability
 * @returns {{ label: import('../agents/types.js').ConfidenceLabel, score: number }}
 */
export function computeConfidence(dataQualityScore, separation) {
  // Combine: must be both data-rich and strongly separated to earn "High"
  const combined = 0.6 * dataQualityScore + 0.4 * Math.min(separation / 0.30, 1.0);
  const score    = +Math.min(1, combined).toFixed(3);
  const label    = score >= 0.72 ? "High"
                 : score >= 0.48 ? "Medium"
                 : score >= 0.20 ? "Low"
                 : "Insufficient";
  return { label, score };
}

// ─── Main model ───────────────────────────────────────────────────────────────

/**
 * Compute a full PredictionSchema from a PerformanceReport + DataBundle.
 * This is the ONLY function allowed to produce probability numbers.
 * No LLM. Deterministic. Testable.
 *
 * @param {import('../agents/types.js').DataBundle}         bundle
 * @param {import('../agents/types.js').PerformanceReport}  report
 * @returns {import('../agents/types.js').PredictionSchema}
 */
export function computeFootballPrediction(bundle, report) {
  const { team_a, team_b, data_quality } = bundle;
  const { team_a_metrics: mA, team_b_metrics: mB,
          h2h_metrics, home_advantage_factor, feature_values } = report;

  const minForm = Math.min(mA.matches_used, mB.matches_used);
  const hasEnoughForPoisson = minForm >= 3;

  // ── A: Poisson probabilities ──────────────────────────────────────────────
  let poissonResult = null;
  let lambdaA = null, lambdaB = null;

  if (hasEnoughForPoisson) {
    ({ lambdaA, lambdaB } = estimateLambdas(mA, mB, bundle.venue_host));
    const { pHome, pDraw, pAway } = poissonMatchProbs(lambdaA, lambdaB);
    const n = normalise(pHome, pDraw, pAway);
    assertProbabilitiesSum(n.a, n.d, n.b);
    poissonResult = n;
  }

  // ── B: Elo-style probabilities ────────────────────────────────────────────
  const { pHome: eH, pDraw: eD, pAway: eA } =
    eloStyleProbs(mA.form_score, mB.form_score, home_advantage_factor);
  const eloN = normalise(eH, eD, eA);
  assertProbabilitiesSum(eloN.a, eloN.d, eloN.b);

  // ── C: Blend ──────────────────────────────────────────────────────────────
  const wPoisson = hasEnoughForPoisson
    ? Math.min(0.80, Math.max(0.20, minForm / 6))
    : 0;
  const wElo = 1 - wPoisson;

  const p = poissonResult ?? { a: 0, d: 0, b: 0 };
  let blA = wPoisson * p.a + wElo * eloN.a;
  let blD = wPoisson * p.d + wElo * eloN.d;
  let blB = wPoisson * p.b + wElo * eloN.b;

  // ── D: H2H correction ────────────────────────────────────────────────────
  if (h2h_metrics.total >= 3) {
    const h2hDrawRate = h2h_metrics.draws / h2h_metrics.total;
    const h2hAWin     = h2h_metrics.team_a_win_rate;
    const h2hBWin     = 1 - h2hAWin - h2hDrawRate;
    const h2hW        = 0.15 * h2h_metrics.recency_weight;
    blA = (1 - h2hW) * blA + h2hW * h2hAWin;
    blD = (1 - h2hW) * blD + h2hW * h2hDrawRate;
    blB = (1 - h2hW) * blB + h2hW * h2hBWin;
  }

  // ── E: Final normalise + floor ────────────────────────────────────────────
  const final = normalise(blA, blD, blB);
  assertProbabilitiesSum(final.a, final.d, final.b);

  // ── F: Integer percentages ────────────────────────────────────────────────
  const { pctA, pctD, pctB } = toIntPercents(final.a, final.d, final.b);

  // ── G: Winner determination ───────────────────────────────────────────────
  // Never fabricate a winner when separation is minimal
  const separation    = Math.abs(final.a - final.b);
  const hasWinner     = separation > 0.04;
  const predicted     = !hasWinner          ? "Draw" :
                        final.a > final.b   ? team_a : team_b;

  // ── H: Confidence ─────────────────────────────────────────────────────────
  const { label: confLabel, score: confScore } =
    computeConfidence(data_quality.score, separation);

  // ── I: Caveats ────────────────────────────────────────────────────────────
  const caveats = [...data_quality.warnings];
  if (!hasEnoughForPoisson)
    caveats.push("Insufficient form data for Poisson model; Elo-only estimate used.");
  if (separation <= 0.04)
    caveats.push("Teams are closely matched; outcome is uncertain and any result is plausible.");
  if (confScore < 0.48)
    caveats.push("Low data confidence. Treat this prediction as indicative only.");

  return {
    model_version:     MODEL_VERSION,
    model_type:        MODEL_TYPE,
    predicted_winner:  predicted,
    winner_is_certain: hasWinner && confLabel !== "Insufficient",
    probabilities: {
      team_a_win:  +final.a.toFixed(4),
      draw:        +final.d.toFixed(4),
      team_b_win:  +final.b.toFixed(4),
      team_a_pct:  pctA,
      draw_pct:    pctD,
      team_b_pct:  pctB,
    },
    expected_goals: {
      team_a_xg: lambdaA,
      team_b_xg: lambdaB,
      method:    hasEnoughForPoisson ? "poisson" : "elo_only",
    },
    confidence:        confLabel,
    confidence_score:  confScore,
    separation:        +separation.toFixed(4),
    data_quality:      data_quality,
    feature_values,
    source_citations:  bundle.sources,
    caveats,
  };
}

// ─── Key factors for explainability ──────────────────────────────────────────

/**
 * Compute a ranked list of factors that contributed most to the prediction,
 * with direction (positive = favours team_a, negative = favours team_b)
 * and a normalised contribution magnitude 0..1.
 *
 * Returns an array sorted by |contribution| descending.
 * Every factor includes the raw evidence value so the UI can cite it.
 *
 * @param {import('../agents/types.js').DataBundle}        bundle
 * @param {import('../agents/types.js').PerformanceReport} report
 * @param {import('../agents/types.js').PredictionSchema}  prediction
 * @returns {KeyFactor[]}
 *
 * @typedef {Object} KeyFactor
 * @property {string}  factor        - human-readable label
 * @property {string}  category      - "form" | "h2h" | "attack" | "defence" | "venue" | "data"
 * @property {number}  contribution  - -1..1, positive favours team_a, negative favours team_b
 * @property {string}  direction     - "favours_a" | "favours_b" | "neutral"
 * @property {string}  evidence      - short human-readable evidence string
 * @property {number}  magnitude     - 0..1 normalised for bar charts
 */
export function computeKeyFactors(bundle, report, prediction) {
  const { team_a, team_b } = bundle;
  const mA = report.team_a_metrics;
  const mB = report.team_b_metrics;
  const h2h = report.h2h_metrics;
  const factors = [];

  // 1. Recent form score difference
  const formDiff = mA.form_score - mB.form_score;
  if (mA.matches_used > 0 || mB.matches_used > 0) {
    factors.push({
      factor: "Recent Form",
      category: "form",
      contribution: +(formDiff).toFixed(3),
      direction: formDiff > 0.05 ? "favours_a" : formDiff < -0.05 ? "favours_b" : "neutral",
      evidence: `${team_a} form score ${mA.form_score.toFixed(2)} vs ${team_b} ${mB.form_score.toFixed(2)} (last ${Math.max(mA.matches_used, mB.matches_used)} matches)`,
      magnitude: Math.min(1, Math.abs(formDiff)),
    });
  }

  // 2. Attack strength
  const atkDiff = mA.attack_strength - mB.attack_strength;
  if (mA.attack_strength > 0 || mB.attack_strength > 0) {
    factors.push({
      factor: "Attacking Strength",
      category: "attack",
      contribution: +(atkDiff / 3).toFixed(3),   // normalise: 3 goals/game = full swing
      direction: atkDiff > 0.2 ? "favours_a" : atkDiff < -0.2 ? "favours_b" : "neutral",
      evidence: `${team_a} avg ${mA.attack_strength.toFixed(2)} goals/game vs ${team_b} ${mB.attack_strength.toFixed(2)}`,
      magnitude: Math.min(1, Math.abs(atkDiff) / 2),
    });
  }

  // 3. Defensive strength (lower conceded = better)
  const defDiff = mB.defence_strength - mA.defence_strength;  // positive = A concedes less
  if (mA.defence_strength > 0 || mB.defence_strength > 0) {
    factors.push({
      factor: "Defensive Resilience",
      category: "defence",
      contribution: +(defDiff / 3).toFixed(3),
      direction: defDiff > 0.2 ? "favours_a" : defDiff < -0.2 ? "favours_b" : "neutral",
      evidence: `${team_a} concedes avg ${mA.defence_strength.toFixed(2)}/game vs ${team_b} ${mB.defence_strength.toFixed(2)}`,
      magnitude: Math.min(1, Math.abs(defDiff) / 2),
    });
  }

  // 4. H2H record
  if (h2h.total >= 2) {
    const h2hBias = h2h.team_a_win_rate - (1 - h2h.team_a_win_rate - h2h.draws / h2h.total);
    factors.push({
      factor: "Head-to-Head Record",
      category: "h2h",
      contribution: +(h2hBias * h2h.recency_weight).toFixed(3),
      direction: h2hBias > 0.1 ? "favours_a" : h2hBias < -0.1 ? "favours_b" : "neutral",
      evidence: `${h2h.team_a_wins}W–${h2h.draws}D–${h2h.team_b_wins}L in last ${h2h.total} meetings (${team_a} perspective)`,
      magnitude: Math.min(1, Math.abs(h2hBias) * h2h.recency_weight),
    });
  }

  // 5. Home advantage
  const haf = report.home_advantage_factor;
  const homeContrib = (haf - 0.5) * 2;  // -1..1
  if (bundle.venue_host) {
    const host = bundle.venue_host === "team_a" ? team_a : team_b;
    factors.push({
      factor: "Home Advantage",
      category: "venue",
      contribution: +(homeContrib).toFixed(3),
      direction: homeContrib > 0.05 ? "favours_a" : homeContrib < -0.05 ? "favours_b" : "neutral",
      evidence: `${host} playing at home (factor ${haf.toFixed(2)})`,
      magnitude: Math.min(1, Math.abs(homeContrib) * 0.8),
    });
  }

  // 6. Expected goals gap (if Poisson ran)
  const xg = prediction.expected_goals;
  if (xg.method === "poisson" && xg.team_a_xg != null && xg.team_b_xg != null) {
    const xgDiff = xg.team_a_xg - xg.team_b_xg;
    factors.push({
      factor: "Expected Goals (xG)",
      category: "attack",
      contribution: +(xgDiff / 2).toFixed(3),
      direction: xgDiff > 0.2 ? "favours_a" : xgDiff < -0.2 ? "favours_b" : "neutral",
      evidence: `${team_a} λ=${xg.team_a_xg.toFixed(2)} vs ${team_b} λ=${xg.team_b_xg.toFixed(2)} (Poisson)`,
      magnitude: Math.min(1, Math.abs(xgDiff) / 2),
    });
  }

  // Sort by magnitude descending
  factors.sort((a, b) => b.magnitude - a.magnitude);
  return factors;
}
