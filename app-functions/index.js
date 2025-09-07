/**
 * LuxeClean Melbourne – Backend MVP (Firebase Functions + Firestore + Express)
 * ---------------------------------------------------------------------------
 * - Single Express app exported as one HTTPS function: exports.api
 * - Public endpoints for MVP (auth to be added later)
 * - JSON responses only (except root welcome string)
 * - Works in Firebase Emulator and production
 */

const functions = require("firebase-functions"); // v2 is under subpaths; v1 default keeps compat
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

console.log("[api] boot file:", __filename);

// ---------------------------
// Safe Admin initialization
// ---------------------------
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// ---------------------------
// Constants / Pricing (AUD)
// ---------------------------
const PRICING = {
  base: 85,             // Turnover base
  perBedroom: 20,       // Per bedroom
  perBathroom: 15,      // Per bathroom
  deepClean: 90,        // Add-on
  linenAddon: 35,       // Linen add-on per turnover
  linenStandalone: 45,  // Standalone linen order (pickup 10 + processing 25 + delivery 10)
  currency: "AUD",
};

// ---------------------------
// Helpers
// ---------------------------

/**
 * Compute a turnover price based on bedrooms/bathrooms and add-ons.
 * @param {Object} param0
 * @param {number} param0.bedrooms
 * @param {number} param0.bathrooms
 * @param {Object} param0.addOns - { deepClean?: boolean, premiumLinen?: boolean }
 * @returns {{total:number, breakdown:Object, currency:string}}
 */
function computeTurnoverPrice({ bedrooms = 0, bathrooms = 0, addOns = {} }) {
  const deep = !!addOns.deepClean;
  const linen = !!addOns.premiumLinen;

  const base = PRICING.base;
  const bedroomsCost = (Number(bedrooms) || 0) * PRICING.perBedroom;
  const bathroomsCost = (Number(bathrooms) || 0) * PRICING.perBathroom;
  const deepCost = deep ? PRICING.deepClean : 0;
  const linenCost = linen ? PRICING.linenAddon : 0;

  const total = base + bedroomsCost + bathroomsCost + deepCost + linenCost;

  return {
    total,
    breakdown: {
      base,
      bedroomsCost,
      bathroomsCost,
      deepClean: deepCost,
      premiumLinen: linenCost,
    },
    currency: PRICING.currency,
  };
}

/** Minimal field guards */
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function isPositiveInt(v) {
  return Number.isInteger(v) && v >= 0;
}
function envName() {
  // Heuristic: emulator env variables commonly set by Firebase
  const isEmu =
    process.env.FUNCTIONS_EMULATOR === "true" ||
    !!process.env.FIREBASE_EMULATOR_HUB ||
    !!process.env.FIRESTORE_EMULATOR_HOST;
  return isEmu ? "emulator" : "prod";
}

function serverTimestamp() {
  const fv = admin.firestore && admin.firestore.FieldValue;
  if (fv && typeof fv.serverTimestamp === "function") {
    return fv.serverTimestamp();
  }
  if (admin.firestore && admin.firestore.Timestamp &&
      typeof admin.firestore.Timestamp.now === "function") {
    return admin.firestore.Timestamp.now();
  }
  return new Date().toISOString();
}

/** Standard error responder */
function sendError(res, code, message, extra = {}) {
  return res.status(code).json({ ok: false, error: message, ...extra });
}

// ---------------------------
// Express App
// ---------------------------
const app = express();

// CORS + JSON middleware
app.use(cors({ origin: true }));
app.use(express.json());
// (Optional) basic content-type enforcement for JSON endpoints
app.use((req, res, next) => {
  if (["POST", "PATCH", "PUT"].includes(req.method)) {
    const ct = req.headers["content-type"] || "";
    if (!ct.includes("application/json")) {
      return sendError(res, 415, "Content-Type must be application/json");
    }
  }
  return next();
});

// Debug: log every request path/method that hits this function
app.use((req, _res, next) => {
  console.log(`[api] ${req.method} ${req.path}`);
  next();
});

// ---------------------------
// 1) Root + Health
// ---------------------------
app.get(["/", "/api"], (req, res) => {
  const msg = "Welcome to LuxeClean API root 🚀";
  const acceptsJson = (req.headers["accept"] || "").includes("application/json");
  if (acceptsJson) {
    return res.json({ ok: true, message: msg, env: envName(), service: "api" });
  }
  res.type("text/plain").status(200).send(msg);
});

app.get(["/health", "/api/health"], (_req, res) => {
  res.json({
    ok: true,
    env: envName(),
    service: "api",
  });
});

// ---------------------------
// 2) Quotes
// ---------------------------

/**
 * POST /quotes
 * Body:
 * {
 *   hostName, email, phone?,
 *   property: { address, bedrooms, bathrooms },
 *   preferences?: { addOns: { deepClean:boolean, premiumLinen:boolean } },
 *   notes?
 * }
 * Logic: compute price, store in "quotes", return { id, ... }
 */
app.post("/quotes", async (req, res) => {
  try {
    const {
      hostName,
      email,
      phone,
      property,
      preferences = {},
      notes,
    } = req.body || {};

    // Basic validation
    if (!isNonEmptyString(hostName)) return sendError(res, 400, "hostName is required");
    if (!isNonEmptyString(email)) return sendError(res, 400, "email is required");

    if (!property || typeof property !== "object") {
      return sendError(res, 400, "property is required");
    }
    const { address, bedrooms, bathrooms } = property;
    if (!isNonEmptyString(address)) return sendError(res, 400, "property.address is required");
    if (!isPositiveInt(Number(bedrooms))) return sendError(res, 400, "property.bedrooms must be a non-negative integer");
    if (!isPositiveInt(Number(bathrooms))) return sendError(res, 400, "property.bathrooms must be a non-negative integer");

    const addOns = (preferences && preferences.addOns) || {};
    const pricing = computeTurnoverPrice({
      bedrooms: Number(bedrooms),
      bathrooms: Number(bathrooms),
      addOns,
    });

    const data = {
      hostName: String(hostName).trim(),
      email: String(email).trim(),
      phone: isNonEmptyString(phone) ? String(phone).trim() : null,
      property: {
        address: String(address).trim(),
        bedrooms: Number(bedrooms),
        bathrooms: Number(bathrooms),
      },
      preferences: {
        addOns: {
          deepClean: !!addOns.deepClean,
          premiumLinen: !!addOns.premiumLinen,
        },
      },
      notes: isNonEmptyString(notes) ? String(notes).trim() : null,
      pricing,
      currency: PRICING.currency,
      status: "quoted",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    const ref = await db.collection("quotes").add(data);

    return res.status(201).json({
      ok: true,
      id: ref.id,
      ...data,
    });
  } catch (err) {
    console.error("POST /quotes error:", err);
    return sendError(res, 500, "Failed to create quote");
  }
});

/**
 * GET /quotes/:id
 */
app.get("/quotes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const snap = await db.collection("quotes").doc(id).get();
    if (!snap.exists) return sendError(res, 404, "Quote not found");
    return res.json({ ok: true, id: snap.id, ...snap.data() });
  } catch (err) {
    console.error("GET /quotes/:id error:", err);
    return sendError(res, 500, "Failed to fetch quote");
  }
});

// ---------------------------
// 3) Jobs (Turnovers)
// ---------------------------

/**
 * POST /jobs
 * Body:
 * {
 *   quoteId?, // optional linkage
 *   schedule: { start, end }, // ISO strings
 *   property: { address, bedrooms, bathrooms },
 *   addOns?: { premiumLinen:boolean, deepClean:boolean },
 *   price?: number, // optional override; if missing we compute
 *   notes?
 * }
 * Logic: if price missing, compute from Pricing; status="scheduled"; include a simple checklist booleans
 */
app.post("/jobs", async (req, res) => {
  try {
    const {
      quoteId,
      schedule,
      property,
      addOns = {},
      price,
      notes,
    } = req.body || {};

    if (!schedule || typeof schedule !== "object") {
      return sendError(res, 400, "schedule is required");
    }
    const { start, end } = schedule;
    if (!isNonEmptyString(start)) return sendError(res, 400, "schedule.start is required (ISO string)");
    if (!isNonEmptyString(end)) return sendError(res, 400, "schedule.end is required (ISO string)");

    if (!property || typeof property !== "object") {
      return sendError(res, 400, "property is required");
    }
    const { address, bedrooms, bathrooms } = property;
    if (!isNonEmptyString(address)) return sendError(res, 400, "property.address is required");
    if (!isPositiveInt(Number(bedrooms))) return sendError(res, 400, "property.bedrooms must be a non-negative integer");
    if (!isPositiveInt(Number(bathrooms))) return sendError(res, 400, "property.bathrooms must be a non-negative integer");

    let pricing =
      typeof price === "number"
        ? {
            total: Number(price),
            breakdown: { customOverride: Number(price) },
            currency: PRICING.currency,
          }
        : computeTurnoverPrice({
            bedrooms: Number(bedrooms),
            bathrooms: Number(bathrooms),
            addOns,
          });

    const checklistDefault = {
      bathroomsDone: false,
      kitchenDone: false,
      floorsDone: false,
      trashOut: false,
      linensChanged: !!addOns.premiumLinen, // if linen add-on, we expect linens to be changed
      restockSupplies: false,
      photosTaken: false,
    };

    const data = {
      quoteId: isNonEmptyString(quoteId) ? String(quoteId).trim() : null,
      schedule: {
        start: String(start),
        end: String(end),
      },
      property: {
        address: String(address).trim(),
        bedrooms: Number(bedrooms),
        bathrooms: Number(bathrooms),
      },
      addOns: {
        deepClean: !!addOns.deepClean,
        premiumLinen: !!addOns.premiumLinen,
      },
      pricing,
      currency: PRICING.currency,
      status: "scheduled",
      checklist: checklistDefault,
      notes: isNonEmptyString(notes) ? String(notes).trim() : null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    const ref = await db.collection("jobs").add(data);

    return res.status(201).json({ ok: true, id: ref.id, ...data });
  } catch (err) {
    console.error("POST /jobs error:", err);
    return sendError(res, 500, "Failed to create job");
  }
});

/**
 * PATCH /jobs/:id/checklist
 * Body: any subset of checklist booleans, e.g. { bathroomsDone: true, floorsDone: true }
 * Behavior: merge-update checklist.* fields
 */
app.patch("/jobs/:id/checklist", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    if (!body || typeof body !== "object") {
      return sendError(res, 400, "Request body must be an object");
    }

    // Build dot-path update object
    const update = {};
    const allowedKeys = [
      "bathroomsDone",
      "kitchenDone",
      "floorsDone",
      "trashOut",
      "linensChanged",
      "restockSupplies",
      "photosTaken",
    ];

    let hasAny = false;
    for (const [k, v] of Object.entries(body)) {
      if (!allowedKeys.includes(k)) continue;
      if (typeof v !== "boolean") {
        return sendError(res, 400, `Checklist field ${k} must be boolean`);
      }
      update[`checklist.${k}`] = v;
      hasAny = true;
    }

    if (!hasAny) {
      return sendError(res, 400, "No valid checklist fields provided");
    }

    update.updatedAt = serverTimestamp();

    const docRef = db.collection("jobs").doc(id);
    const snap = await docRef.get();
    if (!snap.exists) return sendError(res, 404, "Job not found");

    await docRef.update(update);
    const updated = await docRef.get();

    return res.json({ ok: true, id: updated.id, ...updated.data() });
  } catch (err) {
    console.error("PATCH /jobs/:id/checklist error:", err);
    return sendError(res, 500, "Failed to update checklist");
  }
});

/**
 * GET /jobs/:id
 */
app.get("/jobs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const snap = await db.collection("jobs").doc(id).get();
    if (!snap.exists) return sendError(res, 404, "Job not found");
    return res.json({ ok: true, id: snap.id, ...snap.data() });
  } catch (err) {
    console.error("GET /jobs/:id error:", err);
    return sendError(res, 500, "Failed to fetch job");
  }
});

// ---------------------------
// 4) Linen Orders (Add-on)
// ---------------------------

/**
 * POST /linen/orders
 * Body:
 * {
 *   jobId?, // link to a job if applicable
 *   property: { address },
 *   items: { queenSets?, doubleSets?, singleSets?, towelSets?, bathMats?, teaTowels? },
 *   pickupAt, returnAt, notes?
 * }
 * Logic: store in "linen_orders" with flat pricing (PRICING.linenStandalone).
 */
app.post("/linen/orders", async (req, res) => {
  try {
    const {
      jobId,
      property,
      items = {},
      pickupAt,
      returnAt,
      notes,
    } = req.body || {};

    if (!property || typeof property !== "object") {
      return res.status(400).json({ ok: false, error: "property is required" });
    }
    const { address } = property;
    if (!isNonEmptyString(address)) {
      return res.status(400).json({ ok: false, error: "property.address is required" });
    }
    if (!isNonEmptyString(pickupAt) || !isNonEmptyString(returnAt)) {
      return res.status(400).json({ ok: false, error: "pickupAt and returnAt are required" });
    }

    // Flat fee for standalone linen orders
    const pricing = {
      total: PRICING.linenStandalone,
      breakdown: { pickup: 10, processing: 25, delivery: 10 },
      currency: PRICING.currency,
    };

    const data = {
      jobId: isNonEmptyString(jobId) ? String(jobId).trim() : null,
      property: { address: String(address).trim() },
      items: {
        queenSets: Number(items.queenSets) || 0,
        doubleSets: Number(items.doubleSets) || 0,
        singleSets: Number(items.singleSets) || 0,
        towelSets: Number(items.towelSets) || 0,
        bathMats: Number(items.bathMats) || 0,
        teaTowels: Number(items.teaTowels) || 0,
      },
      schedule: { pickupAt: String(pickupAt), returnAt: String(returnAt) },
      pricing,
      currency: PRICING.currency,
      status: "scheduled",
      notes: isNonEmptyString(notes) ? String(notes).trim() : null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    const ref = await db.collection("linen_orders").add(data);

    return res.status(201).json({ ok: true, id: ref.id, ...data });
  } catch (err) {
    console.error("POST /linen/orders error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: "linen_order_failed" });
  }
});

/**
 * GET /linen/orders/:id
 */
app.get("/linen/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const snap = await db.collection("linen_orders").doc(id).get();
    if (!snap.exists) return sendError(res, 404, "Linen order not found");
    return res.json({ ok: true, id: snap.id, ...snap.data() });
  } catch (err) {
    console.error("GET /linen/orders/:id error:", err);
    return sendError(res, 500, "Failed to fetch linen order");
  }
});

// ---------------------------
// JSON 404 fallback so we never emit the default HTML 404
app.all("*", (req, res) => {
  res.status(404).json({ ok: false, error: "Not Found", path: req.path });
});

// ---------------------------
// Export single HTTPS function
// Mounted at: /api/*
exports.api = onRequest({ cors: true, region: "us-central1" }, app);