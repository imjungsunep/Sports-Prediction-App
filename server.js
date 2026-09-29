/**
 * Sports Match Predictor — Express Backend
 *
 * Phase 2 — 4-agent pipeline (evidence-driven, deterministic model):
 *   Agent 1 — Data Collection          (SQLite retrieval, date-leakage guard, NO LLM)
 *   Agent 2 — Performance Analysis     (pure computation, NO LLM)
 *   Agent 3 — Prediction Agent         (Poisson + Elo deterministic model, NO LLM)
 *   Agent 4 — Insight Generation       (LLM for language only, evidence cited)
 *
 * Security:
 *   API keys are read from environment variables only. See .env.example.
 *   If a key has been exposed in a previous commit, rotate it immediately —
 *   see README §Security.
 */

import express  from "express";
import cors     from "cors";
import path     from "path";
import { fileURLToPath } from "url";

import { dataCollectionAgent }    from "./agents/agent1_dataCollection.js";
import { performanceAnalysisAgent } from "./agents/agent2_performanceAnalysis.js";
import { predictionAgent }        from "./agents/agent3_predictionAgent.js";
import { insightGenerationAgent } from "./agents/agent4_insightGeneration.js";
import { getDb }                  from "./db/schema.js";
import { getAllTeams, getDataHealth, getFixtures } from "./db/queries.js";
import { computeKeyFactors }      from "./model/footballModel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Environment validation ───────────────────────────────────────────────────

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("FATAL: GROQ_API_KEY environment variable is not set.");
  console.error("       Copy .env.example to .env and add your Groq API key.");
  console.error("       See README §Setup for details.");
  process.exit(1);
}

const MODEL = process.env.GROQ_MODEL ?? "llama3-8b-8192";

// Verify the database is seeded; warn but do not exit if empty
let db;
try {
  db = getDb();
  const health = getDataHealth(db);
  if (health.total_matches === 0) {
    console.warn("WARNING: Database has no records. Run `node data/seed.js` before making predictions.");
  } else {
    console.log(`[db] ${health.total_matches} matches, ${health.total_teams} teams loaded.`);
  }
} catch (err) {
  console.error("FATAL: Could not open database:", err.message);
  console.error("       Run `node data/seed.js` to create and seed the database.");
  process.exit(1);
}

// ─── Request timeout ──────────────────────────────────────────────────────────
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS ?? "60000", 10);

// ─── Input validation ─────────────────────────────────────────────────────────

const SUPPORTED_SPORTS = ["football"];

/**
 * Validate /api/predict request body.
 * Returns an error message string or null.
 */
function validatePredictBody(body) {
  if (!body.team_a || typeof body.team_a !== "string" || !body.team_a.trim()) {
    return "team_a is required and must be a non-empty string.";
  }
  if (!body.team_b || typeof body.team_b !== "string" || !body.team_b.trim()) {
    return "team_b is required and must be a non-empty string.";
  }
  if (body.team_a.trim().toLowerCase() === body.team_b.trim().toLowerCase()) {
    return "team_a and team_b must be different.";
  }
  if (body.sport && !SUPPORTED_SPORTS.includes(body.sport)) {
    return `Sport "${body.sport}" is not supported. Supported sports: ${SUPPORTED_SPORTS.join(", ")}.`;
  }
  if (body.venue_host && !["team_a", "team_b"].includes(body.venue_host)) {
    return 'venue_host must be "team_a" or "team_b".';
  }
  if (body.fixture_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.fixture_date)) {
    return 'fixture_date must be in YYYY-MM-DD format.';
  }
  return null;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function orchestrate(input, onAgentDone) {
  // Agent 1 — Data Collection (SQLite, date-leakage guard, no LLM)
  onAgentDone?.({ agent: 1, status: "running", label: "Retrieving & validating historical records…" });
  const bundle = dataCollectionAgent({
    team_a:       input.team_a,
    team_b:       input.team_b,
    venue_host:   input.venue_host ?? null,
    fixture_date: input.fixture_date ?? null,
  });
  onAgentDone?.({ agent: 1, status: "done" });

  // Agent 2 — Performance Analysis (pure computation, no LLM)
  onAgentDone?.({ agent: 2, status: "running", label: "Calculating form, strength & H2H metrics…" });
  const report = performanceAnalysisAgent(bundle);
  onAgentDone?.({ agent: 2, status: "done" });

  // Agent 3 — Prediction (deterministic Poisson+Elo model, no LLM)
  onAgentDone?.({ agent: 3, status: "running", label: "Running Poisson+Elo probability model…" });
  const prediction = predictionAgent(bundle, report);
  onAgentDone?.({ agent: 3, status: "done" });

  // Agent 4 — Insight Generation (LLM for language only)
  onAgentDone?.({ agent: 4, status: "running", label: "Generating evidence-grounded insights…" });
  const insightReport = await insightGenerationAgent(bundle, report, prediction);
  onAgentDone?.({ agent: 4, status: "done" });

  return {
    match_prediction: {
      fixture:          `${input.team_a} vs ${input.team_b}`,
      sport:            input.sport ?? "football",
      // ── Core prediction (deterministic) ──────────────────────────────────
      predicted_winner:  prediction.predicted_winner,
      winner_is_certain: prediction.winner_is_certain,
      confidence:        prediction.confidence,
      confidence_score:  prediction.confidence_score,
      model_version:     prediction.model_version,
      model_type:        prediction.model_type,
      win_probability: {
        team_a_pct: prediction.probabilities.team_a_pct,
        team_b_pct: prediction.probabilities.team_b_pct,
        draw_pct:   prediction.probabilities.draw_pct,
      },
      expected_goals:    prediction.expected_goals,
      separation:        prediction.separation,
      caveats:           prediction.caveats,
      // ── Key factors (ranked contribution list) ────────────────────────────
      key_factors:       computeKeyFactors(bundle, report, prediction),
      // ── Performance analysis ──────────────────────────────────────────────
      performance_trends: {
        team_a_form_score:    report.team_a_metrics.form_score,
        team_b_form_score:    report.team_b_metrics.form_score,
        team_a_attack:        report.team_a_metrics.attack_strength,
        team_b_attack:        report.team_b_metrics.attack_strength,
        team_a_defence:       report.team_a_metrics.defence_strength,
        team_b_defence:       report.team_b_metrics.defence_strength,
        team_a_form_string:   report.team_a_metrics.form_string,
        team_b_form_string:   report.team_b_metrics.form_string,
        team_a_matches_used:  report.team_a_metrics.matches_used,
        team_b_matches_used:  report.team_b_metrics.matches_used,
        team_a_rest_days:     report.team_a_metrics.rest_days,
        team_b_rest_days:     report.team_b_metrics.rest_days,
        home_advantage_factor: report.home_advantage_factor,
        h2h_metrics:          report.h2h_metrics,
      },
      // ── Explainable insights (LLM, grounded) ─────────────────────────────
      explainable_insights:  insightReport.insights,
      llm_used:              insightReport.llm_used,
      // ── Data provenance ───────────────────────────────────────────────────
      retrieved_evidence: {
        found:             bundle.found,
        data_quality:      bundle.data_quality,
        coverage:          bundle.coverage,
        head_to_head:      bundle.head_to_head.slice(0, 8),
        team_a_form:       bundle.team_a_form.slice(0, 8),
        team_b_form:       bundle.team_b_form.slice(0, 8),
        data_warnings:     bundle.data_warnings,
        sources:           bundle.sources,
        feature_values:    prediction.feature_values,
        source_citations:  prediction.source_citations,
      },
    },
  };
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── POST /api/predict — SSE streaming prediction ─────────────────────────────

app.post("/api/predict", async (req, res) => {
  // Set a server-side timeout
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ error: "Request timed out. The LLM service may be slow." });
    }
  }, REQUEST_TIMEOUT_MS);

  const validationError = validatePredictBody(req.body);
  if (validationError) {
    clearTimeout(timer);
    return res.status(400).json({ error: validationError });
  }

  const input = {
    team_a:       req.body.team_a.trim(),
    team_b:       req.body.team_b.trim(),
    sport:        req.body.sport        ?? "football",
    venue_host:   req.body.venue_host   ?? null,
    fixture_date: req.body.fixture_date ?? null,
  };

  // Server-Sent Events
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (type, data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    }
  };

  try {
    const result = await orchestrate(input, ({ agent, status, label }) => {
      send("agent", { agent, status, label });
    });
    send("result", { payload: result });
  } catch (err) {
    console.error("[/api/predict] Error:", err.message);
    send("error", { message: err.message });
  } finally {
    clearTimeout(timer);
    res.end();
  }
});

// ── GET /api/data-health — database status ────────────────────────────────────

app.get("/api/data-health", (_req, res) => {
  try {
    const health = getDataHealth(db);
    res.json({ status: "ok", ...health });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ── GET /api/teams/:sport — team lists ───────────────────────────────────────

app.get("/api/teams/:sport", (req, res) => {
  const { sport } = req.params;

  if (sport === "football") {
    // Prefer DB-resident teams; fall back to curated list if DB is empty
    const dbTeams = getAllTeams(db).map(t => t.name);
    if (dbTeams.length > 0) {
      return res.json({ teams: dbTeams, source: "database" });
    }
  }

  // Non-football sports: labelled as coming soon
  const notSupported = ["basketball","cricket","tennis","american-football","baseball"];
  if (notSupported.includes(sport)) {
    return res.json({ teams: [], coming_soon: true,
      message: `${sport} support is coming soon. Only football is currently available.` });
  }

  // Fallback curated list for football (pre-seed)
  const fallback = [
    "Manchester City","Arsenal","Liverpool","Chelsea","Manchester United",
    "Tottenham","Newcastle","Aston Villa","Real Madrid","Barcelona",
    "Atletico Madrid","Bayern Munich","Borussia Dortmund","PSG","Juventus",
    "AC Milan","Inter Milan","Ajax","Porto","Benfica",
    "Al-Hilal","Al-Nassr","Brazil","Argentina","France","England","Germany","Spain"
  ];
  res.json({ teams: fallback, source: "fallback" });
});

// ── GET /api/fixtures — paginated match list ──────────────────────────────────

app.get("/api/fixtures", (req, res) => {
  const page       = Math.max(1, parseInt(req.query.page     ?? "1",  10));
  const pageSize   = Math.min(50, Math.max(1, parseInt(req.query.pageSize ?? "20", 10)));
  const team       = req.query.team        ? String(req.query.team).trim()        : undefined;
  const competition = req.query.competition ? String(req.query.competition).trim() : undefined;

  if (isNaN(page) || isNaN(pageSize)) {
    return res.status(400).json({ error: "page and pageSize must be integers." });
  }

  try {
    const result = getFixtures(db, { team, competition, page, pageSize });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/retrieval-preview — debug retrieval without LLM ─────────────────

app.get("/api/retrieval-preview", async (req, res) => {
  const { team_a, team_b, venue_host, fixture_date } = req.query;
  if (!team_a || !team_b) {
    return res.status(400).json({ error: "team_a and team_b query params are required." });
  }
  if (team_a.trim().toLowerCase() === team_b.trim().toLowerCase()) {
    return res.status(400).json({ error: "team_a and team_b must be different." });
  }

  try {
    const bundle = dataCollectionAgent({
      team_a:       team_a.trim(),
      team_b:       team_b.trim(),
      venue_host:   venue_host ?? null,
      fixture_date: fixture_date ?? null,
    });
    const report = performanceAnalysisAgent(bundle);
    const pred   = predictionAgent(bundle, report);
    res.json({ bundle, report, prediction: pred });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/backtest — evaluate model accuracy on held-out historical matches ─

app.get("/api/backtest", (req, res) => {
  const limit = Math.min(200, Math.max(5, parseInt(req.query.limit ?? "50", 10)));
  try {
    const result = runBacktestSync(db, limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Run a synchronous backtest over held-out matches.
 * Uses leave-one-out: for each match M in the last `limit` matches,
 * make a prediction using only records BEFORE M's date, then compare to actual result.
 *
 * Metrics reported:
 *   - accuracy       : fraction of matches where predicted_winner matches actual
 *   - brier_score    : mean squared error of probability vector (lower = better, 0 = perfect)
 *   - calibration    : mean |predicted_pct - empirical_frequency| per outcome bucket
 *
 * @param {import('node:sqlite').DatabaseSync} dbConn
 * @param {number} n
 * @returns {object}
 */
function runBacktestSync(dbConn, n) {
  // Fetch the n most-recent matches that have a known result
  const matches = dbConn.prepare(`
    SELECT m.id, m.match_date, m.result,
           ht.name AS home_team, at.name AS away_team,
           m.home_goals, m.away_goals
    FROM matches m
    JOIN teams ht ON ht.id = m.home_team_id
    JOIN teams at ON at.id = m.away_team_id
    ORDER BY m.match_date DESC
    LIMIT $n
  `).all({ n });

  if (matches.length === 0) {
    return { error: "No matches in database to backtest against." };
  }

  let correct = 0;
  let brierSum = 0;
  const buckets = { H: { sumP: 0, outcomes: 0, n: 0 },
                    D: { sumP: 0, outcomes: 0, n: 0 },
                    A: { sumP: 0, outcomes: 0, n: 0 } };
  const evaluated = [];

  for (const match of matches) {
    try {
      // Date-leakage guard: predict using only data BEFORE this match's date
      const bundle = dataCollectionAgent({
        team_a:       match.home_team,
        team_b:       match.away_team,
        venue_host:   "team_a",
        fixture_date: match.match_date,   // cut off at this date
      });
      const report = performanceAnalysisAgent(bundle);
      const pred   = predictionAgent(bundle, report);

      const pA = pred.probabilities.team_a_win;
      const pD = pred.probabilities.draw;
      const pB = pred.probabilities.team_b_win;

      // Actual outcome as one-hot vector
      const actual = match.result; // H, D, A
      const oA = actual === "H" ? 1 : 0;
      const oD = actual === "D" ? 1 : 0;
      const oB = actual === "A" ? 1 : 0;

      // Brier score component
      brierSum += (pA - oA) ** 2 + (pD - oD) ** 2 + (pB - oB) ** 2;

      // Accuracy
      const predResult = pred.predicted_winner === match.home_team ? "H"
                       : pred.predicted_winner === match.away_team ? "A"
                       : pred.predicted_winner === "Unavailable"   ? null
                       : "D";
      if (predResult !== null && predResult === actual) correct++;

      // Calibration accumulation
      buckets.H.sumP += pA; buckets.H.n++;
      buckets.D.sumP += pD; buckets.D.n++;
      buckets.A.sumP += pB; buckets.A.n++;
      if (actual === "H") buckets.H.outcomes++;
      if (actual === "D") buckets.D.outcomes++;
      if (actual === "A") buckets.A.outcomes++;

      if (evaluated.length < 20) {
        evaluated.push({
          fixture:       `${match.home_team} vs ${match.away_team}`,
          date:          match.match_date,
          actual_result: actual,
          actual_score:  `${match.home_goals}–${match.away_goals}`,
          predicted:     pred.predicted_winner,
          home_pct:      pred.probabilities.team_a_pct,
          draw_pct:      pred.probabilities.draw_pct,
          away_pct:      pred.probabilities.team_b_pct,
          confidence:    pred.confidence,
          correct:       predResult === actual,
        });
      }
    } catch {
      // Skip matches that can't be predicted (e.g. brand new teams)
    }
  }

  const total       = matches.length;
  const accuracy    = +(correct / total).toFixed(3);
  const brierScore  = +(brierSum / total).toFixed(4);

  const calibration = {};
  for (const [outcome, b] of Object.entries(buckets)) {
    const meanPred = b.n > 0 ? b.sumP / b.n : 0;
    const empFreq  = b.n > 0 ? b.outcomes / b.n : 0;
    calibration[outcome] = {
      mean_predicted: +meanPred.toFixed(3),
      empirical_freq: +empFreq.toFixed(3),
      calibration_error: +Math.abs(meanPred - empFreq).toFixed(3),
    };
  }

  return {
    matches_evaluated: total,
    accuracy,
    brier_score: brierScore,
    calibration,
    note: "Brier score: 0 = perfect, 1 = worst. Accuracy: fraction where model predicted actual winner.",
    sample_predictions: evaluated,
  };
}

// ── GET /api/competitions — distinct competition names in the DB ──────────────

app.get("/api/competitions", (_req, res) => {
  try {
    const rows = db.prepare(
      "SELECT DISTINCT name FROM competitions ORDER BY name"
    ).all();
    res.json({ competitions: rows.map(r => r.name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/demo-fixtures — seeded fixtures ready for demo ──────────────────
// Returns a curated list of high-quality matchups present in the seed data,
// grouped by competition. Used to pre-populate the fixture selector.

const DEMO_FIXTURES = [
  { competition: "EPL",                 home: "Arsenal",         away: "Liverpool",         venue_host: "team_a", label: "Title clash" },
  { competition: "EPL",                 home: "Manchester City", away: "Arsenal",            venue_host: "team_a", label: "Top-of-table" },
  { competition: "EPL",                 home: "Liverpool",       away: "Manchester City",    venue_host: "team_a", label: "Title decider" },
  { competition: "EPL",                 home: "Chelsea",         away: "Arsenal",            venue_host: "team_a", label: "London derby" },
  { competition: "EPL",                 home: "Tottenham",       away: "Arsenal",            venue_host: "team_a", label: "North London derby" },
  { competition: "EPL",                 home: "Manchester City", away: "Liverpool",          venue_host: "team_a", label: "Classic rivalry" },
  { competition: "UEFA Euro 2024",      home: "Spain",           away: "England",            venue_host: null,     label: "Euro 2024 Final" },
  { competition: "UEFA Euro 2024",      home: "Spain",           away: "France",             venue_host: null,     label: "Euro 2024 Semi-final" },
  { competition: "UEFA Euro 2024",      home: "England",         away: "Germany",            venue_host: null,     label: "Tournament clash" },
  { competition: "UEFA Champions League", home: "Arsenal",       away: "Manchester City",    venue_host: "team_a", label: "UCL tie" },
  { competition: "FIFA Qualifiers",     home: "England",         away: "France",             venue_host: null,     label: "International" },
];

app.get("/api/demo-fixtures", (_req, res) => {
  res.json({ fixtures: DEMO_FIXTURES });
});

// ── GET /api/data-status — structured data status card ───────────────────────

app.get("/api/data-status", (_req, res) => {
  try {
    const health  = getDataHealth(db);
    const sources = db.prepare("SELECT name, url, retrieved_at FROM sources ORDER BY name").all();
    const comps   = db.prepare("SELECT name FROM competitions ORDER BY name").all();

    const msPerDay   = 86_400_000;
    const freshness  = health.latest_match
      ? Math.round((Date.now() - new Date(health.latest_match).getTime()) / msPerDay)
      : null;

    res.json({
      status: "ok",
      records:       health.total_matches,
      teams:         health.total_teams,
      competitions:  comps.map(c => c.name),
      date_range: {
        earliest: health.earliest_match,
        latest:   health.latest_match,
      },
      freshness_days: freshness,
      sources,
      limitations: [
        "Historical data only — no live or real-time scores.",
        "Coverage: EPL 2022/23–2023/24, UEFA Euro 2024, UCL 2023/24, FIFA Qualifiers, International Friendlies.",
        "Model uses Poisson + Elo blend; requires ≥3 form matches per team for full accuracy.",
        "Teams not in the seed dataset will receive an uncertain 33/34/33 fallback prediction.",
      ],
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Sports Prediction App running at http://localhost:${PORT}`);
  console.log(`   Model: ${MODEL}`);
  console.log(`   Data:  Use POST /api/predict · GET /api/data-health\n`);
});
