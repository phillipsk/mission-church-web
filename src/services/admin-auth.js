import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fetchGmailTokenIfConfigured } from "./sync-pipeline.js";

const COOKIE_NAME = "mission_admin_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAGIC_TTL_MS = 15 * 60 * 1000;

export const ALLOWED_ADMIN_EMAILS = new Set([
  "phillipskevin386@gmail.com",
  "missionchurch1@gmail.com",
  "flips4063@gmail.com",
]);

function readLocalEnv() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return {};
  const map = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    map[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return map;
}

function getSigningSecret() {
  return (
    process.env.APPROVAL_HMAC_SECRET ||
    readLocalEnv().APPROVAL_HMAC_SECRET ||
    "mission-church-local-dev-approval-secret"
  );
}

function getConfiguredPasscode() {
  return process.env.ADMIN_PASSCODE || readLocalEnv().ADMIN_PASSCODE || "";
}

export function isAuthorizedAdminEmail(email) {
  return ALLOWED_ADMIN_EMAILS.has(String(email || "").trim().toLowerCase());
}

export function verifyPasscodeLogin(email, passcode) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!isAuthorizedAdminEmail(normalizedEmail)) {
    return { ok: false, error: "This email is not on the Mission Church admin list." };
  }
  const expected = getConfiguredPasscode();
  if (!expected) {
    return { ok: false, error: "Admin passcode is not configured on this server. Use Email Login Link instead." };
  }
  const a = Buffer.from(String(passcode || ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "Incorrect admin passcode." };
  }
  return { ok: true, email: normalizedEmail };
}

function signPayload(payloadObj) {
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", getSigningSecret()).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

function verifySignedPayload(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".", 2);
  const expectedSig = crypto.createHmac("sha256", getSigningSecret()).update(payloadB64).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!parsed.exp || Date.now() > Number(parsed.exp)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createSessionCookieHeader(email, req) {
  const token = signPayload({
    email: String(email).trim().toLowerCase(),
    role: "admin",
    exp: Date.now() + SESSION_TTL_MS,
  });
  const isHttps = req?.headers?.["x-forwarded-proto"] === "https";
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(req) {
  const isHttps = req?.headers?.["x-forwarded-proto"] === "https";
  const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

export function parseCookies(req) {
  const raw = req?.headers?.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function getAuthenticatedAdmin(req) {
  const cookies = parseCookies(req);
  const sessionToken = cookies[COOKIE_NAME];
  const parsed = verifySignedPayload(sessionToken);
  if (!parsed || !isAuthorizedAdminEmail(parsed.email)) return null;
  return { email: parsed.email, role: parsed.role || "admin" };
}

export function hasAutomationHeader(req) {
  const supplied = req?.headers?.["x-approval-secret"] || "";
  const secret = getSigningSecret();
  if (!supplied || !secret) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Stateless HMAC magic link + 6-digit code (works seamlessly across Cloud Run instances)
export function createMagicChallenge(email) {
  const normalized = String(email || "").trim().toLowerCase();
  const exp = Date.now() + MAGIC_TTL_MS;
  const code = String(crypto.randomInt(100000, 999999));
  const magicToken = signPayload({ kind: "magic", email: normalized, code, exp });
  const codeEnvelope = signPayload({ kind: "code", email: normalized, code, exp });
  return { email: normalized, code, magicToken, codeEnvelope, exp };
}

export function verifyMagicToken(token) {
  const parsed = verifySignedPayload(token);
  if (!parsed || parsed.kind !== "magic" || !isAuthorizedAdminEmail(parsed.email)) return null;
  return { email: parsed.email };
}

export function verifyEmailCodeChallenge(email, submittedCode, codeEnvelope) {
  const parsed = verifySignedPayload(codeEnvelope);
  if (!parsed || parsed.kind !== "code") return null;
  if (parsed.email !== String(email || "").trim().toLowerCase()) return null;
  if (String(submittedCode || "").trim() !== String(parsed.code)) return null;
  return { email: parsed.email };
}

export async function sendAdminMagicEmail({ email, publicBaseUrl }) {
  if (!isAuthorizedAdminEmail(email)) {
    return { ok: false, error: "This email is not authorized for Mission Church admin login." };
  }
  const token = await fetchGmailTokenIfConfigured();
  if (!token) {
    return { ok: false, error: "Gmail sending is not configured on this server." };
  }
  const challenge = createMagicChallenge(email);
  const magicUrl = `${publicBaseUrl}/api/auth/magic?token=${encodeURIComponent(challenge.magicToken)}`;

  const subject = `[Mission Church Admin] Sign-In Code: ${challenge.code}`;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#faf7f2;border:1px solid #e5d8dc;border-radius:16px;overflow:hidden;">
    <div style="background:#7e151c;color:#fff;padding:18px 24px;">
      <div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#ecd363;font-weight:700;">Mission Church COOLJC · Admin Login</div>
      <h2 style="margin:6px 0 0;font-size:20px;">Your Admin Login Link &amp; Code</h2>
    </div>
    <div style="padding:24px;color:#1e1720;">
      <p style="margin:0 0 14px;">Click the button below to sign into the Mission Church Admin Studio (valid for 15 minutes):</p>
      <a href="${magicUrl}" style="display:inline-block;background:#7e151c;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px;margin-bottom:18px;">Sign In to Admin Studio ↗</a>
      <p style="margin:12px 0 6px;font-size:13px;color:#5d525f;">Or enter this 6-digit code on the <code>/login</code> page:</p>
      <div style="font-size:28px;font-weight:800;letter-spacing:6px;color:#7e151c;background:#fff;border:1px solid #e5d8dc;padding:10px 16px;border-radius:12px;display:inline-block;">${challenge.code}</div>
    </div>
  </div>`;

  const rawMime = [
    `To: ${challenge.email}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
  ].join("\r\n");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(rawMime).toString("base64url") }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `Failed to send login email (${res.status}): ${err.slice(0, 120)}` };
  }
  return { ok: true, codeEnvelope: challenge.codeEnvelope };
}
