import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const app = express();

/* -------------------------------------------------
   Middleware
------------------------------------------------- */

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "1mb" }));

/* -------------------------------------------------
   ENV
------------------------------------------------- */

const DATABASE_URL = process.env.DATABASE_URL || "";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : false
});

/* -------------------------------------------------
   DB Setup (NO position column)
------------------------------------------------- */

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
      variant_id TEXT NOT NULL,
      quantity INT NOT NULL
    );
  `);
}

/* -------------------------------------------------
   Helpers
------------------------------------------------- */

function uid() {
  return crypto.randomBytes(16).toString("hex");
}

function now() {
  return Date.now();
}

/* -------------------------------------------------
   Health Check
------------------------------------------------- */

app.get("/", (req, res) => {
  res.send("OK");
});

/* -------------------------------------------------
   PROXY ENDPOINT
------------------------------------------------- */

app.all("/proxy", async (req, res) => {
  try {

    const action =
      req.query.action ||
      req.body.action ||
      "";

    const customerId =
      req.query.customer_id ||
      req.body.customer_id ||
      "";

    if (!action) {
      return res.json({ ok: false, error: "Missing action" });
    }

    if (!customerId) {
      return res.json({ ok: false, error: "Missing customer_id" });
    }

    /* -------------------------------------------
       LIST
    ------------------------------------------- */

    if (action === "list") {

      const listsRes = await pool.query(
        `SELECT * FROM lists
         WHERE customer_id = $1
         ORDER BY updated_at DESC`,
        [customerId]
      );

      const lists = [];

      for (const row of listsRes.rows) {

        const itemsRes = await pool.query(
          `SELECT variant_id, quantity
           FROM list_items
           WHERE list_id = $1`,
          [row.id]
        );

        lists.push({
          id: row.id,
          name: row.name,
          created_at: row.created_at,
          updated_at: row.updated_at,
          items: itemsRes.rows
        });
      }

      return res.json({ ok: true, lists });
    }

    /* -------------------------------------------
       GET
    ------------------------------------------- */

    if (action === "get") {

      const listId =
        req.query.list_id ||
        req.body.list_id;

      if (!listId) {
        return res.json({ ok: false, error: "Missing list_id" });
      }

      const listRes = await pool.query(
        `SELECT * FROM lists
         WHERE id = $1
         AND customer_id = $2`,
        [listId, customerId]
      );

      if (!listRes.rows.length) {
        return res.json({ ok: false, error: "Not found" });
      }

      const itemsRes = await pool.query(
        `SELECT variant_id, quantity
         FROM list_items
         WHERE list_id = $1`,
        [listId]
      );

      return res.json({
        ok: true,
        list: {
          id: listId,
          name: listRes.rows[0].name,
          items: itemsRes.rows
        }
      });
    }

    /* -------------------------------------------
       UPSERT (CREATE / UPDATE)
    ------------------------------------------- */

    if (action === "upsert" && req.method === "POST") {

      let {
        list_id,
        name,
        items
      } = req.body;

      if (!name) {
        return res.json({ ok: false, error: "Missing name" });
      }

      /* Parse items */
      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch {
          items = [];
        }
      }

      items = Array.isArray(items) ? items : [];

      const ts = now();

      let listId = list_id || uid();

      /* Insert / Update list */

      const exists = await pool.query(
        `SELECT id FROM lists WHERE id = $1`,
        [listId]
      );

      if (!exists.rows.length) {

        await pool.query(
          `INSERT INTO lists
           (id, customer_id, name, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [listId, customerId, name, ts, ts]
        );

      } else {

        await pool.query(
          `UPDATE lists
           SET name = $1,
               updated_at = $2
           WHERE id = $3
           AND customer_id = $4`,
          [name, ts, listId, customerId]
        );
      }

      /* Replace items */

      await pool.query(
        `DELETE FROM list_items WHERE list_id = $1`,
        [listId]
      );

      for (const it of items) {

        if (!it.variant_id || !it.quantity) continue;

        await pool.query(
          `INSERT INTO list_items
           (id, list_id, variant_id, quantity)
           VALUES ($1,$2,$3,$4)`,
          [uid(), listId, it.variant_id, it.quantity]
        );
      }

      return res.json({ ok: true, id: listId });
    }

    /* -------------------------------------------
       DELETE
    ------------------------------------------- */

    if (action === "delete" && req.method === "POST") {

      const listId =
        req.query.list_id ||
        req.body.list_id;

      if (!listId) {
        return res.json({ ok: false, error: "Missing list_id" });
      }

      await pool.query(
        `DELETE FROM list_items WHERE list_id = $1`,
        [listId]
      );

      await pool.query(
        `DELETE FROM lists
         WHERE id = $1
         AND customer_id = $2`,
        [listId, customerId]
      );

      return res.json({ ok: true });
    }

    /* -------------------------------------------
       ORDERIFY (FOR REORDER)
    ------------------------------------------- */

    if (action === "orderify") {

      const listId =
        req.query.list_id ||
        req.body.list_id;

      if (!listId) {
        return res.json({ ok: false, error: "Missing list_id" });
      }

      const itemsRes = await pool.query(
        `SELECT variant_id, quantity
         FROM list_items
         WHERE list_id = $1`,
        [listId]
      );

      return res.json({
        ok: true,
        items: itemsRes.rows
      });
    }

    /* -------------------------------------------
       FALLBACK
    ------------------------------------------- */

    return res.json({
      ok: false,
      error: "Unsupported action/method"
    });

  } catch (err) {

    console.error("Proxy error:", err);

    return res.status(500).json({
      ok: false,
      error: "Server error"
    });
  }
});

/* -------------------------------------------------
   START
------------------------------------------------- */

const PORT = process.env.PORT || 3000;

async function start() {

  if (DATABASE_URL) {
    await ensureTables();
    console.log("DB ready");
  } else {
    console.log("DATABASE_URL not set");
  }

  app.listen(PORT, () => {
    console.log("Server running on " + PORT);
  });
}

start();
