import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

// App Proxy friendly parsers
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

// Prevent Shopify proxy returning HTML on long waits
app.use((req, res, next) => {
  res.setTimeout(12000, () => {
    res.status(200).json({ ok: false, error: "Timeout. Please retry." });
  });
  next();
});

// ENV
const DATABASE_URL = process.env.DATABASE_URL || "";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false
});

// ---------- helpers ----------
function uid(prefix = "") {
  return prefix + crypto.randomBytes(16).toString("hex");
}

function sendJson(res, obj) {
  // IMPORTANT: Always 200 so Shopify App Proxy does NOT swap response into HTML error pages
  res.status(200);
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(obj));
}

function ok(res, obj = {}) {
  return sendJson(res, { ok: true, ...obj });
}

function bad(res, msg = "Bad request", detail = "") {
  return sendJson(res, {
    ok: false,
    error: msg,
    ...(detail ? { error_detail: detail } : {})
  });
}

function parseItems(req) {
  let items = req.body?.items;

  // items may arrive as a JSON string from URL-encoded posts
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }

  items = Array.isArray(items) ? items : [];

  const cleaned = [];
  for (const it of items) {
    const sku = String(it?.sku || "").trim();
    let quantity = parseInt(it?.quantity, 10);
    if (!sku) continue;
    if (!quantity || quantity < 1) quantity = 1;
    cleaned.push({ sku: sku.toUpperCase(), quantity });
  }

  // Merge duplicate SKUs
  const map = new Map();
  for (const it of cleaned) {
    map.set(it.sku, (map.get(it.sku) || 0) + it.quantity);
  }

  let pos = 1;
  return Array.from(map.entries()).map(([sku, quantity]) => ({
    sku,
    quantity,
    position: pos++
  }));
}

// ---------- DB init ----------
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS list_items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INT NOT NULL,
      position INT NOT NULL
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lists_customer ON lists(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_items_list ON list_items(list_id);`);
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.send("OK");
});

/**
 * APP PROXY ENDPOINT
 * App Proxy should point to:
 *   https://YOUR-RENDER-DOMAIN/proxy
 */
app.all("/proxy", async (req, res) => {
  try {
    const action = String(req.query?.action || "").toLowerCase();

    const customer_id = String(
      req.query?.customer_id || req.body?.customer_id || ""
    ).trim();

    if (!action) return bad(res, "Missing action");
    if (!customer_id) return bad(res, "Missing customer_id");

    // --------- DEBUG: ECHO ----------
    // GET /proxy?action=echo&customer_id=123
    // POST /proxy?action=echo&customer_id=123 (with form body)
    if (action === "echo") {
      return ok(res, {
        method: req.method,
        query: req.query,
        body_keys: Object.keys(req.body || {}),
        body: req.body || null,
        content_type: req.headers["content-type"] || null
      });
    }

    // ---------- LIST (FAST) ----------
    if (action === "list" && req.method === "GET") {
      const { rows } = await pool.query(
        `
        SELECT
          l.id,
          l.name,
          l.updated_at,
          COALESCE(COUNT(li.id), 0)::int AS items_count
        FROM lists l
        LEFT JOIN list_items li
          ON li.list_id = l.id
        WHERE l.customer_id = $1
        GROUP BY l.id, l.name, l.updated_at
        ORDER BY l.updated_at DESC
        `,
        [customer_id]
      );

      return ok(res, { lists: rows });
    }

    // ---------- GET ----------
    if (action === "get" && req.method === "GET") {
      const list_id = String(req.query?.list_id || "").trim();
      if (!list_id) return bad(res, "Missing list_id");

      const { rows: lrows } = await pool.query(
        `
        SELECT id, name, updated_at
        FROM lists
        WHERE id=$1 AND customer_id=$2
        LIMIT 1
        `,
        [list_id, customer_id]
      );
      if (!lrows.length) return bad(res, "List not found");

      const { rows: irows } = await pool.query(
        `
        SELECT sku, quantity, position
        FROM list_items
        WHERE list_id=$1
        ORDER BY position ASC
        `,
        [list_id]
      );

      return ok(res, {
        list: {
          id: lrows[0].id,
          name: lrows[0].name,
          updated_at: lrows[0].updated_at,
          items: irows.map(r => ({ sku: r.sku, quantity: r.quantity }))
        }
      });
    }

    // ---------- UPSERT ----------
    if (action === "upsert" && req.method === "POST") {
      const list_id_in = String(req.body?.list_id || "").trim();
      const name = String(req.body?.name || "").trim();
      if (!name) return bad(res, "Missing name");

      const items = parseItems(req);
      if (!items.length) return bad(res, "Please add at least one SKU + Qty.");

      const list_id = list_id_in || uid("list_");
      const updated_at = Date.now();

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

      return ok(res, { list_id, updated_at, items_saved: items.length });
    }

    // ---------- DELETE ----------
    if (action === "delete" && req.method === "POST") {
      const list_id = String(req.body?.list_id || "").trim();
      if (!list_id) return bad(res, "Missing list_id");

      const { rows: owned } = await pool.query(
        `SELECT id FROM lists WHERE id=$1 AND customer_id=$2 LIMIT 1`,
        [list_id, customer_id]
      );
      if (!owned.length) return bad(res, "List not found");

      await pool.query(`DELETE FROM list_items WHERE list_id=$1`, [list_id]);
      await pool.query(`DELETE FROM lists WHERE id=$1 AND customer_id=$2`, [list_id, customer_id]);

      return ok(res, { deleted: true });
    }

    return bad(res, `Unsupported action/method. action=${action} method=${req.method}`);
  } catch (err) {
    console.error("Proxy error:", err);

    const detail =
      (err && err.stack) ? err.stack :
      (err && err.message) ? err.message :
      String(err);

    // Still 200 JSON (Shopify-safe)
    return bad(res, "Server error", detail);
  }
});

// ---------- start ----------
const PORT = process.env.PORT || 3000;

async function start() {
  if (!DATABASE_URL) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  await ensureTables();

  app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
  });
}

start().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
