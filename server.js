import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

// IMPORTANT: App Proxy often posts as x-www-form-urlencoded
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

// ENV
const DATABASE_URL = process.env.DATABASE_URL || "";

// Postgres
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false,
});

// ---------- DB ----------
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  // Store SKU + qty (NOT variant_id) so we don't need Admin API
  await pool.query(`
    CREATE TABLE IF NOT EXISTS list_items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INT NOT NULL,
      position INT NOT NULL,
      CONSTRAINT fk_list FOREIGN KEY(list_id) REFERENCES lists(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lists_customer ON lists(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_items_list ON list_items(list_id);`);
}

function nowMs() {
  return Date.now();
}
function uid(prefix = "") {
  return prefix + crypto.randomBytes(16).toString("hex");
}

function ok(res, data = {}) {
  res.set("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify({ ok: true, ...data }));
}
function fail(res, code = 400, message = "Bad request") {
  res.set("Content-Type", "application/json; charset=utf-8");
  res.status(code).send(JSON.stringify({ ok: false, error: message }));
}

// Normalize items coming from urlencoded forms
function parseItemsFromBody(req) {
  let items = req.body?.items;

  // items might be a JSON string (because we send URLSearchParams)
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch (e) {
      items = [];
    }
  }

  if (!Array.isArray(items)) items = [];

  // Keep only valid rows
  const cleaned = [];
  for (const it of items) {
    const sku = String(it?.sku || "").trim();
    let quantity = parseInt(it?.quantity, 10);
    if (!sku) continue;
    if (!quantity || quantity < 1) quantity = 1;
    cleaned.push({ sku, quantity });
  }

  // Merge duplicates by SKU (case-insensitive)
  const merged = new Map();
  for (const it of cleaned) {
    const key = it.sku.toUpperCase();
    merged.set(key, (merged.get(key) || 0) + it.quantity);
  }

  return Array.from(merged.entries()).map(([sku, quantity], i) => ({
    sku,
    quantity,
    position: i + 1,
  }));
}

// ---------- ROUTES ----------
app.get("/", (req, res) => res.send("OK"));

// (Optional) quick health for debugging
app.get("/proxy-ping", (req, res) => ok(res, { pong: true }));

/**
 * Shopify App Proxy endpoint
 * Your app proxy points to: /proxy  (or whatever you set)
 * Storefront calls: /apps/b2b-lists/proxy?action=...
 */
app.all("/proxy", async (req, res) => {
  try {
    const action = String(req.query?.action || "").toLowerCase();

    // App proxy will be called like:
    // /apps/b2b-lists/proxy?action=list&customer_id=123
    const customer_id = String(req.query?.customer_id || req.body?.customer_id || "").trim();

    if (!action) return fail(res, 400, "Missing action");
    if (!customer_id && action !== "ping") return fail(res, 400, "Missing customer_id");

    // ---- LIST ----
    if (action === "list" && req.method === "GET") {
      const { rows: lists } = await pool.query(
        `SELECT id, customer_id, name, updated_at
         FROM lists
         WHERE customer_id=$1
         ORDER BY updated_at DESC`,
        [customer_id]
      );

      // Attach item counts
      const out = [];
      for (const l of lists) {
        const { rows: cnt } = await pool.query(
          `SELECT COUNT(*)::int AS c FROM list_items WHERE list_id=$1`,
          [l.id]
        );
        out.push({
          id: l.id,
          customer_id: l.customer_id,
          name: l.name,
          updated_at: l.updated_at,
          items_count: cnt?.[0]?.c || 0,
        });
      }

      return ok(res, { lists: out });
    }

    // ---- GET ----
    if (action === "get" && req.method === "GET") {
      const list_id = String(req.query?.list_id || "").trim();
      if (!list_id) return fail(res, 400, "Missing list_id");

      const { rows: lrows } = await pool.query(
        `SELECT id, customer_id, name, updated_at
         FROM lists
         WHERE id=$1 AND customer_id=$2
         LIMIT 1`,
        [list_id, customer_id]
      );
      if (!lrows.length) return fail(res, 404, "List not found");

      const { rows: irows } = await pool.query(
        `SELECT sku, quantity, position
         FROM list_items
         WHERE list_id=$1
         ORDER BY position ASC`,
        [list_id]
      );

      return ok(res, {
        list: {
          id: lrows[0].id,
          customer_id: lrows[0].customer_id,
          name: lrows[0].name,
          updated_at: lrows[0].updated_at,
          items: irows.map((r) => ({ sku: r.sku, quantity: r.quantity })),
        },
      });
    }

    // ---- UPSERT (create or update) ----
    // Your storefront JS calls POST with urlencoded params
    if (action === "upsert" && req.method === "POST") {
      const list_id_in = String(req.body?.list_id || "").trim();
      const name = String(req.body?.name || "").trim();

      if (!name) return fail(res, 400, "Missing name");

      const items = parseItemsFromBody(req);
      if (!items.length) return fail(res, 400, "No items");

      const list_id = list_id_in || uid("list_");
      const updated_at = nowMs();

      // Upsert list
      await pool.query(
        `
        INSERT INTO lists (id, customer_id, name, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE
          SET name=EXCLUDED.name,
              updated_at=EXCLUDED.updated_at
        `,
        [list_id, customer_id, name, updated_at]
      );

      // Replace items
      await pool.query(`DELETE FROM list_items WHERE list_id=$1`, [list_id]);

      for (const it of items) {
        await pool.query(
          `
          INSERT INTO list_items (id, list_id, sku, quantity, position)
          VALUES ($1, $2, $3, $4, $5)
          `,
          [uid("itm_"), list_id, it.sku, it.quantity, it.position]
        );
      }

      return ok(res, {
        list_id,
        updated_at,
        items_saved: items.length,
      });
    }

    // ---- DELETE ----
    if (action === "delete" && req.method === "POST") {
      const list_id = String(req.body?.list_id || req.query?.list_id || "").trim();
      if (!list_id) return fail(res, 400, "Missing list_id");

      // Ensure ownership
      const { rows: owned } = await pool.query(
        `SELECT id FROM lists WHERE id=$1 AND customer_id=$2 LIMIT 1`,
        [list_id, customer_id]
      );
      if (!owned.length) return fail(res, 404, "List not found");

      await pool.query(`DELETE FROM lists WHERE id=$1 AND customer_id=$2`, [list_id, customer_id]);
      return ok(res, { deleted: true });
    }

    // ---- ORDERIFY ----
    // Returns SKUs+qty for the list so the storefront can resolve and add to cart
    if (action === "orderify" && req.method === "GET") {
      const list_id = String(req.query?.list_id || "").trim();
      if (!list_id) return fail(res, 400, "Missing list_id");

      const { rows: lrows } = await pool.query(
        `SELECT id FROM lists WHERE id=$1 AND customer_id=$2 LIMIT 1`,
        [list_id, customer_id]
      );
      if (!lrows.length) return fail(res, 404, "List not found");

      const { rows: irows } = await pool.query(
        `SELECT sku, quantity
         FROM list_items
         WHERE list_id=$1
         ORDER BY position ASC`,
        [list_id]
      );

      return ok(res, {
        list_id,
        items: irows.map((r) => ({ sku: r.sku, quantity: r.quantity })),
      });
    }

    return fail(res, 400, `Unsupported action/method. action=${action} method=${req.method}`);
  } catch (err) {
    console.error("Proxy error:", err);
    return fail(res, 500, "Server error");
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;

async function start() {
  if (!DATABASE_URL) {
    console.log("DATABASE_URL not set — cannot run without DB.");
    process.exit(1);
  }

  await ensureTables();
  app.listen(PORT, () => console.log("Server running on port " + PORT));
}

start().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
