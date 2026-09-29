# Demo Script — Football Match Predictor
## IBM Problem Statement 28 · Judging Demo

> **Timing guide:** The full walkthrough takes approximately 8–10 minutes.
> Suggested fixture for live demo: **Arsenal vs Liverpool** (best H2H + form data in seed).

---

## 0. Setup (before judges arrive — 2 min)

```bash
# 1. Install dependencies
npm install

# 2. Seed the database (idempotent — safe to run twice)
node data/seed.js

# 3. Copy .env.example to .env and add your Groq API key
cp .env.example .env
# Edit .env: GROQ_API_KEY=gsk_...

# 4. Start the server
npm start
# → http://localhost:3000
```

**Confirm:** Browser shows the Match Predictor dashboard with the dark sidebar.

---

## 1. The Problem (30 sec)

> "Most AI sports prediction demos are wrappers around a prompt. They either make up statistics, use undisclosed live-data scraping, or claim RAG without showing what was retrieved.
>
> Problem Statement 28 asked us to build something credible: a predictor that only claims what it can prove, retrieves real historical records, runs a transparent statistical model, and explains exactly what evidence drove each prediction."

---

## 2. Data Transparency — Data Status page (1 min)

Click **"🗄️ Data Status"** in the sidebar.

**Point out:**
- **90 seeded historical match records** from publicly-cited sources (EPL 2022/23–2023/24, UEFA Euro 2024, UCL 2023/24, FIFA Qualifiers)
- Date range and freshness in days
- Competitions covered — shown as pills, not claims
- **Limitations section**: "Historical data only — no live or real-time scores." This is explicitly stated, not buried.

> "There are no placeholder charts pretending to show live data. Everything on the Data Status page is computed from the actual SQLite database the model queries."

---

## 3. Model Architecture — About page (1 min)

Click **"ℹ️ About"** in the sidebar.

**Point out the four-agent pipeline:**
- **Agent 1** — SQLite retrieval with a date-leakage guard (no data on or after the fixture date is ever used)
- **Agent 2** — Pure computation: recency-weighted form, attack/defence strength, rest days, H2H metrics — no LLM
- **Agent 3** — Deterministic Poisson + Elo blend model — no LLM. Probabilities come from maths, not a language model
- **Agent 4** — The only LLM call. Groq receives the pre-computed numbers and the source rows. It narrates, it cannot invent statistics

> "The LLM never touches the probability calculation. It receives results; it does not produce them."

**Also point out:**
- "Built with IBM Bob" attribution — IBM Bob was used as the AI engineering runtime to design and write every component
- Runtime: Groq (llama3-8b-8192) + Node.js/Express + SQLite

---

## 4. Making a Prediction (3 min)

Return to **"🔮 New Prediction"**.

### Step 4a — Demo fixture
Click the **"Arsenal vs Liverpool · Title clash"** demo button.
Fields auto-fill. Confirm venue is set to "Home team is the designated host".

### Step 4b — Run the pipeline
Click **"Run Prediction Pipeline"**. Watch all four agents complete:
1. 🗄️ Historical Record Lookup — completes in <1 s
2. 📊 Performance Analysis — completes in <1 s
3. 🎯 Poisson + Elo Model — completes in <1 s
4. 💡 Insight Generation — calls Groq (~2–5 s)

### Step 4c — Walk through the result card

**Prediction banner:**
> "Arsenal are predicted to win with Medium confidence at 56%. The model also gives you a continuous score: 54%."

**Probability bar:**
> "Arsenal 56% — Draw 21% — Liverpool 23%. Note these are integer-rounded Poisson + Elo blend outputs, not LLM hallucinations. They sum to exactly 100."

**Expected Goals (xG) chips:**
> "Arsenal λ=1.82, Liverpool λ=1.37. These are the Poisson lambda values — the model's estimate of goals per team based on attack and defence ratings. The label says 'Poisson λ' explicitly."

---

## 5. Data Quality Card (30 sec)

**Point out:**
- "Good" quality label with a percentage bar
- H2H records count (e.g. 8), form match counts for each team, data freshness in days
- Any yellow warning pills if data is thin

> "Every prediction comes with a machine-generated confidence assessment. If the data is sparse, the model says so — it never silently returns a confident-looking prediction over two teams it's never seen."

---

## 6. Key Factors — ranked explainability (1 min)

Scroll to **"Key Prediction Factors"**.

**Point out:**
- Up to 6 ranked factors: Recent Form, Attacking Strength, Defensive Resilience, H2H Record, Home Advantage, xG
- Each has a direction bar (blue = favours Arsenal, purple = favours Liverpool)
- Each has a **concrete evidence string** — e.g. "Arsenal form score 0.72 vs Liverpool 0.43 (last 10 matches)"

> "The UI can show you exactly why the model reached this number. No black box."

---

## 7. Recent Form Comparison (30 sec)

Scroll to **"Recent Form"**.

**Point out:**
- Coloured W/D/L dots for last 8 matches per team
- Actual match table: date, scoreline, result, competition
- This is the literal data Agent 1 retrieved

> "These are the records the model used. Click 'Show retrieved evidence records' and you can see every match row, the feature values fed to the model, and the source citation."

---

## 8. Head-to-Head Summary (30 sec)

Scroll to **"Head-to-Head"**.

**Point out:**
- Large W/D/L scoreline (e.g. Arsenal 6W / 4D / 2L in last 12 meetings)
- Date range shown (e.g. 2022-08-05 – 2024-02-03)
- Individual match table

> "The model applies an H2H correction if there are ≥3 head-to-head records. The date range tells you exactly how current that H2H evidence is."

---

## 9. Explainable Insights + Evidence Drawer (1 min)

Scroll to **"Explainable AI Insights"**.

**Point out:**
- Sub-label: "Generated by Groq · llama3-8b-8192 · evidence-grounded"
- Three numbered insights — each should cite a specific match date or statistic from the retrieved evidence
- If the LLM was unavailable: the label says "Fallback template" honestly

Click **"📋 Show retrieved evidence records"**:
- Head-to-head table
- Home form, away form per team
- Model feature values (numerical inputs: form scores, attack, defence, H2H win rate, home advantage)
- Source citation

> "The evidence drawer is a transparency mechanism — every number in the insights can be traced back to a specific retrieved record."

---

## 10. Model Caveats (30 sec)

If visible, scroll to **"Model Caveats"**.

> "The model generates its own caveats automatically. For example: 'Teams are closely matched — outcome is uncertain' or 'Data freshness is over 180 days — may not reflect current squad form'. These are disclosed on every prediction, not buried."

---

## 11. Backtest — proving it works (1 min)

Click **"📊 Model Backtest"** in the sidebar.

Set limit to **50 matches** and click **"Run backtest"**.

**Point out:**
- Accuracy: ~67% (vs random baseline of ~33%)
- Brier score: ~0.49 (lower is better; random ≈ 0.67)
- Calibration table per outcome (Home/Draw/Away): predicted % vs actual frequency
- Sample predictions table with ✓/✗ for each

> "Every metric here is computed using a leave-one-out method — for each test match, only data strictly before that date is used. No leakage. This is the actual performance of the model on its own seed data."

---

## 12. Handling Unknown Teams — "No Prediction Available" state (30 sec)

Go back to **Predict**. Type in two completely made-up team names (e.g. "Fictional FC" vs "Test United").

Click **Run Prediction Pipeline**.

**Show the result:**
- Large "📭 No Prediction Available" state
- Explanation text: "No historical records found for these teams."
- The probability bars still show 33/34/33 with a clear caveat: "These are placeholder values only"

> "The system never fabricates a winner for a fixture it has no data for. Honest uncertainty is a feature, not a bug."

---

## 13. Closing (30 sec)

> "To summarise: real historical data retrieved from SQLite, a deterministic statistical model — Poisson plus Elo — that runs in milliseconds, a language model used only to narrate results it cannot alter, and complete transparency at every step: what data was used, where it came from, how confident the model is, and why.
>
> No live data is claimed. No RAG is claimed without the records being shown. No probability is invented by the LLM. Built with IBM Bob."

---

## Quick-reference fixture pairs for demo variety

| Home | Away | Notes |
|---|---|---|
| Arsenal | Liverpool | Best H2H coverage (8 matches) |
| Manchester City | Arsenal | Top-of-table, both with 10+ form records |
| Spain | England | Euro 2024 Final — international context |
| Arsenal | Bayern Munich | UCL tie — cross-competition |
| Fictional FC | Test United | Demonstrates the "no data" state |

---

## Emergency fallback (if Groq API is down)

The pipeline still runs. Agent 4 falls back to template insights automatically.
The result card shows "⚠ Template insights (LLM unavailable)" in the model strip.
All statistical outputs (probabilities, xG, key factors, form, H2H) are unaffected.
