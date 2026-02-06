import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

/**
 * IMPORTANT:
 * - App Proxy POSTs often arrive as x-www-form-urlencoded.
 * - We support both JSON and URL-encoded.
 */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- ENV --------------------
const DATABASE_URL = process.env.DATABASE_URL || "";

const SHOP_DOMAIN = (process.env.SHOPIFY_SHOP_DOMAIN || "").trim(); // mississauga-hardware-wholesale.myshopify.com
const SHOPIFY_CLIENT_ID = (process.env.SHOPIFY_CLIENT_ID || "").trim();
const SHOPIFY_CLIENT_SECRET = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();
const SHOPIFY_API_VERSION = (process.env.SHOPIFY_API_VERSION || "2025-01").trim();
const VERIFY_PROXY = String(process.env.VERIFY_PROXY || "false").toLowerCase() === "true";

// -------------------- DB --------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false,
});

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS list_items (
      id TEXT PRIMARY KEY,
      list_id TEXT NOT NULL,
      sku TEXT,
      variant_id TEXT NOT NULL,
      quantity INT NOT NULL,
      position INT NOT NULL
    );
  `);

  // Helpful indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lists_customer ON lists(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_items_list ON list_items(list_id);`);
}

// -------------------- Utilities --------------------
function nowMs() {
  return Date.now();
}

function jsonOk(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(payload));
}

function jsonErr(res, code, message, extra) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(code).send(JSON.stringify({ ok: false, error: message, ...(extra || {}) }));
}

/**
 * (Optional) Verify Shopify App Proxy signature.
 * Leave VERIFY_PROXY=false until everything works.
 *
 * Note: Shopify App Proxy uses `signature` in query params.
 * We'll verify using the shared secret (client secret).
 */
function verifyProxySignature(req) {
  if (!VERIFY_PROXY) return true;

  const secret = SHOPIFY_CLIENT_SECRET;
  if (!secret) return false;

  const sig = req.query.signature;
  if (!sig) return false;

  // Build message string: sort all query params except signature
  const params = { ...req.query };
  delete params.signature;

  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${Array.isArray(params[k]) ? params[k].join(",") : params[k]}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(sorted).digest("hex");

  return digest === sig;
}

/**
 * Client Credentials Grant token caching (24h tokens; we refresh early).
 * Docs: POST https://{shop}.myshopify.com/admin/oauth/access_token
 */
let tokenCache = {
  accessToken: null,
  expiresAtMs: 0,
  scope: "",
};

async function getAdminAccessToken() {
  if (!SHOP_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error("Missing SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET");
  }

  // Use cached token if valid for at least 2 minutes.
  const safety = 2 * 60 * 1000;
  if (tokenCache.accessToken && tokenCache.expiresAtMs > nowMs() + safety) {
    return tokenCache.accessToken;
  }

  const url = `https://${SHOP_DOMAIN}/admin/oauth/access_token`;
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", SHOPIFY_CLIENT_ID);
  body.set("client_secret", SHOPIFY_CLIENT_SECRET);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body.toString(),
  });

  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!resp.ok || !data || !data.access_token) {
    throw new Error(`Token fetch failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  const expiresIn = Number(data.expires_in || 0); // seconds (usually 86399)
  tokenCache.accessToken = data.access_token;
  tokenCache.scope = data.scope || "";
  tokenCache.expiresAtMs = nowMs() + (expiresIn > 0 ? expiresIn * 1000 : 23 * 60 * 60 * 1000);

  return tokenCache.accessToken;
}

async function shopifyGql(query, variables) {
  const accessToken = await getAdminAccessToken();
  const url = `https://${SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });

  const text = await resp.text();
  let j;
  try { j = JSON.parse(text); } catch { j = null; }

  if (!resp.ok || !j) {
    throw new Error(`Shopify GQL Non-JSON (${resp.status}): ${text.slice(0, 200)}`);
  }

  // Robust error handling (avoids "j.errors.map is not a function")
  if (Array.isArray(j.errors) && j.errors.length) {
    const msg = j.errors.map((e) => e.message || "GraphQL error").join(" | ");
    throw new Error(`Shopify GQL errors: ${msg}`);
  }

  if (j.data == null) {
    throw new Error(`Shopify GQL missing data: ${JSON.stringify(j).slice(0, 200)}`);
  }

  return j.data;
}

// Convert gid://shopify/ProductVariant/123 -> "123"
function gidToNumericId(gid) {
  if (!gid) return "";
  const m = String(gid).match(/\/ProductVariant\/(\d+)$/);
  return m ? m[1] : "";
}

// Resolve SKU -> variant numeric id using Admin API search
async function resolveSkuToVariant(sku) {
  const q = String(sku || "").trim();
  if (!q) return null;

  const query = `
    query($q: String!) {
      productVariants(first: 1, query: $q) {
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

  // Admin search syntax: sku:ABC-123
  const data = await shopifyGql(query, { q: `sku:${q}` });
  const edge = data?.productVariants?.edges?.[0];
  const node = edge?.node;

  if (!node?.id) return null;

  const numeric = gidToNumericId(node.id);
  if (!numeric) return null;

  return {
    variant_id: numeric,
    sku: node.sku || q,
    title: node.product?.title || "",
    variant_title: node.title || "",
  };
}

// -------------------- Routes --------------------

// Health
app.get("/", (req, res) => res.send("OK"));

// A simple page so Admin "open app" isn't Not Found (optional)
app.get("/app", (req, res) => {
  res.send(`<!doctype html><html><body style="font-family:Arial;padding:24px">
    <h2>B2B Lists API</h2>
    <p>Installed. Storefront uses App Proxy endpoints.</p>
  </body></html>`);
});

/**
 * App Proxy endpoint.
 * Your app proxy should point to: https://b2b-lists-api.onrender.com/proxy
 * Storefront hits: /apps/b2b-lists/proxy?action=...
 */
app.all("/proxy", async (req, res) => {
  try {
    if (!verifyProxySignature(req)) {
      return jsonErr(res, 401, "Invalid proxy signature.");
    }

    const action = String(req.query.action || "").toLowerCase();
    const method = req.method.toUpperCase();

    // Quick ping for testing
    if (action === "ping") {
      return jsonOk(res, { ok: true, pong: true, time: nowMs() });
    }

    // Basic required param for most actions
    const customerId =
      String(req.query.customer_id || req.body?.customer_id || "").trim();

    if (!customerId && ["list", "get", "upsert", "delete", "orderify"].includes(action)) {
      return jsonErr(res, 400, "Missing customer_id");
    }

    // ---------------- LIST ----------------
    if (action === "list" && method === "GET") {
      const { rows } = await pool.query(
        `SELECT id, name, created_at, updated_at
         FROM lists
         WHERE customer_id=$1
         ORDER BY updated_at DESC`,
        [customerId]
      );

      // include item counts
      const ids = rows.map((r) => r.id);
      let counts = {};
      if (ids.length) {
        const c = await pool.query(
          `SELECT list_id, COUNT(*)::int AS cnt
           FROM list_items
           WHERE list_id = ANY($1)
           GROUP BY list_id`,
          [ids]
        );
        c.rows.forEach((r) => (counts[r.list_id] = r.cnt));
      }

      const lists = rows.map((r) => ({
        id: r.id,
        name: r.name,
        created_at: r.created_at,
        updated_at: r.updated_at,
        items_count: counts[r.id] || 0,
      }));

      return jsonOk(res, { ok: true, lists });
    }

    // ---------------- GET (single list + items) ----------------
    if (action === "get" && method === "GET") {
      const listId = String(req.query.list_id || "").trim();
      if (!listId) return jsonErr(res, 400, "Missing list_id");

      const list = await pool.query(
        `SELECT id, customer_id, name, created_at, updated_at
         FROM lists
         WHERE id=$1 AND customer_id=$2`,
        [listId, customerId]
      );
      if (!list.rows.length) return jsonErr(res, 404, "List not found");

      const items = await pool.query(
        `SELECT sku, variant_id, quantity, position
         FROM list_items
         WHERE list_id=$1
         ORDER BY position ASC`,
        [listId]
      );

      return jsonOk(res, {
        ok: true,
        list: {
          ...list.rows[0],
          items: items.rows.map((r) => ({
            sku: r.sku || "",
            variant_id: r.variant_id,
            quantity: r.quantity,
          })),
        },
      });
    }

    // ---------------- UPSERT (create or update) ----------------
    // Proxy-friendly: URL-encoded POST (items may be JSON string)
    if (action === "upsert" && method === "POST") {
      const listIdRaw = String(req.body?.list_id || "").trim();
      const name = String(req.body?.name || "").trim();

      if (!name) return jsonErr(res, 400, "Missing name");

      let items = req.body?.items;

      // items may arrive as a JSON string from URL-encoded posts
      if (typeof items === "string") {
        try { items = JSON.parse(items); } catch { items = []; }
      }
      items = Array.isArray(items) ? items : [];

      // Normalize incoming items: [{sku, quantity}]
      const cleaned = items
        .map((it) => ({
          sku: String(it?.sku || "").trim(),
          quantity: Math.max(1, parseInt(it?.quantity || it?.qty || "1", 10) || 1),
        }))
        .filter((it) => it.sku);

      if (!cleaned.length) return jsonErr(res, 400, "No items");

      // Resolve SKUs -> variant numeric IDs
      const resolved = [];
      const notFound = [];

      for (const it of cleaned) {
        const r = await resolveSkuToVariant(it.sku);
        if (!r) {
          notFound.push(it.sku);
          continue;
        }
        resolved.push({
          sku: it.sku,
          variant_id: r.variant_id,
          quantity: it.quantity,
        });
      }

      if (!resolved.length) {
        return jsonErr(res, 400, "No SKUs matched", { not_found: notFound });
      }

      const listId = listIdRaw || crypto.randomUUID();
      const t = nowMs();

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Upsert list header
        const existing = await client.query(
          `SELECT id FROM lists WHERE id=$1 AND customer_id=$2`,
          [listId, customerId]
        );

        if (existing.rows.length) {
          await client.query(
            `UPDATE lists SET name=$1, updated_at=$2 WHERE id=$3 AND customer_id=$4`,
            [name, t, listId, customerId]
          );
        } else {
          await client.query(
            `INSERT INTO lists (id, customer_id, name, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5)`,
            [listId, customerId, name, t, t]
          );
        }

        // Replace items
        await client.query(`DELETE FROM list_items WHERE list_id=$1`, [listId]);

        for (let i = 0; i < resolved.length; i++) {
          const row = resolved[i];
          await client.query(
            `INSERT INTO list_items (id, list_id, sku, variant_id, quantity, position)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [crypto.randomUUID(), listId, row.sku, row.variant_id, row.quantity, i]
          );
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      return jsonOk(res, {
        ok: true,
        list_id: listId,
        saved_count: resolved.length,
        not_found: notFound,
      });
    }

    // ---------------- DELETE ----------------
    if (action === "delete" && method === "POST") {
      const listId = String(req.body?.list_id || req.query.list_id || "").trim();
      if (!listId) return jsonErr(res, 400, "Missing list_id");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `DELETE FROM list_items WHERE list_id=$1`,
          [listId]
        );
        const del = await client.query(
          `DELETE FROM lists WHERE id=$1 AND customer_id=$2`,
          [listId, customerId]
        );
        await client.query("COMMIT");

        if (!del.rowCount) return jsonErr(res, 404, "List not found");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      return jsonOk(res, { ok: true });
    }

    // ---------------- ORDERIFY ----------------
    // Returns line items + a cart permalink you can redirect to.
    // GET /proxy?action=orderify&customer_id=...&list_id=...
    if (action === "orderify" && method === "GET") {
      const listId = String(req.query.list_id || "").trim();
      if (!listId) return jsonErr(res, 400, "Missing list_id");

      const list = await pool.query(
        `SELECT id, name FROM lists WHERE id=$1 AND customer_id=$2`,
        [listId, customerId]
      );
      if (!list.rows.length) return jsonErr(res, 404, "List not found");

      const items = await pool.query(
        `SELECT variant_id, quantity
         FROM list_items
         WHERE list_id=$1
         ORDER BY position ASC`,
        [listId]
      );

      const lines = items.rows.map((r) => ({
        variant_id: r.variant_id,
        quantity: r.quantity,
      }));

      // cart permalink: /cart/123:2,456:1
      const permalink = "/cart/" + lines.map((l) => `${l.variant_id}:${l.quantity}`).join(",");

      return jsonOk(res, {
        ok: true,
        list: { id: listId, name: list.rows[0].name },
        lines,
        cart_url: permalink,
      });
    }

    // If action doesn't match
    return jsonErr(res, 400, `Unsupported action/method. action=${action} method=${method}`);
  } catch (e) {
    console.error("Proxy error:", e);
    return jsonErr(res, 500, "Server error", { details: String(e?.message || e) });
  }
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 3000;

async function start() {
  app.listen(PORT, () => console.log("Server running on port " + PORT));
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
