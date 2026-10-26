import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "";

if (JWT_SECRET.length < 32) {
  throw new Error("Set JWT_SECRET in .env to a random secret of at least 32 characters.");
}

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());

const db = new Database("apexnova.sqlite3");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    package_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    merchant_request_id TEXT,
    checkout_request_id TEXT UNIQUE,
    mpesa_receipt TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS entitlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    package_id TEXT NOT NULL,
    payment_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(payment_id) REFERENCES payments(id)
  );
`);

const packages = {
  forex_basic: {
    name: "Forex Essentials",
    category: "forex",
    amount: 200
  },
  forex_plus: {
    name: "Forex Professional",
    category: "forex",
    amount: 500
  },
  forex_elite: {
    name: "Forex Advanced",
    category: "forex",
    amount: 1000
  },
  crypto_basic: {
    name: "Crypto Essentials",
    category: "crypto",
    amount: 200
  },
  crypto_plus: {
    name: "Crypto Professional",
    category: "crypto",
    amount: 500
  },
  crypto_elite: {
    name: "Crypto Advanced",
    category: "crypto",
    amount: 1000
  },
  complete: {
    name: "Forex and Crypto Access",
    category: "both",
    amount: 1000
  }
};

function normalizeKenyanPhone(input) {
  let phone = String(input || "").replace(/[\s-]/g, "");

  if (phone.startsWith("+254")) phone = phone.slice(1);
  if (phone.startsWith("0")) phone = "254" + phone.slice(1);

  if (!/^254[17]\d{8}$/.test(phone)) {
    throw new Error("Enter a valid Kenyan mobile number, such as 0712345678.");
  }

  return phone;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone
  };
}

function setSession(res, user) {
  const token = jwt.sign(
    { sub: String(user.id) },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.cookie("apexnova_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

function requireAuth(req, res, next) {
  try {
    const token = req.cookies.apexnova_session;

    if (!token) {
      return res.status(401).json({ error: "Please sign in first." });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(
      "SELECT id, name, email, phone FROM users WHERE id = ?"
    ).get(Number(decoded.sub));

    if (!user) {
      return res.status(401).json({ error: "Account not found." });
    }

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Your session expired. Please sign in again." });
  }
}

function getEntitlements(userId) {
  const entitlements = db.prepare(`
    SELECT
      e.package_id,
      e.created_at,
      p.amount,
      p.status
    FROM entitlements e
    JOIN payments p ON p.id = e.payment_id
    WHERE e.user_id = ?
      AND p.user_id = e.user_id
      AND p.status = 'paid'
    ORDER BY e.id DESC
  `).all(userId);

  return entitlements.map(item => {
    const packageInfo = packages[item.package_id];

    return {
      packageId: item.package_id,
      name: packageInfo?.name || item.package_id,
      category: packageInfo?.category || "unknown",
      amount: item.amount,
      purchasedAt: item.created_at
    };
  });
}

function hasAccess(userId, category) {
  const entitlements = getEntitlements(userId);

  return entitlements.some(item =>
    item.category === "both" || item.category === category
  );
}

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Basic per-process rate limiting for sensitive endpoints.
// Use a shared rate limiter when deploying multiple server instances.
const attempts = new Map();

function rateLimit({ windowMs = 60_000, max = 10 } = {}) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let entry = attempts.get(key);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      attempts.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      return res.status(429).json({
        error: "Too many requests. Please wait and try again."
      });
    }

    next();
  };
}

// Register.
app.post("/api/auth/register", rateLimit({ max: 5 }), async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const phone = normalizeKenyanPhone(req.body.phone);

    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ error: "Enter your full name." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({
        error: "Your password must contain 10 to 128 characters."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = db.prepare(`
      INSERT INTO users (name, email, phone, password_hash)
      VALUES (?, ?, ?, ?)
    `).run(name, email, phone, passwordHash);

    const user = db.prepare(
      "SELECT id, name, email, phone FROM users WHERE id = ?"
    ).get(result.lastInsertRowid);

    setSession(res, user);
    return res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed: users.email")) {
      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    return res.status(400).json({
      error: error.message || "Registration failed."
    });
  }
});

// Sign in.
app.post("/api/auth/login", rateLimit({ max: 10 }), async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const user = db.prepare(
      "SELECT * FROM users WHERE email = ?"
    ).get(email);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    setSession(res, user);

    return res.json({
      user: publicUser(user),
      entitlements: getEntitlements(user.id)
    });
  } catch {
    return res.status(500).json({ error: "Unable to sign in right now." });
  }
});

// Sign out.
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("apexnova_session", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });

  res.json({ success: true });
});

// Current account and purchased packages.
app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    entitlements: getEntitlements(req.user.id)
  });
});

// Public package catalogue. Prices are controlled by the server.
app.get("/api/packages", (req, res) => {
  res.json({
    packages: Object.entries(packages).map(([id, item]) => ({
      id,
      ...item
    }))
  });
});

async function darajaAccessToken() {
  const key = process.env.DARAJA_CONSUMER_KEY;
  const secret = process.env.DARAJA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error("Daraja credentials have not been configured.");
  }

  const base = process.env.DARAJA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

  const credentials = Buffer.from(`${key}:${secret}`).toString("base64");

  const response = await fetch(
    `${base}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${credentials}` }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Could not obtain a Daraja access token.");
  }

  return { token: data.access_token, base };
}

function darajaTimestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));

  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

// Start an M-Pesa STK Push request.
app.post("/api/payments/mpesa", requireAuth, rateLimit({ max: 5 }), async (req, res) => {
  let paymentId;

  try {
    const packageId = String(req.body.packageId || "");
    const selectedPackage = packages[packageId];

    if (!selectedPackage) {
      return res.status(400).json({ error: "Select a valid package." });
    }

    if (
      hasAccess(req.user.id, selectedPackage.category) ||
      (selectedPackage.category === "both" &&
        hasAccess(req.user.id, "forex") &&
        hasAccess(req.user.id, "crypto"))
    ) {
      return res.status(409).json({
        error: "Your account already has access to this market category."
      });
    }

    const phone = normalizeKenyanPhone(req.body.phone);

    const shortcode = process.env.DARAJA_BUSINESS_SHORTCODE;
    const passkey = process.env.DARAJA_PASSKEY;
    const callbackUrl = process.env.DARAJA_CALLBACK_URL;

    if (!shortcode || !passkey || !callbackUrl) {
      return res.status(503).json({
        error: "M-Pesa payments are not configured yet."
      });
    }

    if (!callbackUrl.startsWith("https://")) {
      return res.status(503).json({
        error: "The M-Pesa callback must use a public HTTPS URL."
      });
    }

    paymentId = crypto.randomUUID();

    db.prepare(`
      INSERT INTO payments (id, user_id, package_id, amount, phone, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(
      paymentId,
      req.user.id,
      packageId,
      selectedPackage.amount,
      phone
    );

    const { token, base } = await darajaAccessToken();
    const timestamp = darajaTimestamp();
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: selectedPackage.amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: paymentId.slice(0, 12),
      TransactionDesc: `ApexNova ${selectedPackage.name}`.slice(0, 100)
    };

    const response = await fetch(
      `${base}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    if (!response.ok || data.ResponseCode !== "0" || !data.CheckoutRequestID) {
      db.prepare(
        "UPDATE payments SET status = 'failed' WHERE id = ?"
      ).run(paymentId);

      return res.status(502).json({
        error: data.errorMessage || data.ResponseDescription ||
          "Safaricom could not start the payment request."
      });
    }

    db.prepare(`
      UPDATE payments
      SET merchant_request_id = ?, checkout_request_id = ?
      WHERE id = ?
    `).run(
      data.MerchantRequestID || null,
      data.CheckoutRequestID,
      paymentId
    );

    return res.status(202).json({
      paymentId,
      message: "Check your phone and complete the M-Pesa prompt.",
      customerMessage: data.CustomerMessage || null
    });
  } catch (error) {
    if (paymentId) {
      db.prepare(`
        UPDATE payments
        SET status = 'failed'
        WHERE id = ? AND status = 'pending'
      `).run(paymentId);
    }

    console.error("STK Push error:", error.message);

    return res.status(502).json({
      error: "Unable to start the M-Pesa payment. Check the server configuration."
    });
  }
});

// Safaricom sends the payment result to this endpoint.
// Only a matching pending checkout and matching amount can grant access.
app.post("/api/payments/mpesa/callback", (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;

    if (!callback?.CheckoutRequestID) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: "Invalid callback" });
    }

    const payment = db.prepare(`
      SELECT * FROM payments WHERE checkout_request_id = ?
    `).get(callback.CheckoutRequestID);

    // Acknowledge unrelated or already processed callbacks without granting access.
    if (!payment || payment.status !== "pending") {
      return res.json({ ResultCode: 0, ResultDesc: "Callback received" });
    }

    if (Number(callback.ResultCode) !== 0) {
      db.prepare(`
        UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'
      `).run(payment.id);

      return res.json({ ResultCode: 0, ResultDesc: "Payment failure recorded" });
    }

    const items = callback.CallbackMetadata?.Item || [];
    const metadata = Object.fromEntries(
      items.map(item => [item.Name, item.Value])
    );

    const paidAmount = Number(metadata.Amount);
    const receipt = String(metadata.MpesaReceiptNumber || "");

    if (!receipt || paidAmount !== payment.amount) {
      console.error("Payment callback amount/receipt mismatch for", payment.id);
      return res.json({ ResultCode: 0, ResultDesc: "Callback received for review" });
    }

    const processPayment = db.transaction(() => {
      const current = db.prepare(
        "SELECT * FROM payments WHERE id = ?"
      ).get(payment.id);

      if (!current || current.status !== "pending") return;

      db.prepare(`
        UPDATE payments
        SET status = 'paid', mpesa_receipt = ?, paid_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `).run(receipt, payment.id);

      db.prepare(`
        INSERT OR IGNORE INTO entitlements (user_id, package_id, payment_id)
        VALUES (?, ?, ?)
      `).run(payment.user_id, payment.package_id, payment.id);
    });

    processPayment();

    return res.json({ ResultCode: 0, ResultDesc: "Payment recorded" });
  } catch (error) {
    console.error("M-Pesa callback error:", error.message);
    return res.status(500).json({ ResultCode: 1, ResultDesc: "Processing error" });
  }
});

// Check payment status. A browser redirect or customer screenshot cannot unlock access.
app.get("/api/payments/:id", requireAuth, (req, res) => {
  const payment = db.prepare(`
    SELECT id, package_id, amount, status, mpesa_receipt, created_at, paid_at
    FROM payments
    WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);

  if (!payment) {
    return res.status(404).json({ error: "Payment not found." });
  }

  res.json({ payment });
});

// Only return market data from the configured provider.
app.get("/api/markets/quote", requireAuth, async (req, res) => {
  const category = String(req.query.category || "");
  const symbol = String(req.query.symbol || "");

  if (!["forex", "crypto"].includes(category)) {
    return res.status(400).json({ error: "Choose forex or crypto." });
  }

  if (!hasAccess(req.user.id, category)) {
    return res.status(403).json({
      error: "Purchase the relevant package to access this market."
    });
  }

  const allowedSymbols = category === "forex"
    ? ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/KES"]
    : ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD"];

  if (!allowedSymbols.includes(symbol)) {
    return res.status(400).json({ error: "Unsupported market symbol." });
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: "The live market-data provider has not been configured."
    });
  }

  try {
    const url = new URL("https://api.twelvedata.com/price");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", apiKey);

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || !data.price) {
      return res.status(502).json({
        error: data.message || "The provider did not return a market price."
      });
    }

    res.json({
      symbol,
      price: Number(data.price),
      source: "Twelve Data"
    });
  } catch {
    res.status(502).json({ error: "Could not retrieve market data." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*path", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API endpoint not found." });
  }

  res.sendFile(path.join(__dirname, "public", "index.html"), error => {
    if (error) next(error);
  });
});

app.listen(PORT, () => {
  console.log(`ApexNova Markets running on http://localhost:${PORT}`);
});