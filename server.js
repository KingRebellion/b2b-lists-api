// index.js (ESM) — works when package.json has "type": "module"
import crypto from "crypto";
import express from "express";

const app = express();
app.use(express.urlencoded({ extended: false }));

function verifyAppProxySignature(req) {
  const secret = process.env.SHOPIFY_APP_SECRET;
  if (!secret) throw new Error("Missing env var: SHOPIFY_APP_SECRET");

  const provided = (req.query.signature || "").toString();
  if (!provided) return false;

  const keys = Object.keys(req.query).filter(k => k !== "signature").sort();
  const message = keys.map(k => `${k}=${Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]}`).join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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

  if (!resp.ok) throw new Error(`Shopify GraphQL HTTP ${resp.status}: ${JSON.stringify(json)}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);

  return json.data;
}

async function proxyHandler(req, res) {
  try {
    const okSig = verifyAppProxySignature(req);
    if (!okSig) return res.status(401).json({ ok: false, error: "Invalid proxy signature" });

    const action = (req.query.action || "").toString();
    if (action !== "draftpad") {
      return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }

    const shop = (req.query.shop || "").toString();

    const customerId = (req.body.customer_id || "").toString().trim();       // gid://shopify/Customer/...
    const customerEmail = (req.body.customer_email || "").toString().trim(); // someone@email.com
    const noteRaw = (req.body.note || "").toString();

    const companyName = (req.body.company_name || "").toString();
    const locationName = (req.body.location_name || "").toString();

    if (!noteRaw.trim()) {
      return res.status(400).json({ ok: false, error: "Missing note (pasted list)" });
    }

    const note = [
      "OrderPad Draft",
      companyName ? `Company: ${companyName}` : null,
      locationName ? `Location: ${locationName}` : null,
      customerEmail ? `Customer: ${customerEmail}` : null,
      "",
      "---",
      noteRaw.trim(),
    ].filter(Boolean).join("\n");

    const mutation = `
      mutation DraftCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name email customer { id email } }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      input: {
        // ✅ key fix: attach customer/email at creation time
        customerId: customerId || null,
        email: customerEmail || null,
        note,
      },
    };

    const data = await shopifyGraphql(shop, mutation, variables);
    const payload = data?.draftOrderCreate;
    const userErrors = payload?.userErrors || [];

    if (userErrors.length) {
      return res.status(400).json({ ok: false, error: userErrors.map(e => e.message).join(" | ") });
    }

    const draft = payload?.draftOrder;
    return res.json({ ok: true, draft_id: draft?.id, draft_name: draft?.name });
  } catch (err) {
    console.error("draftpad error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
}

// ✅ Support both possible inbound paths
app.post("/apps/b2b-lists/proxy", proxyHandler);
app.post("/proxy", proxyHandler);

app.get("/health", (req, res) => res.status(200).send("ok"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));