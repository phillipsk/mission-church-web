import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { askChurchConcierge, resolveGeminiApiKey } from "./services/gemini-concierge.js";
import { loadStore, saveStore } from "./services/firestore-store.js";
import {
  parseFlyerWithGemini,
  registerGmailWatch,
  runBandSync,
  runGmailSync,
  scanLocalFlyers,
  sendApprovalEmail,
  verifyApprovalToken,
  watchAndPrepareDrafts,
} from "./services/sync-pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, statusCode, title, heading, message, publicBaseUrl) {
  const safe = (v) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(title)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#faf7f2;color:#1e1720;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;">
  <div style="max-width:520px;background:#fff;border:1px solid #e5d8dc;border-radius:18px;padding:30px;text-align:center;box-shadow:0 18px 45px rgba(24,14,24,0.1);">
    <div style="color:#7e151c;font-weight:800;letter-spacing:1.2px;font-size:12px;text-transform:uppercase;">Mission Church COOLJC</div>
    <h1 style="margin:10px 0 12px;font-size:24px;">${safe(heading)}</h1>
    <p style="color:#5d525f;line-height:1.55;margin:0 0 22px;">${safe(message)}</p>
    <a href="${safe(publicBaseUrl)}" style="display:inline-block;background:#7e151c;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px;">View Live Website ↗</a>
  </div>
</body>
</html>`);
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || "localhost:8095";
  return `${proto}://${host}`;
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

async function publishDraftById(store, draftId, overrides = {}) {
  const idx = (store.pendingPosts || []).findIndex((p) => p.id === draftId);
  if (idx === -1) return null;
  const draft = store.pendingPosts[idx];
  store.pendingPosts.splice(idx, 1);

  const feedItem = {
    id: draft.id.replace(/^draft-/, "live-"),
    category: overrides.category || draft.category || "Upcoming Events",
    badge: draft.badge || "PUBLISHED",
    title: overrides.title || draft.title,
    dateIso: new Date().toISOString(),
    endIso: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    dateDisplay: overrides.dateDisplay || draft.dateDisplay,
    location: overrides.location || draft.location,
    summary: overrides.summary || draft.summary,
    imageUrl: draft.imageUrl || "/assets/photos/00_cover_sanctuary_worship_1920x1080.jpg",
    sourceLabel: draft.sourceLabel || "Approved Church Update",
    ctaLabel: draft.ctaLabel || "Learn More",
    ...(draft.externalUrl ? { externalUrl: draft.externalUrl } : { ctaAction: draft.ctaAction || "scroll-visit" }),
  };

  store.feed.unshift(feedItem);
  return feedItem;
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const publicBaseUrl = getPublicBaseUrl(req);

    try {
      if (pathname === "/health" && method === "GET") {
        return sendJson(res, 200, { ok: true, service: "mission-church-web" });
      }

      if (pathname === "/api/bootstrap" && method === "GET") {
        const store = await loadStore();
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
          persistenceBackend: store._persistence,
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
        const store = await loadStore();
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

        const store = await loadStore();
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
          await saveStore(store);
          return sendJson(res, 201, {
            ok: true,
            message: "Your prayer request has been added to the Mission Church Prayer Wall.",
            prayerItem,
          });
        }

        store.ministrySubmissions.unshift(entry);
        await saveStore(store);
        return sendJson(res, 201, {
          ok: true,
          message: `Thank you, ${entry.name}! Your ${ministry.replace("-", " ")} submission has been recorded for the Mission Church care team.`,
          submission: entry,
        });
      }

      const amenMatch = pathname.match(/^\/api\/prayer\/([^/]+)\/amen$/);
      if (amenMatch && method === "POST") {
        const prayerId = amenMatch[1];
        const store = await loadStore();
        const target = store.prayerWall.find((p) => p.id === prayerId);
        if (!target) {
          return sendJson(res, 404, { error: "Prayer item not found." });
        }
        target.amens = (target.amens || 0) + 1;
        await saveStore(store);
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
        const store = await loadStore();
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
        await saveStore(store);
        return sendJson(res, 201, {
          ok: true,
          message: `We look forward to welcoming ${plan.name} (${plan.partySize} ${plan.partySize === 1 ? "guest" : "guests"})! Our ushers at 130 Highland Ave are ready to greet you.`,
          plan,
        });
      }

      if (pathname === "/api/admin/sync" && method === "POST") {
        const store = await loadStore();
        const [gmailResult, bandResult] = await Promise.all([
          runGmailSync(store.syncState.gmail),
          runBandSync(PUBLIC_DIR),
        ]);
        const now = new Date().toISOString();
        store.syncState.gmail.lastRunAt = now;
        store.syncState.gmail.status = gmailResult.note || `Synced ${gmailResult.messagesFound} emails`;
        store.syncState.bandApp.lastRunAt = now;
        store.syncState.bandApp.status = `${bandResult.curatedPhotosCount} curated photos across ${bandResult.curatedAlbumsCount} albums`;
        const persist = await saveStore(store);

        return sendJson(res, 200, {
          ok: true,
          syncedAt: now,
          persistenceBackend: persist.backend,
          gmail: gmailResult,
          bandApp: { ...bandResult, manifestPhotos: undefined, items: undefined },
          syncState: store.syncState,
          pendingPosts: store.pendingPosts,
        });
      }

      if ((pathname === "/api/admin/watch-poll" || pathname === "/api/webhooks/gmail-push") && method === "POST") {
        const store = await loadStore();
        const { newDrafts, emailResults } = await watchAndPrepareDrafts({
          store,
          publicDir: PUBLIC_DIR,
          publicBaseUrl,
          sendEmails: true,
        });
        const now = new Date().toISOString();
        store.syncState.gmail.lastRunAt = now;
        if (newDrafts.length > 0) {
          store.syncState.gmail.status = `${store.pendingPosts.length} draft(s) awaiting approval`;
        }
        const persist = await saveStore(store);
        return sendJson(res, 200, {
          ok: true,
          checkedAt: now,
          persistenceBackend: persist.backend,
          newDraftsCount: newDrafts.length,
          newDrafts,
          emailResults,
          pendingPosts: store.pendingPosts,
        });
      }

      if (pathname === "/api/admin/register-watch" && method === "POST") {
        const result = await registerGmailWatch();
        const store = await loadStore();
        store.syncState.gmail.watch = result;
        await saveStore(store);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (pathname === "/api/admin/resend-approval" && method === "POST") {
        const body = await readJsonBody(req);
        const store = await loadStore();
        const draft = (store.pendingPosts || []).find((p) => p.id === body.id);
        if (!draft) return sendJson(res, 404, { error: "Draft post not found." });
        const emailRes = await sendApprovalEmail({ draft, publicBaseUrl });
        draft.emailStatus = emailRes.sent ? "emailed" : emailRes.reason;
        await saveStore(store);
        return sendJson(res, 200, { ok: emailRes.sent, draftId: draft.id, ...emailRes });
      }

      if (pathname === "/api/admin/approve-post") {
        const store = await loadStore();
        if (method === "GET") {
          const id = url.searchParams.get("id") || "";
          const token = url.searchParams.get("token") || "";
          if (!verifyApprovalToken(id, "approve", token)) {
            return sendHtml(res, 403, "Invalid Approval Link", "Approval Link Invalid or Expired", "Please approve this post from the Admin & AI Sync drawer on the website.", publicBaseUrl);
          }
          const published = await publishDraftById(store, id);
          if (!published) {
            return sendHtml(res, 200, "Already Processed", "Already Published or Removed", "This draft has already been processed. Check the live community feed!", publicBaseUrl);
          }
          await saveStore(store);
          return sendHtml(res, 200, "Published!", "Post Approved & Published!", `"${published.title}" is now live in the Mission Church community feed.`, publicBaseUrl);
        }
        if (method === "POST") {
          const body = await readJsonBody(req);
          const published = await publishDraftById(store, body.id, body);
          if (!published) return sendJson(res, 404, { error: "Pending post not found." });
          await saveStore(store);
          return sendJson(res, 200, { ok: true, published, feed: store.feed, pendingPosts: store.pendingPosts });
        }
      }

      if (pathname === "/api/admin/reject-post") {
        const store = await loadStore();
        if (method === "GET") {
          const id = url.searchParams.get("id") || "";
          const token = url.searchParams.get("token") || "";
          if (!verifyApprovalToken(id, "reject", token)) {
            return sendHtml(res, 403, "Invalid Link", "Invalid Rejection Link", "Please manage pending drafts from the Admin & AI Sync drawer.", publicBaseUrl);
          }
          store.pendingPosts = (store.pendingPosts || []).filter((p) => p.id !== id);
          await saveStore(store);
          return sendHtml(res, 200, "Skipped", "Draft Skipped", "The draft was removed and will not appear on the public website.", publicBaseUrl);
        }
        if (method === "POST") {
          const body = await readJsonBody(req);
          store.pendingPosts = (store.pendingPosts || []).filter((p) => p.id !== body.id);
          await saveStore(store);
          return sendJson(res, 200, { ok: true, pendingPosts: store.pendingPosts });
        }
      }

      if (pathname === "/api/admin/parse-flyer" && method === "POST") {
        const body = await readJsonBody(req);
        const store = await loadStore();
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
        await saveStore(store);
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
