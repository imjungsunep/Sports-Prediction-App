// launcher.cjs — loads .env then starts the ESM server
// SECURITY: Never hard-code API keys here. Use a .env file (see .env.example).
// If a key was previously committed, rotate it immediately — see README §Security.

const path = require("path");

// Load .env before anything else so process.env is populated for server.js
try {
  require("dotenv").config({ path: path.join(__dirname, ".env") });
} catch {
  // dotenv is optional in production environments where vars are injected directly
}

import("./server.js").catch(e => { console.error(e); process.exit(1); });
