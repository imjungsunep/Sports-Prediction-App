# AI Sports Match Predictor

> **Problem Statement 28** — IBM watsonx Hackathon demo  
> A credible, demo-ready sports match predictor using a real 4-agent AI pipeline with local SQLite retrieval and a deterministic statistical model.

---

## Architecture

```
POST /api/predict
        │
        ├─ Agent 1 ── Historical Record Lookup (SQLite, NO LLM)
        │             → RetrievalBundle with sourced match rows
        │
        ├─ Agent 2 ── Performance Analysis (Groq LLM)
        │             → interprets retrieved evidence only
        │
        ├─ Agent 3 ── Statistical Prediction
        │             Step A: deterministic Dixon–Coles-inspired model → probabilities
        │             Step B: Groq LLM narrates pre-computed numbers only
        │
        └─ Agent 4 ── Explainable AI Insights (Groq LLM)
                      → every insight must cite a retrieved match record
```

**No RAG buzzwords.** The pipeline calls genuine SQLite retrieval on local historical data. Every probability comes from a formula, not an LLM.

---

## Security

### ⚠ Exposed key remediation

A Groq API key was previously hard-coded in `launcher.cjs`. It has been removed.  
If the key `gsk_T5kLBtq...` is still active, **rotate it immediately**:

1. Log in to [console.groq.com/keys](https://console.groq.com/keys).
2. Delete or revoke the exposed key.
3. Generate a new key.
4. Add the new key to your local `.env` file (see Setup below).

Never commit `.env` to version control — it is listed in `.gitignore`.

---

## Setup

### Prerequisites

- Node.js ≥ 18
- A Groq API key ([get one free](https://console.groq.com/keys))

### 1. Install dependencies

```bash
cd sports-prediction-app
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set your `GROQ_API_KEY`:

```
GROQ_API_KEY=gsk_your_new_key_here
GROQ_MODEL=llama3-8b-8192
PORT=3000
```

### 3. Seed the database

This imports ~95 historical football matches into a local SQLite file at `data/football.db`.  
The command is **idempotent** — safe to run multiple times.

```bash
node data/seed.js
```

Expected output:
```
[seed] Starting ingestion from .../data/seed/football_historical.csv
[seed] Done. Total: 95 | Inserted: 95 | Skipped (duplicate): 0
```

To validate the CSV without writing to the DB:

```bash
node data/seed.js --dry-run
```

### 4. Run the server

```bash
node launcher.cjs
# or:
npm start
```

Open [http://localhost:3000](http://localhost:3000).

For development with auto-restart:

```bash
npm run dev
```

---

## Data

Historical match data is stored in [`data/seed/football_historical.csv`](data/seed/football_historical.csv).

| Competition | Seasons | Matches |
|---|---|---|
| English Premier League | 2022/23, 2023/24 | ~60 |
| UEFA Euro 2024 | 2024 | ~16 |
| UEFA Champions League | 2023/24 | ~10 |
| FIFA World Cup Qualifiers | 2023/24 | ~5 |
| International Friendlies | 2023/24 | ~4 |

**Sources consulted:** football-data.co.uk, UEFA official results, FIFA.com, Premier League official site.  
Match results (scores, dates, venues) are factual events in the public domain.

See [`data/seed/README.md`](data/seed/README.md) for full column documentation and how to add more records.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/predict` | SSE stream — 4-agent prediction pipeline |
| `GET`  | `/api/data-health` | Database record counts and date range |
| `GET`  | `/api/teams/football` | Team list (from DB when seeded) |
| `GET`  | `/api/fixtures` | Paginated match list (`?team=&competition=&page=&pageSize=`) |
| `GET`  | `/api/retrieval-preview` | Debug: retrieval bundle without LLM (`?team_a=&team_b=`) |

### POST /api/predict

Request body:
```json
{
  "team_a": "Arsenal",
  "team_b": "Chelsea",
  "sport": "football",
  "venue_host": "team_a"
}
```

`venue_host` is optional. Accepted values: `"team_a"`, `"team_b"`.

The response is streamed as Server-Sent Events. Event types:
- `agent` — pipeline progress (`{ agent: 1-4, status: "running"|"done", label: "…" }`)
- `result` — final prediction payload
- `error` — error message

---

## Running Tests

Tests use Node.js built-in `node:test` (Node ≥18, no extra install).

```bash
npm test
```

This runs all test files matching `test/*.test.js`.

To run a single test file:

```bash
node --test test/ingestion.test.js
node --test test/retrieval.test.js
```

### Test coverage

| File | What is tested |
|---|---|
| `test/ingestion.test.js` | CSV parsing, row validation, upserts, insertMatch, idempotency, dry-run |
| `test/retrieval.test.js` | Team lookups, H2H queries, form queries, stats aggregation, formScore, h2hRates, computeProbabilities (determinism, sum=100, home advantage) |

---

## Limitations (Phase 1)

1. **Football only.** All other sports are labelled "Coming soon" in the UI.
2. **No live data.** All retrieval is from the seeded local database. Set `FOOTBALL_API_KEY` in `.env` to enable live lookups (Phase 2).
3. **Small dataset.** ~95 matches. Teams not in the seed data (e.g. many international club sides) will return `confidence: "Low"` predictions with data-quality warnings.
4. **No vector embeddings.** Semantic search over match notes uses simple keyword scoring. A proper embedding model will be added in Phase 2.
5. **No player availability.** The schema has an `optional` design for player data; ingestion from roster APIs is a Phase 2 task.
6. **Model calibration.** The Dixon–Coles-inspired model uses fixed weights (H2H: 40%, form: 45%, home: 15%). These should be calibrated against a larger dataset.

---

## Project Structure

```
sports-prediction-app/
├── server.js                    Express app + orchestrator
├── launcher.cjs                 dotenv loader → starts server.js
├── package.json
├── .env.example                 Template — copy to .env
├── .gitignore
│
├── agents/
│   ├── agent1_retrieval.js      DB lookup, NO LLM
│   ├── agent2_analysis.js       LLM interprets retrieved evidence
│   ├── agent3_prediction.js     Deterministic model + LLM narration
│   └── agent4_xai.js            LLM, grounded on retrieved records
│
├── model/
│   └── probabilityModel.js      Deterministic Dixon–Coles-inspired model
│
├── retrieval/
│   └── retrievalService.js      Hybrid retrieval orchestrator
│
├── db/
│   ├── schema.js                SQLite schema + getDb()
│   └── queries.js               Typed query functions
│
├── data/
│   ├── seed.js                  Idempotent CSV → SQLite ingestion script
│   ├── football.db              Generated by seed.js (git-ignored)
│   └── seed/
│       ├── football_historical.csv   ~95 sourced match records
│       └── README.md            Column docs + data sources
│
├── public/
│   └── index.html               Vanilla JS single-page UI
│
└── test/
    ├── ingestion.test.js        Ingestion unit tests
    └── retrieval.test.js        Query + model unit tests
```
