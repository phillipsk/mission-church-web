import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.resolve(__dirname, "..", "data", "church-data.json");

const PROJECT_ID = process.env.GCP_PROJECT_ID || "gen-lang-client-0150678391";
const DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/app_state/mission_church`;

let cachedToken = { token: "", expiresAt: 0 };
let writeQueue = Promise.resolve();
const localClaimedIds = new Set();

/**
 * Atomically claims a sourceId in Firestore (`processed_sources/{docId}`) before
 * running Gemini drafting or sending approval emails. Returns false if already claimed.
 */
export async function claimSourceId(sourceId) {
  const key = String(sourceId || "").trim();
  if (!key) return false;
  if (localClaimedIds.has(key)) return false;
  localClaimedIds.add(key);

  const token = await getAccessToken();
  if (!token) return true;

  const docId = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/processed_sources?documentId=${encodeURIComponent(docId)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          sourceId: { stringValue: key },
          claimedAt: { stringValue: new Date().toISOString() },
        },
      }),
    });
    if (res.status === 409) {
      return false;
    }
    return res.ok;
  } catch {
    return true;
  }
}

function toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFsValue(item)) } };
  }
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFsValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFsValue(node) {
  if (!node || typeof node !== "object") return null;
  if ("nullValue" in node) return null;
  if ("booleanValue" in node) return Boolean(node.booleanValue);
  if ("integerValue" in node) return Number(node.integerValue);
  if ("doubleValue" in node) return Number(node.doubleValue);
  if ("stringValue" in node) return node.stringValue;
  if ("timestampValue" in node) return node.timestampValue;
  if ("arrayValue" in node) {
    return (node.arrayValue?.values || []).map((item) => fromFsValue(item));
  }
  if ("mapValue" in node) {
    const out = {};
    for (const [k, v] of Object.entries(node.mapValue?.fields || {})) {
      out[k] = fromFsValue(v);
    }
    return out;
  }
  return null;
}

async function getAccessToken() {
  if (cachedToken.token && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  // 1. Cloud Run / GCE Metadata Server
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      if (json.access_token) {
        cachedToken = {
          token: json.access_token,
          expiresAt: Date.now() + Number(json.expires_in || 3000) * 1000,
        };
        return cachedToken.token;
      }
    }
  } catch {
    // Not on GCE/Cloud Run; try local gcloud fallback
  }

  // 2. Local gcloud fallback (optional in local dev)
  if (process.env.DISABLE_GCLOUD_FIRESTORE_TOKEN === "1") return "";
  try {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"], { timeout: 4000 });
    const token = stdout.trim();
    if (token) {
      cachedToken = { token, expiresAt: Date.now() + 25 * 60_000 };
      return token;
    }
  } catch {
    // Offline or gcloud unavailable
  }
  return "";
}

export function readLocalSeed() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!Array.isArray(data.pendingPosts)) data.pendingPosts = [];
  if (!Array.isArray(data.processedSourceIds)) data.processedSourceIds = [];
  return data;
}

export async function loadStore() {
  const local = readLocalSeed();
  const token = await getAccessToken();
  if (!token) {
    return { ...local, _persistence: "local-json" };
  }

  try {
    const res = await fetch(DOC_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      await saveStore(local);
      return { ...local, _persistence: "firestore-seeded" };
    }
    if (!res.ok) {
      return { ...local, _persistence: "local-json-fallback" };
    }
    const doc = await res.json();
    const parsed = fromFsValue({ mapValue: { fields: doc.fields || {} } });
    if (!parsed || !parsed.church) {
      return { ...local, _persistence: "local-json-fallback" };
    }
    if (!Array.isArray(parsed.pendingPosts)) parsed.pendingPosts = [];
    if (!Array.isArray(parsed.processedSourceIds)) parsed.processedSourceIds = [];
    return { ...parsed, _persistence: "cloud-firestore" };
  } catch {
    return { ...local, _persistence: "local-json-fallback" };
  }
}

export async function saveStore(data) {
  const clean = { ...data };
  delete clean._persistence;
  if (!Array.isArray(clean.pendingPosts)) clean.pendingPosts = [];
  if (!Array.isArray(clean.processedSourceIds)) clean.processedSourceIds = [];
  clean.updatedAt = new Date().toISOString();

  // Keep local JSON cache synchronized when writable
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(clean, null, 2) + "\n", "utf8");
  } catch {
    // Ignore read-only filesystem edge cases
  }

  const writeOp = async () => {
    const token = await getAccessToken();
    if (!token) return { ok: true, backend: "local-json" };
    const fields = toFsValue(clean).mapValue.fields;
    const res = await fetch(DOC_URL, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Firestore PATCH failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return { ok: true, backend: "cloud-firestore" };
  };

  writeQueue = writeQueue.then(writeOp, writeOp);
  return writeQueue;
}
