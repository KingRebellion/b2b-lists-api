/**
 * server.js — Minimal Shopify App Proxy handler for OrderPad -> Draft Order
 *
 * ✅ Verifies Shopify App Proxy signature (HMAC)
 * ✅ Creates Draft Order with customerId + email (so Flow fields populate)
 *
 * ENV required:
 *   SHOPIFY_APP_SECRET=xxxxxxxxxxxxxxxxxxxx
 *   SHOPIFY_ADMIN_TOKEN=shpat_...
 *   PORT=10000 (Render sets automatically)
 *
 * Notes:
 * - Your Liquid sends x-www-form-urlencoded with:
 *   customer_id, customer_email, note, company_name, location_name
 * - Your JS calls:
 *   POST /apps/b2b-lists/proxy?action=draftpad&customer_id=...
 */

import crypto from "crypto";
import express from "express";

// Node 18+ has fetch built-in. If you're on older Node, install node-fetch and import it.
const app = express();

// App Proxy sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

/** ---------------------------
 *  Shopify App Proxy HMAC verify
 *  ---------------------------
 * Shopify App Proxy signs the querystring with `signature`.
 * You must compute signature from the query params (excluding signature)
 * and compare.
 */
function verifyAppProxySignature(req) {
  const secret = process.env.SHOPIFY_APP_SECRET;
  if (!secret) throw new Error("Missing env var: SHOPIFY_APP_SECRET");

  // Shopify app proxy uses `signature` param (not `hmac`)
  const provided = (req.query.signature || "").toString();
  if (!provided) return false;

  // Build message from query params except `signature`
  // Sort keys and concatenate as key=value with no separators
  const keys = Object.keys(req.query)
    .filter((k) => k !== "signature")
    .sort();

  const message = keys
    .map((k) => `${k}=${Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  // Timing-safe compare
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** ---------------------------
 *  Shopify Admin GraphQL helper
 *  ---------------------------
 */
async function shopifyGraphql(shop, query, variables) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("Missing env var: SHOPIFY_ADMIN_TOKEN");

  if (!shop || !/\.myshopify\.com$/i.test(shop)) {
    throw new Error("Invalid shop domain");
  }

  const url = `https://${shop}/admin/api/2025-01/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/** ---------------------------
 *  App Proxy route
 *  ---------------------------
 * Shopify will call this via:
 *   /apps/b2b-lists/proxy?...&signature=...
 */
app.post("/apps/b2b-lists/proxy", async (req, res) => {
  try {
    // 1) Verify signature
    const okSig = verifyAppProxySignature(req);
    if (!okSig) return res.status(401).json({ ok: false, error: "Invalid proxy signature" });

    // 2) Ensure correct action
    const action = (req.query.action || "").toString();
    if (action !== "draftpad") {
      return res.status(400).json({ ok: false, error: "Unknown action" });
    }

    // 3) Extract inputs
    const shop = (req.query.shop || "").toString(); // App Proxy includes shop=xxx.myshopify.com
    const customerId = (req.body.customer_id || "").toString().trim(); // usually gid://shopify/Customer/123...
    const customerEmail = (req.body.customer_email || "").toString().trim();
    const noteRaw = (req.body.note || "").toString();

    const companyName = (req.body.company_name || "").toString();
    const locationName = (req.body.location_name || "").toString();

    if (!noteRaw.trim()) {
      return res.status(400).json({ ok: false, error: "Missing note (orderpad list)" });
    }

    // 4) Build note (add context)
    const note = [
      "OrderPad Draft",
      companyName ? `Company: ${companyName}` : null,
      locationName ? `Location: ${locationName}` : null,
      customerEmail ? `Customer: ${customerEmail}` : null,
      "",
      "---",
      noteRaw.trim(),
    ]
      .filter(Boolean)
      .join("\n");

    // 5) Create Draft Order with customerId + email attached
    const mutation = `
      mutation DraftCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            email
            customer { id email }
          }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      input: {
        // ✅ This is the key fix: attach customer/email at creation time
        customerId: customerId || null,
        email: customerEmail || null,

        note,
      },
    };

    const data = await shopifyGraphql(shop, mutation, variables);
    const result = data?.draftOrderCreate;

    const userErrors = result?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({
        ok: false,
        error: userErrors.map((e) => e.message).join(" | "),
      });
    }

    const draft = result?.draftOrder;
    return res.json({
      ok: true,
      draft_id: draft?.id,
      draft_name: draft?.name,
      draft_email: draft?.email,
      customer_email: draft?.customer?.email,
    });
  } catch (err) {
    console.error("draftpad error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

/** ---------------------------
 *  Health check
 *  ---------------------------
 */
app.get("/health", (req, res) => res.status(200).send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));