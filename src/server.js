import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { askChurchConcierge, resolveGeminiApiKey } from "./services/gemini-concierge.js";
import { loadStore, saveStore } from "./services/firestore-store.js";
import {
  clearSessionCookieHeader,
  createSessionCookieHeader,
  getAuthenticatedAdmin,
  hasAutomationHeader,
  sendAdminMagicEmail,
  verifyEmailCodeChallenge,
  verifyMagicToken,
  verifyPasscodeLogin,
} from "./services/admin-auth.js";
import {
  ingestExternalBandPosts,
  parseFlyerWithGemini,
  registerGmailWatch,
  runBandSync,
  runGmailSync,
  scanLocalFlyers,
  sendApprovalEmail,
  verifyApprovalToken,
  watchAndPrepareDrafts,
} from "./services/sync-pipeline.js";
import {
  buildWpAdminAutoPublishScript,
  getGeneratedMediaFile,
  isWordPressConfigured,
  parseMonthlyCalendarOrEmail,
  prepareDualEventImages,
  publishDraftToWordPress,
  resolveTargetTypesForDraft,
} from "./services/wordpress-publisher.js";

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

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function sendRedirect(res, location, extraHeaders = {}) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end();
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

const SPA_ROUTES = new Set([
  "/",
  "/shorts",
  "/shepherds-kitchen",
  "/ministries",
  "/prayer-wall",
  "/visit",
  "/give",
]);

function serveStaticFile(req, res, urlPath) {
  let cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  if (cleanPath.length > 1 && cleanPath.endsWith("/")) {
    cleanPath = cleanPath.slice(0, -1);
  }
  if (SPA_ROUTES.has(cleanPath)) cleanPath = "/index.html";
  if (cleanPath === "/login") cleanPath = "/login.html";

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
    ...(ext.match(/^\.(png|jpe?g|webp|svg)$/) ? { "Access-Control-Allow-Origin": "https://missionchurchcooljc.com" } : {}),
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

function isAuthorizedAdmin(req) {
  return Boolean(getAuthenticatedAdmin(req) || hasAutomationHeader(req));
}

let pollInFlight = null;

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

      if ((pathname === "/admin" || pathname === "/wp-admin" || pathname === "/admin/") && method === "GET") {
        const admin = getAuthenticatedAdmin(req);
        return sendRedirect(res, admin ? "/?admin=1" : "/login");
      }

      if (pathname === "/api/auth/login" && method === "POST") {
        const body = await readJsonBody(req);
        const check = verifyPasscodeLogin(body.email, body.passcode);
        if (!check.ok) {
          return sendJson(res, 401, { error: check.error });
        }
        return sendJson(
          res,
          200,
          { ok: true, email: check.email },
          { "Set-Cookie": createSessionCookieHeader(check.email, req) }
        );
      }

      if (pathname === "/api/auth/send-code" && method === "POST") {
        const body = await readJsonBody(req);
        const resMagic = await sendAdminMagicEmail({ email: body.email, publicBaseUrl });
        if (!resMagic.ok) {
          return sendJson(res, 400, { error: resMagic.error });
        }
        return sendJson(res, 200, { ok: true, codeEnvelope: resMagic.codeEnvelope });
      }

      if (pathname === "/api/auth/verify-code" && method === "POST") {
        const body = await readJsonBody(req);
        const verified = verifyEmailCodeChallenge(body.email, body.code, body.codeEnvelope);
        if (!verified) {
          return sendJson(res, 401, { error: "Invalid or expired verification code." });
        }
        return sendJson(
          res,
          200,
          { ok: true, email: verified.email },
          { "Set-Cookie": createSessionCookieHeader(verified.email, req) }
        );
      }

      if (pathname === "/api/auth/magic" && method === "GET") {
        const token = url.searchParams.get("token") || "";
        const verified = verifyMagicToken(token);
        if (!verified) {
          return sendHtml(
            res,
            401,
            "Login Link Expired",
            "Login Link Invalid or Expired",
            "Please request a fresh login link on the /login page.",
            `${publicBaseUrl}/login`
          );
        }
        return sendRedirect(res, "/?admin=1", {
          "Set-Cookie": createSessionCookieHeader(verified.email, req),
        });
      }

      if (pathname === "/api/auth/logout" && method === "POST") {
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookieHeader(req) });
      }

      if (pathname === "/api/bootstrap" && method === "GET") {
        const store = await loadStore();
        const adminUser = getAuthenticatedAdmin(req);
        const isAdmin = Boolean(adminUser);

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
          isAdmin,
          adminEmail: adminUser?.email || null,
          pendingPosts: isAdmin ? store.pendingPosts || [] : [],
          ministrySubmissions: isAdmin ? store.ministrySubmissions || [] : [],
          visitPlans: isAdmin ? store.visitPlans || [] : [],
          processedSourceIds: isAdmin ? store.processedSourceIds || [] : [],
          persistenceBackend: store._persistence,
          curatedPhotos,
          geminiConfigured: Boolean(resolveGeminiApiKey()),
          wordpressConfigured: isWordPressConfigured(),
        });
      }

      if (pathname.startsWith("/api/media/generated/") && method === "GET") {
        const fileName = pathname.slice("/api/media/generated/".length);
        const filePath = getGeneratedMediaFile(fileName);
        if (!filePath) {
          return sendJson(res, 404, { error: "Generated image not found." });
        }
        const ext = path.extname(filePath).toLowerCase();
        const ct = MIME_TYPES[ext] || "image/png";
        res.writeHead(200, {
          "Content-Type": ct,
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "https://missionchurchcooljc.com",
        });
        fs.createReadStream(filePath).pipe(res);
        return;
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

      if ((pathname === "/api/admin/watch-poll" || pathname === "/api/webhooks/gmail-push") && method === "POST") {
        if (!pollInFlight) {
          pollInFlight = (async () => {
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
            return { now, persist, newDrafts, emailResults, pendingPosts: store.pendingPosts };
          })().finally(() => {
            pollInFlight = null;
          });
        }
        const { now, persist, newDrafts, emailResults, pendingPosts } = await pollInFlight;
        const showDetails = isAuthorizedAdmin(req);
        return sendJson(res, 200, {
          ok: true,
          checkedAt: now,
          persistenceBackend: persist.backend,
          newDraftsCount: newDrafts.length,
          ...(showDetails ? { newDrafts, emailResults, pendingPosts } : {}),
        });
      }

      // Signed 1-click email links (GET) work without cookie; POST actions require Admin auth
      if (pathname === "/api/admin/approve-post") {
        const store = await loadStore();
        if (method === "GET") {
          const id = url.searchParams.get("id") || "";
          const token = url.searchParams.get("token") || "";
          if (!verifyApprovalToken(id, "approve", token)) {
            return sendHtml(res, 403, "Invalid Approval Link", "Approval Link Invalid or Expired", "Please sign in at /login to approve this post.", `${publicBaseUrl}/login`);
          }
          const published = await publishDraftById(store, id);
          if (!published) {
            return sendHtml(res, 200, "Already Processed", "Already Published or Removed", "This draft has already been processed. Check the live community feed!", publicBaseUrl);
          }
          await saveStore(store);
          return sendHtml(res, 200, "Published!", "Post Approved & Published!", `"${published.title}" is now live in the Mission Church community feed.`, publicBaseUrl);
        }
        if (method === "POST") {
          if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { error: "Admin login required (/login)." });
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
            return sendHtml(res, 403, "Invalid Link", "Invalid Rejection Link", "Please sign in at /login to manage pending drafts.", `${publicBaseUrl}/login`);
          }
          store.pendingPosts = (store.pendingPosts || []).filter((p) => p.id !== id);
          await saveStore(store);
          return sendHtml(res, 200, "Skipped", "Draft Skipped", "The draft was removed and will not appear on the public website.", publicBaseUrl);
        }
        if (method === "POST") {
          if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { error: "Admin login required (/login)." });
          const body = await readJsonBody(req);
          store.pendingPosts = (store.pendingPosts || []).filter((p) => p.id !== body.id);
          await saveStore(store);
          return sendJson(res, 200, { ok: true, pendingPosts: store.pendingPosts });
        }
      }

      if (pathname === "/api/admin/wp-bridge.js" && method === "GET") {
        const id = url.searchParams.get("id") || "";
        const img = url.searchParams.get("img") === "ai" ? "ai" : "original";
        const mode = url.searchParams.get("mode") === "publish" ? "publish" : "draft";
        const token = url.searchParams.get("token") || "";
        const authOk =
          isAuthorizedAdmin(req) ||
          verifyApprovalToken(id, `wp:${img}:${mode}`, token) ||
          verifyApprovalToken(id, "wp:bridge", token);
        if (!authOk) {
          res.writeHead(403, {
            "Content-Type": "application/javascript; charset=utf-8",
            "Access-Control-Allow-Origin": "https://missionchurchcooljc.com",
          });
          res.end(`throw new Error("Invalid bridge token");`);
          return;
        }
        const store = await loadStore();
        const draft = (store.pendingPosts || []).find((p) => p.id === id);
        if (!draft) {
          res.writeHead(404, {
            "Content-Type": "application/javascript; charset=utf-8",
            "Access-Control-Allow-Origin": "https://missionchurchcooljc.com",
          });
          res.end(`throw new Error("Draft not found");`);
          return;
        }
        const js = buildWpAdminAutoPublishScript({
          draft,
          imageChoice: img,
          wpStatus: mode,
          publicBaseUrl,
        });
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "https://missionchurchcooljc.com",
        });
        res.end(js);
        return;
      }

      if (pathname === "/api/admin/wp-approved-queue" && method === "GET") {
        const store = await loadStore();
        const queued = (store.pendingPosts || [])
          .filter((p) => p.status === "approved_for_wp")
          .map((d) => {
            const img = d.preferredImage || "original";
            const mode = d.preferredWpMode || "draft";
            const tok = verifyApprovalToken(d.id, "wp:bridge", d.bridgeToken || "")
              ? d.bridgeToken
              : null;
            return {
              id: d.id,
              title: d.title,
              dateDisplay: d.dateDisplay,
              location: d.location,
              summary: d.summary,
              preferredImage: img,
              preferredWpMode: mode,
              approvedAt: d.approvedForWpAt || d.createdAt,
              ...(tok ? {} : {}),
            };
          });
        return sendJson(
          res,
          200,
          { ok: true, count: queued.length, queued },
          { "Access-Control-Allow-Origin": "https://missionchurchcooljc.com" }
        );
      }

      if (pathname === "/api/admin/wp-publish") {
        const store = await loadStore();
        if (method === "GET") {
          const id = url.searchParams.get("id") || "";
          const img = url.searchParams.get("img") === "ai" ? "ai" : "original";
          const mode = url.searchParams.get("mode") === "draft" ? "draft" : "publish";
          const token = url.searchParams.get("token") || "";
          if (!verifyApprovalToken(id, `wp:${img}:${mode}`, token)) {
            return sendHtml(res, 403, "Invalid WordPress Link", "WordPress Approval Link Invalid", "Please sign in at /login to publish to missionchurchcooljc.com.", `${publicBaseUrl}/login`);
          }
          const draft = (store.pendingPosts || []).find((p) => p.id === id);
          if (!draft) {
            return sendHtml(res, 404, "Draft Not Found", "Draft Not Found", "This draft has already been published or removed.", publicBaseUrl);
          }

          if (!isWordPressConfigured()) {
            draft.status = "approved_for_wp";
            draft.preferredImage = img;
            draft.preferredWpMode = mode;
            draft.approvedForWpAt = new Date().toISOString();
            await saveStore(store);
            const bridgeUrl = `${publicBaseUrl}/api/admin/wp-bridge.js?id=${encodeURIComponent(draft.id)}&img=${encodeURIComponent(img)}&mode=${encodeURIComponent(mode)}&token=${encodeURIComponent(token)}`;
            return sendHtml(
              res,
              200,
              "Queued for WordPress Sync",
              "Approved & Queued for WordPress!",
              `"${draft.title}" (${img === "ai" ? "AI/Blended" : "Original"} image) is approved for '${mode}'. Because Sharefaith hosting disables remote Application Passwords, open missionchurchcooljc.com/wp-admin/ (logged in as brother kevin) or tell Antigravity to sync your approved WordPress queue using bridge: ${bridgeUrl}`,
              "https://missionchurchcooljc.com/wp-admin/edit.php"
            );
          }

          const wpResult = await publishDraftToWordPress({
            draft,
            imageChoice: img,
            wpStatus: mode,
            targetTypes: resolveTargetTypesForDraft(draft),
            publicDir: PUBLIC_DIR,
          });
          draft.wpResult = wpResult;
          draft.status = mode === "publish" ? "published_wp" : "staged_wp_draft";
          await saveStore(store);
          const editUrl = wpResult.post?.editUrl || "https://missionchurchcooljc.com/wp-admin/edit.php";
          return sendHtml(
            res,
            200,
            mode === "publish" ? "Published to WordPress!" : "Staged WP Draft!",
            mode === "publish" ? "Published to WordPress!" : "WordPress Draft Created!",
            `"${draft.title}" (${img === "ai" ? "AI/Blended" : "Original"} image) was pushed as '${mode}' on missionchurchcooljc.com (Post #${wpResult.post?.id}${wpResult.event?.id ? `, MEC Event #${wpResult.event.id}` : ""}). Review in wp-admin: ${editUrl}`,
            editUrl
          );
        }
        if (method === "POST") {
          if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { error: "Admin login required (/login)." });
          const body = await readJsonBody(req);
          const draft = body.draft || (store.pendingPosts || []).find((p) => p.id === body.id);
          if (!draft) return sendJson(res, 404, { error: "Draft not found." });
          const wpResult = await publishDraftToWordPress({
            draft,
            imageChoice: body.img === "ai" ? "ai" : "original",
            wpStatus: body.mode === "publish" ? "publish" : "draft",
            targetTypes: Array.isArray(body.targetTypes)
              ? body.targetTypes
              : resolveTargetTypesForDraft(draft),
            publicDir: PUBLIC_DIR,
          });
          draft.wpResult = wpResult;
          await saveStore(store);
          return sendJson(res, 200, { ok: true, wpResult, draft });
        }
      }

      // All remaining /api/admin/* endpoints require admin session or automation secret
      if (pathname.startsWith("/api/admin/")) {
        if (!isAuthorizedAdmin(req)) {
          return sendJson(res, 401, { error: "Admin sign-in required. Please log in at /login." });
        }
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

      if (pathname === "/api/admin/ingest-band-posts" && method === "POST") {
        const body = await readJsonBody(req);
        const posts = Array.isArray(body.posts) ? body.posts : body.post ? [body.post] : [];
        if (!posts.length) {
          return sendJson(res, 400, { error: "Provide a 'posts' array containing post text, overall description, and optional images/schedule." });
        }
        const store = await loadStore();
        const { newDrafts, emailResults } = await ingestExternalBandPosts({
          posts,
          store,
          publicBaseUrl,
          sendEmails: body.sendEmails !== false,
        });
        const persist = await saveStore(store);
        return sendJson(res, 200, {
          ok: true,
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

      if (pathname === "/api/admin/wp-parse-calendar" && method === "POST") {
        const body = await readJsonBody(req, 6_000_000);
        const store = await loadStore();
        let imageBase64 = body.imageBase64 || "";
        let imageMimeType = body.imageMimeType || "image/jpeg";
        let origImgUrl = body.imageUrl || "/assets/photos/00_cover_sanctuary_worship_1920x1080.jpg";

        if (body.filename && !imageBase64) {
          const safeName = path.basename(String(body.filename));
          const fullPath = path.join(PUBLIC_DIR, "assets", "flyers", safeName);
          if (fs.existsSync(fullPath)) {
            imageBase64 = fs.readFileSync(fullPath).toString("base64");
            imageMimeType = safeName.endsWith(".png") ? "image/png" : "image/jpeg";
            origImgUrl = `/assets/flyers/${safeName}`;
          }
        }

        const parsed = await parseMonthlyCalendarOrEmail({
          subject: body.subject || "Monthly Church Calendar",
          bodyText: body.bodyText || "",
          imageBase64,
          imageMimeType,
        });

        const stagedDrafts = [];
        for (let idx = 0; idx < (parsed.netNewEvents || []).length; idx++) {
          const ev = parsed.netNewEvents[idx];
          const draftId = `draft-wp-${Date.now().toString(36)}-${idx + 1}`;
          const dual = await prepareDualEventImages({
            draftId,
            title: ev.title,
            dateDisplay: ev.dateDisplay || `${ev.startDate} ${ev.startTime || ""}`,
            location: ev.location || "130 Highland Ave, Somerville, MA",
            badge: ev.badge || "NET-NEW EVENT",
            originalImageUrl: origImgUrl,
            originalImageBase64: imageBase64,
            originalImageMimeType: imageMimeType,
            publicBaseUrl,
          });
          const draft = {
            id: draftId,
            sourceId: `wp-manual:${draftId}`,
            sourceType: "calendar-parser",
            sourceLabel: parsed.isMonthlyCalendar
              ? `Monthly Calendar · ${parsed.monthLabel || "Net-New Event"}`
              : "Church Email / Flyer Parser",
            contentType: ev.contentType || "special_event",
            targetTypes: resolveTargetTypesForDraft(ev),
            badge: ev.badge || "CHURCH EVENT",
            category: ev.category || "Upcoming Events",
            title: ev.title,
            dateDisplay: ev.dateDisplay || `${ev.startDate || ""} ${ev.startTime || ""}`.trim(),
            location: ev.location || "130 Highland Ave, Somerville, MA",
            speaker: ev.speaker || "",
            zoomUrl: ev.zoomUrl || "",
            startDate: ev.startDate || "",
            startTime: ev.startTime || "",
            endDate: ev.endDate || "",
            endTime: ev.endTime || "",
            summary: ev.publicSummary || ev.title,
            imageUrl: dual.originalImageUrl,
            aiImageUrl: dual.aiImageUrl,
            aiGenerator: dual.aiGenerator,
            ctaLabel: "Learn More",
            status: "pending_approval",
            createdAt: new Date().toISOString(),
          };
          if (body.sendEmails) {
            const emailRes = await sendApprovalEmail({ draft, publicBaseUrl });
            draft.emailStatus = emailRes.sent ? "emailed" : emailRes.reason;
          }
          store.pendingPosts.unshift(draft);
          stagedDrafts.push(draft);
        }

        await saveStore(store);
        return sendJson(res, 200, {
          ok: true,
          isMonthlyCalendar: parsed.isMonthlyCalendar,
          monthLabel: parsed.monthLabel,
          recurringSummary: parsed.recurringSummary,
          stagedDrafts,
        });
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
