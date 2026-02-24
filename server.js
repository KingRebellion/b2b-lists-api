// server.js (ESM) — Express + Postgres + Shopify App Proxy verification
// Supports actions: list, get, upsert, delete, orderify, draftpad, upload_po
//
// App Proxy endpoint: /proxy
// Shopify proxy URL: https://YOUR-STORE.myshopify.com/apps/b2b-lists/proxy
//
// ENV required:
//   DATABASE_URL
//   SHOPIFY_APP_SECRET
//   SHOPIFY_STORE_DOMAIN
//   SHOPIFY_ADMIN_ACCESS_TOKEN  (Admin API token w/ write_files for uploads)

import express from "express";
import crypto from "crypto";
import pg from "pg";
import multer from "multer";

const { Pool } = pg;

const app = express();
app.set("trust proxy", 1);

// App Proxy: keep urlencoded enabled
app.use(express.urlencoded({ extended: false }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SHOPIFY_APP_SECRET = process.env.SHOPIFY_APP_SECRET;
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ---------- DB init (safe, idempotent) ----------
async function ensureSchema() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  } catch {}

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
ensureSchema().catch((e) => console.error("Schema init failed:", e));

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

function customerGidFromNumericId(customerIdNumeric) {
  if (!customerIdNumeric) return null;
  return `gid://shopify/Customer/${customerIdNumeric}`;
}

function nowIso() {
  return Date.now().toString();
}

// ---------- Shopify Admin GraphQL ----------
async function shopifyGql(query, variables = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN");
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/graphql.json`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const snippet = (text || "").replace(/\s+/g, " ").slice(0, 220);
    throw new Error(`Non-JSON from Shopify Admin API (${r.status}): ${snippet}`);
  }

  if (!r.ok) throw new Error(data?.errors?.[0]?.message || `Shopify Admin API HTTP ${r.status}`);
  if (Array.isArray(data?.errors) && data.errors.length) {
    const msg = data.errors.map((e) => e.message).filter(Boolean).join(" | ");
    throw new Error(msg || "Shopify GraphQL error");
  }

  return data.data;
}

// ---------- Shopify Files upload (stagedUploadsCreate -> upload -> fileCreate) ----------
async function uploadToShopifyFiles({ filename, mimeType, buffer }) {
  const stagedMutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;

  const stagedInput = [
    {
      resource: "FILE",
      filename,
      mimeType,
      httpMethod: "POST",
    },
  ];

  const staged = await shopifyGql(stagedMutation, { input: stagedInput });
  const out = staged?.stagedUploadsCreate;
  const errs = out?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).filter(Boolean).join(" | ") || "stagedUploadsCreate failed");

  const target = out?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl || !Array.isArray(target.parameters)) {
    throw new Error("Missing staged upload target");
  }

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) {
    const txt = await up.text().catch(() => "");
    throw new Error(`Staged upload failed (${up.status}): ${(txt || "").slice(0, 200)}`);
  }

  const fileCreateMutation = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          __typename
          ... on GenericFile { id url }
          ... on MediaImage { id image { url } }
        }
        userErrors { field message }
      }
    }
  `;

  const created = await shopifyGql(fileCreateMutation, {
    files: [
      {
        originalSource: target.resourceUrl,
        contentType: "FILE",
        alt: filename,
      },
    ],
  });

  const fc = created?.fileCreate;
  const fcErrs = fc?.userErrors || [];
  if (fcErrs.length) throw new Error(fcErrs.map((e) => e.message).filter(Boolean).join(" | ") || "fileCreate failed");

  const f = fc?.files?.[0];
  const url = f?.url || f?.image?.url || null;
  if (!url) throw new Error("File created but URL not returned yet");

  return { url };
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

    const digest = crypto.createHmac("sha256", SHOPIFY_APP_SECRET).update(message).digest("hex");

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

// ---------- routes ----------
app.get("/health", (req, res) => json(res, 200, { ok: true, ts: nowIso() }));

app.get("/proxy-ping/proxy", (req, res) =>
  json(res, 200, {
    ok: true,
    pong: true,
    shop: req.query.shop || null,
    path_prefix: req.query.path_prefix || null,
    ts: nowIso(),
  })
);

app.all("/proxy", verifyAppProxy, upload.single("file"), async (req, res) => {
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
      upload_po: ["POST"],
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
            (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id) AS item_count
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
          items: [],
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

        return json(res, 200, {
          ok: true,
          list: {
            id: listRes.rows[0].id,
            name: listRes.rows[0].name,
            updated_at: listRes.rows[0].updated_at_ms ? String(Math.trunc(listRes.rows[0].updated_at_ms)) : null,
            items: itemsRes.rows.map((x) => ({ sku: x.sku, quantity: Number(x.quantity || 1) })),
          },
        });
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
                `INSERT INTO lists (customer_id, name) VALUES ($1, $2) RETURNING id`,
                [customerId, name]
              );
              listId = ins.rows[0].id;
            }
          } else {
            const ins = await client.query(
              `INSERT INTO lists (customer_id, name) VALUES ($1, $2) RETURNING id`,
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

          await client.query(`INSERT INTO list_items (list_id, sku, quantity) VALUES ${values.join(",")}`, params);

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
          `DELETE FROM lists WHERE id = $1 AND customer_id = $2 RETURNING id`,
          [listId, customerId]
        );

        if (!del.rows.length) return json(res, 404, { ok: false, error: "List not found" });
        return json(res, 200, { ok: true });
      }

      case "orderify": {
        const listId = (req.query.list_id || "").toString().trim();
        if (!listId) return json(res, 400, { ok: false, error: "Missing list_id" });

        const listRes = await pool.query(
          `SELECT id FROM lists WHERE id = $1 AND customer_id = $2 LIMIT 1`,
          [listId, customerId]
        );
        if (!listRes.rows.length) return json(res, 404, { ok: false, error: "List not found" });

        const itemsRes = await pool.query(
          `SELECT sku, quantity FROM list_items WHERE list_id = $1 ORDER BY created_at ASC`,
          [listId]
        );

        return json(res, 200, {
          ok: true,
          items: itemsRes.rows.map((x) => ({ sku: x.sku, quantity: Number(x.quantity || 1) })),
        });
      }

      case "upload_po": {
        const f = req.file;
        if (!f || !f.buffer) return json(res, 400, { ok: false, error: "Missing file" });

        const filename = (f.originalname || "po-upload").toString();
        const mimeType = (f.mimetype || "application/octet-stream").toString();

        try {
          const uploaded = await uploadToShopifyFiles({ filename, mimeType, buffer: f.buffer });
          return json(res, 200, { ok: true, url: uploaded.url });
        } catch (e) {
          console.error("upload_po failed:", e);
          return json(res, 200, { ok: false, error: e.message || "Upload failed" });
        }
      }

      case "draftpad": {
        const note = (req.body?.note || "").toString().trim();

        const companyName = (req.body?.company_name || "").toString().trim();
        const locationName = (req.body?.location_name || "").toString().trim();
        const customerEmail = (req.body?.customer_email || "").toString().trim();

        const poNumber = (req.body?.po_number || "").toString().trim();
        const siteContactName = (req.body?.site_contact_name || "").toString().trim();
        const siteContactPhone = (req.body?.site_contact_phone || "").toString().trim();
        const poFileUrl = (req.body?.po_file_url || "").toString().trim();

        if (!poNumber) return json(res, 400, { ok: false, error: "Missing PO Number" });
        if (!siteContactName) return json(res, 400, { ok: false, error: "Missing Site Contact Name" });
        if (!siteContactPhone) return json(res, 400, { ok: false, error: "Missing Site Contact Phone" });

        const cartItemsRaw = (req.body?.cart_items || "").toString();
        let cartItems = [];
        try {
          const parsed = JSON.parse(cartItemsRaw || "[]");
          if (Array.isArray(parsed)) cartItems = parsed;
        } catch {
          cartItems = [];
        }

        if (!note && (!cartItems || cartItems.length === 0)) {
          return json(res, 400, { ok: false, error: "Please paste items or add items to cart." });
        }

        let header = "Order Pad Submission";
        header += `\nCustomer ID: ${customerId}`;
        if (customerEmail) header += `\nEmail: ${customerEmail}`;
        if (companyName) header += `\nCompany: ${companyName}`;
        if (locationName) header += `\nLocation: ${locationName}`;

        header += `\n\nPO Number: ${poNumber}`;
        header += `\nSite Contact: ${siteContactName}`;
        header += `\nSite Contact Phone: ${siteContactPhone}`;
        if (poFileUrl) header += `\nPO File: ${poFileUrl}`;

        if (cartItems.length) {
          header += `\n\nCart Items:`;
          for (const it of cartItems) {
            const sku = (it?.sku || it?.variant_sku || "").toString().trim();
            const title = (it?.product_title || it?.title || "").toString().trim();
            const qty = Number(it?.quantity || 0);
            header += `\n- ${qty} x ${sku || title || "Item"}`;
          }
        }

        const finalNote = header + (note ? "\n\n---\n" + note : "");

        const lineItemsFromCart = cartItems
          .map((it) => {
            const variantIdNum = Number(it?.variant_id || 0);
            const qty = Number(it?.quantity || 0);
            if (!variantIdNum || !Number.isFinite(qty) || qty <= 0) return null;
            return { variantId: `gid://shopify/ProductVariant/${variantIdNum}`, quantity: qty };
          })
          .filter(Boolean);

        const mutation = `
          mutation DraftOrderCreate($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder { id name email }
              userErrors { field message }
            }
          }
        `;

        const input = {
          customerId: customerGidFromNumericId(customerId),
          ...(customerEmail ? { email: customerEmail } : {}),
          note: finalNote,
          lineItems: lineItemsFromCart.length
            ? lineItemsFromCart
            : [{ title: "Order Pad Submission", quantity: 1, originalUnitPrice: "0.00" }],
        };

        try {
          const data = await shopifyGql(mutation, { input });
          const out = data?.draftOrderCreate;
          const userErrors = out?.userErrors || [];

          if (userErrors.length) {
            return json(res, 200, {
              ok: false,
              error: userErrors.map((e) => e.message).filter(Boolean).join(" | ") || "Draft order not created",
            });
          }

          if (!out?.draftOrder?.id) return json(res, 200, { ok: false, error: "Draft order not created" });

          return json(res, 200, {
            ok: true,
            draft_order_id: out.draftOrder.id,
            draft_order_name: out.draftOrder.name,
          });
        } catch (e) {
          console.error("draftpad failed:", e);
          return json(res, 200, { ok: false, error: e.message || "Draft order not created" });
        }
      }

      default:
        return json(res, 400, { ok: false, error: "Unsupported action" });
    }
  } catch (e) {
    console.error("Proxy handler error:", e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
});

app.use((req, res) => json(res, 404, { ok: false, error: "Not found" }));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));