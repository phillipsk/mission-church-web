import fs from "node:fs";
import path from "node:path";
import { resolveGeminiApiKey } from "./gemini-concierge.js";

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

export async function parseFlyerWithGemini(filePath) {
  const apiKey = resolveGeminiApiKey();
  const fileName = path.basename(filePath);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Flyer file not found: ${filePath}`);
  }

  const fallbackMeta = {
    title: fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
    dateDisplay: "Check Church Calendar",
    category: "Upcoming Events",
    location: "Mission Church · 130 Highland Ave, Somerville, MA",
    summary: `Scanned local church flyer (${fileName}). Verify exact time and location before publishing.`,
    source: "local-flyer-fallback",
  };

  if (!apiKey) return fallbackMeta;

  const base64Data = fs.readFileSync(filePath).toString("base64");
  const mimeType = getMimeType(filePath);
  const prompt = `Extract structured event information from this Mission Church flyer image.
Return ONLY valid JSON (no markdown fences) with keys:
{
  "title": "short event title",
  "dateDisplay": "human readable date & time",
  "category": "one of: Upcoming Events, Outreach & Pantry, Youth & Fellowship, Zoom Gatherings",
  "location": "address or Zoom details",
  "summary": "2-sentence warm invitation summarizing key details, speakers, scripture, or items"
}`;

  const models = [process.env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-2.0-flash"];
  for (const model of models) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                { inlineData: { mimeType, data: base64Data } },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 500,
            responseMimeType: "application/json",
          },
        }),
      });
      clearTimeout(timeout);

      if (!res.ok) continue;
      const json = await res.json();
      const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!raw) continue;
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      const parsed = JSON.parse(cleaned);
      return {
        title: parsed.title || fallbackMeta.title,
        dateDisplay: parsed.dateDisplay || fallbackMeta.dateDisplay,
        category: parsed.category || fallbackMeta.category,
        location: parsed.location || fallbackMeta.location,
        summary: parsed.summary || fallbackMeta.summary,
        source: `gemini-vision:${model}`,
      };
    } catch {
      // Try next model or fallback
    }
  }
  return fallbackMeta;
}

function loadLocalEnvVars() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return {};
  const map = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    map[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return map;
}

async function fetchGmailTokenIfConfigured() {
  if (process.env.GMAIL_ACCESS_TOKEN) {
    return process.env.GMAIL_ACCESS_TOKEN.trim();
  }
  const localEnv = loadLocalEnvVars();
  const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || localEnv.GMAIL_CLIENT_ID;
  const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || localEnv.GMAIL_CLIENT_SECRET;
  const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || localEnv.GMAIL_REFRESH_TOKEN;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    return "";
  }
  const body = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    refresh_token: GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return "";
  const data = await res.json();
  return data.access_token || "";
}

export async function runGmailSync({ targetInbox = "philipskevin386@gmail.com", senderFilter = "missionchurch1@gmail.com" } = {}) {
  const token = await fetchGmailTokenIfConfigured();
  if (!token) {
    return {
      mode: "oauth-not-configured",
      targetInbox,
      senderFilter,
      messagesFound: 0,
      note: "Set GMAIL_ACCESS_TOKEN or GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN to pull live emails from missionchurch1@gmail.com into philipskevin386@gmail.com. Local Downloads flyer scanning remains active.",
    };
  }

  const query = encodeURIComponent(`from:${senderFilter}`);
  const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    return {
      mode: "oauth-error",
      statusCode: listRes.status,
      targetInbox,
      senderFilter,
      messagesFound: 0,
      note: "Gmail API returned a non-200 status; verify OAuth scope gmail.readonly for philipskevin386@gmail.com.",
    };
  }
  const listData = await listRes.json();
  const messageRefs = listData.messages || [];
  const items = [];

  for (const ref of messageRefs.slice(0, 5)) {
    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=From`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!msgRes.ok) continue;
    const msg = await msgRes.json();
    const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    items.push({
      id: msg.id,
      subject: headers.subject || "(No subject)",
      date: headers.date || "",
      snippet: msg.snippet || "",
    });
  }

  return {
    mode: "live-gmail-api",
    targetInbox,
    senderFilter,
    messagesFound: items.length,
    items,
  };
}

export async function runBandSync(publicDir) {
  const manifestPath = path.join(publicDir, "assets", "photos", "curated_photos_manifest.json");
  let manifestPhotos = [];
  if (fs.existsSync(manifestPath)) {
    try {
      manifestPhotos = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      manifestPhotos = [];
    }
  }

  const albums = Array.from(new Set(manifestPhotos.map((p) => p.album_name).filter(Boolean)));
  const bandToken = process.env.BAND_ACCESS_TOKEN?.trim();

  if (bandToken) {
    try {
      const res = await fetch(`https://openapi.band.us/v2/band/posts?access_token=${encodeURIComponent(bandToken)}&band_key=${encodeURIComponent(process.env.BAND_KEY || "74073849")}`);
      if (res.ok) {
        const json = await res.json();
        return {
          mode: "live-band-openapi",
          bandId: "74073849",
          postsFetched: json?.result_data?.items?.length || 0,
          curatedAlbumsCount: albums.length,
          curatedPhotosCount: manifestPhotos.length,
        };
      }
    } catch {
      // Fallback to manifest summary
    }
  }

  return {
    mode: "curated-band-manifest",
    bandId: "74073849",
    bandUrl: "https://www.band.us/n/ada0bcJfJ1f9z",
    curatedAlbumsCount: albums.length,
    curatedPhotosCount: manifestPhotos.length,
    albums,
    note: "Using locally synced BAND App photo manifest (23 curated photos). Add BAND_ACCESS_TOKEN or run scheduled agent check to ingest new BAND posts automatically.",
  };
}

export async function scanLocalFlyers(publicDir) {
  const flyersDir = path.join(publicDir, "assets", "flyers");
  if (!fs.existsSync(flyersDir)) return [];
  const files = fs
    .readdirSync(flyersDir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && !f.includes("logo"));

  const results = [];
  for (const file of files) {
    const fullPath = path.join(flyersDir, file);
    const parsed = await parseFlyerWithGemini(fullPath);
    results.push({
      file,
      imageUrl: `/assets/flyers/${file}`,
      ...parsed,
    });
  }
  return results;
}
