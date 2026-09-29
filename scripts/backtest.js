/**
 * scripts/backtest.js
 *
 * Standalone backtest script.
 * Evaluates the Phase 2 Poisson+Elo model on every match in the database
 * using temporal leave-one-out cross-validation (no data leakage).
 *
 * Usage:
 *   node scripts/backtest.js
 *   node scripts/backtest.js --limit 100
 *   node scripts/backtest.js --csv        # output CSV to stdout
 *
 * Metrics:
 *   accuracy     — fraction of matches where predicted_winner = actual winner
 *   brier_score  — mean-squared error of the 3-outcome probability vector
 *                  (0 = perfect, 1 = maximally wrong; random = ~0.667)
 *   calibration  — per-outcome |mean_predicted_prob − empirical_frequency|
 *
 * Note on sample size: the seed dataset contains ~90 matches. With temporal
 * holdout, early matches have no prior data and are predicted at near-chance,
 * pulling accuracy toward base rate. This is correct behaviour — it reflects
 * real uncertainty, not a model deficiency.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb }                     from "../db/schema.js";
import { dataCollectionAgent }       from "../agents/agent1_dataCollection.js";
import { performanceAnalysisAgent }  from "../agents/agent2_performanceAnalysis.js";
import { predictionAgent }           from "../agents/agent3_predictionAgent.js";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const LIMIT_FLAG  = process.argv.indexOf("--limit");
const LIMIT       = LIMIT_FLAG >= 0 ? parseInt(process.argv[LIMIT_FLAG + 1], 10) : 200;
const CSV_MODE    = process.argv.includes("--csv");

// ─── Main ─────────────────────────────────────────────────────────────────────

const db = getDb();

const matches = db.prepare(`
  SELECT m.id, m.match_date, m.result,
         ht.name AS home_team, at.name AS away_team,
         m.home_goals, m.away_goals
  FROM matches m
  JOIN teams ht ON ht.id = m.home_team_id
  JOIN teams at ON at.id = m.away_team_id
  ORDER BY m.match_date ASC
  LIMIT $n
`).all({ n: LIMIT });

if (matches.length === 0) {
  console.error("No matches in database. Run `node data/seed.js` first.");
  process.exit(1);
}

let correct   = 0;
let brierSum  = 0;
let evaluated = 0;
let skipped   = 0;

const buckets = {
  H: { sumP: 0, outcomes: 0, n: 0 },
  D: { sumP: 0, outcomes: 0, n: 0 },
  A: { sumP: 0, outcomes: 0, n: 0 },
};

const rows = [];

for (const match of matches) {
  try {
    const bundle = dataCollectionAgent({
      team_a:       match.home_team,
      team_b:       match.away_team,
      venue_host:   "team_a",
      fixture_date: match.match_date,  // leakage guard
    });
    const report = performanceAnalysisAgent(bundle);
    const pred   = predictionAgent(bundle, report);

    // Skip unavailable predictions (no data for either team before this match)
    if (pred.predicted_winner === "Unavailable") { skipped++; continue; }

    const pA = pred.probabilities.team_a_win;
    const pD = pred.probabilities.draw;
    const pB = pred.probabilities.team_b_win;

    const actual = match.result;
    const oA = actual === "H" ? 1 : 0;
    const oD = actual === "D" ? 1 : 0;
    const oB = actual === "A" ? 1 : 0;

    brierSum += (pA - oA) ** 2 + (pD - oD) ** 2 + (pB - oB) ** 2;

    const predResult = pred.predicted_winner === match.home_team ? "H"
                     : pred.predicted_winner === match.away_team ? "A" : "D";
    if (predResult === actual) correct++;

    buckets.H.sumP += pA; buckets.H.n++;
    buckets.D.sumP += pD; buckets.D.n++;
    buckets.A.sumP += pB; buckets.A.n++;
    if (actual === "H") buckets.H.outcomes++;
    if (actual === "D") buckets.D.outcomes++;
    if (actual === "A") buckets.A.outcomes++;

    evaluated++;
    rows.push({
      date:          match.match_date,
      fixture:       `${match.home_team} vs ${match.away_team}`,
      actual_result: actual,
      score:         `${match.home_goals}-${match.away_goals}`,
      pred_result:   predResult,
      correct:       predResult === actual ? "YES" : "NO",
      home_pct:      pred.probabilities.team_a_pct,
      draw_pct:      pred.probabilities.draw_pct,
      away_pct:      pred.probabilities.team_b_pct,
      confidence:    pred.confidence,
      data_quality:  bundle.data_quality.label,
      xg_home:       pred.expected_goals.team_a_xg ?? "-",
      xg_away:       pred.expected_goals.team_b_xg ?? "-",
    });
  } catch (err) {
    skipped++;
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const accuracy    = evaluated > 0 ? +(correct / evaluated).toFixed(3)   : 0;
const brierScore  = evaluated > 0 ? +(brierSum / evaluated).toFixed(4)  : 0;

const calibration = {};
for (const [outcome, b] of Object.entries(buckets)) {
  const meanPred = b.n > 0 ? b.sumP / b.n : 0;
  const empFreq  = b.n > 0 ? b.outcomes / b.n : 0;
  calibration[outcome] = {
    mean_predicted:    +meanPred.toFixed(3),
    empirical_freq:    +empFreq.toFixed(3),
    calibration_error: +Math.abs(meanPred - empFreq).toFixed(3),
  };
}

if (CSV_MODE) {
  // CSV output
  const header = Object.keys(rows[0] ?? {}).join(",");
  console.log(header);
  for (const r of rows) console.log(Object.values(r).join(","));
} else {
  console.log("\n══════════ Backtest Results ══════════════════════════════════");
  console.log(`Matches evaluated : ${evaluated}  (skipped: ${skipped})`);
  console.log(`Accuracy          : ${(accuracy * 100).toFixed(1)}%`);
  console.log(`Brier score       : ${brierScore}  (random baseline ≈ 0.667)`);
  console.log("\nCalibration:");
  for (const [k, v] of Object.entries(calibration)) {
    const label = k === "H" ? "Home win" : k === "D" ? "Draw    " : "Away win";
    console.log(`  ${label}  mean_pred=${v.mean_predicted.toFixed(3)}  empirical=${v.empirical_freq.toFixed(3)}  error=${v.calibration_error.toFixed(3)}`);
  }
  console.log("\nSample predictions (last 10 evaluated):");
  console.log("  Date        Fixture                              Actual  Pred   H%  D%  A%  Correct");
  for (const r of rows.slice(-10)) {
    const fix = r.fixture.padEnd(40);
    console.log(`  ${r.date}  ${fix}  ${r.actual_result}       ${r.pred_result}     ${String(r.home_pct).padStart(2)}  ${String(r.draw_pct).padStart(2)}  ${String(r.away_pct).padStart(2)}  ${r.correct}`);
  }
  console.log("═══════════════════════════════════════════════════════════════\n");
}
