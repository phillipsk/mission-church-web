import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { askChurchConcierge, resolveGeminiApiKey } from "./services/gemini-concierge.js";
import { parseFlyerWithGemini, runBandSync, runGmailSync, scanLocalFlyers } from "./services/sync-pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const DATA_FILE = path.join(__dirname, "data", "church-data.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
};

function readStore() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeStore(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function serveStaticFile(req, res, urlPath) {
  let cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  if (cleanPath === "/") cleanPath = "/index.html";

  const resolvedPath = path.resolve(PUBLIC_DIR, "." + cleanPath);
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let targetPath = resolvedPath;
  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
    targetPath = path.join(PUBLIC_DIR, "index.html");
  }

  const stat = fs.statSync(targetPath);
  const ext = path.extname(targetPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  // Range support for video streaming
  const range = req.headers.range;
  if (range && (ext === ".mp4" || ext === ".webm")) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": contentType,
      });
      fs.createReadStream(targetPath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  fs.createReadStream(targetPath).pipe(res);
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    try {
      if (pathname === "/health" && method === "GET") {
        return sendJson(res, 200, { ok: true, service: "mission-church-web" });
      }

      if (pathname === "/api/bootstrap" && method === "GET") {
        const store = readStore();
        const photosManifestPath = path.join(PUBLIC_DIR, "assets", "photos", "curated_photos_manifest.json");
        let curatedPhotos = [];
        if (fs.existsSync(photosManifestPath)) {
          curatedPhotos = JSON.parse(fs.readFileSync(photosManifestPath, "utf8")).map((p) => ({
            role: p.role,
            filename: p.filename,
            albumName: p.album_name,
            bandUrl: p.band_url,
            localUrl: `/assets/photos/${p.filename}`,
            width: p.width,
            height: p.height,
          }));
        }
        return sendJson(res, 200, {
          ...store,
          curatedPhotos,
          geminiConfigured: Boolean(resolveGeminiApiKey()),
        });
      }

      if (pathname === "/api/chat" && method === "POST") {
        const body = await readJsonBody(req);
        const message = String(body.message || "").trim();
        if (!message || message.length > 1000) {
          return sendJson(res, 400, { error: "Please enter a question (1–1000 characters)." });
        }
        const store = readStore();
        const result = await askChurchConcierge({
          message,
          history: Array.isArray(body.history) ? body.history : [],
          churchData: store,
        });
        return sendJson(res, 200, result);
      }

      if (pathname === "/api/ministries/interact" && method === "POST") {
        const body = await readJsonBody(req);
        const ministry = String(body.ministry || "").trim();
        const mode = String(body.mode || "").trim();
        const name = String(body.name || "").trim();
        const contact = String(body.contact || "").trim();
        const details = String(body.details || "").trim();
        const category = String(body.category || "").trim();

        if (!ministry || !name || name.length < 2) {
          return sendJson(res, 400, { error: "Please provide your name and select a ministry action." });
        }

        const store = readStore();
        const entry = {
          id: `sub-${crypto.randomUUID().slice(0, 8)}`,
          ministry,
          mode,
          name: name.slice(0, 80),
          contact: contact.slice(0, 120),
          category: category.slice(0, 80),
          details: details.slice(0, 800),
          createdAt: new Date().toISOString(),
        };

        if (ministry === "prayer-wall") {
          const prayerItem = {
            id: `prayer-${crypto.randomUUID().slice(0, 8)}`,
            name: entry.name,
            category: entry.category || "Prayer Request",
            request: entry.details || entry.mode,
            amens: 1,
            createdAt: entry.createdAt,
          };
          store.prayerWall.unshift(prayerItem);
          writeStore(store);
          return sendJson(res, 201, {
            ok: true,
            message: "Your prayer request has been added to the Mission Church Prayer Wall.",
            prayerItem,
          });
        }

        store.ministrySubmissions.unshift(entry);
        writeStore(store);
        return sendJson(res, 201, {
          ok: true,
          message: `Thank you, ${entry.name}! Your ${ministry.replace("-", " ")} submission has been recorded for the Mission Church care team.`,
          submission: entry,
        });
      }

      const amenMatch = pathname.match(/^\/api\/prayer\/([^/]+)\/amen$/);
      if (amenMatch && method === "POST") {
        const prayerId = amenMatch[1];
        const store = readStore();
        const target = store.prayerWall.find((p) => p.id === prayerId);
        if (!target) {
          return sendJson(res, 404, { error: "Prayer item not found." });
        }
        target.amens = (target.amens || 0) + 1;
        writeStore(store);
        return sendJson(res, 200, { ok: true, id: target.id, amens: target.amens });
      }

      if (pathname === "/api/visit" && method === "POST") {
        const body = await readJsonBody(req);
        const name = String(body.name || "").trim();
        const partySize = Math.max(1, Math.min(25, Number(body.partySize || 1)));
        const visitDate = String(body.visitDate || "").trim();
        const note = String(body.note || "").trim();
        const emailOrPhone = String(body.contact || "").trim();

        if (name.length < 2) {
          return sendJson(res, 400, { error: "Please enter at least 2 characters for your name." });
        }
        const store = readStore();
        const plan = {
          id: `visit-${crypto.randomUUID().slice(0, 8)}`,
          name: name.slice(0, 80),
          partySize,
          visitDate: visitDate.slice(0, 40),
          contact: emailOrPhone.slice(0, 120),
          note: note.slice(0, 500),
          createdAt: new Date().toISOString(),
        };
        store.visitPlans.unshift(plan);
        writeStore(store);
        return sendJson(res, 201, {
          ok: true,
          message: `We look forward to welcoming ${plan.name} (${plan.partySize} ${plan.partySize === 1 ? "guest" : "guests"})! Our ushers at 130 Highland Ave are ready to greet you.`,
          plan,
        });
      }

      if (pathname === "/api/admin/sync" && method === "POST") {
        const store = readStore();
        const [gmailResult, bandResult] = await Promise.all([
          runGmailSync(store.syncState.gmail),
          runBandSync(PUBLIC_DIR),
        ]);
        const now = new Date().toISOString();
        store.syncState.gmail.lastRunAt = now;
        store.syncState.gmail.status = gmailResult.note || `Synced ${gmailResult.messagesFound} emails`;
        store.syncState.bandApp.lastRunAt = now;
        store.syncState.bandApp.status = `${bandResult.curatedPhotosCount} curated photos across ${bandResult.curatedAlbumsCount} albums`;
        writeStore(store);

        return sendJson(res, 200, {
          ok: true,
          syncedAt: now,
          gmail: gmailResult,
          bandApp: bandResult,
          syncState: store.syncState,
        });
      }

      if (pathname === "/api/admin/parse-flyer" && method === "POST") {
        const body = await readJsonBody(req);
        const store = readStore();
        if (body.filename) {
          const safeName = path.basename(String(body.filename));
          const fullPath = path.join(PUBLIC_DIR, "assets", "flyers", safeName);
          const parsed = await parseFlyerWithGemini(fullPath);
          return sendJson(res, 200, {
            ok: true,
            scanned: [{ file: safeName, imageUrl: `/assets/flyers/${safeName}`, ...parsed }],
          });
        }
        const scanned = await scanLocalFlyers(PUBLIC_DIR);
        store.syncState.gmail.scannedFlyersCount = scanned.length;
        store.syncState.gmail.lastRunAt = new Date().toISOString();
        writeStore(store);
        return sendJson(res, 200, { ok: true, scanned });
      }

      if (method === "GET") {
        return serveStaticFile(req, res, pathname);
      }

      return sendJson(res, 404, { error: "Endpoint not found." });
    } catch (err) {
      return sendJson(res, 500, { error: err?.message || "Internal server error" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8095);
  const server = createAppServer();
  server.listen(port, () => {
    console.log(`Mission Church Web + AI Concierge listening on http://localhost:${port}`);
  });
}
