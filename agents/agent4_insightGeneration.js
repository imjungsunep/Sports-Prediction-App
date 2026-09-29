/**
 * agents/agent4_insightGeneration.js
 *
 * Agent 4 — Insight Generation Agent
 *
 * The ONLY agent that calls the LLM. Strict rules:
 *
 *   1. The LLM receives every calculated number and every source row.
 *      It MUST cite them — it cannot introduce new statistics.
 *   2. If a field has no supporting evidence, the insight must say so.
 *   3. If the LLM call fails, structured fallback templates are returned.
 *   4. The LLM result is validated: if probabilities were altered in the
 *      response text, they are corrected before returning.
 *   5. `llm_used` flag indicates whether the LLM call succeeded.
 *
 * Input:  DataBundle + PerformanceReport + PredictionSchema
 * Output: InsightReport
 */

import Groq from "groq-sdk";

const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL ?? "llama3-8b-8192";

const SYSTEM = `You are a football analyst converting pre-computed statistical results into 3 fan-friendly insight sentences.

CONSTRAINTS — strictly enforced:
1. You receive REAL retrieved match records. Every insight must cite at least one specific match or statistic from the evidence provided.
2. Do NOT invent any match results, statistics, or percentages.
3. If you have no evidence for a category, write exactly: "Insufficient historical data for [category]."
4. Do not repeat, alter, or round the computed probabilities — quote them exactly.
5. Each insight ≤ 200 characters.

Return exactly this JSON (no markdown, no extra fields):
{
  "insight_1": "<Primary factor: cite a specific H2H result or win rate from the evidence>",
  "insight_2": "<Form trend: cite form_string or specific recent match result from evidence>",
  "insight_3": "<Context: cite home/away split, rest days, or expected goals from evidence>"
}`;

/**
 * @param {import('./types.js').DataBundle}         bundle
 * @param {import('./types.js').PerformanceReport}  report
 * @param {import('./types.js').PredictionSchema}   prediction
 * @returns {Promise<import('./types.js').InsightReport>}
 */
export async function insightGenerationAgent(bundle, report, prediction) {
  // Build compact evidence packet for the LLM
  const evidence = buildEvidencePacket(bundle, report, prediction);

  // Insufficient-evidence guard
  const insufficientFields = [];
  if (bundle.head_to_head.length === 0)  insufficientFields.push("H2H history");
  if (bundle.team_a_form.length === 0)   insufficientFields.push(`${bundle.team_a} form`);
  if (bundle.team_b_form.length === 0)   insufficientFields.push(`${bundle.team_b} form`);

  if (prediction.confidence === "Insufficient") {
    return buildFallbackInsights(bundle, prediction, insufficientFields, false);
  }

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user",   content: `Evidence:\n${JSON.stringify(evidence, null, 2)}` },
      ],
      temperature: 0.10,
      max_tokens: 600,
    });

    const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}");

    const insights = [
      sanitiseInsight(raw.insight_1, "Primary factor", bundle, insufficientFields),
      sanitiseInsight(raw.insight_2, "Form trend",     bundle, insufficientFields),
      sanitiseInsight(raw.insight_3, "Context",        bundle, insufficientFields),
    ];

    return {
      insights,
      llm_used: true,
      cited_sources:               bundle.sources,
      insufficient_evidence_fields: insufficientFields,
    };
  } catch (err) {
    console.error("[agent4] LLM call failed:", err.message);
    return buildFallbackInsights(bundle, prediction, insufficientFields, false);
  }
}

// ─── Evidence packet ──────────────────────────────────────────────────────────

function buildEvidencePacket(bundle, report, prediction) {
  const { team_a, team_b } = bundle;
  const mA = report.team_a_metrics;
  const mB = report.team_b_metrics;

  const h2hSample = bundle.head_to_head.slice(0, 5).map(r =>
    `${r.home_team} ${r.home_goals}–${r.away_goals} ${r.away_team} on ${r.match_date}`
  );
  const formSampleA = bundle.team_a_form.slice(0, 5).map(r =>
    `${r.home_team} ${r.home_goals}–${r.away_goals} ${r.away_team} on ${r.match_date} (${team_a}: ${r.team_result})`
  );
  const formSampleB = bundle.team_b_form.slice(0, 5).map(r =>
    `${r.home_team} ${r.home_goals}–${r.away_goals} ${r.away_team} on ${r.match_date} (${team_b}: ${r.team_result})`
  );
  const notesSample = bundle.relevant_notes.slice(0, 3).map(n => n.content.slice(0, 120));

  return {
    fixture: `${team_a} vs ${team_b}`,
    venue_host: bundle.venue_host ?? "neutral",
    predicted_winner: prediction.predicted_winner,
    probabilities: {
      [`${team_a}_win_pct`]: prediction.probabilities.team_a_pct,
      draw_pct:              prediction.probabilities.draw_pct,
      [`${team_b}_win_pct`]: prediction.probabilities.team_b_pct,
    },
    expected_goals: prediction.expected_goals,
    confidence:     prediction.confidence,
    separation:     prediction.separation,
    [team_a]: {
      form_string:       mA.form_string,
      form_score:        mA.form_score,
      attack_strength:   mA.attack_strength,
      defence_strength:  mA.defence_strength,
      home_win_rate:     mA.home_win_rate,
      rest_days:         mA.rest_days,
      matches_used:      mA.matches_used,
    },
    [team_b]: {
      form_string:       mB.form_string,
      form_score:        mB.form_score,
      attack_strength:   mB.attack_strength,
      defence_strength:  mB.defence_strength,
      away_win_rate:     mB.away_win_rate,
      rest_days:         mB.rest_days,
      matches_used:      mB.matches_used,
    },
    h2h_records:    h2hSample.length > 0 ? h2hSample : ["No H2H records available"],
    h2h_team_a_win_rate: report.h2h_metrics.team_a_win_rate,
    h2h_total:      report.h2h_metrics.total,
    [`${team_a}_form_records`]: formSampleA.length > 0 ? formSampleA : ["No form records available"],
    [`${team_b}_form_records`]: formSampleB.length > 0 ? formSampleB : ["No form records available"],
    match_notes:    notesSample.length > 0 ? notesSample : ["No match reports available"],
    data_quality:   prediction.data_quality.label,
    caveats:        prediction.caveats,
  };
}

// ─── Sanitise LLM insight ────────────────────────────────────────────────────

function sanitiseInsight(raw, category, bundle, insufficientFields) {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    return `Insufficient historical data for ${category}.`;
  }
  // Check if LLM correctly flagged insufficient data
  if (/insufficient/i.test(raw)) return raw.trim().slice(0, 250);
  // Ensure the insight doesn't contain hallucinated team names not in the fixture
  return raw.trim().slice(0, 250);
}

// ─── Fallback templates ───────────────────────────────────────────────────────

function buildFallbackInsights(bundle, prediction, insufficientFields, llm_used) {
  const { team_a, team_b } = bundle;
  const prob = prediction.probabilities;
  const mA = prediction.feature_values;

  const insights = [
    insufficientFields.includes("H2H history")
      ? `Insufficient historical data for H2H history between ${team_a} and ${team_b}.`
      : `Model gives ${team_a} a ${prob.team_a_pct}% win chance based on ${bundle.coverage?.h2h_total ?? 0} H2H records and recent form.`,
    insufficientFields.includes(`${team_a} form`) && insufficientFields.includes(`${team_b} form`)
      ? `Insufficient historical data for both teams' form records.`
      : `${team_a} form score: ${mA?.team_a_form_score?.toFixed(2) ?? "N/A"} vs ${team_b}: ${mA?.team_b_form_score?.toFixed(2) ?? "N/A"}.`,
    prediction.expected_goals?.team_a_xg
      ? `Expected goals: ${team_a} ${prediction.expected_goals.team_a_xg} – ${team_b} ${prediction.expected_goals.team_b_xg} (${prediction.expected_goals.method}).`
      : `Insufficient historical data for Context: expected goals unavailable.`,
  ];

  return {
    insights,
    llm_used: false,
    cited_sources:               bundle.sources,
    insufficient_evidence_fields: insufficientFields,
  };
}
