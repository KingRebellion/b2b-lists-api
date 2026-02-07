import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

const DATABASE_URL = process.env.DATABASE_URL || "";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false
});

function uid(prefix = "") {
  return prefix + crypto.randomBytes(16).toString("hex");
}

function sendJson(res, obj) {
  // Always 200 JSON for Shopify App Proxy stability
  res.status(200);
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(obj));
}

function ok(res, obj = {}) {
  return sendJson(res, { ok: true, ...obj });
}

function bad(res, msg = "Bad request", detail = "") {
  return sendJson(res, { ok: false, error: msg, ...(detail ? { detail } : {}) });
}

function parseItemsFromBody(req) {
  // items may arrive as JSON string (urlencoded) or array (json)
  let items = req.body?.items;

  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { items = []; }
  }
  items = Array.isArray(items) ? items : [];

  const cleaned = [];
  for (const it of items) {
    const sku = String(it?.sku || "").trim();
    let qty = parseInt(it?.quantity, 10);
    if (!sku) continue;
    if (!qty || qty < 1) qty = 1;
    cleaned.push({ sku: sku.toUpperCase(), quantity: qty });
  }

  // merge duplicate SKUs
  const map = new Map();
  for (const it of cleaned) {
    map.set(it.sku, (map.get(it.sku) || 0) + it.quantity);
  }
  return Array.from(map.entries()).map(([sku, quantity]) => ({ sku, quantity }));
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  // SKU-based table (NO variant_id, NO position)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS list_items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INT NOT NULL
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lists_customer ON lists(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_items_list ON list_items(list_id);`);

  // If you previously created list_items without sku, this will still fail —
  // but based on your error, you DO have sku and NOT variant_id, so we're aligning to that.
}

app.get("/", (req, res) => res.send("OK"));

app.all("/proxy", async (req, res) => {
  try {
    const action = String(req.query.action || req.body.action || "").toLowerCase();
    const customer_id = String(req.query.customer_id || req.body.customer_id || "").trim();

    if (!action) return bad(res, "Missing action");
    if (!customer_id) return bad(res, "Missing customer_id");

    // Debug helper
    if (action === "echo") {
      return ok(res, {
        method: req.method,
        query: req.query,
        body_keys: Object.keys(req.body || {}),
        body: req.body || null,
        content_type: req.headers["content-type"] || null
      });
    }

    // LIST
    if (action === "list" && req.method === "GET") {
      const { rows: lists } = await pool.query(
        `
        SELECT id, name, created_at, updated_at
        FROM lists
        WHERE customer_id=$1
        ORDER BY updated_at DESC
        `,
        [customer_id]
      );

      const out = [];
      for (const l of lists) {
        const { rows: items } = await pool.query(
          `
          SELECT sku, quantity
          FROM list_items
          WHERE list_id=$1
          `,
          [l.id]
        );

        out.push({ ...l, items });
      }

      return ok(res, { lists: out });
    }

    // GET
    if (action === "get" && req.method === "GET") {
      const list_id = String(req.query.list_id || "").trim();
      if (!list_id) return bad(res, "Missing list_id");

      const { rows: lrows } = await pool.query(
        `
        SELECT id, name, created_at, updated_at
        FROM lists
        WHERE id=$1 AND customer_id=$2
        LIMIT 1
        `,
        [list_id, customer_id]
      );
      if (!lrows.length) return bad(res, "List not found");

      const { rows: items } = await pool.query(
        `
        SELECT sku, quantity
        FROM list_items
        WHERE list_id=$1
        `,
        [list_id]
      );

      return ok(res, { list: { ...lrows[0], items } });
    }

    // UPSERT (expects items as [{sku, quantity}, ...])
    if (action === "upsert" && req.method === "POST") {
      const list_id_in = String(req.body.list_id || "").trim();
      const name = String(req.body.name || "").trim();
      if (!name) return bad(res, "Missing name");

      const items = parseItemsFromBody(req);
      if (!items.length) return bad(res, "No valid items provided");

      const list_id = list_id_in || uid("list_");
      const ts = Date.now();

      const { rows: exists } = await pool.query(
        `SELECT id FROM lists WHERE id=$1 AND customer_id=$2 LIMIT 1`,
        [list_id, customer_id]
      );

      if (!exists.length) {
        await pool.query(
          `
          INSERT INTO lists (id, customer_id, name, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5)
          `,
          [list_id, customer_id, name, ts, ts]
        );
      } else {
        await pool.query(
          `
          UPDATE lists
          SET name=$1, updated_at=$2
          WHERE id=$3 AND customer_id=$4
          `,
          [name, ts, list_id, customer_id]
        );
      }

      // Replace items
      await pool.query(`DELETE FROM list_items WHERE list_id=$1`, [list_id]);

      for (const it of items) {
        await pool.query(
          `
          INSERT INTO list_items (id, list_id, sku, quantity)
          VALUES ($1,$2,$3,$4)
          `,
          [uid("itm_"), list_id, it.sku, it.quantity]
        );
      }

      return ok(res, { list_id, updated_at: ts, items_saved: items.length });
    }

    // DELETE
    if (action === "delete" && req.method === "POST") {
      const list_id = String(req.body.list_id || req.query.list_id || "").trim();
      if (!list_id) return bad(res, "Missing list_id");

      await pool.query(`DELETE FROM list_items WHERE list_id=$1`, [list_id]);
      await pool.query(`DELETE FROM lists WHERE id=$1 AND customer_id=$2`, [list_id, customer_id]);

      return ok(res, { deleted: true });
    }

    // ORDERIFY (returns sku/qty)
    if (action === "orderify" && req.method === "GET") {
      const list_id = String(req.query.list_id || "").trim();
      if (!list_id) return bad(res, "Missing list_id");

      const { rows: items } = await pool.query(
        `SELECT sku, quantity FROM list_items WHERE list_id=$1`,
        [list_id]
      );

      return ok(res, { items });
    }

    return bad(res, `Unsupported action/method. action=${action} method=${req.method}`);
  } catch (err) {
    console.error("Proxy error:", err);
    return bad(res, "Server error", err?.message || String(err));
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  if (!DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  await ensureTables();
  app.listen(PORT, () => console.log("Server running on port " + PORT));
}

start().catch((e) => {
  console.error("Startup failed:", e);
  process.exit(1);
});

