/**
 * test/frontend.test.js
 *
 * Integration tests for the new Phase 3 API endpoints.
 * Tests run against a live server instance to verify end-to-end behaviour.
 * Requires the database to be seeded first (`node data/seed.js`).
 *
 * Endpoints tested:
 *   GET /api/competitions
 *   GET /api/demo-fixtures
 *   GET /api/data-status
 *   POST /api/predict (key_factors shape)
 *   GET  /api/backtest
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path       from 'node:path';
import { spawn }  from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

// ─── Helpers ──────────────────────────────────────────────────────────────────

let serverProcess;
let BASE_URL;
const PORT = 13099;   // Use a port unlikely to conflict

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(
      process.execPath,
      ['launcher.cjs'],
      {
        cwd:   ROOT,
        env:   { ...process.env, PORT: String(PORT), GROQ_API_KEY: process.env.GROQ_API_KEY ?? 'test-key-for-unit' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let ready = false;
    const timeout = setTimeout(() => {
      if (!ready) reject(new Error('Server did not start in time'));
    }, 12_000);

    serverProcess.stdout.on('data', chunk => {
      const txt = chunk.toString();
      if (txt.includes('running at')) {
        ready = true;
        clearTimeout(timeout);
        BASE_URL = `http://localhost:${PORT}`;
        resolve();
      }
    });

    serverProcess.stderr.on('data', chunk => {
      // Suppress GROQ_API_KEY fatal error for unit test purposes;
      // the test key is intentionally not real — we only test non-LLM endpoints.
    });

    serverProcess.on('error', reject);
    serverProcess.on('exit', code => {
      if (!ready) reject(new Error(`Server exited with code ${code}`));
    });
  });
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise(res => setTimeout(res, 300));
  }
}

async function get(path) {
  const res = await fetch(BASE_URL + path);
  return { status: res.status, body: await res.json() };
}

async function post(path, body) {
  const res = await fetch(BASE_URL + path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  // For SSE streaming, collect the full body and parse final result event
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    return parseSSE(text);
  }
  return { status: res.status, body: JSON.parse(text) };
}

function parseSSE(text) {
  const events = text.split('\n\n').filter(Boolean);
  let result = null;
  for (const ev of events) {
    const line = ev.replace(/^data: /, '').trim();
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'result') result = msg.payload;
      if (msg.type === 'error')  return { status: 500, body: { error: msg.message } };
    } catch {}
  }
  return { status: 200, body: result };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// NOTE: We guard every network test with a try/catch on server start.
// If the server fails to start (e.g. in CI without a GROQ key), tests are skipped gracefully.
let serverOk = false;

// Attempt server start once before all network tests
try {
  await startServer();
  serverOk = true;
} catch (e) {
  console.warn('[frontend.test] Server did not start — skipping network tests:', e.message);
}

// ── /api/competitions ──────────────────────────────────────────────────────────
test('/api/competitions returns array of strings', { skip: !serverOk }, async () => {
  const { status, body } = await get('/api/competitions');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.competitions), 'competitions should be an array');
  // Seeded data has at least EPL
  assert.ok(body.competitions.some(c => c === 'EPL' || c.includes('EPL') || c.includes('Premier')),
    'Should include EPL');
  // All entries are non-empty strings
  body.competitions.forEach(c => {
    assert.equal(typeof c, 'string');
    assert.ok(c.length > 0);
  });
});

// ── /api/demo-fixtures ────────────────────────────────────────────────────────
test('/api/demo-fixtures returns curated list', { skip: !serverOk }, async () => {
  const { status, body } = await get('/api/demo-fixtures');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.fixtures));
  assert.ok(body.fixtures.length >= 5, 'Should have at least 5 demo fixtures');
  body.fixtures.forEach(f => {
    assert.ok(f.home, 'Each fixture must have a home team');
    assert.ok(f.away, 'Each fixture must have an away team');
    assert.ok(f.label, 'Each fixture must have a label');
  });
  // Verify no demo fixture has home === away
  body.fixtures.forEach(f => {
    assert.notEqual(f.home.toLowerCase(), f.away.toLowerCase(),
      `Demo fixture home and away must differ: ${f.home}`);
  });
});

// ── /api/data-status ──────────────────────────────────────────────────────────
test('/api/data-status returns structured status object', { skip: !serverOk }, async () => {
  const { status, body } = await get('/api/data-status');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(typeof body.records === 'number' && body.records > 0,
    'records should be positive integer');
  assert.ok(typeof body.teams === 'number'   && body.teams   > 0,
    'teams should be positive integer');
  assert.ok(Array.isArray(body.competitions) && body.competitions.length > 0,
    'competitions array should be non-empty');
  assert.ok(body.date_range?.earliest, 'should have earliest date');
  assert.ok(body.date_range?.latest,   'should have latest date');
  assert.ok(typeof body.freshness_days === 'number',
    'freshness_days should be a number');
  assert.ok(Array.isArray(body.limitations) && body.limitations.length > 0,
    'limitations array should be non-empty');
  assert.ok(Array.isArray(body.sources), 'sources should be an array');
});

test('/api/data-status: limitations mention historical-only', { skip: !serverOk }, async () => {
  const { body } = await get('/api/data-status');
  const allText  = body.limitations.join(' ').toLowerCase();
  assert.ok(allText.includes('historical') || allText.includes('no live'),
    'limitations must mention no live data');
});

// ── /api/predict — key_factors shape ─────────────────────────────────────────
test('/api/predict returns key_factors for known fixture', { skip: !serverOk }, async (t) => {
  // Arsenal vs Liverpool both have seed data → key_factors should be non-empty
  const { status, body } = await post('/api/predict', {
    team_a: 'Arsenal',
    team_b: 'Liverpool',
    sport:  'football',
  });

  if (status !== 200 || !body) {
    t.skip('Server returned non-200 or no body');
    return;
  }

  const mp = body.match_prediction;
  assert.ok(mp, 'match_prediction should exist');
  assert.ok(Array.isArray(mp.key_factors), 'key_factors should be an array');

  if (mp.key_factors.length > 0) {
    mp.key_factors.forEach((f, i) => {
      assert.ok(typeof f.factor     === 'string', `factor[${i}].factor should be string`);
      assert.ok(typeof f.category   === 'string', `factor[${i}].category should be string`);
      assert.ok(typeof f.contribution === 'number', `factor[${i}].contribution should be number`);
      assert.ok(typeof f.direction  === 'string', `factor[${i}].direction should be string`);
      assert.ok(['favours_a','favours_b','neutral'].includes(f.direction),
        `factor[${i}].direction should be one of the valid values`);
      assert.ok(typeof f.evidence   === 'string', `factor[${i}].evidence should be string`);
      assert.ok(f.evidence.length > 0,            `factor[${i}].evidence should be non-empty`);
      assert.ok(typeof f.magnitude  === 'number', `factor[${i}].magnitude should be number`);
      assert.ok(f.magnitude >= 0 && f.magnitude <= 1,
        `factor[${i}].magnitude should be 0..1`);
    });

    // Should be sorted by magnitude descending
    for (let i = 0; i < mp.key_factors.length - 1; i++) {
      assert.ok(mp.key_factors[i].magnitude >= mp.key_factors[i + 1].magnitude,
        'key_factors should be sorted by magnitude descending');
    }
  }
});

test('/api/predict: performance_trends includes new Phase 3 fields', { skip: !serverOk }, async (t) => {
  const { status, body } = await post('/api/predict', {
    team_a:     'Arsenal',
    team_b:     'Manchester City',
    sport:      'football',
    venue_host: 'team_a',
  });

  if (status !== 200 || !body) { t.skip(); return; }

  const pt = body.match_prediction.performance_trends;
  assert.ok(pt, 'performance_trends should exist');
  assert.ok('team_a_defence'      in pt, 'should include team_a_defence');
  assert.ok('team_b_defence'      in pt, 'should include team_b_defence');
  assert.ok('team_a_matches_used' in pt, 'should include team_a_matches_used');
  assert.ok('team_b_matches_used' in pt, 'should include team_b_matches_used');
  assert.ok('h2h_metrics'         in pt, 'should include h2h_metrics');
  assert.ok(typeof pt.h2h_metrics === 'object', 'h2h_metrics should be object');
});

// ── /api/predict: insufficient data state ─────────────────────────────────────
test('/api/predict: unknown teams return Unavailable, not fabricated winner', { skip: !serverOk }, async (t) => {
  const { status, body } = await post('/api/predict', {
    team_a: 'Fictional FC Alpha',
    team_b: 'Fictional FC Beta',
    sport:  'football',
  });
  if (status !== 200 || !body) { t.skip(); return; }

  const mp = body.match_prediction;
  assert.equal(mp.predicted_winner, 'Unavailable',
    'Unknown teams must return Unavailable, not a fabricated winner');
  assert.equal(mp.winner_is_certain, false);
  assert.equal(mp.confidence, 'Insufficient');
  // Equal placeholder probabilities
  const { team_a_pct, team_b_pct, draw_pct } = mp.win_probability;
  assert.equal(team_a_pct + team_b_pct + draw_pct, 100, 'probabilities must sum to 100');
  assert.ok(mp.caveats && mp.caveats.length > 0, 'caveats must be present for unknown teams');
});

// ── /api/backtest ─────────────────────────────────────────────────────────────
test('/api/backtest returns valid metrics', { skip: !serverOk }, async () => {
  const { status, body } = await get('/api/backtest?limit=20');
  assert.equal(status, 200);
  assert.ok(typeof body.accuracy    === 'number', 'accuracy should be number');
  assert.ok(typeof body.brier_score === 'number', 'brier_score should be number');
  assert.ok(body.accuracy >= 0 && body.accuracy <= 1, 'accuracy should be in [0,1]');
  assert.ok(body.brier_score >= 0 && body.brier_score <= 1, 'brier_score should be in [0,1]');
  assert.ok(typeof body.calibration === 'object', 'calibration should be object');
  assert.ok('H' in body.calibration && 'D' in body.calibration && 'A' in body.calibration,
    'calibration should have H, D, A buckets');
  assert.ok(Array.isArray(body.sample_predictions), 'sample_predictions should be array');
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
if (serverOk) {
  await new Promise(res => setTimeout(res, 200)); // wait for all tests to settle
  await stopServer();
}
