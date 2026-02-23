// server.js (ESM) — Express + Postgres + Shopify App Proxy verification
// Supports actions: list, get, upsert, delete, orderify, draftpad
//
// IMPORTANT FIX:
// - Shopify App Proxy can sometimes forward to /proxy/proxy depending on your proxy setup.
// - This server handles BOTH "/proxy" AND "/proxy/*" so you don't get HTML (theme) 500s.
//
// URL patterns supported (storefront calls):
//  - /apps/b2b-lists/proxy?action=list&customer_id=...
//  - /apps/b2b-lists/proxy?action=get&customer_id=...&list_id=...
//  - /apps/b2b-lists/proxy?action=upsert&customer_id=...   (POST urlencoded)
//  - /apps/b2b-lists/proxy?action=delete&customer_id=...   (POST urlencoded)
//  - /apps/b2b-lists/proxy?action=orderify&customer_id=...&list_id=...
//  - /apps/b2b-lists/proxy?action=draftpad&customer_id=... (POST urlencoded)
//
// ENV required:
//   DATABASE_URL
//   SHOPIFY_APP_SECRET
//   SHOPIFY_ADMIN_TOKEN         (Admin API access token - from your app install / admin token area)
//   SHOPIFY_STORE_DOMAIN        (e.g. mississauga-hardware-wholesale.myshopify.com)
//
// Optional:
//   PORT (default 3000)

import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.set("trust proxy", 1);

// App Proxy + Shopify can be picky; urlencoded is safest
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;
const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET;

// Draft order (Admin API)
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;

if (!DATABASE_URL) console.warn("Missing env DATABASE_URL");
if (!SHOPIFY_APP_SECRET) console.warn("Missing env SHOPIFY_APP_SECRET");
if (!SHOPIFY_ADMIN_TOKEN) console.warn("Missing env SHOPIFY_ADMIN_TOKEN (draftpad will fail)");
if (!SHOPIFY_STORE_DOMAIN) console.warn("Missing env SHOPIFY_STORE_DOMAIN (draftpad will fail)");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ---------- DB init (safe, idempotent) ----------
async function ensureSchema() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  } catch {
    // ok if extensions are locked down
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS list_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_lists_customer_id ON lists(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_list_items_list_id ON list_items(list_id);`);
}

ensureSchema().catch((e) => {
  console.error("Schema init failed:", e);
});

// ---------- helpers ----------
function json(res, status, obj) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(obj));
}

function safeParseItems(itemsStr) {
  if (!itemsStr) return [];
  try {
    const arr = JSON.parse(itemsStr);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        sku: (x?.sku || "").toString().trim(),
        quantity: Number.parseInt(x?.quantity ?? 1, 10),
      }))
      .filter((x) => x.sku && Number.isFinite(x.quantity) && x.quantity > 0)
      .map((x) => ({ sku: x.sku, quantity: x.quantity }));
  } catch {
    return [];
  }
}

function normalizeCustomerId(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return null;
  return s;
}

function nowIso() {
  return Date.now().toString();
}

// ---------- Shopify App Proxy signature verification ----------
function verifyAppProxy(req, res, next) {
  try {
    if (!SHOPIFY_APP_SECRET) return next();

    const q = { ...req.query };
    const provided = (q.signature || "").toString();
    if (!provided) return json(res, 401, { ok: false, error: "Missing signature" });

    delete q.signature;

    const message = Object.keys(q)
      .sort()
      .map((k) => `${k}=${Array.isArray(q[k]) ? q[k].join(",") : q[k]}`)
      .join("");

    const digest = crypto
      .createHmac("sha256", SHOPIFY_APP_SECRET)
      .update(message)
      .digest("hex");

    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return json(res, 401, { ok: false, error: "Invalid signature" });
    }

    next();
  } catch (e) {
    console.error("Proxy verify error:", e);
    return json(res, 500, { ok: false, error: "Proxy verification failed" });
  }
}

// ---------- Shopify Admin GraphQL helper ----------
async function shopifyGql(query, variables) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    return { ok: false, error: "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN" };
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/graphql.json`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, error: `Non-JSON Admin API response (${r.status}): ${text.slice(0, 220)}` };
  }

  if (!r.ok) {
    return { ok: false, error: `Admin API HTTP ${r.status}`, raw: j };
  }

  if (j.errors && Array.isArray(j.errors) && j.errors.length) {
    return { ok: false, error: "Admin API errors", raw: j.errors };
  }

  return { ok: true, data: j.data };
}

// ---------- routes ----------
app.get("/health", (req, res) => json(res, 200, { ok: true, ts: nowIso() }));

// Helpful for diagnosing "Cannot GET /proxy-ping/proxy"
app.get("/proxy-ping/proxy", (req, res) => json(res, 200, { ok: true, pong: true, ts: nowIso() }));

// Main App Proxy endpoint
// ✅ FIX: handle both "/proxy" and "/proxy/*" (covers /proxy/proxy forwarding)
app.all(["/proxy", "/proxy/*"], verifyAppProxy, async (req, res) => {
  try {
    const action = (req.query.action || req.query.actions || "").toString().trim();
    const method = req.method.toUpperCase();

    const customerId = normalizeCustomerId(req.query.customer_id || req.body?.customer_id);
    if (!customerId) return json(res, 400, { ok: false, error: "Missing customer_id" });

    const allowed = {
      list: ["GET"],
      get: ["GET"],
      orderify: ["GET"],
      upsert: ["POST"],
      delete: ["POST"],
      draftpad: ["POST"],
    };

    if (!action || !allowed[action] || !allowed[action].includes(method)) {
      return json(res, 400, {
        ok: false,
        error: `Unsupported action/method. action=${action || "(missing)"} method=${method}`,
      });
    }

    switch (action) {
      case "list": {
        const listsRes = await pool.query(
          `
          SELECT
            l.id,
            l.name,
            EXTRACT(EPOCH FROM l.updated_at) * 1000 AS updated_at_ms,
            (
              SELECT COUNT(*)
              FROM list_items li
              WHERE li.list_id = l.id
            ) AS item_count
          FROM lists l
          WHERE l.customer_id = $1
          ORDER BY l.updated_at DESC
        `,
          [customerId]
        );

        const lists = listsRes.rows.map((r) => ({
          id: r.id,
          name: r.name,
          updated_at: r.updated_at_ms ? String(Math.trunc(r.updated_at_ms)) : null,
          items: [], // lightweight; fetch items via get
          item_count: Number(r.item_count || 0),
        }));

        return json(res, 200, { ok: true, lists });
      }

      case "get": {
        const listId = (req.query.list_id || req.body?.list_id || "").toString().trim();
        if (!listId) return json(res, 400, { ok: false, error: "Missing list_id" });

        const listRes = await pool.query(
          `
          SELECT id, name, EXTRACT(EPOCH FROM updated_at) * 1000 AS updated_at_ms
          FROM lists
          WHERE id = $1 AND customer_id = $2
          LIMIT 1
        `,
          [listId, customerId]
        );

        if (!listRes.rows.length) return json(res, 404, { ok: false, error: "List not found" });

        const itemsRes = await pool.query(
          `
          SELECT sku, quantity
          FROM list_items
          WHERE list_id = $1
          ORDER BY created_at ASC
        `,
          [listId]
        );

        const list = {
          id: listRes.rows[0].id,
          name: listRes.rows[0].name,
          updated_at: listRes.rows[0].updated_at_ms
            ? String(Math.trunc(listRes.rows[0].updated_at_ms))
            : null,
          items: itemsRes.rows.map((x) => ({
            sku: x.sku,
            quantity: Number(x.quantity || 1),
          })),
        };

        return json(res, 200, { ok: true, list });
      }

      case "upsert": {
        const listIdRaw = (req.body?.list_id || "").toString().trim();
        const name = (req.body?.name || "").toString().trim();
        const items = safeParseItems(req.body?.items);

        if (!name) return json(res, 400, { ok: false, error: "Missing name" });
        if (!items.length) return json(res, 400, { ok: false, error: "No valid items provided" });

        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          let listId = listIdRaw;

          if (listId) {
            const up = await client.query(
              `
              UPDATE lists
              SET name = $1, updated_at = NOW()
              WHERE id = $2 AND customer_id = $3
              RETURNING id
            `,
              [name, listId, customerId]
            );

            if (!up.rows.length) {
              const ins = await client.query(
                `
                INSERT INTO lists (customer_id, name)
                VALUES ($1, $2)
                RETURNING id
              `,
                [customerId, name]
              );
              listId = ins.rows[0].id;
            }
          } else {
            const ins = await client.query(
              `
              INSERT INTO lists (customer_id, name)
              VALUES ($1, $2)
              RETURNING id
            `,
              [customerId, name]
            );
            listId = ins.rows[0].id;
          }

          await client.query(`DELETE FROM list_items WHERE list_id = $1`, [listId]);

          const values = [];
          const params = [];
          let i = 1;
          for (const it of items) {
            values.push(`($${i++}, $${i++}, $${i++})`);
            params.push(listId, it.sku, it.quantity);
          }

          await client.query(
            `
            INSERT INTO list_items (list_id, sku, quantity)
            VALUES ${values.join(",")}
          `,
            params
          );

          await client.query("COMMIT");
          return json(res, 200, { ok: true, list_id: listId });
        } catch (e) {
          await client.query("ROLLBACK");
          console.error("Upsert failed:", e);
          return json(res, 500, { ok: false, error: "Server error" });
        } finally {
          client.release();
        }
      }

      case "delete": {
        const listId = (req.body?.list_id || req.query.list_id || "").toString().trim();
        if (!listId) return json(res, 400, { ok: false, error: "Missing list_id" });

        const del = await pool.query(
          `
          DELETE FROM lists
          WHERE id = $1 AND customer_id = $2
          RETURNING id
        `,
          [listId, customerId]
        );

        if (!del.rows.length) return json(res, 404, { ok: false, error: "List not found" });
        return json(res, 200, { ok: true });
      }

      case "orderify": {
        const listId = (req.query.list_id || "").toString().trim();
        if (!listId) return json(res, 400, { ok: false, error: "Missing list_id" });

        const listRes = await pool.query(
          `
          SELECT id
          FROM lists
          WHERE id = $1 AND customer_id = $2
          LIMIT 1
        `,
          [listId, customerId]
        );
        if (!listRes.rows.length) return json(res, 404, { ok: false, error: "List not found" });

        const itemsRes = await pool.query(
          `
          SELECT sku, quantity
          FROM list_items
          WHERE list_id = $1
          ORDER BY created_at ASC
        `,
          [listId]
        );

        const items = itemsRes.rows.map((x) => ({
          sku: x.sku,
          quantity: Number(x.quantity || 1),
        }));

        return json(res, 200, { ok: true, items });
      }

      case "draftpad": {
        // Note comes from the Order Pad textarea
        const note = (req.body?.note || "").toString().trim();
        if (!note) return json(res, 400, { ok: false, error: "Missing note" });

        // Optional context from Liquid (no payment terms needed)
        const companyName = (req.body?.company_name || "").toString().trim();
        const locationName = (req.body?.location_name || "").toString().trim();
        const shippingJson = (req.body?.shipping_address_json || "").toString().trim();
        const repEmail = (req.body?.rep_email || "").toString().trim();

        // Build draft note
        let header = "Order Pad Submission";
        header += `\nCustomer ID: ${customerId}`;
        if (companyName) header += `\nCompany: ${companyName}`;
        if (locationName) header += `\nLocation: ${locationName}`;
        if (repEmail) header += `\nSales Rep: ${repEmail}`;

        const finalNote = header + "\n\n" + note;

        // Parse shipping address JSON (optional)
        let shippingAddress = null;
        if (shippingJson) {
          try {
            const addr = JSON.parse(shippingJson);
            // Only include safe fields Shopify accepts
            shippingAddress = {
              firstName: addr.firstName || undefined,
              lastName: addr.lastName || undefined,
              address1: addr.address1 || undefined,
              address2: addr.address2 || undefined,
              city: addr.city || undefined,
              province: addr.province || undefined,
              zip: addr.zip || undefined,
              country: addr.country || undefined,
              phone: addr.phone || undefined,
              company: addr.company || undefined,
            };
          } catch {
            shippingAddress = null;
          }
        }

        const mutation = `
          mutation DraftOrderCreate($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder { id name invoiceUrl }
              userErrors { field message }
            }
          }
        `;

        // Customer GID
        const customerGid = `gid://shopify/Customer/${customerId}`;

        const input = {
          customerId: customerGid,
          note: finalNote,
          // No lineItems on purpose: order pad is a note-based request (team reviews/edits)
          // You CAN add a dummy line item if your shop requires it, but you told me you want note-only.
        };

        if (shippingAddress) {
          input.shippingAddress = shippingAddress;
        }

        const gql = await shopifyGql(mutation, { input });

        if (!gql.ok) {
          console.error("draftpad Admin API error:", gql.error, gql.raw || "");
          return json(res, 500, { ok: false, error: "Draft order not created" });
        }

        const payload = gql.data?.draftOrderCreate;
        const errs = payload?.userErrors || [];
        if (errs.length) {
          console.error("draftpad userErrors:", errs);
          return json(res, 400, { ok: false, error: errs[0]?.message || "Draft order not created" });
        }

        const draft = payload?.draftOrder;
        if (!draft?.id) {
          console.error("draftpad missing draftOrder in response:", payload);
          return json(res, 500, { ok: false, error: "Draft order not created" });
        }

        return json(res, 200, {
          ok: true,
          draft_id: draft.id,
          draft_name: draft.name,
          invoice_url: draft.invoiceUrl || null,
        });
      }

      default:
        return json(res, 400, { ok: false, error: "Unsupported action" });
    }
  } catch (e) {
    console.error("Proxy handler error:", e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
});

// Fallback 404 (still JSON)
app.use((req, res) => {
  json(res, 404, { ok: false, error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});