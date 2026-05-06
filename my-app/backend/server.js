import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import { Resend } from "resend";
import cron from "node-cron";
import { containsProfanity } from "./utils/profanityFilter.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const app = express();

app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: "100kb" }));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RATE LIMITING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Four tiers: general (all routes), write (creating posts/messages), strict (reports/deletions), guest upload.
// Authenticated reads (polls, prefetches, dashboard) get a much higher ceiling via keyGenerator bucketing.

// Paths that must never be blocked — login depends on these being reachable
const AUTH_CRITICAL_PATHS = new Set(["/api/profile", "/api/auth/check-device", "/api/auth/trust-device"]);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,           // raised from 100 — polling + prefetch burns through 100 quickly
  standardHeaders: true,
  legacyHeaders: false,
  // Authenticated requests get their own bucket by user id; anonymous share IP bucket
  keyGenerator: (req) => req.cookies?.sb_session || req.headers?.authorization || ipKeyGenerator(req),
  skip: (req) => AUTH_CRITICAL_PATHS.has(req.path),
  message: { error: "Too many requests. Please try again later." },
});

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,            // raised from 20 — active dev/testing needs headroom
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.cookies?.sb_session || req.headers?.authorization || ipKeyGenerator(req),
  message: { error: "Too many requests. Please slow down." },
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,            // raised from 5 — still strict for guest lookups but not painful
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// For unauthenticated image uploads — more lenient than strictLimiter since
// magic-byte verification auto-rejects bad files, but stricter than writeLimiter
const guestUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,            // raised from 15
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many upload attempts. Please try again later." },
});

app.use("/api/", generalLimiter);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PUBLIC STATS + REFERRAL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/stats/user-count — no auth, shown on the login page community counter
app.get("/api/stats/user-count", generalLimiter, async (_req, res) => {
  try {
    const { count, error } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true });
    if (error) return res.json({ count: 0 });
    res.json({ count: count ?? 0 });
  } catch {
    res.json({ count: 0 });
  }
});

const REFERRAL_SOURCES = new Set([
  "word_of_mouth", "social_media", "northeastern_website",
  "professor_class", "flyer_poster", "oasis_event", "other",
]);

// GET /api/stats/overview — mod-only, used by the Stats page
app.get("/api/stats/overview", requireAuth, require2FA, requireModerator, async (_req, res) => {
  try {
    const [usersRes, ticketsRes, reportsRes, referralsRes] = await Promise.all([
      supabase.from("profiles").select("id, created_at", { count: "exact" }).order("created_at", { ascending: false }).limit(5000),
      supabase.from("support_tickets").select("id, ticket_type, status", { count: "exact" }).limit(5000),
      supabase.from("reports").select("id, status", { count: "exact" }).limit(5000),
      supabase.from("referral_sources").select("source").limit(5000),
    ]);

    const users    = usersRes.data    || [];
    const tickets  = ticketsRes.data  || [];
    const reports  = reportsRes.data  || [];
    const refs     = referralsRes.data || [];

    // Referral counts by source
    const referralCounts = {};
    for (const r of refs) referralCounts[r.source] = (referralCounts[r.source] || 0) + 1;

    // New users in last 7 and 30 days
    const now   = new Date();
    const day7  = new Date(now - 7  * 86400000);
    const day30 = new Date(now - 30 * 86400000);
    const newUsers7  = users.filter(u => new Date(u.created_at) >= day7).length;
    const newUsers30 = users.filter(u => new Date(u.created_at) >= day30).length;

    // Users per day for the last 30 days (for sparkline)
    const usersByDay = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      usersByDay[key] = 0;
    }
    for (const u of users) {
      const key = new Date(u.created_at).toISOString().slice(0, 10);
      if (key in usersByDay) usersByDay[key]++;
    }

    res.json({
      users: {
        total:    usersRes.count  ?? users.length,
        new7:     newUsers7,
        new30:    newUsers30,
        byDay:    usersByDay,
      },
      tickets: {
        total:    ticketsRes.count ?? tickets.length,
        bugs:     tickets.filter(t => t.ticket_type === "Bug Report").length,
        support:  tickets.filter(t => t.ticket_type === "Support").length,
        feedback: tickets.filter(t => t.ticket_type === "Feedback").length,
        open:     tickets.filter(t => t.status === "open").length,
      },
      reports: {
        total:   reportsRes.count ?? reports.length,
        pending: reports.filter(r => r.status === "pending").length,
      },
      referrals: {
        total:  refs.length,
        counts: referralCounts,
      },
    });
  } catch (err) {
    console.error("Stats overview error:", err);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// POST /api/referral — no auth; logs source only (no profile writes on unauthenticated endpoint)
app.post("/api/referral", strictLimiter, async (req, res) => {
  const { source } = req.body || {};
  if (!source || !REFERRAL_SOURCES.has(source)) {
    return res.status(400).json({ error: "Invalid source" });
  }
  const { error } = await supabase.from("referral_sources").insert({ source });
  if (error) return res.status(500).json({ error: "Failed to save referral" });
  res.json({ success: true });
});

// POST /api/referral/user — auth required; one-time poll for existing users
// Records source (optional) and marks profile as answered so poll never shows again
app.post("/api/referral/user", requireAuth, require2FA, async (req, res) => {
  const { source } = req.body || {};
  try {
    if (source && REFERRAL_SOURCES.has(source)) {
      await supabase.from("referral_sources").insert({ source });
    }
    await supabase.from("profiles").update({ referral_answered: true }).eq("id", req.user.id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Failed to record response." });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INPUT VALIDATION HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const INVISIBLE_CHARS_RE = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function sanitize(str, maxLength = 500) {
  if (typeof str !== "string") return "";
  return str.replace(INVISIBLE_CHARS_RE, "").trim().slice(0, maxLength);
}

// Returns a 422 response and true if any field contains profanity; otherwise returns false.
// Usage: if (profanityCheck(res, { 'item title': title, description })) return;
function profanityCheck(res, fields) {
  for (const [label, value] of Object.entries(fields)) {
    if (value && containsProfanity(value)) {
      res.status(422).json({ error: `Your ${label} contains inappropriate language.` });
      return true;
    }
  }
  return false;
}

function validateRequired(fields, body) {
  for (const f of fields) {
    if (!body[f] || (typeof body[f] === "string" && !body[f].trim())) {
      return f;
    }
  }
  return null;
}

const PROFILE_NAME_MAX_LENGTH = 25;

const VALID_CAMPUS_IDS = new Set([
  "oakland", "san_jose", "miami", "boston", "burlington",
  "portland", "charlotte", "new_york", "toronto", "london", "arlington", "seattle",
]);

const VALID_CATEGORIES = new Set([
  "Husky Card", "Jacket", "Wallet/Purse", "Bag", "Keys", "Electronics", "Other",
]);

// Valid listing types: 'found' = poster found someone else's item,
// 'lost' = poster lost their own item and is looking for it.
const VALID_LISTING_TYPES = new Set(["found", "lost"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dbError(res, error, label = "") {
  console.error(`[DB error${label ? " " + label : ""}]`, error?.message || error);
  return res.status(500).json({ error: "Internal server error" });
}

function logModAction(modUserId, action, targetId, details) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    mod_user_id: modUserId,
    action,
    target_id: targetId,
    details,
  }));
}

function buildDeviceTokenCookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge,
    path: "/",
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTH MIDDLEWARE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  req.accessToken = token;
  req.user = data.user;
  next();
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function isAal2Token(token) {
  const payload = decodeJwtPayload(token);
  return payload?.aal === "aal2";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2FA MIDDLEWARE — validates device token issued after OTP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function require2FA(req, res, next) {
  const raw = req.headers["x-device-token"];
  if (raw && typeof raw === "string" && raw.length >= 10) {
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");

    const { data } = await supabase
      .from("trusted_devices")
      .select("expires_at")
      .eq("user_id", req.user.id)
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (data && new Date(data.expires_at) >= new Date()) {
      return next();
    }
  }

  // Fallback: allow requests from a current Supabase MFA-authenticated session.
  if (isAal2Token(req.accessToken)) {
    return next();
  }

  return res.status(403).json({ error: "2FA_REQUIRED" });
}

async function requireModerator(req, res, next) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_moderator")
    .eq("id", req.user.id)
    .single();

  if (!profile?.is_moderator) {
    return res.status(403).json({ error: "Forbidden" });
  }

  next();
}

async function requireOwner(req, res, next) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_owner")
    .eq("id", req.user.id)
    .single();

  if (!profile?.is_owner) {
    return res.status(403).json({ error: "Forbidden" });
  }

  next();
}

// Block banned users from taking actions (creating posts, sending messages, etc.)
// Does NOT block reading data — banned users can still view the feed
async function requireNotBanned(req, res, next) {
  const { data: profile } = await supabase
    .from("profiles")
    .select("banned_until")
    .eq("id", req.user.id)
    .single();

  if (profile?.banned_until) {
    const isPermanent = profile.banned_until === "9999-12-31T23:59:59Z" ||
                        profile.banned_until === "9999-12-31T23:59:59+00:00";
    const stillBanned = isPermanent || new Date(profile.banned_until) > new Date();

    if (stillBanned) {
      return res.status(403).json({ error: "Your account is currently suspended." });
    }
  }

  next();
}

// Verify the requesting user is a participant in the conversation
async function requireConversationParticipant(req, res, next) {
  const convoId = req.params.id;
  const userId = req.user.id;

  const { data: convo } = await supabase
    .from("conversations")
    .select("participant_1, participant_2")
    .eq("id", convoId)
    .single();

  if (!convo) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  if (convo.participant_1 !== userId && convo.participant_2 !== userId) {
    return res.status(403).json({ error: "You are not a participant in this conversation" });
  }

  req.conversation = convo;
  next();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2FA ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// After MFA verification, the client receives a device token (hashed before storage) that
// lasts 24h (or 30 days if "remember me"). Subsequent requests send this token in
// X-Device-Token so the user doesn't have to re-verify on every session.

// Check whether the device token in the request is still trusted.
// If it is, the client can skip showing the OTP screen.
app.post("/api/auth/check-device", requireAuth, async (req, res) => {
  const raw = req.headers["x-device-token"];
  if (!raw || typeof raw !== "string") return res.json({ trusted: false });

  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const { data } = await supabase
    .from("trusted_devices")
    .select("expires_at")
    .eq("user_id", req.user.id)
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (!data || new Date(data.expires_at) < new Date()) {
    return res.json({ trusted: false });
  }
  res.json({ trusted: true });
});

// Issue a trusted-device token after Supabase MFA (aal2) is complete.
app.post("/api/auth/trust-device", requireAuth, async (req, res) => {
  if (!isAal2Token(req.accessToken)) {
    return res.status(403).json({ error: "MFA_REQUIRED" });
  }

  const rememberDevice = !!req.body?.rememberDevice;
  const userId = req.user.id;

  const rawToken  = crypto.randomUUID() + "-" + crypto.randomBytes(16).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const ttlMs    = rememberDevice ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const deviceInfo = req.headers["user-agent"]?.slice(0, 200) || null;

  await supabase
    .from("trusted_devices")
    .delete()
    .eq("user_id", userId)
    .lt("expires_at", new Date().toISOString());

  const { error: insertErr } = await supabase.from("trusted_devices").insert({
    user_id:     userId,
    token_hash:  tokenHash,
    expires_at:  expiresAt,
    device_info: deviceInfo,
  });
  if (insertErr) {
    console.error("trust-device insert error:", insertErr);
    return res.status(500).json({ error: "Failed to issue device token" });
  }

  res.json({ verified: true, rememberDevice: !!rememberDevice, deviceToken: rawToken });
});

app.post("/api/auth/clear-device", requireAuth, async (req, res) => {
  const raw = req.headers["x-device-token"];
  if (raw && typeof raw === "string") {
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
    await supabase
      .from("trusted_devices")
      .delete()
      .eq("user_id", req.user.id)
      .eq("token_hash", tokenHash);
  }
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PASSKEYS (WebAuthn)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PASSKEY_RP_NAME = "Lost & Hound";
const PASSKEY_RP_ID   = process.env.PASSKEY_RP_ID   || "localhost";
// Support comma-separated list of origins (e.g. www and non-www variants)
const PASSKEY_ORIGINS = (process.env.PASSKEY_ORIGIN || "http://localhost:5173")
  .split(",").map(o => o.trim()).filter(Boolean);

// In-memory challenge store — challenge -> { userId/email, expiry }
// TTL of 5 minutes per challenge.
const paskeyChallenges = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function storeChallenge(key, challenge) {
  paskeyChallenges.set(key, { challenge, expiry: Date.now() + CHALLENGE_TTL_MS });
}
function consumeChallenge(key) {
  const entry = paskeyChallenges.get(key);
  paskeyChallenges.delete(key);
  if (!entry || Date.now() > entry.expiry) return null;
  return entry.challenge;
}

// POST /api/passkeys/register/options — generate registration options for logged-in user
app.post("/api/passkeys/register/options", requireAuth, require2FA, async (req, res) => {
  const { data: authUser } = await supabase.auth.admin.getUserById(req.user.id);
  if (!authUser?.user?.email) return res.status(400).json({ error: "User not found" });

  const { data: existing } = await supabase
    .from("passkey_credentials")
    .select("credential_id")
    .eq("user_id", req.user.id);

  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: PASSKEY_RP_ID,
    userID: Buffer.from(req.user.id),
    userName: authUser.user.email,
    userDisplayName: authUser.user.email,
    attestationType: "none",
    authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
    excludeCredentials: (existing || []).map(c => ({
      id: c.credential_id,
      type: "public-key",
    })),
  });

  storeChallenge(`reg:${req.user.id}`, options.challenge);
  res.json(options);
});

// POST /api/passkeys/register/verify — verify registration and store credential
app.post("/api/passkeys/register/verify", requireAuth, require2FA, async (req, res) => {
  const { response, deviceName } = req.body;
  if (!response) return res.status(400).json({ error: "Missing response" });

  const expectedChallenge = consumeChallenge(`reg:${req.user.id}`);
  if (!expectedChallenge) return res.status(400).json({ error: "Challenge expired or not found" });

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: PASSKEY_ORIGINS,
      expectedRPID: PASSKEY_RP_ID,
      requireUserVerification: true,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Registration verification failed" });
  }

  if (!verification.verified) return res.status(400).json({ error: "Verification failed" });

  const { credential, aaguid } = verification.registrationInfo;
  const { error } = await supabase.from("passkey_credentials").insert({
    user_id:       req.user.id,
    credential_id: credential.id,
    public_key:    isoBase64URL.fromBuffer(credential.publicKey),
    counter:       credential.counter,
    device_name:   sanitize(deviceName || "My Device", 50),
    transports:    credential.transports ? JSON.stringify(credential.transports) : null,
    aaguid:        aaguid || null,
  });

  if (error) return dbError(res, error, "POST /api/passkeys/register/verify");
  res.json({ verified: true });
});

// GET /api/passkeys — list user's registered passkeys
app.get("/api/passkeys", requireAuth, require2FA, async (req, res) => {
  const { data, error } = await supabase
    .from("passkey_credentials")
    .select("id, device_name, created_at, last_used_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });

  if (error) return dbError(res, error, "GET /api/passkeys");
  res.json({ passkeys: data || [] });
});

// DELETE /api/passkeys/:id — remove a passkey
app.delete("/api/passkeys/:id", requireAuth, require2FA, async (req, res) => {
  const { error } = await supabase
    .from("passkey_credentials")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);

  if (error) return dbError(res, error, "DELETE /api/passkeys");
  res.json({ success: true });
});

// POST /api/passkeys/authenticate/options — generate challenge for sign-in (public)
app.post("/api/passkeys/authenticate/options", strictLimiter, async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  if (!email.endsWith("@northeastern.edu")) {
    return res.status(400).json({ error: "Must use a @northeastern.edu email address" });
  }

  // Look up the Supabase user
  const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const authUser = usersData?.users?.find(u => u.email === email);
  if (!authUser) return res.status(404).json({ error: "No account found with this email" });
  if (!authUser.email_confirmed_at) return res.status(403).json({ error: "Email not confirmed" });

  const { data: credentials } = await supabase
    .from("passkey_credentials")
    .select("credential_id, transports")
    .eq("user_id", authUser.id);

  if (!credentials || credentials.length === 0) {
    return res.status(404).json({ error: "No passkeys registered for this account" });
  }

  const options = await generateAuthenticationOptions({
    rpID: PASSKEY_RP_ID,
    userVerification: "required",
    allowCredentials: credentials.map(c => ({
      id: c.credential_id,
      type: "public-key",
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  });

  storeChallenge(`auth:${email}`, options.challenge);
  res.json(options);
});

// POST /api/passkeys/authenticate/verify — verify sign-in assertion and issue session (public)
app.post("/api/passkeys/authenticate/verify", strictLimiter, async (req, res) => {
  const email = (req.body.email || "").toLowerCase().trim();
  const { response } = req.body;
  if (!email || !response) return res.status(400).json({ error: "Missing email or response" });

  const expectedChallenge = consumeChallenge(`auth:${email}`);
  if (!expectedChallenge) return res.status(400).json({ error: "Challenge expired or not found" });

  // Look up credential in DB by credential_id
  const credentialId = response.id;
  const { data: credRow } = await supabase
    .from("passkey_credentials")
    .select("id, user_id, public_key, counter, transports")
    .eq("credential_id", credentialId)
    .maybeSingle();

  if (!credRow) return res.status(400).json({ error: "Passkey not recognized" });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: PASSKEY_ORIGINS,
      expectedRPID: PASSKEY_RP_ID,
      requireUserVerification: true,
      credential: {
        id: credentialId,
        publicKey: isoBase64URL.toBuffer(credRow.public_key),
        counter: Number(credRow.counter),
        transports: credRow.transports ? JSON.parse(credRow.transports) : undefined,
      },
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || "Authentication verification failed" });
  }

  if (!verification.verified) return res.status(400).json({ error: "Verification failed" });

  // Update counter and last_used_at
  await supabase
    .from("passkey_credentials")
    .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq("id", credRow.id);

  // Generate a Supabase magic link for the user to establish a session
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !linkData?.properties?.hashed_token) {
    return res.status(500).json({ error: "Failed to generate session" });
  }

  // Issue a device token so require2FA is satisfied for subsequent requests
  const rawToken = crypto.randomUUID() + "-" + crypto.randomBytes(16).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  const deviceInfo = req.headers["user-agent"]?.slice(0, 200) || null;

  await supabase.from("trusted_devices").insert({
    user_id: credRow.user_id, token_hash: tokenHash, expires_at: expiresAt, device_info: deviceInfo,
  });

  res.json({
    verified: true,
    hashedToken: linkData.properties.hashed_token,
    email,
    deviceToken: rawToken,
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PASSWORD RESET
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post("/api/auth/reset-password", strictLimiter, requireAuth, async (req, res) => {
  const { password } = req.body;

  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Password is required" });
  }

  if (password.length < 6 || password.length > 32) {
    return res.status(400).json({ error: "Password must be between 6 and 32 characters" });
  }

  const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password });

  if (error) return dbError(res, error, "POST /api/auth/reset-password");
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLEANUP COOLDOWN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let lastCleanupTime = 0;
const CLEANUP_COOLDOWN = 60 * 60 * 1000; // 1 hour

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROFILE ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET auto-creates a profile on first login using Supabase user metadata.
// DELETE cascades through listings, messages, conversations, reports, devices, and storage.

app.get("/api/profile", requireAuth, require2FA, async (req, res) => {
  const { data, error } = await supabase
    .from("profiles")
    .select("first_name, last_name, default_campus, is_moderator, is_owner, banned_until, ban_reason, referral_answered")
    .eq("id", req.user.id)
    .single();

  if (error && error.code === "PGRST116") {
    const meta = req.user.user_metadata;
    if (meta?.first_name && meta?.last_name) {
      const { data: created, error: upsertErr } = await supabase
        .from("profiles")
        .upsert(
          {
            id: req.user.id,
            first_name: sanitize(meta.first_name, PROFILE_NAME_MAX_LENGTH),
            last_name: sanitize(meta.last_name, PROFILE_NAME_MAX_LENGTH),
            default_campus: "boston",
            referral_answered: true, // new signups answered the required dropdown at registration
          },
          { onConflict: "id" }
        )
        .select("first_name, last_name, default_campus, is_moderator, is_owner, banned_until, ban_reason, referral_answered")
        .single();

      if (upsertErr) return res.status(500).json({ error: "Failed to create profile" });
      return res.json(created);
    }
    return res.status(404).json({ error: "Profile not found" });
  }

  if (error) return dbError(res, error, "GET /api/profile");
  res.json(data);
});

app.patch("/api/profile", requireAuth, require2FA, async (req, res) => {
  if (
    typeof req.body.first_name === "string" && req.body.first_name.trim().length > PROFILE_NAME_MAX_LENGTH ||
    typeof req.body.last_name === "string" && req.body.last_name.trim().length > PROFILE_NAME_MAX_LENGTH
  ) {
    return res.status(400).json({
      error: `First name and last name must be ${PROFILE_NAME_MAX_LENGTH} characters or fewer`,
    });
  }

  const first_name = sanitize(req.body.first_name, PROFILE_NAME_MAX_LENGTH);
  const last_name = sanitize(req.body.last_name, PROFILE_NAME_MAX_LENGTH);

  if (!first_name || !last_name) {
    return res.status(400).json({ error: "First name and last name are required" });
  }

  if (profanityCheck(res, { "first name": first_name, "last name": last_name })) return;

  const { data, error } = await supabase
    .from("profiles")
    .update({ first_name, last_name })
    .eq("id", req.user.id)
    .select("first_name, last_name, default_campus, is_moderator, is_owner")
    .single();

  if (error) return dbError(res, error, "PATCH /api/profile");
  res.json(data);
});

app.patch("/api/profile/campus", requireAuth, require2FA, async (req, res) => {
  const default_campus = sanitize(req.body.default_campus, 50);

  if (!default_campus) {
    return res.status(400).json({ error: "Campus is required" });
  }

  if (!VALID_CAMPUS_IDS.has(default_campus)) {
    return res.status(400).json({ error: "Invalid campus" });
  }

  const { error } = await supabase
    .from("profiles")
    .update({ default_campus })
    .eq("id", req.user.id);

  if (error) return dbError(res, error, "PATCH /api/profile/campus");
  res.json({ default_campus });
});

app.patch("/api/settings/notifications", requireAuth, async (req, res) => {
  const { emailNotifications, pushNotifications, broadcastNotifications } = req.body;
  const updates = {};
  if (typeof emailNotifications     === "boolean") updates.email_notifications_enabled      = emailNotifications;
  if (typeof pushNotifications      === "boolean") updates.push_notifications_enabled       = pushNotifications;
  if (typeof broadcastNotifications === "boolean") updates.broadcast_notifications_enabled  = broadcastNotifications;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No valid fields" });

  const { error } = await supabase.from("profiles").update(updates).eq("id", req.user.id);
  if (error) return dbError(res, error, "PATCH /api/settings/notifications");
  res.json({ ok: true });
});

app.delete("/api/profile", strictLimiter, requireAuth, require2FA, async (req, res) => {
  const userId = req.user.id;
  const errors = [];

  // 1. Delete user's listings
  const { error: listingsErr } = await supabase
    .from("listings")
    .delete()
    .eq("poster_id", userId);
  if (listingsErr) errors.push({ step: "listings", message: listingsErr.message });

  // 2. Delete messages in conversations the user is part of, then the conversations
  const { data: convos } = await supabase
    .from("conversations")
    .select("id")
    .or(`participant_1.eq.${userId},participant_2.eq.${userId}`);

  if (convos && convos.length > 0) {
    const convoIds = convos.map((c) => c.id);

    const { error: msgsErr } = await supabase
      .from("messages")
      .delete()
      .in("conversation_id", convoIds);
    if (msgsErr) errors.push({ step: "messages", message: msgsErr.message });

    const { error: hiddenErr } = await supabase
      .from("hidden_conversations")
      .delete()
      .in("conversation_id", convoIds);
    if (hiddenErr) errors.push({ step: "hidden_conversations", message: hiddenErr.message });

    const { error: convosErr } = await supabase
      .from("conversations")
      .delete()
      .in("id", convoIds);
    if (convosErr) errors.push({ step: "conversations", message: convosErr.message });
  }

  // 3. Delete any remaining hidden_conversations for this user
  const { error: hiddenUserErr } = await supabase
    .from("hidden_conversations")
    .delete()
    .eq("user_id", userId);
  if (hiddenUserErr) errors.push({ step: "hidden_conversations_user", message: hiddenUserErr.message });

  // 4. Delete reports filed by this user (reported-against reports are kept for mod history)
  const { error: reportsErr } = await supabase
    .from("reports")
    .delete()
    .eq("reporter_id", userId);
  if (reportsErr) errors.push({ step: "reports", message: reportsErr.message });

  // 5. Delete trusted devices
  const { error: devicesErr } = await supabase
    .from("trusted_devices")
    .delete()
    .eq("user_id", userId);
  if (devicesErr) errors.push({ step: "trusted_devices", message: devicesErr.message });

  // 6. Delete uploaded images from storage
  const { data: storageFiles } = await supabase.storage
    .from("listing-images")
    .list(userId);

  if (storageFiles && storageFiles.length > 0) {
    const filePaths = storageFiles.map((f) => `${userId}/${f.name}`);
    const { error: storageErr } = await supabase.storage
      .from("listing-images")
      .remove(filePaths);
    if (storageErr) errors.push({ step: "storage", message: storageErr.message });
  }

  // 7. Delete profile
  const { error: profileErr } = await supabase
    .from("profiles")
    .delete()
    .eq("id", userId);
  if (profileErr) errors.push({ step: "profile", message: profileErr.message });

  // 8. Delete auth user from Supabase Auth
  const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
  if (authErr) errors.push({ step: "auth_user", message: authErr.message });

  if (errors.length > 0) {
    console.error(`[Account deletion partial failure] user=${userId}`, errors);
    // If the profile and auth user were deleted, still consider it a success
    // but log the partial failures for manual cleanup
    if (profileErr || authErr) {
      return res.status(500).json({ error: "Failed to fully delete account. Please contact support." });
    }
  }

  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LISTING ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Listings are either 'found' (poster found someone else's item) or 'lost' (poster lost their own).
// The poster can mark their listing resolved. A cleanup job ages out old listings automatically.

app.get("/api/listings", requireAuth, require2FA, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  // Optional ?listing_type=found|lost filter. Omitting it (or passing any other
  // value) returns all listings, preserving the existing default behavior.
  const listing_type = req.query.listing_type;

  let query = supabase
    .from("listings")
    .select("*, locations(name, coordinates, campus)", { count: "exact" })
    .order("date", { ascending: false })
    .range(offset, offset + limit - 1);

  // Only narrow the query when a valid type is explicitly requested.
  if (VALID_LISTING_TYPES.has(listing_type)) {
    query = query.eq("listing_type", listing_type);
  }

  const { data, error, count } = await query;

  if (error) return dbError(res, error, "GET /api/listings");
  res.json({ data: data || [], page, limit, total: count ?? 0, hasMore: offset + limit < (count ?? 0) });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LEADERBOARD — POINTS HELPER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const POINT_VALUES = { post_found: 15, post_lost: 5, resolved: 25 };

async function awardPoints(userId, eventType, listingId = null) {
  const points = POINT_VALUES[eventType];
  if (!points) return;
  await supabase.from("point_events").insert([{ user_id: userId, event_type: eventType, points, listing_id: listingId }]);
  await supabase.rpc("increment_user_points", { uid: userId, delta: points });
}

app.post("/api/listings", writeLimiter, requireAuth, require2FA, requireNotBanned, async (req, res) => {
  const title = sanitize(req.body.title, 50);
  const category = sanitize(req.body.category, 50);
  const location_id = req.body.location_id;
  const found_at = sanitize(req.body.found_at, 50);
  const importance = req.body.importance;
  const description = sanitize(req.body.description, 250);
  const image_url = req.body.image_url || null;
  const lat = req.body.lat;
  const lng = req.body.lng;

  // Default to 'found' if the client sends anything other than a valid type.
  // This keeps all existing posts working without requiring them to send the field.
  const listing_type = VALID_LISTING_TYPES.has(req.body.listing_type)
    ? req.body.listing_type
    : "found";

  if (!title || !category || !location_id || !found_at || !description) {
    return res.status(400).json({ error: "Missing required fields: title, category, location_id, found_at, description" });
  }

  if (!VALID_CATEGORIES.has(category)) {
    return res.status(400).json({ error: "Invalid category" });
  }

  if (![1, 2, 3].includes(importance)) {
    return res.status(400).json({ error: "Importance must be 1, 2, or 3" });
  }

  if (image_url !== null) {
    const ALLOWED_IMAGE_ORIGINS = (process.env.ALLOWED_IMAGE_ORIGINS || "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    let parsedUrl;
    try { parsedUrl = new URL(image_url); } catch { return res.status(400).json({ error: "Invalid image URL" }); }
    const allowed = ALLOWED_IMAGE_ORIGINS.some((o) => parsedUrl.origin === o) ||
      parsedUrl.hostname.endsWith(".supabase.co");
    if (!allowed) return res.status(400).json({ error: "Invalid image URL" });
  }

  if (lat != null && (typeof lat !== "number" || lat < -90 || lat > 90)) {
    return res.status(400).json({ error: "Invalid latitude" });
  }
  if (lng != null && (typeof lng !== "number" || lng < -180 || lng > 180)) {
    return res.status(400).json({ error: "Invalid longitude" });
  }

  if (profanityCheck(res, { "item title": title, "location": found_at, "description": description })) return;

  const { data: profile } = await supabase
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", req.user.id)
    .single();

  const poster_name = profile
    ? `${profile.first_name} ${profile.last_name}`
    : req.user.email;

  const insertData = {
    title,
    category,
    location_id,
    found_at,
    importance,
    description,
    image_url,
    listing_type,
    resolved: false,
    poster_id: req.user.id,
    poster_name,
    date: new Date().toISOString(),
  };

  if (lat != null) insertData.lat = lat;
  if (lng != null) insertData.lng = lng;

  const { data, error } = await supabase
    .from("listings")
    .insert([insertData])
    .select("*, locations(name, coordinates, campus)")
    .single();

  if (error) return dbError(res, error, "POST /api/listings");

  awardPoints(req.user.id, listing_type === "found" ? "post_found" : "post_lost", data.item_id).catch(() => {});

  res.json(data);
});

app.patch("/api/listings/:item_id/resolve", requireAuth, require2FA, requireNotBanned, async (req, res) => {
  const { data: listing } = await supabase
    .from("listings")
    .select("item_id, poster_id, resolved")
    .eq("item_id", req.params.item_id)
    .maybeSingle();

  if (!listing) {
    return res.status(404).json({ error: "Listing not found" });
  }

  if (listing.poster_id !== req.user.id) {
    return res.status(403).json({ error: "Only the original poster can mark an item as returned" });
  }

  const { data: updated, error } = await supabase
    .from("listings")
    .update({ resolved: true })
    .eq("item_id", req.params.item_id)
    .eq("resolved", false)
    .select("item_id")
    .maybeSingle();

  if (error) return dbError(res, error, "PATCH /api/listings/resolve");

  if (updated) {
    awardPoints(req.user.id, "resolved", updated.item_id).catch(() => {});
  }

  res.json({ success: true });
});

// GET /api/leaderboard?campus=boston — top 50 confirmed users by points; optional campus filter
app.get("/api/leaderboard", requireAuth, require2FA, async (req, res) => {
  const campus = req.query.campus || null;

  const { data, error } = await supabase.rpc("get_leaderboard", { campus_filter: campus });
  if (error) return dbError(res, error, "GET /api/leaderboard");

  const ranked = (data || []).map((u, i) => ({ ...u, rank: i + 1 }));

  // If the current user isn't in the top 50, fetch their rank separately
  let currentUser = ranked.find(u => u.id === req.user.id) || null;
  if (!currentUser) {
    const { data: myProfile } = await supabase
      .from("profiles")
      .select("id, first_name, last_name, points, default_campus")
      .eq("id", req.user.id)
      .single();
    if (myProfile) {
      const { data: aheadCount } = await supabase.rpc("get_rank_of_user", { uid: req.user.id, campus_filter: campus });
      currentUser = { ...myProfile, rank: (aheadCount ?? 0) + 1 };
    }
  }

  res.json({ leaderboard: ranked, currentUser });
});

app.delete("/api/listings/:item_id", requireAuth, require2FA, requireModerator, async (req, res) => {
  // Fetch image_url before deleting so we can clean up storage afterward
  const { data: listing } = await supabase
    .from("listings")
    .select("image_url")
    .eq("item_id", req.params.item_id)
    .maybeSingle();

  const { error } = await supabase
    .from("listings")
    .delete()
    .eq("item_id", req.params.item_id);

  if (error) return dbError(res, error, "DELETE /api/listings");

  // Delete the image from storage — fire-and-forget, don't block the response
  if (listing?.image_url) {
    const storagePrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/listing-images/`;
    if (listing.image_url.startsWith(storagePrefix)) {
      const imagePath = listing.image_url.slice(storagePrefix.length);
      supabase.storage.from("listing-images").remove([imagePath]).catch(() => {});
    }
  }

  logModAction(req.user.id, "delete_listing", req.params.item_id, { deleted_listing_id: req.params.item_id });
  res.json({ success: true });
});

// Cleanup with cooldown — runs at most once per hour
app.post("/api/listings/cleanup", requireAuth, require2FA, async (req, res) => {
  const now = Date.now();

  if (now - lastCleanupTime < CLEANUP_COOLDOWN) {
    return res.json({ success: true, skipped: true });
  }

  lastCleanupTime = now;

  const resolvedCutoff   = new Date(now - 10 * 86400000).toISOString();
  const unresolvedCutoff = new Date(now - 30 * 86400000).toISOString();

  const { error: resolvedError } = await supabase
    .from("listings")
    .delete()
    .eq("resolved", true)
    .lt("date", resolvedCutoff);

  if (resolvedError) return dbError(res, resolvedError, "POST /api/listings/cleanup");

  const { error: unresolvedError } = await supabase
    .from("listings")
    .delete()
    .eq("resolved", false)
    .lt("date", unresolvedCutoff);

  if (unresolvedError) return dbError(res, unresolvedError, "POST /api/listings/cleanup");

  res.json({ success: true });
});

app.post("/api/upload-url", writeLimiter, requireAuth, require2FA, requireNotBanned, async (req, res) => {
  const filename = sanitize(req.body.filename, 200);

  if (!filename) {
    return res.status(400).json({ error: "Filename is required" });
  }

  const ext = filename.split(".").pop().toLowerCase();
  const allowedExts = ["jpg", "jpeg", "png", "webp", "gif"];
  if (!allowedExts.includes(ext)) {
    return res.status(400).json({ error: "Only image files are allowed (jpg, jpeg, png, webp, gif)" });
  }

  // Validate MIME type from the client (first line of defense)
  const contentType = sanitize(req.body.contentType, 100);
  const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (contentType && !allowedMimes.includes(contentType)) {
    return res.status(400).json({ error: "Invalid image type" });
  }

  const fileSize = parseInt(req.body.fileSize);
  if (fileSize && fileSize > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "Image must be under 5MB" });
  }

  const folder = sanitize(req.body.folder || "", 50);
  const UPLOAD_ALLOWED_FOLDERS = new Set(["", "support"]);
  if (!UPLOAD_ALLOWED_FOLDERS.has(folder)) {
    return res.status(400).json({ error: "Invalid folder." });
  }
  const path = folder
    ? `${req.user.id}/${folder}/${Date.now()}.${ext}`
    : `${req.user.id}/${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage
    .from("listing-images")
    .createSignedUploadUrl(path);

  if (error) return dbError(res, error, "POST /api/upload-url");

  const { data: publicUrlData } = supabase.storage
    .from("listing-images")
    .getPublicUrl(path);

  res.json({
    signedUrl: data.signedUrl,
    publicUrl: publicUrlData.publicUrl,
    path,
  });
});

// Verify uploaded image is actually an image by checking magic bytes
// Called after the file is uploaded to storage but before creating the listing
app.post("/api/verify-image", requireAuth, require2FA, requireNotBanned, async (req, res) => {
  const filePath = sanitize(req.body.path, 500);
  if (!filePath) {
    return res.status(400).json({ error: "File path is required" });
  }

  // Ensure user can only verify their own uploads
  if (!filePath.startsWith(req.user.id + "/")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { data, error } = await supabase.storage
    .from("listing-images")
    .download(filePath);

  if (error || !data) {
    return res.status(404).json({ error: "File not found" });
  }

  // Read the first 12 bytes to check magic number signatures
  const buffer = Buffer.from(await data.arrayBuffer());
  const header = buffer.subarray(0, 12);

  const isJpeg = header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF;
  const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
  const isGif = header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46;
  const isWebp = header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46
              && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;

  if (!isJpeg && !isPng && !isGif && !isWebp) {
    // Not a real image — delete it from storage
    await supabase.storage.from("listing-images").remove([filePath]);
    return res.status(400).json({ error: "File is not a valid image. Upload rejected." });
  }

  // Track Vision API usage (month granularity for free-tier monitoring)
  const visionMonth = new Date().toISOString().slice(0, 7);
  await supabase.rpc("increment_vision_usage", { p_month: visionMonth });

  // SafeSearch — screen for adult/violent/racy content before accepting the upload
  if (process.env.GOOGLE_CLOUD_VISION_API_KEY) {
    const visionRes = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_CLOUD_VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ image: { content: buffer.toString("base64") }, features: [{ type: "SAFE_SEARCH_DETECTION" }] }],
        }),
      }
    );
    const visionData = await visionRes.json();
    const safe = visionData.responses?.[0]?.safeSearchAnnotation;
    const REJECT = new Set(["LIKELY", "VERY_LIKELY"]);
    if (safe && (REJECT.has(safe.adult) || REJECT.has(safe.violence) || safe.racy === "VERY_LIKELY")) {
      await supabase.storage.from("listing-images").remove([filePath]);
      return res.status(422).json({ error: "This image cannot be uploaded as it may contain inappropriate content." });
    }
  }

  res.json({ valid: true });
});

// Guest image upload — no auth required, scoped to guest/support/ path
app.post("/api/upload-url/guest", guestUploadLimiter, async (req, res) => {
  const filename = sanitize(req.body.filename, 200);
  if (!filename) return res.status(400).json({ error: "Filename is required" });

  const ext = filename.split(".").pop().toLowerCase();
  const allowedExts = ["jpg", "jpeg", "png", "webp", "gif"];
  if (!allowedExts.includes(ext)) {
    return res.status(400).json({ error: "Only image files are allowed (jpg, jpeg, png, webp, gif)" });
  }

  const contentType = sanitize(req.body.contentType, 100);
  const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (contentType && !allowedMimes.includes(contentType)) {
    return res.status(400).json({ error: "Invalid image type" });
  }

  const fileSize = parseInt(req.body.fileSize);
  if (fileSize && fileSize > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "Image must be under 5MB" });
  }

  const path = `guest/support/${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage.from("listing-images").createSignedUploadUrl(path);
  if (error) return dbError(res, error, "POST /api/upload-url/guest");

  const { data: publicUrlData } = supabase.storage.from("listing-images").getPublicUrl(path);
  res.json({ signedUrl: data.signedUrl, publicUrl: publicUrlData.publicUrl, path });
});

// Guest image verification — no auth, only allows guest/support/ paths
app.post("/api/verify-image/guest", guestUploadLimiter, async (req, res) => {
  const filePath = sanitize(req.body.path, 500);
  if (!filePath) return res.status(400).json({ error: "File path is required" });

  // Scope enforcement: guests can only verify their own guest/support/ uploads
  if (!filePath.startsWith("guest/support/")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { data, error } = await supabase.storage.from("listing-images").download(filePath);
  if (error || !data) return res.status(404).json({ error: "File not found" });

  const buffer = Buffer.from(await data.arrayBuffer());
  const header = buffer.subarray(0, 12);

  const isJpeg = header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF;
  const isPng  = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
  const isGif  = header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46;
  const isWebp = header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46
              && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;

  if (!isJpeg && !isPng && !isGif && !isWebp) {
    await supabase.storage.from("listing-images").remove([filePath]);
    return res.status(400).json({ error: "File is not a valid image. Upload rejected." });
  }

  // Track Vision API usage (month granularity for free-tier monitoring)
  const guestVisionMonth = new Date().toISOString().slice(0, 7);
  await supabase.rpc("increment_vision_usage", { p_month: guestVisionMonth });

  // SafeSearch — screen for adult/violent/racy content before accepting the upload
  if (process.env.GOOGLE_CLOUD_VISION_API_KEY) {
    const visionRes = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_CLOUD_VISION_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [{ image: { content: buffer.toString("base64") }, features: [{ type: "SAFE_SEARCH_DETECTION" }] }],
        }),
      }
    );
    const visionData = await visionRes.json();
    const safe = visionData.responses?.[0]?.safeSearchAnnotation;
    const REJECT = new Set(["LIKELY", "VERY_LIKELY"]);
    if (safe && (REJECT.has(safe.adult) || REJECT.has(safe.violence) || safe.racy === "VERY_LIKELY")) {
      await supabase.storage.from("listing-images").remove([filePath]);
      return res.status(422).json({ error: "This image cannot be uploaded as it may contain inappropriate content." });
    }
  }

  res.json({ valid: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LOCATIONS ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get("/api/locations", async (req, res) => {
  const { campus } = req.query;

  let query = supabase
    .from("locations")
    .select("location_id, name, coordinates, campus")
    .order("name", { ascending: true });

  if (campus) {
    const sanitizedCampus = sanitize(campus, 50);
    if (!VALID_CAMPUS_IDS.has(sanitizedCampus)) {
      return res.status(400).json({ error: "Invalid campus" });
    }
    query = query.eq("campus", sanitizedCampus);
  }

  const { data, error } = await query;
  if (error) return dbError(res, error, "GET /api/locations");
  res.json(data);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONVERSATIONS & MESSAGE ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /conversations is find-or-create: reopening an existing conversation returns its id.
// Closing a conversation inserts a system message, then deletes it — hidden_conversations
// records which users have "closed" a thread so it doesn't reappear in their inbox.

app.get("/api/conversations", requireAuth, require2FA, async (req, res) => {
  const userId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));

  // Fetch conversations, hidden list, and blocked users in parallel
  const [convosResult, hiddenResult, myBlocksResult, blockersOfMeResult] = await Promise.all([
    supabase.from("conversations").select("*").or(`participant_1.eq.${userId},participant_2.eq.${userId}`).order("created_at", { ascending: false }),
    supabase.from("hidden_conversations").select("conversation_id").eq("user_id", userId),
    supabase.from("blocked_users").select("blocked_id").eq("blocker_id", userId),
    supabase.from("blocked_users").select("blocker_id").eq("blocked_id", userId),
  ]);

  if (convosResult.error) return dbError(res, convosResult.error, "GET /api/conversations");
  const convos = convosResult.data;
  if (!convos || convos.length === 0) {
    return res.json({ conversations: [], profiles: {}, listings: {}, page, limit, total: 0, hasMore: false });
  }

  const hiddenIds = new Set((hiddenResult.data || []).map((h) => h.conversation_id));
  const blockedUserIds = new Set([
    ...(myBlocksResult.data ?? []).map(r => r.blocked_id),
    ...(blockersOfMeResult.data ?? []).map(r => r.blocker_id),
  ]);

  const visible = convos.filter((c) => {
    if (hiddenIds.has(c.id)) return false;
    const otherId = c.participant_1 === userId ? c.participant_2 : c.participant_1;
    return !blockedUserIds.has(otherId);
  });

  const total = visible.length;
  const offset = (page - 1) * limit;
  const paginated = visible.slice(offset, offset + limit);

  const otherIds = paginated.map((c) =>
    c.participant_1 === userId ? c.participant_2 : c.participant_1
  );
  const listingIds = paginated.map((c) => c.listing_id).filter(Boolean);

  // Fetch profiles and listings in parallel
  const [profileResult, listingResult] = await Promise.all([
    supabase.from("profiles").select("id, first_name, last_name").in("id", otherIds),
    listingIds.length > 0
      ? supabase.from("listings").select("item_id, title").in("item_id", listingIds)
      : Promise.resolve({ data: [] }),
  ]);

  const profileMap = {};
  (profileResult.data || []).forEach((p) => { profileMap[p.id] = p; });
  const listingMap = {};
  (listingResult.data || []).forEach((l) => { listingMap[l.item_id] = l; });

  // Fetch unread counts per conversation in parallel
  const unreadCounts = {};
  if (paginated.length > 0) {
    const unreadResults = await Promise.all(
      paginated.map((c) =>
        supabase.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", c.id).neq("sender_id", userId).eq("read", false)
      )
    );
    paginated.forEach((c, i) => { unreadCounts[c.id] = unreadResults[i].count ?? 0; });
  }

  res.json({ conversations: paginated, profiles: profileMap, listings: listingMap, unreadCounts, page, limit, total, hasMore: offset + limit < total });
});

// Must be a participant to view
app.get("/api/conversations/:id", requireAuth, require2FA, requireConversationParticipant, async (req, res) => {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (error) return res.status(404).json({ error: "Conversation not found" });

  const userId = req.user.id;
  const otherId = data.participant_1 === userId ? data.participant_2 : data.participant_1;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, first_name, last_name")
    .eq("id", otherId)
    .single();

  let listing = null;
  if (data.listing_id) {
    const { data: l } = await supabase
      .from("listings")
      .select("item_id, title")
      .eq("item_id", data.listing_id)
      .single();
    listing = l;
  }

  res.json({ conversation: data, profile, listing });
});

// Find or create — banned users cannot start conversations
app.post("/api/conversations", writeLimiter, requireAuth, require2FA, requireNotBanned, async (req, res) => {
  const { listing_id, other_user_id } = req.body;
  const userId = req.user.id;

  if (!listing_id || !other_user_id) {
    return res.status(400).json({ error: "listing_id and other_user_id are required" });
  }

  if (other_user_id === userId) {
    return res.status(400).json({ error: "Cannot create a conversation with yourself" });
  }

  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("listing_id", listing_id)
    .eq("participant_1", userId)
    .maybeSingle();

  if (existing) return res.json({ id: existing.id, created: false });

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({
      listing_id,
      participant_1: userId,
      participant_2: other_user_id,
    })
    .select("id")
    .single();

  if (error) return dbError(res, error, "POST /api/conversations");
  res.json({ id: created.id, created: true });
});

// Close convo — must be a participant
app.delete("/api/conversations/:id", requireAuth, require2FA, requireConversationParticipant, async (req, res) => {
  const convoId = req.params.id;
  const userId = req.user.id;

  const { data: profile } = await supabase
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", userId)
    .single();

  const name = profile ? `${profile.first_name} ${profile.last_name}` : "Someone";

  await supabase.from("messages").insert({
    conversation_id: convoId,
    sender_id: userId,
    content: `${name} has closed this conversation.`,
    is_system: true,
  });

  await supabase.from("hidden_conversations").insert({
    user_id: userId,
    conversation_id: convoId,
  });

  await supabase.from("messages").delete().eq("conversation_id", convoId);
  await supabase.from("conversations").delete().eq("id", convoId);

  res.json({ success: true });
});

// Get messages — must be a participant
app.get("/api/conversations/:id/messages", requireAuth, require2FA, requireConversationParticipant, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  // Fetch messages and closed status in parallel
  const [msgResult, hiddenResult] = await Promise.all([
    supabase.from("messages").select("*", { count: "exact" }).eq("conversation_id", req.params.id).order("created_at", { ascending: false }).range(offset, offset + limit - 1),
    supabase.from("hidden_conversations").select("id", { count: "exact", head: true }).eq("conversation_id", req.params.id),
  ]);

  if (msgResult.error) return dbError(res, msgResult.error, "GET /api/conversations/messages");

  // Reverse so messages display oldest-first in the UI
  res.json({ messages: (msgResult.data || []).reverse(), isClosed: (hiddenResult.count ?? 0) > 0, page, limit, total: msgResult.count ?? 0, hasMore: offset + limit < (msgResult.count ?? 0) });
});

// Total count of unread messages across all of the user's visible conversations.
// Used by the navbar badge — lightweight head-count query, no message content returned.
app.get("/api/messages/unread-count", requireAuth, require2FA, async (req, res) => {
  console.log(`[unread-count] reached — user=${req.user?.id}`);
  const userId = req.user.id;

  // Find all conversations the user is in
  const { data: convos, error: convoErr } = await supabase
    .from("conversations")
    .select("id")
    .or(`participant_1.eq.${userId},participant_2.eq.${userId}`);

  if (convoErr) return dbError(res, convoErr, "GET /api/messages/unread-count");
  if (!convos || convos.length === 0) return res.json({ count: 0 });

  // Exclude hidden/closed conversations
  const { data: hiddenData } = await supabase
    .from("hidden_conversations")
    .select("conversation_id")
    .eq("user_id", userId);

  const hiddenIds = new Set((hiddenData || []).map((h) => h.conversation_id));
  const visibleIds = convos.map((c) => c.id).filter((id) => !hiddenIds.has(id));
  if (visibleIds.length === 0) return res.json({ count: 0 });

  // Count messages sent by others that this user hasn't read yet
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .in("conversation_id", visibleIds)
    .neq("sender_id", userId)
    .eq("read", false);

  if (error) return dbError(res, error, "GET /api/messages/unread-count");
  res.json({ count: count ?? 0 });
});

// Mark all unread messages in a conversation as read (those sent by the other participant).
app.patch("/api/conversations/:id/read", requireAuth, require2FA, requireConversationParticipant, async (req, res) => {
  const { error } = await supabase
    .from("messages")
    .update({ read: true })
    .eq("conversation_id", req.params.id)
    .neq("sender_id", req.user.id)
    .eq("read", false);

  if (error) return dbError(res, error, "PATCH /api/conversations/read");
  res.json({ ok: true });
});

// Send messages — must be a participant, must not be banned
app.post("/api/conversations/:id/messages", writeLimiter, requireAuth, require2FA, requireNotBanned, requireConversationParticipant, async (req, res) => {
  const content = sanitize(req.body.content, 500);

  if (!content) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  if (profanityCheck(res, { "message": content })) return;

  // Check if either party has blocked the other
  const otherId = req.conversation.participant_1 === req.user.id
    ? req.conversation.participant_2
    : req.conversation.participant_1;
  const { data: blockRows } = await supabase
    .from("blocked_users")
    .select("id")
    .or(`and(blocker_id.eq.${req.user.id},blocked_id.eq.${otherId}),and(blocker_id.eq.${otherId},blocked_id.eq.${req.user.id})`);
  if (blockRows?.length > 0) return res.status(403).json({ error: "Messaging is not available in this conversation." });

  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: req.params.id,
      sender_id: req.user.id,
      content,
    })
    .select("*")
    .single();

  if (error) return dbError(res, error, "POST /api/conversations/messages");

  // Send push notification to the other participant (otherId already computed above)
  const { data: senderProfile } = await supabase
    .from("profiles")
    .select("first_name")
    .eq("id", req.user.id)
    .single();

  const senderName = senderProfile?.first_name || "Someone";
  const preview = content.length > 80 ? content.slice(0, 80) + "..." : content;
  sendPushNotification(otherId, senderName, preview, { conversationId: req.params.id }).catch(() => {});

  res.json(data);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BLOCK ROUTES

// Returns all user IDs that should be hidden from the current user's feed/messages
// — both users they've blocked AND users who've blocked them.
// Backend service key bypasses RLS so both directions are readable.
app.get("/api/blocked-ids", requireAuth, async (req, res) => {
  const [myBlocks, blockersOfMe] = await Promise.all([
    supabase.from("blocked_users").select("blocked_id").eq("blocker_id", req.user.id),
    supabase.from("blocked_users").select("blocker_id").eq("blocked_id", req.user.id),
  ]);
  const ids = [
    ...(myBlocks.data ?? []).map(r => r.blocked_id),
    ...(blockersOfMe.data ?? []).map(r => r.blocker_id),
  ];
  res.json({ ids: [...new Set(ids)] });
});

app.post("/api/users/:id/block", requireAuth, async (req, res) => {
  const blockedId = req.params.id;
  if (blockedId === req.user.id) return res.status(400).json({ error: "Cannot block yourself" });
  const { error } = await supabase
    .from("blocked_users")
    .upsert({ blocker_id: req.user.id, blocked_id: blockedId });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete("/api/users/:id/block", requireAuth, async (req, res) => {
  const { error } = await supabase
    .from("blocked_users")
    .delete()
    .eq("blocker_id", req.user.id)
    .eq("blocked_id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REPORTS ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Users submit reports against a listing or another user. Moderators review them and
// issue a decision: no violation, or a 3-day / 30-day / permanent ban. Bans can be reversed.
// For theft reports, GET /reports enriches the response with conversation context so
// moderators can see who first contacted the poster about the item.

app.post("/api/reports", strictLimiter, requireAuth, require2FA, requireNotBanned, async (req, res) => {
  const reason = sanitize(req.body.reason, 200);
  const details = sanitize(req.body.details, 2000) || null;
  const reported_listing_id = req.body.reported_listing_id || null;
  let reported_user_id = req.body.reported_user_id || null;

  if (!reason) {
    return res.status(400).json({ error: "Reason is required" });
  }

  if (!reported_listing_id && !reported_user_id) {
    return res.status(400).json({ error: "Must report either a listing or a user" });
  }

  if (reported_listing_id && !reported_user_id) {
    const { data: listingTarget } = await supabase
      .from("listings")
      .select("poster_id")
      .eq("item_id", reported_listing_id)
      .maybeSingle();

    // Snapshot the reported user for listing reports so email lookups survive later listing deletion.
    if (listingTarget?.poster_id) {
      reported_user_id = listingTarget.poster_id;
    }
  }

  if (reported_user_id === req.user.id) {
    return res.status(400).json({ error: "Cannot report yourself" });
  }

  const { data, error } = await supabase
    .from("reports")
    .insert({
      reporter_id: req.user.id,
      reported_listing_id,
      reported_user_id,
      reason,
      details,
      status: "pending",
    })
    .select("*")
    .single();

  if (error) return dbError(res, error, "POST /api/reports");
  res.json(data);
});

app.get("/api/reports", requireAuth, require2FA, requireModerator, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabase
    .from("reports")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return dbError(res, error, "GET /api/reports");
  if (!data || data.length === 0) return res.json({ reports: [], listings: {}, page, limit, total: count ?? 0, hasMore: false });

  const userIds = new Set();
  data.forEach((r) => {
    if (r.reporter_id) userIds.add(r.reporter_id);
    if (r.reported_user_id) userIds.add(r.reported_user_id);
  });

  const { data: profilesData } = await supabase
    .from("profiles")
    .select("id, first_name, last_name")
    .in("id", [...userIds]);

  const profileMap = {};
  (profilesData || []).forEach((p) => { profileMap[p.id] = p; });

  const listingIds = data.map((r) => r.reported_listing_id).filter(Boolean);
  const listingMap = {};
  if (listingIds.length > 0) {
    const { data: listingsData } = await supabase
      .from("listings")
      .select("*, locations(name, coordinates, campus)")
      .in("item_id", listingIds);
    (listingsData || []).forEach((l) => { listingMap[l.item_id] = l; });
  }

  const isStolenReport = (report) => {
    const reason = (report?.reason || "").toLowerCase();
    const details = (report?.details || "").toLowerCase();
    return reason.includes("stolen") || details.includes("stolen") || reason.includes("theft") || details.includes("theft");
  };

  const stolenListingIds = data
    .filter((r) => isStolenReport(r) && r.reported_listing_id)
    .map((r) => r.reported_listing_id);

  const stolenClaimantByListingId = {};
  const firstConvoByListingId = {};
  if (stolenListingIds.length > 0) {
    const { data: convoData } = await supabase
      .from("conversations")
      .select("listing_id, participant_1, participant_2, created_at")
      .in("listing_id", stolenListingIds)
      .order("created_at", { ascending: true });

    for (const convo of convoData || []) {
      if (convo?.listing_id && !firstConvoByListingId[convo.listing_id]) {
        firstConvoByListingId[convo.listing_id] = convo;
      }

      if (!convo?.listing_id || stolenClaimantByListingId[convo.listing_id]) continue;
      const listingPosterId = listingMap[convo.listing_id]?.poster_id || null;

      if (listingPosterId && convo.participant_1 !== listingPosterId) {
        stolenClaimantByListingId[convo.listing_id] = convo.participant_1;
      } else if (listingPosterId && convo.participant_2 !== listingPosterId) {
        stolenClaimantByListingId[convo.listing_id] = convo.participant_2;
      } else {
        stolenClaimantByListingId[convo.listing_id] = convo.participant_1 || convo.participant_2 || null;
      }
    }
  }

  const emailUserIds = new Set();
  for (const r of data) {
    if (r.reporter_id) emailUserIds.add(r.reporter_id);
    if (r.reported_user_id) emailUserIds.add(r.reported_user_id);
    if (r.reported_listing_id && listingMap[r.reported_listing_id]?.poster_id) {
      emailUserIds.add(listingMap[r.reported_listing_id].poster_id);
    }
    if (r.reported_listing_id && stolenClaimantByListingId[r.reported_listing_id]) {
      emailUserIds.add(stolenClaimantByListingId[r.reported_listing_id]);
    }
  }

  const emailMap = {};
  const unresolvedEmailIds = new Set();
  await Promise.all(
    [...emailUserIds].map(async (uid) => {
      try {
        const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(uid);
        if (!userErr && userData?.user?.email) {
          emailMap[uid] = userData.user.email;
          return;
        }
        unresolvedEmailIds.add(uid);
      } catch {
        // Keep missing emails as null so dashboard can render a fallback label.
        unresolvedEmailIds.add(uid);
      }
    })
  );

  // Fallback for any unresolved IDs: scan auth users pages and map matching IDs.
  if (unresolvedEmailIds.size > 0) {
    let page = 1;
    const perPage = 200;

    while (unresolvedEmailIds.size > 0) {
      const { data: usersPage, error: usersErr } = await supabase.auth.admin.listUsers({ page, perPage });
      if (usersErr) break;

      const users = usersPage?.users || [];
      if (users.length === 0) break;

      for (const u of users) {
        if (u?.id && unresolvedEmailIds.has(u.id) && u.email) {
          emailMap[u.id] = u.email;
          unresolvedEmailIds.delete(u.id);
        }
      }

      if (users.length < perPage) break;
      page += 1;
    }
  }

  const enriched = data.map((r) => ({
    ...r,
    reporter: profileMap[r.reporter_id] || null,
    reportedUser: profileMap[r.reported_user_id] || null,
    reportedListing: listingMap[r.reported_listing_id] || null,
    stolenContext: (() => {
      if (!isStolenReport(r)) return null;

      const listingId = r.reported_listing_id;
      const listingPosterId = listingMap[listingId]?.poster_id || null;
      const firstConvo = listingId ? firstConvoByListingId[listingId] : null;

      const inferredReportedFromConvo = firstConvo
        ? (firstConvo.participant_1 === r.reporter_id
          ? firstConvo.participant_2
          : (firstConvo.participant_2 === r.reporter_id ? firstConvo.participant_1 : null))
        : null;

      const reportedPersonId = r.reported_user_id || listingPosterId || inferredReportedFromConvo || null;
      const claimedMinePersonId = listingId
        ? (stolenClaimantByListingId[listingId] || r.reporter_id || null)
        : (r.reporter_id || null);
      const reporterId = r.reporter_id || null;

      return {
        reportedPersonId,
        claimedMinePersonId,
        reporterId,
        reportedPersonEmail: reportedPersonId ? (emailMap[reportedPersonId] || null) : null,
        claimedMinePersonEmail: claimedMinePersonId ? (emailMap[claimedMinePersonId] || null) : null,
        reporterEmail: reporterId ? (emailMap[reporterId] || null) : null,
      };
    })(),
  }));

  res.json({ reports: enriched, listings: listingMap, page, limit, total: count ?? 0, hasMore: offset + limit < (count ?? 0) });
});

app.patch("/api/reports/:id/status", requireAuth, require2FA, requireModerator, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });

  const status = sanitize(req.body.status, 20);
  const validStatuses = ["pending", "reviewed", "dismissed"];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: "Invalid status. Must be: pending, reviewed, or dismissed" });
  }

  const { error } = await supabase
    .from("reports")
    .update({ status })
    .eq("id", req.params.id);

  if (error) return dbError(res, error, "PATCH /api/reports/status");
  res.json({ success: true });
});

app.delete("/api/reports/:id", requireAuth, require2FA, requireModerator, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });

  const { error } = await supabase
    .from("reports")
    .delete()
    .eq("id", req.params.id);

  if (error) return dbError(res, error, "DELETE /api/reports");
  logModAction(req.user.id, "delete_report", req.params.id, { deleted_report_id: req.params.id });
  res.json({ success: true });
});

app.post("/api/reports/:id/decision", requireAuth, require2FA, requireModerator, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });

  const { decision, mod_note } = req.body;
  const validDecisions = ["no_violation", "violation_3", "violation_30", "violation_permanent"];

  if (!validDecisions.includes(decision)) {
    return res.status(400).json({ error: "Invalid decision" });
  }

  const { data: report, error: reportErr } = await supabase
    .from("reports")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (reportErr) return res.status(404).json({ error: "Report not found" });

  if (decision === "no_violation") {
    await supabase.from("reports").update({ status: "dismissed" }).eq("id", report.id);
    logModAction(req.user.id, "report_decision", req.params.id, {
      decision,
      banned_user_id: null,
      mod_note: mod_note ?? null,
    });
    return res.json({ success: true, action: "dismissed" });
  }

  let banned_until;
  if (decision === "violation_3") {
    banned_until = new Date(Date.now() + 3 * 86400000).toISOString();
  } else if (decision === "violation_30") {
    banned_until = new Date(Date.now() + 30 * 86400000).toISOString();
  } else {
    banned_until = "9999-12-31T23:59:59Z";
  }

  const isPost = !!report.reported_listing_id;

  let banUserId;
  if (isPost) {
    const { data: listing } = await supabase
      .from("listings")
      .select("poster_id")
      .eq("item_id", report.reported_listing_id)
      .single();
    banUserId = listing?.poster_id;
  } else {
    banUserId = report.reported_user_id;
  }

  if (isPost && report.reported_listing_id) {
    await supabase.from("listings").delete().eq("item_id", report.reported_listing_id);
  } else if (!isPost && report.reporter_id && report.reported_user_id) {
    const { data: convos } = await supabase
      .from("conversations")
      .select("id")
      .or(
        `and(participant_1.eq.${report.reporter_id},participant_2.eq.${report.reported_user_id}),` +
        `and(participant_1.eq.${report.reported_user_id},participant_2.eq.${report.reporter_id})`
      );
    if (convos) {
      for (const c of convos) {
        await supabase.from("messages").delete().eq("conversation_id", c.id);
        await supabase.from("conversations").delete().eq("id", c.id);
      }
    }
  }

  if (banUserId) {
    const banLabel =
      decision === "violation_3" ? "3-day ban" :
      decision === "violation_30" ? "30-day ban" : "Permanent ban";

    const ban_reason = mod_note
      ? `${banLabel}: ${sanitize(mod_note, 500)}`
      : `${banLabel}: ${report.reason}`;

    await supabase
      .from("profiles")
      .update({ banned_until, ban_reason })
      .eq("id", banUserId);
  }

  const column = isPost ? "reported_listing_id" : "reported_user_id";
  const targetId = isPost ? report.reported_listing_id : report.reported_user_id;

  await supabase
    .from("reports")
    .update({ status: "reviewed" })
    .eq(column, targetId);

  logModAction(req.user.id, "report_decision", req.params.id, {
    decision,
    banned_user_id: banUserId ?? null,
    mod_note: mod_note ?? null,
  });

  res.json({ success: true, action: "violation", banned_user_id: banUserId });
});

app.post("/api/reports/:id/reverse-ban", requireAuth, require2FA, requireModerator, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });

  const { data: report, error: reportErr } = await supabase
    .from("reports")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (reportErr) return res.status(404).json({ error: "Report not found" });

  const isPost = !!report.reported_listing_id;
  let banUserId;

  if (isPost) {
    const { data: listing } = await supabase
      .from("listings")
      .select("poster_id")
      .eq("item_id", report.reported_listing_id)
      .maybeSingle();
    banUserId = listing?.poster_id;
  } else {
    banUserId = report.reported_user_id;
  }

  if (!banUserId) return res.status(400).json({ error: "Cannot determine user to unban" });

  const { error: unbanErr } = await supabase
    .from("profiles")
    .update({ banned_until: null, ban_reason: null })
    .eq("id", banUserId);

  if (unbanErr) return dbError(res, unbanErr, "POST /api/reports/reverse-ban");

  await supabase.from("reports").update({ status: "pending" }).eq("id", report.id);

  logModAction(req.user.id, "reverse_ban", req.params.id, { unbanned_user_id: banUserId });

  res.json({ success: true });
});

app.get("/api/reports/ban-info/:userId", requireAuth, require2FA, requireModerator, async (req, res) => {
  if (!UUID_RE.test(req.params.userId)) return res.status(400).json({ error: "Invalid userId" });

  const { data, error } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, banned_until, ban_reason")
    .eq("id", req.params.userId)
    .single();

  if (error) return res.status(404).json({ error: "User not found" });
  res.json(data);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MOD MESSAGE VIEWER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Moderator-only endpoint to read the conversation between a reporter and a reported user,
// used to provide evidence context when reviewing harassment or theft reports.

app.get("/api/mod/messages", requireAuth, require2FA, requireModerator, async (req, res) => {
  const { reporter, reported } = req.query;
  if (!reporter || !reported) {
    return res.status(400).json({ error: "Missing reporter/reported params" });
  }

  if (!UUID_RE.test(reporter) || !UUID_RE.test(reported)) {
    return res.status(400).json({ error: "Invalid reporter or reported id" });
  }

  const { data: convos } = await supabase
    .from("conversations")
    .select("id")
    .or(
      `and(participant_1.eq.${reporter},participant_2.eq.${reported}),` +
      `and(participant_1.eq.${reported},participant_2.eq.${reporter})`
    );

  if (!convos || convos.length === 0) {
    return res.json({ messages: [], profiles: {} });
  }

  const convoIds = convos.map((c) => c.id);

  const { data: msgs } = await supabase
    .from("messages")
    .select("*")
    .in("conversation_id", convoIds)
    .order("created_at", { ascending: true })
    .limit(50);

  const { data: profileData } = await supabase
    .from("profiles")
    .select("id, first_name, last_name")
    .in("id", [reporter, reported]);

  const profileMap = {};
  (profileData || []).forEach((p) => { profileMap[p.id] = p; });

  res.json({ messages: msgs || [], profiles: profileMap });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SUPPORT TICKETS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Ticket confirmation email ──────────────────────────────
async function sendReplyNotificationEmail({ toEmail, toName, ticketTitle, ticketCode, replyMessage, moderatorName }) {
  if (!resend || !process.env.RESEND_FROM || !toEmail) return;
  const from = process.env.RESEND_FROM;
  const subject = `A moderator replied to your ticket — Lost & Hound`;
  const html = `<div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; border: 1px solid #e0e0e0; border-radius: 8px; color: #000000;">

  <h2 style="color: #A84D48; border-bottom: 2px solid #000000; padding-bottom: 10px; margin-top: 0;">
    You have a new reply
  </h2>

  <p style="font-size: 16px; line-height: 1.5;">
    ${toName ? `Hi <strong>${toName}</strong>, a` : "A"} member of the <strong>Lost & Hound</strong> support team has responded to your ticket.
  </p>

  <div style="background-color: #fdf5f5; border-left: 4px solid #A84D48; border-radius: 0 6px 6px 0; padding: 16px 20px; margin: 24px 0;">
    <p style="margin: 0 0 6px; font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; color: #A84D48;">${moderatorName || "Support Team"} replied</p>
    <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #000000;">${replyMessage.replace(/\n/g, "<br>")}</p>
  </div>

  <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 28px;">
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #eeeeee; color: #666666;">Ticket</td>
      <td style="padding: 10px 0; border-bottom: 1px solid #eeeeee; font-weight: bold; text-align: right;">${ticketTitle}</td>
    </tr>
    <tr>
      <td style="padding: 10px 0; color: #666666;">Ticket Code</td>
      <td style="padding: 10px 0; font-weight: bold; text-align: right; letter-spacing: 2px;">${ticketCode}</td>
    </tr>
  </table>

  <div style="text-align: center; margin: 32px 0;">
    <a href="https://thelostandhound.com" style="display: inline-block; background-color: #A84D48; color: #ffffff; text-decoration: none; font-weight: bold; font-size: 15px; padding: 14px 32px; border-radius: 6px;">View Your Ticket</a>
  </div>

  <p style="font-size: 12px; color: #666666; border-top: 1px solid #eeeeee; padding-top: 20px;">
    To reply, visit <a href="https://thelostandhound.com" style="color: #A84D48;">thelostandhound.com</a> and use your ticket code <strong>${ticketCode}</strong> with your email address. If you did not submit this ticket, you can safely ignore this email.
  </p>

</div>`;

  try {
    await resend.emails.send({ from, to: toEmail, subject, html });
  } catch (err) {
    console.error("[Resend] Failed to send reply notification:", err?.message);
  }
}

async function sendTicketConfirmationEmail({ toEmail, toName, ticketCode, ticketType, category }) {
  if (!resend || !process.env.RESEND_FROM || !toEmail) return;
  const from = process.env.RESEND_FROM;
  const subject = `We received your ${ticketType} ticket — Lost & Hound`;
  const html = `<div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; border: 1px solid #e0e0e0; border-radius: 8px; color: #000000;">

  <h2 style="color: #A84D48; border-bottom: 2px solid #000000; padding-bottom: 10px; margin-top: 0;">
    Support Ticket Received
  </h2>

  <p style="font-size: 16px; line-height: 1.5;">
    ${toName ? `Hi <strong>${toName}</strong>, we` : "We"} received your <strong>${ticketType}</strong> ticket for <strong>Lost & Hound</strong>. A moderator will review it and get back to you shortly.
  </p>

  <div style="background-color: #fdf5f5; border: 2px solid #A84D48; border-radius: 6px; padding: 24px; text-align: center; margin: 32px 0;">
    <p style="margin: 0 0 6px; font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; color: #A84D48;">Your Ticket Code</p>
    <p style="margin: 0; font-size: 36px; font-weight: bold; letter-spacing: 6px; color: #000000;">${ticketCode}</p>
    <p style="margin: 10px 0 0; font-size: 13px; color: #666666;">Save this code — use it with your email address to check your ticket status anytime.</p>
  </div>

  <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px;">
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #eeeeee; color: #666666;">Type</td>
      <td style="padding: 10px 0; border-bottom: 1px solid #eeeeee; font-weight: bold; text-align: right;">${ticketType}</td>
    </tr>
    <tr>
      <td style="padding: 10px 0; color: #666666;">Category</td>
      <td style="padding: 10px 0; font-weight: bold; text-align: right;">${category}</td>
    </tr>
  </table>

  <p style="font-size: 12px; color: #666666; border-top: 1px solid #eeeeee; padding-top: 20px;">
    If you did not submit this ticket, you can safely ignore this email.
  </p>

</div>`;

  try {
    await resend.emails.send({ from, to: toEmail, subject, html });
  } catch (err) {
    console.error("[Resend] Failed to send ticket confirmation:", err?.message);
  }
}

const VALID_TICKET_TYPES = new Set(["Support", "Bug Report", "Feedback"]);

const VALID_SUPPORT_CATEGORIES = new Set([
  // Support
  "Login / Access Issue",
  "Account or Profile Issue",
  "Listing Problem",
  "Messaging Issue",
  "Technical Problem",
  // Bug Report
  "UI / Display Issue",
  "App Crash / Freeze",
  "Feature Not Working",
  "Performance Issue",
  // Feedback
  "Feature Request",
  "Usability Improvement",
  "Design Suggestion",
  "General Feedback",
  // Shared
  "Other",
]);

const SUPPORT_TITLE_MAX = 100;
const SUPPORT_DESC_MAX = 500;
const SUPPORT_NAME_MAX = 50;
const SUPPORT_VALID_STATUSES = new Set(["open", "in_progress", "resolved", "closed"]);

const TICKET_ID_RE = /^\d+$/;
const TICKET_CODE_RE = /^\d{5}$/;

// Generates a random 5-digit code (10000–99999) for user-facing ticket lookup
function generateTicketCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

// POST /api/support — authenticated user submits a ticket
app.post("/api/support", requireAuth, writeLimiter, async (req, res) => {
  const { ticketType, name, category, subject, description, image_url } = req.body;

  if (!ticketType || !category || !subject || !description) {
    return res.status(400).json({ error: "ticketType, category, subject, and description are required." });
  }
  if (!VALID_TICKET_TYPES.has(ticketType)) {
    return res.status(400).json({ error: "Invalid ticketType." });
  }
  if (!VALID_SUPPORT_CATEGORIES.has(category)) {
    return res.status(400).json({ error: "Invalid category." });
  }

  const safeTitle = sanitize(subject, SUPPORT_TITLE_MAX);
  const safeDesc = sanitize(description, SUPPORT_DESC_MAX);

  if (!safeTitle) return res.status(400).json({ error: "Subject is required." });
  if (!safeDesc) return res.status(400).json({ error: "Description is required." });

  // Validate image_url must come from our own Supabase storage bucket
  let safeImageUrl = null;
  if (image_url) {
    const rawUrl = sanitize(image_url, 600);
    const storagePrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/listing-images/`;
    if (!rawUrl.startsWith(storagePrefix)) {
      return res.status(400).json({ error: "Invalid image URL." });
    }
    safeImageUrl = rawUrl;
  }

  const { data: inserted, error } = await supabase.from("support_tickets").insert({
    user_id: req.user.id,
    name: name ? sanitize(name, SUPPORT_NAME_MAX) : null,
    email: req.user.email || null,
    ticket_type: ticketType,
    category,
    ticket_title: safeTitle,
    ticket_desc: safeDesc,
    image_url: safeImageUrl,
    ticket_code: generateTicketCode(),
  }).select("ticket_code");

  if (error) return dbError(res, error, "POST /api/support");
  const code = inserted?.[0]?.ticket_code;
  // Fire-and-forget — never block the response on email delivery
  sendTicketConfirmationEmail({
    toEmail: req.user.email,
    toName: name ? sanitize(name, SUPPORT_NAME_MAX) : null,
    ticketCode: code,
    ticketType,
    category,
  });
  res.status(201).json({ success: true, ticketCode: code });
});

// POST /api/support/guest — unauthenticated user submits a ticket (from login page)
app.post("/api/support/guest", strictLimiter, async (req, res) => {
  const { ticketType, name, email, category, subject, description, image_url } = req.body;

  if (!ticketType || !name || !email || !category || !subject || !description) {
    return res.status(400).json({ error: "ticketType, name, email, category, subject, and description are required." });
  }
  if (!VALID_TICKET_TYPES.has(ticketType)) {
    return res.status(400).json({ error: "Invalid ticketType." });
  }
  if (!VALID_SUPPORT_CATEGORIES.has(category)) {
    return res.status(400).json({ error: "Invalid category." });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  const safeName = sanitize(name, SUPPORT_NAME_MAX);
  const safeTitle = sanitize(subject, SUPPORT_TITLE_MAX);
  const safeDesc = sanitize(description, SUPPORT_DESC_MAX);

  if (!safeName) return res.status(400).json({ error: "Name is required." });
  if (!safeTitle) return res.status(400).json({ error: "Subject is required." });
  if (!safeDesc) return res.status(400).json({ error: "Description is required." });

  // Validate image_url must come from the guest/support/ path in our own storage bucket
  let safeImageUrl = null;
  if (image_url) {
    const rawUrl = sanitize(image_url, 600);
    const guestStoragePrefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/listing-images/guest/support/`;
    if (!rawUrl.startsWith(guestStoragePrefix)) {
      return res.status(400).json({ error: "Invalid image URL." });
    }
    safeImageUrl = rawUrl;
  }

  const { data: inserted, error } = await supabase.from("support_tickets").insert({
    name: safeName,
    email: email.trim().toLowerCase(),
    ticket_type: ticketType,
    category,
    ticket_title: safeTitle,
    ticket_desc: safeDesc,
    image_url: safeImageUrl,
    ticket_code: generateTicketCode(),
  }).select("ticket_code");

  if (error) return dbError(res, error, "POST /api/support/guest");
  const code = inserted?.[0]?.ticket_code;
  sendTicketConfirmationEmail({
    toEmail: email.trim().toLowerCase(),
    toName: safeName,
    ticketCode: code,
    ticketType,
    category,
  });
  res.status(201).json({ success: true, ticketCode: code });
});

// GET /api/support-tickets/guest-status — guest ticket lookup by email + ticket ID
app.get("/api/support-tickets/guest-status", strictLimiter, async (req, res) => {
  const email = sanitize(req.query.email || "", 200).trim().toLowerCase();
  const ticketCode = sanitize(req.query.ticketCode || "", 5).trim();

  if (!email || !ticketCode) {
    return res.status(400).json({ error: "Email and ticket code are required." });
  }
  if (!TICKET_CODE_RE.test(ticketCode)) {
    return res.status(400).json({ error: "Ticket code must be a 5-digit number." });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  const { data, error } = await supabase
    .from("support_tickets")
    .select("id, ticket_code, ticket_type, category, ticket_title, ticket_desc, status, claimed_by, image_url, created_at, support_replies(id, is_moderator, message, created_at)")
    .eq("ticket_code", ticketCode)
    .eq("email", email)
    .single();

  // Return same error regardless of whether email or code is wrong — prevents enumeration
  if (error || !data) {
    return res.status(404).json({ error: "No ticket found with that email and code." });
  }

  res.json({ ticket: data });
});

// POST /api/support-tickets/guest-reply — guest submits a reply using email + ticket code
app.post("/api/support-tickets/guest-reply", strictLimiter, async (req, res) => {
  const email = sanitize(req.body.email || "", 200).trim().toLowerCase();
  const ticketCode = sanitize(req.body.ticketCode || "", 5).trim();
  const message = sanitize(req.body.message || "", 1000).trim();

  if (!email || !ticketCode || !message) {
    return res.status(400).json({ error: "Email, ticket code, and message are required." });
  }
  if (!TICKET_CODE_RE.test(ticketCode)) {
    return res.status(400).json({ error: "Ticket code must be a 5-digit number." });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  const { data: ticket, error: fetchErr } = await supabase
    .from("support_tickets")
    .select("id, status, email, ticket_code")
    .eq("ticket_code", ticketCode)
    .eq("email", email)
    .single();

  if (fetchErr || !ticket) {
    return res.status(404).json({ error: "No ticket found with that email and code." });
  }
  if (ticket.status === "closed") {
    return res.status(400).json({ error: "Cannot reply to a closed ticket." });
  }

  const { data, error } = await supabase
    .from("support_replies")
    .insert({ ticket_id: ticket.id, user_id: null, is_moderator: false, message })
    .select();

  if (error) return dbError(res, error, "POST /api/support-tickets/guest-reply");
  res.status(201).json(data[0]);
});

// GET /api/support — list tickets (moderators only)
app.get("/api/support", requireAuth, require2FA, requireModerator, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 100;
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabase
    .from("support_tickets")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return dbError(res, error, "GET /api/support");
  res.json({ tickets: data || [], total: count ?? 0, hasMore: offset + limit < (count ?? 0) });
});

// PATCH /api/support/:id/status — update ticket status (moderators only)
app.patch("/api/support/:id/status", requireAuth, require2FA, requireModerator, async (req, res) => {
  if (!TICKET_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });

  const { status } = req.body;
  if (!status || !SUPPORT_VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: "Invalid status. Must be one of: open, in_progress, resolved, closed." });
  }

  const { error } = await supabase
    .from("support_tickets")
    .update({ status })
    .eq("id", req.params.id);

  if (error) return dbError(res, error, "PATCH /api/support/:id/status");
  res.json({ success: true });
});

// DELETE /api/support/:id — delete ticket (moderators only)
app.delete("/api/support/:id", requireAuth, require2FA, requireModerator, async (req, res) => {
  if (!TICKET_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });

  const { error } = await supabase
    .from("support_tickets")
    .delete()
    .eq("id", req.params.id);

  if (error) return dbError(res, error, "DELETE /api/support/:id");
  res.json({ success: true });
});

// SUPPORT TICKETS ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Dashboard summary — lightweight counts for the overview page
app.get("/api/dashboard/summary", requireAuth, require2FA, requireModerator, async (req, res) => {
  const userId = req.user.id;
  try {
    const [reportsRes, ticketsRes, myWorkRes] = await Promise.all([
      supabase.from("reports").select("id, status, reason, details").limit(5000),
      supabase.from("support_tickets").select("id, ticket_type, status, severity, deadline, claimed_by").limit(5000),
      supabase.from("support_tickets").select("id, status, deadline").eq("assignee_id", userId).not("status", "in", '("closed","resolved")'),
    ]);

    const reports = reportsRes.data || [];
    const tickets = ticketsRes.data || [];
    const myWork  = myWorkRes.data || [];

    const isStolen = (r) => {
      const reason  = (r.reason  || "").toLowerCase();
      const details = (r.details || "").toLowerCase();
      return reason.includes("stolen") || details.includes("stolen")
          || reason.includes("theft")  || details.includes("theft");
    };

    const regular = reports.filter(r => !isStolen(r));
    const stolen  = reports.filter(r =>  isStolen(r));
    const feedback = tickets.filter(t => t.ticket_type === "Feedback");
    const bugs     = tickets.filter(t => t.ticket_type === "Bug Report");
    const support  = tickets.filter(t => t.ticket_type === "Support");
    const now = new Date();

    res.json({
      reports: {
        pending:   regular.filter(r => r.status === "pending").length,
        reviewed:  regular.filter(r => r.status === "reviewed").length,
        dismissed: regular.filter(r => r.status === "dismissed").length,
      },
      stolen: {
        pending: stolen.filter(r => r.status === "pending").length,
        total:   stolen.length,
      },
      feedback: {
        open:        feedback.filter(t => t.status === "open").length,
        in_progress: feedback.filter(t => t.status === "in_progress").length,
      },
      bugs: {
        open:        bugs.filter(t => t.status === "open").length,
        in_progress: bugs.filter(t => t.status === "in_progress").length,
        critical:    bugs.filter(t => t.severity === "critical" && !["closed","resolved"].includes(t.status)).length,
      },
      support: {
        open:        support.filter(t => t.status === "open").length,
        unclaimed:   support.filter(t => t.status === "open" && !t.claimed_by).length,
        in_progress: support.filter(t => t.status === "in_progress").length,
      },
      myWork: {
        total:   myWork.length,
        overdue: myWork.filter(t => t.deadline && new Date(t.deadline) < now).length,
      },
    });
  } catch (err) {
    console.error("Dashboard summary error:", err);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

// Fetch all support tickets with replies (moderators only)
app.get("/api/support-tickets", requireAuth, require2FA, requireModerator, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const ticketType = req.query.ticket_type || null;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("support_tickets")
      .select("id, ticket_code, user_id, ticket_type, category, ticket_title, ticket_desc, name, email, status, image_url, claimed_by, resolved_by, resolved_at, severity, assignee, assignee_id, environment, estimated_effort, repro_steps, fix_notes, fix_pr_url, deadline, created_at, support_replies(id, is_moderator, message, created_at)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (ticketType) query = query.eq("ticket_type", ticketType);

    const { data, error, count } = await query;
    if (error) return dbError(res, error, "fetching support tickets");
    res.json({ tickets: data, hasMore: (count ?? 0) > offset + limit, total: count ?? 0 });
  } catch (error) {
    dbError(res, error, "fetching support tickets");
  }
});

// Fetch current user's own support tickets
app.get("/api/support-tickets/mine", requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabase
      .from("support_tickets")
      .select("id, ticket_code, ticket_type, category, ticket_title, ticket_desc, status, claimed_by, image_url, created_at, support_replies(id, is_moderator, message, created_at)", { count: "exact" })
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return dbError(res, error, "fetching user support tickets");
    res.json({ tickets: data, hasMore: (count ?? 0) > offset + limit });
  } catch (error) {
    dbError(res, error, "fetching user support tickets");
  }
});

const SEVERITY_VALUES = new Set(["critical", "high", "medium", "low"]);
const ENVIRONMENT_VALUES = new Set(["web", "ios", "android", "all"]);
const EFFORT_VALUES = new Set(["xs", "s", "m", "l", "xl"]);

// List all moderators (for assignee dropdown)
app.get("/api/moderators", requireAuth, require2FA, requireModerator, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, first_name, last_name")
      .eq("is_moderator", true)
      .order("first_name");
    if (error) return dbError(res, error, "GET /api/moderators");
    res.json({ moderators: data.map(m => ({ id: m.id, name: `${m.first_name || ""} ${m.last_name || ""}`.trim() || "Moderator" })) });
  } catch (err) {
    dbError(res, err, "GET /api/moderators");
  }
});

// My Work — tickets assigned to the requesting moderator
app.get("/api/support-tickets/my-work", requireAuth, require2FA, requireModerator, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
    const page   = Math.max(parseInt(req.query.page)  || 1, 1);
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabase
      .from("support_tickets")
      .select("id, ticket_code, user_id, ticket_type, category, ticket_title, ticket_desc, name, email, status, image_url, claimed_by, resolved_by, resolved_at, severity, assignee, assignee_id, environment, estimated_effort, repro_steps, fix_notes, fix_pr_url, deadline, created_at, support_replies(id, is_moderator, message, created_at)", { count: "exact" })
      .eq("assignee_id", req.user.id)
      .not("status", "eq", "closed")
      .order("deadline", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return dbError(res, error, "GET /api/support-tickets/my-work");
    res.json({ tickets: data, hasMore: offset + limit < (count ?? 0), total: count ?? 0 });
  } catch (err) {
    dbError(res, err, "GET /api/support-tickets/my-work");
  }
});

// Update a support ticket (status + optional engineering fields) — moderators only
app.patch("/api/support-tickets/:id", requireAuth, require2FA, requireModerator, async (req, res) => {
  if (!TICKET_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });

  const { status, severity, assignee, assignee_id, environment, estimated_effort, repro_steps, fix_notes, fix_pr_url, deadline } = req.body;

  // status is optional — can PATCH only engineering fields
  if (status !== undefined && !SUPPORT_VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }

  const ENG_FIELDS = ["severity", "assignee", "assignee_id", "environment", "estimated_effort", "repro_steps", "fix_notes", "fix_pr_url", "deadline"];
  const isEngEdit = ENG_FIELDS.some(f => req.body[f] !== undefined);

  try {
    // Ownership check: if ticket has an assignee_id set and this is an eng edit,
    // only the assigned moderator (or any mod changing only status) can edit eng fields.
    if (isEngEdit) {
      const { data: current } = await supabase
        .from("support_tickets")
        .select("assignee_id")
        .eq("id", req.params.id)
        .single();
      if (current?.assignee_id && current.assignee_id !== req.user.id) {
        return res.status(403).json({ error: "This ticket is assigned to another moderator. Only the assigned moderator can edit engineering details." });
      }
    }

    const updates = {};
    if (status !== undefined) updates.status = status;

    // Engineering fields — each validated before applying
    if (severity !== undefined) {
      if (severity !== null && !SEVERITY_VALUES.has(severity)) return res.status(400).json({ error: "Invalid severity." });
      updates.severity = severity;
    }
    if (environment !== undefined) {
      if (environment !== null && !ENVIRONMENT_VALUES.has(environment)) return res.status(400).json({ error: "Invalid environment." });
      updates.environment = environment;
    }
    if (estimated_effort !== undefined) {
      if (estimated_effort !== null && !EFFORT_VALUES.has(estimated_effort)) return res.status(400).json({ error: "Invalid effort value." });
      updates.estimated_effort = estimated_effort;
    }
    if (assignee !== undefined) {
      updates.assignee = assignee ? String(assignee).trim().slice(0, 80) || null : null;
    }
    if (assignee_id !== undefined) {
      updates.assignee_id = assignee_id || null;
    }
    if (repro_steps !== undefined) {
      updates.repro_steps = repro_steps ? String(repro_steps).trim().slice(0, 1000) || null : null;
    }
    if (fix_notes !== undefined) {
      updates.fix_notes = fix_notes ? String(fix_notes).trim().slice(0, 1000) || null : null;
    }
    if (fix_pr_url !== undefined) {
      if (fix_pr_url !== null && !String(fix_pr_url).startsWith("https://")) {
        return res.status(400).json({ error: "fix_pr_url must start with https://" });
      }
      updates.fix_pr_url = fix_pr_url ? String(fix_pr_url).trim().slice(0, 300) : null;
    }
    if (deadline !== undefined) {
      updates.deadline = deadline || null; // ISO string or null
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Nothing to update." });

    // Auto-claim on start; record resolver on resolve
    if (status === "in_progress" || status === "resolved") {
      const { data: mod } = await supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("id", req.user.id)
        .single();
      const modName = mod
        ? `${mod.first_name || ""} ${mod.last_name || ""}`.trim() || "Moderator"
        : "Moderator";

      if (status === "in_progress") {
        const { data: current } = await supabase
          .from("support_tickets")
          .select("claimed_by")
          .eq("id", req.params.id)
          .single();
        if (current && !current.claimed_by) updates.claimed_by = modName;
      }
      if (status === "resolved") {
        updates.resolved_by = modName;
        updates.resolved_at = new Date().toISOString();
      }
    }

    const { data, error } = await supabase
      .from("support_tickets")
      .update(updates)
      .eq("id", req.params.id)
      .select("id, status, claimed_by, resolved_by, resolved_at, severity, assignee, assignee_id, environment, estimated_effort, repro_steps, fix_notes, fix_pr_url, deadline");

    if (error) return dbError(res, error, "updating support ticket");
    if (!data || data.length === 0) return res.status(404).json({ error: "Ticket not found." });
    res.json(data[0]);
  } catch (error) {
    dbError(res, error, "updating support ticket");
  }
});

// Get replies for a support ticket (ticket owner or moderator)
app.get("/api/support-tickets/:id/replies", requireAuth, async (req, res) => {
  if (!TICKET_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const { data: ticket } = await supabase.from("support_tickets").select("id, user_id").eq("id", req.params.id).single();
    if (!ticket) return res.status(404).json({ error: "Ticket not found." });

    const { data: profile } = await supabase.from("profiles").select("is_moderator").eq("id", req.user.id).single();
    const isModerator = profile?.is_moderator === true;

    if (ticket.user_id !== req.user.id && !isModerator) return res.status(403).json({ error: "Forbidden." });

    const { data, error } = await supabase
      .from("support_replies")
      .select("id, user_id, is_moderator, message, created_at")
      .eq("ticket_id", req.params.id)
      .order("created_at", { ascending: true });

    if (error) return dbError(res, error, "GET replies");
    res.json({ replies: data });
  } catch (err) {
    dbError(res, err, "GET replies");
  }
});

// Post a reply as the ticket owner (authenticated user, not moderator)
app.post("/api/support-tickets/:id/reply", requireAuth, writeLimiter, async (req, res) => {
  if (!TICKET_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: "Message is required." });

  try {
    const { data: ticket } = await supabase.from("support_tickets").select("id, user_id, status").eq("id", req.params.id).single();
    if (!ticket) return res.status(404).json({ error: "Ticket not found." });
    if (ticket.user_id !== req.user.id) return res.status(403).json({ error: "Forbidden." });
    if (ticket.status === "closed") return res.status(400).json({ error: "Cannot reply to a closed ticket." });

    const { data, error } = await supabase
      .from("support_replies")
      .insert({ ticket_id: Number(req.params.id), user_id: req.user.id, is_moderator: false, message: sanitize(message, 1000) })
      .select();

    if (error) return dbError(res, error, "POST user reply");
    res.status(201).json(data[0]);
  } catch (err) {
    dbError(res, err, "POST user reply");
  }
});

// Post a reply to a support ticket (moderators only)
app.post("/api/support-tickets/:id/replies", requireAuth, require2FA, requireModerator, async (req, res) => {
  if (!TICKET_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid id" });

  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  try {
    const { data: ticket, error: ticketError } = await supabase
      .from("support_tickets")
      .select("id, status, claimed_by, email, name, ticket_title, ticket_code, user_id")
      .eq("id", req.params.id)
      .single();

    if (ticketError || !ticket) return res.status(404).json({ error: "Ticket not found." });
    if (ticket.status === "closed") return res.status(400).json({ error: "Cannot reply to a closed ticket." });

    // Check if this is the first moderator reply (for email notification)
    const { count: existingModReplies } = await supabase
      .from("support_replies")
      .select("id", { count: "exact", head: true })
      .eq("ticket_id", req.params.id)
      .eq("is_moderator", true);
    const isFirstModReply = (existingModReplies ?? 0) === 0;

    const safeMessage = sanitize(message, 1000);

    const { data, error } = await supabase
      .from("support_replies")
      .insert({
        ticket_id: Number(req.params.id),
        is_moderator: true,
        message: safeMessage,
      })
      .select();

    if (error) return dbError(res, error, "posting reply");

    // Auto-advance open tickets to in_progress when a moderator replies
    const updates = {};
    if (ticket.status === "open") updates.status = "in_progress";

    // Auto-claim: first moderator to reply becomes the owner
    let moderatorName = "Support Team";
    if (!ticket.claimed_by) {
      const { data: mod } = await supabase
        .from("profiles")
        .select("first_name, last_name")
        .eq("id", req.user.id)
        .single();
      moderatorName = mod
        ? `${mod.first_name || ""} ${mod.last_name || ""}`.trim() || "Support Team"
        : "Support Team";
      updates.claimed_by = moderatorName;
    } else {
      moderatorName = ticket.claimed_by;
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from("support_tickets").update(updates).eq("id", req.params.id);
    }

    // Send email only on the first mod reply — fire-and-forget
    if (isFirstModReply && ticket.email) {
      sendReplyNotificationEmail({
        toEmail: ticket.email,
        toName: ticket.name || null,
        ticketTitle: ticket.ticket_title,
        ticketCode: ticket.ticket_code,
        replyMessage: safeMessage,
        moderatorName,
      });
    }

    // Push notification to authenticated ticket owner on every mod reply
    if (ticket.user_id) {
      const replyPreview = safeMessage.length > 100 ? safeMessage.slice(0, 97) + "…" : safeMessage;
      sendPushNotification(
        ticket.user_id,
        "Support reply from the team",
        replyPreview,
        { type: "support_reply", ticketId: ticket.id }
      ).catch(() => {});
    }

    res.status(201).json(data[0]);
  } catch (error) {
    dbError(res, error, "posting reply");
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PUSH NOTIFICATIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Register or update a OneSignal player_id for the current user.
app.post("/api/push-tokens", requireAuth, async (req, res) => {
  const { playerId } = req.body;
  if (!playerId || typeof playerId !== "string") {
    return res.status(400).json({ error: "playerId is required" });
  }

  const { error } = await supabase
    .from("push_tokens")
    .upsert(
      { user_id: req.user.id, player_id: playerId },
      { onConflict: "user_id" }
    );

  if (error) return dbError(res, error, "POST /api/push-tokens");
  res.json({ ok: true });
});

// Remove push token on logout.
app.delete("/api/push-tokens", requireAuth, async (req, res) => {
  await supabase.from("push_tokens").delete().eq("user_id", req.user.id);
  res.json({ ok: true });
});

// Send push notification to a user via Expo Push API.
async function sendPushNotification(userId, title, body, data = {}) {
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  const appId  = process.env.ONESIGNAL_APP_ID;
  if (!apiKey || !appId) return;

  const [{ data: row }, { data: prefs }] = await Promise.all([
    supabase.from("push_tokens").select("player_id").eq("user_id", userId).single(),
    supabase.from("profiles").select("push_notifications_enabled").eq("id", userId).single(),
  ]);

  if (!row?.player_id) return;
  if (prefs?.push_notifications_enabled === false) return;

  try {
    await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${apiKey}` },
      body: JSON.stringify({
        app_id: appId,
        include_player_ids: [row.player_id],
        headings: { en: title },
        contents: { en: body },
        data,
      }),
    });
    supabase.from("push_logs").insert({ user_id: userId }).catch(() => {});
    incrementPushCount().catch(() => {});
  } catch (err) {
    console.error("Push notification error:", err);
  }
}

async function sendBroadcastPush(title, body, data = {}) {
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  const appId  = process.env.ONESIGNAL_APP_ID;
  if (!apiKey || !appId) return;
  try {
    let notifPayload = {
      app_id: appId,
      included_segments: ["All"],
      headings: { en: title },
      contents: { en: body },
      data,
    };

    // Exclude users who have opted out of community broadcasts
    try {
      const { data: optedOut } = await supabase
        .from("profiles")
        .select("id")
        .eq("broadcast_notifications_enabled", false);
      if (optedOut?.length > 0) {
        const optedOutIds = optedOut.map(r => r.id);
        const { data: tokens } = await supabase
          .from("push_tokens")
          .select("player_id")
          .not("user_id", "in", `(${optedOutIds.join(",")})`);
        const playerIds = (tokens ?? []).map(t => t.player_id).filter(Boolean);
        if (playerIds.length > 0) {
          delete notifPayload.included_segments;
          notifPayload.include_player_ids = playerIds;
        }
      }
    } catch {} // broadcast_notifications_enabled column may not exist yet

    await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${apiKey}` },
      body: JSON.stringify(notifPayload),
    });
    await incrementPushCount();
  } catch (err) {
    console.error("Broadcast push error:", err);
  }
}

async function incrementPushCount() {
  const { data: cfg } = await supabase
    .from("finance_config")
    .select("overrides")
    .eq("id", "singleton")
    .single();
  const current = cfg?.overrides?.push_count || 6;
  const next = { ...(cfg?.overrides ?? {}), push_count: current + 1 };
  await supabase
    .from("finance_config")
    .upsert({ id: "singleton", overrides: next, updated_at: new Date().toISOString() });
}

// Mod-only manual trigger for the daily lost items broadcast
app.post("/api/push/broadcast-lost-items", requireAuth, require2FA, requireOwner, async (_req, res) => {
  const { count } = await supabase
    .from("listings")
    .select("item_id", { count: "exact", head: true })
    .neq("resolved", true);

  const n = count ?? 0;
  await sendBroadcastPush(
    "Lost & Hound",
    `There are currently ${n} active posts. Can you lend a paw? 🐾`,
    { type: "broadcast_lost_items" }
  );
  res.json({ ok: true, count: n });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FINANCES (owner-only)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get("/api/finances/summary", requireAuth, require2FA, requireOwner, async (_req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const { data: visionRow } = await supabase
    .from("vision_usage")
    .select("call_count")
    .eq("month", month)
    .single();
  const vision = { month, callCount: visionRow?.call_count ?? 0, freeLimit: 1000 };

  let railway = null;
  if (process.env.RAILWAY_API_TOKEN) {
    try {
      const railwayFetch = async (query, variables = {}) => {
        const r = await fetch("https://backboard.railway.app/graphql/v2", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RAILWAY_API_TOKEN}` },
          body: JSON.stringify({ query, variables }),
        });
        return r.json();
      };

      // Step 1: get workspaceId from projects
      const projectsData = await railwayFetch(`{ projects { edges { node { name workspaceId } } } }`);
      const projects = projectsData?.data?.projects?.edges ?? [];
      const workspaceId = projects[0]?.node?.workspaceId;

      // Step 2: get billing from workspace (parameterized — no string interpolation)
      if (workspaceId) {
        const billingData = await railwayFetch(
          `query($wid: String!) {
            workspace(workspaceId: $wid) {
              name plan
              customer { currentUsage remainingUsageCreditBalance state }
            }
          }`,
          { wid: workspaceId }
        );
        const ws = billingData?.data?.workspace;
        if (ws) {
          const currentUsage = ws.customer?.currentUsage ?? 0;
          const now = new Date();
          const dayOfMonth = now.getDate();
          const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
          const estimatedUsage = currentUsage * (daysInMonth / dayOfMonth);
          railway = {
            workspaceName: ws.name,
            plan: ws.plan,
            currentUsage,
            estimatedUsage,
            remainingCredit: ws.customer?.remainingUsageCreditBalance ?? null,
            state: ws.customer?.state ?? null,
          };
        }
      }
    } catch (err) {
      console.error("[Finances] Railway API error:", err.message);
    }
  }

  const { data: cfgData } = await supabase
    .from("finance_config")
    .select("overrides")
    .eq("id", "singleton")
    .single();
  const push = { month, sentCount: cfgData?.overrides?.push_count || 6, freeLimit: 10000 };

  res.json({ vision, railway, push });
});

app.get("/api/finances/config", requireAuth, require2FA, requireOwner, async (_req, res) => {
  const { data, error } = await supabase
    .from("finance_config")
    .select("overrides, updated_by, updated_at")
    .eq("id", "singleton")
    .single();
  if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });
  res.json(data ?? { overrides: {}, updated_by: null, updated_at: null });
});

app.patch("/api/finances/config", requireAuth, require2FA, requireOwner, async (req, res) => {
  const { overrides } = req.body;
  if (!overrides || typeof overrides !== "object") return res.status(400).json({ error: "overrides object required" });
  const { data, error } = await supabase
    .from("finance_config")
    .upsert({ id: "singleton", overrides, updated_by: req.user.id, updated_at: new Date().toISOString() })
    .select("overrides, updated_by, updated_at")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/finances/expenses", requireAuth, require2FA, requireOwner, async (_req, res) => {
  const { data, error } = await supabase
    .from("finance_expenses")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

app.post("/api/finances/expenses", requireAuth, require2FA, requireOwner, async (req, res) => {
  const { name, amount, type, date, notes } = req.body;
  if (!name || amount == null || !type) return res.status(400).json({ error: "name, amount, type required" });
  const { data, error } = await supabase
    .from("finance_expenses")
    .insert({ name, amount: parseFloat(amount), type, date: date || null, notes: notes || null, created_by: req.user.id })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/finances/expenses/:id", requireAuth, require2FA, requireOwner, async (req, res) => {
  const { name, amount, type, date, notes } = req.body;
  if (!name || amount == null || !type) return res.status(400).json({ error: "name, amount, type required" });
  const { data, error } = await supabase
    .from("finance_expenses")
    .update({ name, amount: parseFloat(amount), type, date: date || null, notes: notes || null })
    .eq("id", req.params.id)
    .eq("created_by", req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Expense not found" });
  res.json(data);
});

app.delete("/api/finances/expenses/:id", requireAuth, require2FA, requireOwner, async (req, res) => {
  const { error } = await supabase
    .from("finance_expenses")
    .delete()
    .eq("id", req.params.id)
    .eq("created_by", req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Catch-all: log any request that didn't match a route
app.use((req, res) => {
  console.log(`[404] No route matched: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found" });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UNREAD MESSAGE EMAIL NOTIFICATIONS (cron — hourly)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function sendUnreadMessageEmail({ toEmail, toName, messageCount, conversationCount }) {
  if (!resend || !process.env.RESEND_FROM || !toEmail) return;
  const msgWord = messageCount === 1 ? "message" : "messages";
  const convWord = conversationCount === 1 ? "conversation" : "conversations";
  const subject = `You have ${messageCount} unread ${msgWord} on Lost & Hound`;
  const html = `<div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 40px; border: 1px solid #e0e0e0; border-radius: 8px; color: #000000;">

  <h2 style="color: #A84D48; border-bottom: 2px solid #000000; padding-bottom: 10px; margin-top: 0;">
    Unread Messages
  </h2>

  <p style="font-size: 16px; line-height: 1.5;">
    ${toName ? `Hi <strong>${toName}</strong>, you have` : "You have"} <strong>${messageCount} unread ${msgWord}</strong> across <strong>${conversationCount} ${convWord}</strong> on Lost &amp; Hound.
  </p>

  <div style="text-align: center; margin: 32px 0;">
    <a href="https://thelostandhound.com/messages" style="display: inline-block; background-color: #A84D48; color: #ffffff; text-decoration: none; font-weight: bold; font-size: 15px; padding: 14px 32px; border-radius: 6px;">View Messages</a>
  </div>

  <p style="font-size: 12px; color: #666666; border-top: 1px solid #eeeeee; padding-top: 20px;">
    You're receiving this because someone sent you a message on <a href="https://thelostandhound.com" style="color: #A84D48;">Lost & Hound</a>. You won't receive another reminder for these messages unless you read them and receive new ones.
  </p>

</div>`;
  try {
    await resend.emails.send({ from: process.env.RESEND_FROM, to: toEmail, subject, html });
  } catch (err) {
    console.error("[Resend] Failed to send unread message notification:", err?.message);
  }
}

async function processUnreadMessageNotifications() {
  if (!resend || !process.env.RESEND_FROM) return;

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Find unread messages older than 24h that haven't been notified yet
  const { data: msgs, error: msgsErr } = await supabase
    .from("messages")
    .select("id, conversation_id, sender_id")
    .eq("read", false)
    .eq("email_notified", false)
    .lt("created_at", cutoff);

  if (msgsErr) { console.error("[UnreadNotif] Query error:", msgsErr.message); return; }
  if (!msgs?.length) return;

  // 2. Fetch the relevant conversations to determine recipients
  const convIds = [...new Set(msgs.map((m) => m.conversation_id))];
  const { data: convos } = await supabase
    .from("conversations")
    .select("id, participant_1, participant_2")
    .in("id", convIds);
  if (!convos?.length) return;

  const convMap = Object.fromEntries(convos.map((c) => [c.id, c]));

  // 3. Group message IDs by recipient user ID
  const byRecipient = {}; // { [userId]: { messageIds: [], convIds: Set } }
  for (const msg of msgs) {
    const conv = convMap[msg.conversation_id];
    if (!conv) continue;
    const recipient = conv.participant_1 === msg.sender_id ? conv.participant_2 : conv.participant_1;
    if (!byRecipient[recipient]) byRecipient[recipient] = { messageIds: [], convIds: new Set() };
    byRecipient[recipient].messageIds.push(msg.id);
    byRecipient[recipient].convIds.add(msg.conversation_id);
  }

  const recipientIds = Object.keys(byRecipient);
  if (!recipientIds.length) return;

  // 4. Fetch display names + notification prefs from profiles
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, first_name, last_name, email_notifications_enabled")
    .in("id", recipientIds);
  const profileMap = Object.fromEntries((profiles || []).map((p) => [p.id, p]));

  // 5. Send one email per recipient, then mark their messages as notified
  const notifiedIds = [];

  for (const [recipientId, { messageIds, convIds }] of Object.entries(byRecipient)) {
    try {
      const { data: { user: authUser } } = await supabase.auth.admin.getUserById(recipientId);
      const email = authUser?.email;
      if (!email) continue;

      const profile = profileMap[recipientId];
      if (profile?.email_notifications_enabled === false) continue;

      const name = profile ? `${profile.first_name || ""} ${profile.last_name || ""}`.trim() || null : null;

      await sendUnreadMessageEmail({
        toEmail: email,
        toName: name,
        messageCount: messageIds.length,
        conversationCount: convIds.size,
      });

      notifiedIds.push(...messageIds);
    } catch (err) {
      console.error(`[UnreadNotif] Failed for user ${recipientId}:`, err?.message);
    }
  }

  // 6. Mark all successfully notified messages so they don't trigger again
  if (notifiedIds.length > 0) {
    await supabase.from("messages").update({ email_notified: true }).in("id", notifiedIds);
    console.log(`[UnreadNotif] Notified ${Object.keys(byRecipient).length} users, ${notifiedIds.length} messages marked.`);
  }
}

// Run every hour at :00 — only fires for messages that crossed the 24h threshold since last run
cron.schedule("0 * * * *", () => {
  processUnreadMessageNotifications().catch((err) =>
    console.error("[UnreadNotif] Cron error:", err)
  );
});

// Daily lost items broadcast at 10am ET (15:00 UTC)
cron.schedule("0 15 * * *", () => {
  supabase
    .from("listings")
    .select("item_id", { count: "exact", head: true })
    .neq("resolved", true)
    .then(({ count }) => {
      if (!count || count === 0) return;
      return sendBroadcastPush(
        "Lost & Hound",
        `There are currently ${count} active posts. Can you lend a paw? 🐾`,
        { type: "broadcast_lost_items" }
      );
    })
    .catch((err) => console.error("[BroadcastCron]", err));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));