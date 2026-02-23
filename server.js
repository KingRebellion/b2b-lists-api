// server.js (CommonJS)
// npm i express
// Node 18+ recommended (has global fetch)

const crypto = require("crypto");
const express = require("express");

const app = express();

// App Proxy posts x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

/**
 * Verify Shopify App Proxy signature
 * App Proxy uses `signature` query param (not `hmac`).
 */
function verifyAppProxySignature(req) {
  const secret = process.env.SHOPIFY_APP_SECRET;
  if (!secret) throw new Error("Missing env var: SHOPIFY_APP_SECRET");

  const provided = (req.query.signature || "").toString();
  if (!provided) return false;

  const keys = Object.keys(req.query)
    .filter((k) => k !== "signature")
    .sort();

  const message = keys
    .map((k) => {
      const v = Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k];
      return `${k}=${v}`;
    })
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  // timing safe compare
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Shopify Admin GraphQL helper
 */
async function shopifyGraphql(shop, query, variables) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("Missing env var: SHOPIFY_ADMIN_TOKEN");

  if (!shop || !/\.myshopify\.com$/i.test(shop)) {
    throw new Error(`Invalid shop domain: ${shop}`);
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

/**
 * One handler used by BOTH routes
 */
async function proxyHandler(req, res) {
  try {
    // 1) Verify App Proxy signature
    const okSig = verifyAppProxySignature(req);
    if (!okSig) return res.status(401).json({ ok: false, error: "Invalid proxy signature" });

    // 2) Check action
    const action = (req.query.action || "").toString();
    if (action !== "draftpad") {
      return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }

    // 3) Inputs
    const shop = (req.query.shop || "").toString();

    // From your Liquid POST body
    const customerId = (req.body.customer_id || "").toString().trim(); // likely gid://shopify/Customer/...
    const customerEmail = (req.body.customer_email || "").toString().trim();
    const noteRaw = (req.body.note || "").toString();

    const companyName = (req.body.company_name || "").toString();
    const locationName = (req.body.location_name || "").toString();

    if (!noteRaw.trim()) {
      return res.status(400).json({ ok: false, error: "Missing note (pasted list)" });
    }

    // Add context into note so your team can see what came from where
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

    // 4) Create Draft Order WITH customer attached (this is the key fix)
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
        // ✅ Attach these so Shopify Flow can see customer/email on draft
        customerId: customerId || null,
        email: customerEmail || null,

        note,
      },
    };

    const data = await shopifyGraphql(shop, mutation, variables);
    const payload = data?.draftOrderCreate;

    const userErrors = payload?.userErrors || [];
    if (userErrors.length) {
      return res.status(400).json({
        ok: false,
        error: userErrors.map((e) => e.message).join(" | "),
      });
    }

    const draft = payload?.draftOrder;
    return res.json({
      ok: true,
      draft_id: draft?.id,
      draft_name: draft?.name,
      draft_email: draft?.email,
      customer_email: draft?.customer?.email,
    });
  } catch (err) {
    console.error("Proxy draftpad error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}

// ✅ Support BOTH paths:
app.post("/apps/b2b-lists/proxy", proxyHandler);
app.post("/proxy", proxyHandler);

// Health check
app.get("/health", (req, res) => res.status(200).send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));