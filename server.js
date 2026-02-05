import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

app.use(express.json({ limit: "1mb" }));

// ENV
const DATABASE_URL = process.env.DATABASE_URL || "";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

// Create tables
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS list_items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      quantity INT NOT NULL
    );
  `);
}

// Test route
app.get("/", (req, res) => {
  res.send("OK");
});

// Test API route
app.get("/proxy", (req, res) => {
  res.json({ ok: true, lists: [] });
});

const PORT = process.env.PORT || 3000;

function start() {
  app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
  });
}

if (!DATABASE_URL) {
  console.log("DATABASE_URL not set — running without DB (local dev mode).");
  start();
} else {
  ensureTables()
    .then(start)
    .catch(err => {
      console.error("DB init failed:", err);
      process.exit(1);
    });
}