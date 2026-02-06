import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

/**
 * ✅ MUST HAVE:
 * - JSON for any JSON posts
 * - URL-encoded for Shopify App Proxy posts (your modal uses this)
 */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true })); // ✅ FIXES YOUR 500 on upsert

// -------------------- ENV --------------------
const DATABASE_URL = process.env.DATABASE_URL || "";
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || ""; // Admin API access token
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN || ""; // ex: mississauga-hardware-wholesale.myshopify.com
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || "";   // App proxy signature secret (optional but recommended)

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false,
    })
  : null;

// -------------------- DB INIT --------------------
async function ensureTables() {
  // lists: one per customer
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  // list_items: store SKU + quantity (not variant_id) so we can re-resolve later
  await pool.query(`
    CREATE TABLE IF NOT EXISTS list_items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INT NOT NULL,
      position INT NOT NULL,
      CONSTRAINT fk_list
        FOREIGN KEY(list_id)
        REFERENCES lists(id)
        ON DELETE CASCADE
    );
  `);

  // Helpful index
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_lists_customer_id ON lists(customer_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_list_items_list_id ON list_items(list_id);
  `);
}

function nowMs() {
  return Date.now();
}

function uid() {
  return crypto.randomBytes(16).toString("hex");
}

// -------------------- OPTIONAL: Verify App Proxy Signature --------------------
/**
 * Shopify App Proxy adds a "signature" query param.
 * You can validate it using your App Proxy secret.
 *
 * If SHOPIFY_API_SECRET is not set, we skip validation.
 * (That’s OK during dev, but set it for production.)
 */
function verifyProxySignature(req) {
  if (!SHOPIFY_API_SECRET) return true;

  const q = { ...(req.query || {}) };

  // Shopify uses "signature"
  const provided = q.signature;
  if (!provided) return false;

  // Remove signature from message
  delete q.signature;

  // Build message: sort keys, concatenate key=value
  const message = Object.keys(q)
    .sort()
    .map((k) => `${k}=${q[k]}`)
    .join("");

  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  return digest === provided;
}

// -------------------- Shopify Admin GraphQL --------------------
async function shopifyGql(query, variables = {}) {
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    throw new Error("Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN in env.");
  }

  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await resp.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Shopify GraphQL non-JSON (${resp.status}): ${text.slice(0, 200)}`);
  }

  // Handle top-level errors (array)
  if (Array.isArray(json.errors) && json.errors.length) {
    const msg = json.errors.map((e) => e.message).join("; ");
    throw new Error(`Shopify GraphQL errors: ${msg}`);
  }

  // Some responses include userErrors inside data; caller checks
  return json;
}

/**
 * Resolve SKUs -> variant ids via GraphQL.
 * This uses a variant query by SKU (search query).
 */
async function resolveSkusToVariants(skus = []) {
  // Deduplicate + sanitize
  const cleaned = Array.from(
    new Set(
      skus
        .map((s) => String(s || "").trim())
        .filter(Boolean)
        .map((s) => s.toUpperCase())
    )
  );

  if (!cleaned.length) return { found: new Map(), notFound: [] };

  // We’ll query each sku individually (simple + reliable)
  const found = new Map();
  const notFound = [];

  const Q = `
    query VariantBySku($q: String!) {
      productVariants(first: 5, query: $q) {
        edges {
          node {
            id
            sku
            title
            product { title }
          }
        }
      }
    }
  `;

  for (const sku of cleaned) {
    const q = `sku:${sku}`;
    try {
      const j = await shopifyGql(Q, { q });

      const edges = j?.data?.productVariants?.edges || [];
      if (!edges.length) {
        notFound.push(sku);
        continue;
      }

      // pick exact SKU match if present
      let exact = edges.find((e) => (e?.node?.sku || "").toUpperCase() === sku);
      if (!exact) exact = edges[0];

      const node = exact?.node;
      if (!node?.id) {
        notFound.push(sku);
        continue;
      }

      // Shopify GraphQL IDs are gid://shopify/ProductVariant/123...
      const variantIdNum = String(node.id).split("/").pop();
      found.set(sku, {
        variant_id: variantIdNum,
        sku: node.sku || sku,
        title: `${node.product?.title || ""}${node.title ? " — " + node.title : ""}`.trim(),
      });
    } catch (e) {
      // If Shopify errors, treat as not found for this sku but continue
      notFound.push(sku);
    }
  }

  return { found, notFound };
}

// -------------------- Helpers --------------------
function ok(res, payload = {}) {
  res.set("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify({ ok: true, ...payload }));
}

function fail(res, status = 400, message = "Bad request", extra = {}) {
  res.set("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify({ ok: false, error: message, ...extra }));
}

function getAction(req) {
  return String(req.query?.action || "").toLowerCase().trim();
}

function getCustomerId(req) {
  // can come from query or body (your liquid includes both)
  return String(req.query?.customer_id || req.body?.customer_id || "").trim();
}

function normalizeItems(rawItems) {
  // rawItems may be an array or a JSON string from URL-encoded posts
  let items = rawItems;

  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }

  items = Array.isArray(items) ? items : [];

  // Normalize each row: { sku, quantity }
  const cleaned = items
    .map((it, idx) => {
      const sku = String(it?.sku || "").trim().toUpperCase();
      let quantity = parseInt(String(it?.quantity ?? it?.qty ?? "1"), 10);
      if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
      return { sku, quantity, position: idx + 1 };
    })
    .filter((x) => x.sku);

  // Merge duplicate SKUs
  const merged = new Map();
  for (const it of cleaned) {
    if (!merged.has(it.sku)) merged.set(it.sku, { sku: it.sku, quantity: 0, position: it.position });
    merged.get(it.sku).quantity += it.quantity;
  }

  return Array.from(merged.values());
}

// -------------------- Health --------------------
app.get("/", (req, res) => res.send("OK"));

// -------------------- APP PROXY ROUTE --------------------
/**
 * Your proxy URL in Shopify should point to:
 *   https://b2b-lists-api.onrender.com/proxy
 *
 * Shopify storefront calls:
 *   /apps/b2b-lists/proxy?action=...
 * Shopify forwards it to /proxy on Render.
 */
app.all("/proxy", async (req, res) => {
  try {
    // Optional signature validation
    if (!verifyProxySignature(req)) {
      return fail(res, 401, "Invalid proxy signature.");
    }

    // If DB not configured
    if (!pool) {
      const action = getAction(req);
      if (action === "list") return ok(res, { lists: [] });
      return fail(res, 500, "DATABASE_URL not set on server.");
    }

    const action = getAction(req);
    const customerId = getCustomerId(req);

    if (!action) return fail(res, 400, "Missing action.");
    if (!customerId) return fail(res, 400, "Missing customer_id.");

    // ---------- LIST ----------
    if (action === "list" && req.method === "GET") {
      const { rows: lists } = await pool.query(
        `SELECT id, customer_id, name, updated_at
         FROM lists
         WHERE customer_id = $1
         ORDER BY updated_at DESC`,
        [customerId]
      );

      // attach item counts quickly
      const ids = lists.map((l) => l.id);
      let countsById = new Map();
      if (ids.length) {
        const { rows: counts } = await pool.query(
          `SELECT list_id, COUNT(*)::int AS cnt
           FROM list_items
           WHERE list_id = ANY($1)
           GROUP BY list_id`,
          [ids]
        );
        counts.forEach((c) => countsById.set(c.list_id, c.cnt));
      }

      const shaped = lists.map((l) => ({
        id: l.id,
        customer_id: l.customer_id,
        name: l.name,
        updated_at: l.updated_at,
        items: new Array(countsById.get(l.id) || 0).fill({}), // keeps your UI meta stable
        item_count: countsById.get(l.id) || 0,
      }));

      return ok(res, { lists: shaped });
    }

    // ---------- GET (full list with items) ----------
    if (action === "get" && req.method === "GET") {
      const listId = String(req.query?.list_id || "").trim();
      if (!listId) return fail(res, 400, "Missing list_id.");

      const { rows: listRows } = await pool.query(
        `SELECT id, customer_id, name, updated_at
         FROM lists
         WHERE id = $1 AND customer_id = $2`,
        [listId, customerId]
      );
      if (!listRows.length) return fail(res, 404, "List not found.");

      const { rows: itemRows } = await pool.query(
        `SELECT sku, quantity, position
         FROM list_items
         WHERE list_id = $1
         ORDER BY position ASC`,
        [listId]
      );

      return ok(res, {
        list: {
          ...listRows[0],
          items: itemRows.map((r) => ({ sku: r.sku, quantity: r.quantity })),
        },
      });
    }

    // ---------- UPSERT (create or update) ----------
    if (action === "upsert" && req.method === "POST") {
      const listIdIncoming = String(req.body?.list_id || req.query?.list_id || "").trim();
      const name = String(req.body?.name || "").trim();
      const items = normalizeItems(req.body?.items);

      if (!name) return fail(res, 400, "Missing name.");
      if (!items.length) return fail(res, 400, "No items provided.");

      const listId = listIdIncoming || uid();
      const ts = nowMs();

      // Ensure list row
      await pool.query(
        `INSERT INTO lists (id, customer_id, name, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at
         WHERE lists.customer_id = $2`,
        [listId, customerId, name, ts]
      );

      // Replace items (simple + reliable)
      await pool.query(`DELETE FROM list_items WHERE list_id = $1`, [listId]);

      // Insert items
      for (const it of items) {
        await pool.query(
          `INSERT INTO list_items (id, list_id, sku, quantity, position)
           VALUES ($1, $2, $3, $4, $5)`,
          [uid(), listId, it.sku, it.quantity, it.position]
        );
      }

      return ok(res, { list_id: listId });
    }

    // ---------- DELETE ----------
    if (action === "delete" && req.method === "POST") {
      const listId = String(req.body?.list_id || req.query?.list_id || "").trim();
      if (!listId) return fail(res, 400, "Missing list_id.");

      // Only delete if belongs to this customer
      const r = await pool.query(
        `DELETE FROM lists WHERE id = $1 AND customer_id = $2`,
        [listId, customerId]
      );

      if (r.rowCount === 0) return fail(res, 404, "List not found.");
      return ok(res, {});
    }

    // ---------- ORDERIFY (convert saved SKUs -> variant ids) ----------
    if (action === "orderify" && req.method === "GET") {
      const listId = String(req.query?.list_id || "").trim();
      if (!listId) return fail(res, 400, "Missing list_id.");

      const { rows: listRows } = await pool.query(
        `SELECT id FROM lists WHERE id = $1 AND customer_id = $2`,
        [listId, customerId]
      );
      if (!listRows.length) return fail(res, 404, "List not found.");

      const { rows: itemRows } = await pool.query(
        `SELECT sku, quantity
         FROM list_items
         WHERE list_id = $1
         ORDER BY position ASC`,
        [listId]
      );

      const skus = itemRows.map((r) => r.sku);
      const { found, notFound } = await resolveSkusToVariants(skus);

      const items = [];
      for (const row of itemRows) {
        const hit = found.get(String(row.sku).toUpperCase());
        if (!hit) continue;
        items.push({
          sku: row.sku,
          quantity: row.quantity,
          variant_id: hit.variant_id,
          title: hit.title,
        });
      }

      return ok(res, { items, not_found: notFound });
    }

    // Anything else
    return fail(res, 400, `Unsupported action/method. action=${action} method=${req.method}`);
  } catch (err) {
    // IMPORTANT: return JSON (so your Liquid doesn't get HTML)
    console.error("Proxy error:", err);
    return fail(res, 500, "Server error", { detail: String(err?.message || err) });
  }
});

// -------------------- START --------------------
const PORT = process.env.PORT || 3000;

async function start() {
  app.listen(PORT, () => console.log("Server running on port " + PORT));
}

if (!pool) {
  console.log("DATABASE_URL not set — running without DB.");
  start();
} else {
  ensureTables()
    .then(start)
    .catch((err) => {
      console.error("DB init failed:", err);
      process.exit(1);
    });
}
