import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

/**
 * IMPORTANT:
 * - Shopify app proxy + frontend fetch works more reliably with URL-encoded POST
 * - So we enable BOTH json + urlencoded
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ENV
const DATABASE_URL = process.env.DATABASE_URL || "";

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("render.com")
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

// Create tables
async function ensureTables() {
  if (!pool) return;

  // Create base tables if missing (original)
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

  // --- Migrations (safe) ---

  // Add updated_at if missing
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS updated_at BIGINT;`);

  // If list_items has variant_id but not sku, rename variant_id -> sku
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='list_items' AND column_name='variant_id'
      )
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='list_items' AND column_name='sku'
      ) THEN
        ALTER TABLE list_items RENAME COLUMN variant_id TO sku;
      END IF;
    END $$;
  `);

  // If sku still doesn't exist for some reason, add it
  await pool.query(`ALTER TABLE list_items ADD COLUMN IF NOT EXISTS sku TEXT;`);

  // Indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lists_customer_id ON lists(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_list_items_list_id ON list_items(list_id);`);
}
// Health
app.get("/", (req, res) => res.send("OK"));

/**
 * Helper: safe parse items from body (may arrive as JSON string via URL-encoded posts)
 */
function parseItems(req) {
  let items = req.body?.items;

  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch (e) {
      items = [];
    }
  }

  if (!Array.isArray(items)) items = [];

  // normalize
  items = items
    .map((x) => ({
      sku: String(x?.sku || "").trim(),
      quantity: parseInt(x?.quantity || 0, 10)
    }))
    .filter((x) => x.sku && x.quantity > 0);

  return items;
}

/**
 * Proxy route used by Shopify App Proxy:
 * /apps/b2b-lists/proxy?action=list&customer_id=123
 *
 * We'll support:
 * GET  /proxy?action=list&customer_id=...
 * GET  /proxy?action=get&customer_id=...&list_id=...
 * POST /proxy?action=upsert&customer_id=...   (urlencoded or json)
 * POST /proxy?action=delete&customer_id=...   (urlencoded or json)
 *
 * NOTE: In dev you can hit /proxy directly.
 */
app.all("/proxy", async (req, res) => {
  try {
    const action = String(req.query.action || "").toLowerCase();

    const customer_id =
      String(req.query.customer_id || req.body?.customer_id || "").trim();

    if (!customer_id) {
      return res.status(400).json({ ok: false, error: "Missing customer_id" });
    }

    if (!pool) {
      // If DATABASE_URL isn't set, we can still respond (local/dev)
      return res.json({ ok: true, lists: [] });
    }

    // LIST
    if (req.method === "GET" && action === "list") {
      const { rows } = await pool.query(
        `SELECT id, customer_id, name, created_at, updated_at
         FROM lists
         WHERE customer_id = $1
         ORDER BY updated_at DESC
         LIMIT 50`,
        [customer_id]
      );

      // attach item counts
      const ids = rows.map((r) => r.id);
      let countsById = {};
      if (ids.length) {
        const { rows: countRows } = await pool.query(
          `SELECT list_id, COUNT(*)::int AS cnt
           FROM list_items
           WHERE list_id = ANY($1)
           GROUP BY list_id`,
          [ids]
        );
        countRows.forEach((r) => (countsById[r.list_id] = r.cnt));
      }

      const lists = rows.map((r) => ({
        id: r.id,
        name: r.name,
        created_at: String(r.created_at),
        updated_at: String(r.updated_at),
        items: Array(countsById[r.id] || 0).fill(0) // frontend only needs length for "x items"
      }));

      return res.json({ ok: true, lists });
    }

    // GET ONE (for editing)
    if (req.method === "GET" && action === "get") {
      const list_id = String(req.query.list_id || "").trim();
      if (!list_id) return res.status(400).json({ ok: false, error: "Missing list_id" });

      const { rows: listRows } = await pool.query(
        `SELECT id, customer_id, name, created_at, updated_at
         FROM lists
         WHERE id = $1 AND customer_id = $2
         LIMIT 1`,
        [list_id, customer_id]
      );

      if (!listRows.length) return res.status(404).json({ ok: false, error: "List not found" });

      const { rows: itemRows } = await pool.query(
        `SELECT sku, quantity
         FROM list_items
         WHERE list_id = $1
         ORDER BY sku ASC`,
        [list_id]
      );

      return res.json({
        ok: true,
        list: {
          id: listRows[0].id,
          name: listRows[0].name,
          created_at: String(listRows[0].created_at),
          updated_at: String(listRows[0].updated_at),
          items: itemRows
        }
      });
    }

    // UPSERT (create or update)
    if (req.method === "POST" && action === "upsert") {
      const list_id = String(req.body?.list_id || "").trim(); // optional
      const name = String(req.body?.name || "").trim();
      const items = parseItems(req);

      if (!name) return res.status(400).json({ ok: false, error: "Missing list name" });
      if (!items.length) return res.status(400).json({ ok: false, error: "No items provided" });

      const now = Date.now();
      const id = list_id || crypto.randomUUID();

      // If list exists, ensure it belongs to customer
      const { rows: existing } = await pool.query(
        `SELECT id FROM lists WHERE id=$1 AND customer_id=$2 LIMIT 1`,
        [id, customer_id]
      );

      if (existing.length) {
        await pool.query(
          `UPDATE lists SET name=$1, updated_at=$2 WHERE id=$3 AND customer_id=$4`,
          [name, now, id, customer_id]
        );
        // wipe old items
        await pool.query(`DELETE FROM list_items WHERE list_id=$1`, [id]);
      } else {
        await pool.query(
          `INSERT INTO lists (id, customer_id, name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, customer_id, name, now, now]
        );
      }

      // insert items (store SKU + qty)
      for (const it of items) {
        await pool.query(
          `INSERT INTO list_items (id, list_id, sku, quantity)
           VALUES ($1,$2,$3,$4)`,
          [crypto.randomUUID(), id, it.sku, it.quantity]
        );
      }

      return res.json({ ok: true, list_id: id, not_found: [] });
    }

    // DELETE
    if (req.method === "POST" && action === "delete") {
      const list_id = String(req.body?.list_id || "").trim();
      if (!list_id) return res.status(400).json({ ok: false, error: "Missing list_id" });

      // Only delete if owned by customer
      await pool.query(`DELETE FROM list_items WHERE list_id=$1`, [list_id]);
      await pool.query(`DELETE FROM lists WHERE id=$1 AND customer_id=$2`, [list_id, customer_id]);

      return res.json({ ok: true });
    }

    return res.status(400).json({
      ok: false,
      error: `Unsupported action/method. action=${action} method=${req.method}`
    });
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
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
    .catch((err) => {
      console.error("DB init failed:", err);
      process.exit(1);
    });
}
