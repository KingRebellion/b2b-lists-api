/**
 * server.js — B2B Lists API (Render) for Shopify App Proxy
 *
 * Supports:
 *  GET  /proxy?action=list&customer_id=...
 *  GET  /proxy?action=get&customer_id=...&list_id=...
 *  POST /proxy?action=upsert&customer_id=...   (x-www-form-urlencoded or JSON)
 *  POST /proxy?action=delete&customer_id=...   (x-www-form-urlencoded or JSON)
 *  GET  /proxy?action=orderify&customer_id=...&list_id=...   (SKU -> variant_id via Admin GraphQL)
 *
 * ENV required on Render:
 *  DATABASE_URL
 *  SHOPIFY_SHOP_DOMAIN = mississauga-hardware-wholesale.myshopify.com
 *  SHOPIFY_ADMIN_TOKEN = shpat_...
 */

import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

// Support both JSON and URL-encoded (proxy-friendly)
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

/**
 * Create tables + safe migrations
 */
async function ensureTables() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  // list_items stores SKU + quantity (variant resolution done at orderify)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS list_items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INT NOT NULL
    );
  `);

  // migrations
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS updated_at BIGINT;`);

  // indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lists_customer_id ON lists(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_list_items_list_id ON list_items(list_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_list_items_sku ON list_items(sku);`);
}

/**
 * Parse items from req.body.items (array or JSON string)
 * Expected items: [{ sku, quantity }]
 */
function parseItems(req) {
  let items = req.body?.items;

  // items may arrive as JSON string from URL-encoded posts
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch (e) {
      items = [];
    }
  }

  items = Array.isArray(items) ? items : [];

  items = items
    .map((x) => ({
      sku: String(x?.sku || "").trim(),
      quantity: parseInt(x?.quantity || 0, 10)
    }))
    .filter((x) => x.sku && x.quantity > 0);

  // normalize to uppercase SKUs to be consistent
  items = items.map((x) => ({ ...x, sku: x.sku.toUpperCase() }));

  return items;
}

/**
 * Admin GraphQL helper (hardened error handling)
 */
async function shopifyGql(query, variables) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!shop || !token) {
    const err = new Error("Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN");
    err.code = "MISSING_SHOPIFY_ENV";
    throw err;
  }

  const url = `https://${shop}/admin/api/2025-01/graphql.json`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await r.text();

  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    const err = new Error(
      `Shopify returned non-JSON (status ${r.status}). First 200 chars: ${text.slice(0, 200)}`
    );
    err.code = "SHOPIFY_NON_JSON";
    throw err;
  }

  // HTTP-level errors
  if (!r.ok) {
    const msg =
      (j && (j.error_description || j.error || j.message)) ||
      `Shopify HTTP ${r.status}`;
    const err = new Error(msg);
    err.code = "SHOPIFY_HTTP_ERROR";
    throw err;
  }

  // GraphQL "errors" in any shape
  if (j && j.errors) {
    let msg = "";
    if (Array.isArray(j.errors)) {
      msg = j.errors.map((e) => e.message || JSON.stringify(e)).join("; ");
    } else if (typeof j.errors === "string") {
      msg = j.errors;
    } else {
      msg = JSON.stringify(j.errors);
    }
    const err = new Error(msg || "Shopify GraphQL error");
    err.code = "SHOPIFY_GQL_ERROR";
    throw err;
  }

  return j.data;
}

// Health route
app.get("/", (req, res) => res.send("OK"));

/**
 * App Proxy endpoint (Shopify routes to this via app proxy config)
 */
app.all("/proxy", async (req, res) => {
  try {
    const action = String(req.query.action || "").toLowerCase();

    const customer_id = String(req.query.customer_id || req.body?.customer_id || "").trim();
    if (!customer_id) {
      return res.status(400).json({ ok: false, error: "Missing customer_id" });
    }

    if (!pool) {
      // Local mode without DB
      return res.json({ ok: true, lists: [] });
    }

    // ----------------------------
    // LIST: GET action=list
    // ----------------------------
    if (req.method === "GET" && action === "list") {
      const { rows } = await pool.query(
        `SELECT id, customer_id, name, created_at, updated_at
         FROM lists
         WHERE customer_id = $1
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 100`,
        [customer_id]
      );

      // item counts (fast)
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

      return res.json({
        ok: true,
        lists: rows.map((r) => ({
          id: r.id,
          name: r.name,
          created_at: String(r.created_at),
          updated_at: String(r.updated_at || r.created_at),
          // Keep UI simple: provide an array sized to item count (matches your meta usage)
          items: Array(countsById[r.id] || 0).fill(0)
        }))
      });
    }

    // ----------------------------
    // GET ONE: GET action=get&list_id=...
    // ----------------------------
    if (req.method === "GET" && action === "get") {
      const list_id = String(req.query.list_id || "").trim();
      if (!list_id) return res.status(400).json({ ok: false, error: "Missing list_id" });

      const { rows: listRows } = await pool.query(
        `SELECT id, name, created_at, updated_at
         FROM lists
         WHERE id=$1 AND customer_id=$2
         LIMIT 1`,
        [list_id, customer_id]
      );

      if (!listRows.length) return res.status(404).json({ ok: false, error: "List not found" });

      const { rows: itemRows } = await pool.query(
        `SELECT sku, quantity
         FROM list_items
         WHERE list_id=$1
         ORDER BY sku ASC`,
        [list_id]
      );

      return res.json({
        ok: true,
        list: {
          id: listRows[0].id,
          name: listRows[0].name,
          created_at: String(listRows[0].created_at),
          updated_at: String(listRows[0].updated_at || listRows[0].created_at),
          items: itemRows.map((r) => ({
            sku: r.sku,
            quantity: parseInt(r.quantity || 1, 10)
          }))
        }
      });
    }

    // ----------------------------
    // ORDERIFY: GET action=orderify&list_id=...
    // Returns: [{variant_id, quantity}] for cart adds
    // ----------------------------
    if (req.method === "GET" && action === "orderify") {
      const list_id = String(req.query.list_id || "").trim();
      if (!list_id) return res.status(400).json({ ok: false, error: "Missing list_id" });

      // ownership check
      const { rows: listRows } = await pool.query(
        `SELECT id FROM lists WHERE id=$1 AND customer_id=$2 LIMIT 1`,
        [list_id, customer_id]
      );
      if (!listRows.length) return res.status(404).json({ ok: false, error: "List not found" });

      const { rows: itemsRows } = await pool.query(
        `SELECT sku, quantity FROM list_items WHERE list_id=$1`,
        [list_id]
      );

      const QUERY = `
        query VariantBySku($q: String!) {
          productVariants(first: 1, query: $q) {
            edges { node { id sku availableForSale } }
          }
        }
      `;

      const resolved = [];
      const not_found = [];

      for (const it of itemsRows) {
        const sku = String(it.sku || "").trim();
        const qty = parseInt(it.quantity || 0, 10);
        if (!sku || qty < 1) continue;

        const data = await shopifyGql(QUERY, { q: `sku:${sku}` });
        const node = data?.productVariants?.edges?.[0]?.node;

        if (!node?.id) {
          not_found.push(sku);
          continue;
        }

        const numericId = String(node.id).split("/").pop(); // gid -> numeric
        resolved.push({
          sku,
          variant_id: numericId,
          quantity: qty,
          available: !!node.availableForSale
        });
      }

      return res.json({ ok: true, items: resolved, not_found });
    }

    // ----------------------------
    // UPSERT: POST action=upsert
    // Body: customer_id, list_id(optional), name, items(JSON string or array)
    // ----------------------------
    if (req.method === "POST" && action === "upsert") {
      const list_id = String(req.body?.list_id || "").trim(); // optional
      const name = String(req.body?.name || "").trim();
      const items = parseItems(req);

      if (!name) return res.status(400).json({ ok: false, error: "Missing list name" });
      if (!items.length) return res.status(400).json({ ok: false, error: "No items provided" });

      const now = Date.now();
      const id = list_id || crypto.randomUUID();

      // check existing ownership
      const { rows: existing } = await pool.query(
        `SELECT id FROM lists WHERE id=$1 AND customer_id=$2 LIMIT 1`,
        [id, customer_id]
      );

      if (existing.length) {
        await pool.query(
          `UPDATE lists SET name=$1, updated_at=$2 WHERE id=$3 AND customer_id=$4`,
          [name, now, id, customer_id]
        );
        await pool.query(`DELETE FROM list_items WHERE list_id=$1`, [id]);
      } else {
        await pool.query(
          `INSERT INTO lists (id, customer_id, name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, customer_id, name, now, now]
        );
      }

      // insert items
      for (const it of items) {
        await pool.query(
          `INSERT INTO list_items (id, list_id, sku, quantity)
           VALUES ($1,$2,$3,$4)`,
          [crypto.randomUUID(), id, it.sku, it.quantity]
        );
      }

      return res.json({ ok: true, list_id: id, not_found: [] });
    }

    // ----------------------------
    // DELETE: POST action=delete
    // Body: customer_id, list_id
    // ----------------------------
    if (req.method === "POST" && action === "delete") {
      const list_id = String(req.body?.list_id || "").trim();
      if (!list_id) return res.status(400).json({ ok: false, error: "Missing list_id" });

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
  app.listen(PORT, () => console.log("Server running on port " + PORT));
}
app.get("/proxy-ping", (req, res) => {
  res.json({ ok: true, ping: "from-render" });
});

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
