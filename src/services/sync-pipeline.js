import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveGeminiApiKey } from "./gemini-concierge.js";

const DEFAULT_PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://mission-church-web-5jdy3d7zua-uc.a.run.app";
const DEFAULT_GMAIL_QUERY =
  'from:missionchurch1@gmail.com OR from:missionchurch@missionchurchofchrist.ccsend.com OR from:band.us OR "missionchurch1@gmail.com"';

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function getApprovalSecret() {
  return (
    process.env.APPROVAL_HMAC_SECRET ||
    loadLocalEnvVars().APPROVAL_HMAC_SECRET ||
    "mission-church-local-dev-approval-secret"
  );
}

export function signApprovalToken(postId, action) {
  return crypto
    .createHmac("sha256", getApprovalSecret())
    .update(`${postId}:${action}`)
    .digest("hex");
}

export function verifyApprovalToken(postId, action, token) {
  if (!postId || !action || !token) return false;
  const expected = signApprovalToken(postId, action);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
  return extractStructuredPostWithGemini({
    apiKey,
    textContext: `Church flyer filename: ${fileName}`,
    imageBase64: base64Data,
    imageMimeType: mimeType,
    fallback: fallbackMeta,
  });
}

async function extractStructuredPostWithGemini({
  apiKey,
  textContext,
  imageBase64 = "",
  imageMimeType = "image/jpeg",
  fallback,
}) {
  if (!apiKey) return fallback;

  const prompt = `You are drafting a warm, clear announcement card for Mission Church of Our Lord Jesus Christ (130 Highland Ave, Somerville, MA).
Given the source text and optional flyer/event image, return ONLY valid JSON (no markdown fences) with keys:
{
  "title": "concise, engaging post title (max 70 chars)",
  "badge": "short uppercase pill like UPCOMING · NOV 2026 or SUNDAY WORSHIP or BAND HIGHLIGHT",
  "category": "one of: Upcoming Events, Outreach & Pantry, Youth & Fellowship, Zoom Gatherings",
  "dateDisplay": "human readable date & time",
  "location": "address or Zoom/BAND link info",
  "summary": "2-sentence welcoming write-up summarizing the event, speaker, or call to action",
  "ctaLabel": "short CTA label like View Details or Join Worship"
}

SOURCE CONTEXT:
${String(textContext).slice(0, 3500)}`;

  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inlineData: { mimeType: imageMimeType, data: imageBase64 } });
  }

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
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.25,
            maxOutputTokens: 550,
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
        title: parsed.title || fallback.title,
        badge: parsed.badge || fallback.badge || "CHURCH UPDATE",
        category: parsed.category || fallback.category || "Upcoming Events",
        dateDisplay: parsed.dateDisplay || fallback.dateDisplay || "Check Church Calendar",
        location: parsed.location || fallback.location || "Mission Church · 130 Highland Ave, Somerville, MA",
        summary: parsed.summary || fallback.summary,
        ctaLabel: parsed.ctaLabel || fallback.ctaLabel || "Learn More",
        source: `gemini:${model}`,
      };
    } catch {
      // Try next model or fallback
    }
  }
  return fallback;
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

export async function fetchGmailTokenIfConfigured() {
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

function flattenGmailParts(payload, acc = []) {
  if (!payload) return acc;
  if (payload.body?.data || payload.body?.attachmentId) {
    acc.push(payload);
  }
  for (const part of payload.parts || []) {
    flattenGmailParts(part, acc);
  }
  return acc;
}

function extractBestImageUrlFromHtml(html) {
  if (!html) return "";
  const matches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const url of matches) {
    const lower = url.toLowerCase();
    if (
      lower.includes("on.jsp") ||
      lower.includes("spacer") ||
      lower.includes("constantcontact.com/images") ||
      lower.includes("imgssl.constantcontact.com/letters/images") ||
      lower.endsWith(".gif") ||
      lower.includes("referral") ||
      lower.includes("footer")
    ) {
      continue;
    }
    if (url.startsWith("https://")) return url;
  }
  return "";
}

async function fetchRemoteImageAsBase64(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("https://")) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(imageUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_000_000) return null;
    return { base64: buf.toString("base64"), mimeType: contentType };
  } catch {
    return null;
  }
}

export async function runGmailSync({
  targetInbox = "phillipskevin386@gmail.com",
  senderFilter = "missionchurch1@gmail.com",
} = {}) {
  const token = await fetchGmailTokenIfConfigured();
  if (!token) {
    return {
      mode: "oauth-not-configured",
      targetInbox,
      senderFilter,
      messagesFound: 0,
      note: "Set GMAIL_ACCESS_TOKEN or GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN to pull live emails from missionchurch1@gmail.com into phillipskevin386@gmail.com. Local Downloads flyer scanning remains active.",
    };
  }

  const query = encodeURIComponent(DEFAULT_GMAIL_QUERY);
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) {
    return {
      mode: "oauth-error",
      statusCode: listRes.status,
      targetInbox,
      senderFilter,
      messagesFound: 0,
      note: "Gmail API returned a non-200 status; verify OAuth scope gmail.readonly for phillipskevin386@gmail.com.",
    };
  }
  const listData = await listRes.json();
  const messageRefs = listData.messages || [];
  const items = [];

  for (const ref of messageRefs.slice(0, 6)) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=From`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!msgRes.ok) continue;
    const msg = await msgRes.json();
    const headers = Object.fromEntries(
      (msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
    );
    items.push({
      id: msg.id,
      subject: headers.subject || "(No subject)",
      from: headers.from || "",
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
      const res = await fetch(
        `https://openapi.band.us/v2/band/posts?access_token=${encodeURIComponent(bandToken)}&band_key=${encodeURIComponent(process.env.BAND_KEY || "74073849")}`
      );
      if (res.ok) {
        const json = await res.json();
        return {
          mode: "live-band-openapi",
          bandId: "74073849",
          postsFetched: json?.result_data?.items?.length || 0,
          items: json?.result_data?.items || [],
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
    manifestPhotos,
    note: "Using synced BAND App album manifest (23 curated photos). Set BAND_ACCESS_TOKEN to pull live BAND posts directly.",
  };
}

export async function registerGmailWatch({
  topicName = process.env.GMAIL_WATCH_TOPIC || "projects/concessionstand-420708/topics/mission-church-gmail-watch",
} = {}) {
  const token = await fetchGmailTokenIfConfigured();
  if (!token) {
    return { ok: false, status: "oauth-not-configured" };
  }
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/watch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      topicName,
      labelIds: ["INBOX"],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      status: "watch-error",
      statusCode: res.status,
      error: data?.error?.message || JSON.stringify(data),
    };
  }
  return {
    ok: true,
    status: "watching",
    historyId: data.historyId,
    expiration: data.expiration,
    topicName,
  };
}

function escapeHtmlBasic(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendApprovalEmail({
  draft,
  recipient = "phillipskevin386@gmail.com",
  publicBaseUrl = DEFAULT_PUBLIC_BASE_URL,
}) {
  const token = await fetchGmailTokenIfConfigured();
  if (!token) {
    return { sent: false, reason: "oauth-not-configured" };
  }

  const approveTok = signApprovalToken(draft.id, "approve");
  const rejectTok = signApprovalToken(draft.id, "reject");
  const approveUrl = `${publicBaseUrl}/api/admin/approve-post?id=${encodeURIComponent(draft.id)}&token=${encodeURIComponent(approveTok)}`;
  const rejectUrl = `${publicBaseUrl}/api/admin/reject-post?id=${encodeURIComponent(draft.id)}&token=${encodeURIComponent(rejectTok)}`;
  const previewImageUrl = draft.imageUrl?.startsWith("http")
    ? draft.imageUrl
    : `${publicBaseUrl}${draft.imageUrl || "/assets/photos/00_cover_sanctuary_worship_1920x1080.jpg"}`;

  const subject = `[Mission Church Approval Needed] ${draft.title}`;
  const html = `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #faf7f2; border: 1px solid #e5d8dc; border-radius: 16px; overflow: hidden;">
    <div style="background: #7e151c; color: #fff; padding: 20px 24px;">
      <div style="font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #ecd363; font-weight: 700;">${escapeHtmlBasic(draft.sourceLabel)} · AI Draft Review</div>
      <h2 style="margin: 6px 0 0; font-size: 22px;">${escapeHtmlBasic(draft.title)}</h2>
    </div>
    <img src="${escapeHtmlBasic(previewImageUrl)}" alt="Event preview" style="width: 100%; max-height: 320px; object-fit: cover; display: block;" />
    <div style="padding: 22px 24px; color: #1e1720;">
      <p style="margin: 0 0 8px; font-weight: 700; color: #7e151c;">${escapeHtmlBasic(draft.dateDisplay)}</p>
      <p style="margin: 0 0 14px; font-size: 13px; color: #5d525f;">${escapeHtmlBasic(draft.location)}</p>
      <p style="margin: 0 0 22px; font-size: 15px; line-height: 1.55;">${escapeHtmlBasic(draft.summary)}</p>
      <div style="display: flex; gap: 12px; flex-wrap: wrap;">
        <a href="${approveUrl}" style="display: inline-block; background: #7e151c; color: #ffffff; text-decoration: none; font-weight: 700; padding: 12px 20px; border-radius: 999px; margin-right: 10px;">Approve &amp; Publish to Website</a>
        <a href="${rejectUrl}" style="display: inline-block; background: #ffffff; color: #5d525f; border: 1px solid #d7c8cd; text-decoration: none; font-weight: 700; padding: 12px 18px; border-radius: 999px;">Skip / Reject</a>
      </div>
      <p style="margin: 20px 0 0; font-size: 12px; color: #7c6f7d;">You can also review or edit all pending drafts inside the website's <strong>Admin &amp; AI Sync</strong> drawer at ${escapeHtmlBasic(publicBaseUrl)}.</p>
    </div>
  </div>`;

  const rawMime = [
    `To: ${recipient}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
  ].join("\r\n");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      raw: Buffer.from(rawMime).toString("base64url"),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const needsScope = res.status === 403 && errText.toLowerCase().includes("insufficient");
    return {
      sent: false,
      needsSendScope: needsScope,
      statusCode: res.status,
      reason: needsScope ? "awaiting-gmail-send-scope" : errText.slice(0, 180),
    };
  }
  const sentJson = await res.json();
  return { sent: true, gmailMessageId: sentJson.id };
}

export async function watchAndPrepareDrafts({
  store,
  publicDir,
  publicBaseUrl = DEFAULT_PUBLIC_BASE_URL,
  sendEmails = true,
}) {
  const apiKey = resolveGeminiApiKey();
  const token = await fetchGmailTokenIfConfigured();
  const processed = new Set(store.processedSourceIds || []);
  const newDrafts = [];
  const emailResults = [];

  // 1. Check recent Mission Church emails in Gmail
  if (token) {
    const query = encodeURIComponent(DEFAULT_GMAIL_QUERY);
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=6`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      for (const ref of (listData.messages || []).slice(0, 3)) {
        const sourceId = `gmail:${ref.id}`;
        if (processed.has(sourceId)) continue;

        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!msgRes.ok) continue;
        const msg = await msgRes.json();
        const headers = Object.fromEntries(
          (msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
        );
        const parts = flattenGmailParts(msg.payload);
        const htmlPart = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
        const textPart = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
        const html = htmlPart ? Buffer.from(htmlPart.body.data, "base64url").toString("utf8") : "";
        const plain = textPart ? Buffer.from(textPart.body.data, "base64url").toString("utf8") : "";

        const remoteImageUrl = extractBestImageUrlFromHtml(html);
        const remoteImageData = await fetchRemoteImageAsBase64(remoteImageUrl);
        const subject = headers.subject || "Mission Church Announcement";

        const structured = await extractStructuredPostWithGemini({
          apiKey,
          textContext: `Email Subject: ${subject}\nFrom: ${headers.from || ""}\nDate: ${headers.date || ""}\nBody:\n${plain || msg.snippet || ""}`,
          imageBase64: remoteImageData?.base64 || "",
          imageMimeType: remoteImageData?.mimeType || "image/jpeg",
          fallback: {
            title: subject.slice(0, 70),
            badge: "EMAIL UPDATE",
            category: "Upcoming Events",
            dateDisplay: headers.date || "Recent Church Email",
            location: "Mission Church · 130 Highland Ave, Somerville, MA",
            summary: (msg.snippet || plain || subject).slice(0, 220),
            ctaLabel: "Plan to Attend",
          },
        });

        const draft = {
          id: `draft-gmail-${ref.id}`,
          sourceId,
          sourceType: "gmail",
          sourceLabel: "Gmail Watch · Mission Church",
          badge: structured.badge,
          category: structured.category,
          title: structured.title,
          dateDisplay: structured.dateDisplay,
          location: structured.location,
          summary: structured.summary,
          imageUrl: remoteImageUrl || "/assets/photos/00_cover_sanctuary_worship_1920x1080.jpg",
          ctaLabel: structured.ctaLabel,
          ctaAction: "scroll-visit",
          status: "pending_approval",
          createdAt: new Date().toISOString(),
        };

        if (sendEmails) {
          const emailRes = await sendApprovalEmail({ draft, publicBaseUrl });
          draft.emailStatus = emailRes.sent ? "emailed" : emailRes.reason;
          emailResults.push({ draftId: draft.id, ...emailRes });
        }

        store.pendingPosts.unshift(draft);
        store.processedSourceIds.push(sourceId);
        processed.add(sourceId);
        newDrafts.push(draft);
      }
    }
  }

  // 2. Sync latest BAND App posts (text + overall description + images + schedules)
  const bandRes = await runBandSync(publicDir);
  if (bandRes.mode === "live-band-openapi" && Array.isArray(bandRes.items)) {
    const bandIngest = await ingestExternalBandPosts({
      posts: bandRes.items.slice(0, 5),
      store,
      publicBaseUrl,
      sendEmails,
    });
    newDrafts.push(...bandIngest.newDrafts);
    emailResults.push(...bandIngest.emailResults);
  } else if (Array.isArray(bandRes.manifestPhotos)) {
    const featured = bandRes.manifestPhotos.slice(0, 1);
    for (const photo of featured) {
      const sourceId = `band-album:${photo.album_no}:${photo.photo_no}`;
      if (processed.has(sourceId)) continue;
      const localImgPath = path.join(publicDir, "assets", "photos", photo.filename);
      const b64 = fs.existsSync(localImgPath) ? fs.readFileSync(localImgPath).toString("base64") : "";
      const structured = await extractStructuredPostWithGemini({
        apiKey,
        textContext: `BAND Album: ${photo.album_name}\nPhoto Role: ${photo.role}\nAuthor: ${photo.author}`,
        imageBase64: b64,
        imageMimeType: "image/jpeg",
        fallback: {
          title: `${photo.album_name} Highlight`,
          badge: "BAND ALBUM",
          category: "Youth & Fellowship",
          dateDisplay: "Mission Church BAND Album",
          location: "Mission Church Sanctuary",
          summary: `New moments shared from ${photo.album_name} by ${photo.author} on the Mission Church BAND community.`,
          ctaLabel: "Open Album on BAND ↗",
        },
      });
      const draft = {
        id: `draft-band-${photo.photo_no}`,
        sourceId,
        sourceType: "band",
        sourceLabel: `BAND Album · ${photo.album_name}`,
        badge: structured.badge,
        category: structured.category,
        title: structured.title,
        dateDisplay: structured.dateDisplay,
        location: structured.location,
        summary: structured.summary,
        imageUrl: `/assets/photos/${photo.filename}`,
        ctaLabel: "View on BAND ↗",
        externalUrl: photo.band_url || "https://www.band.us/n/ada0bcJfJ1f9z",
        status: "pending_approval",
        createdAt: new Date().toISOString(),
      };
      if (sendEmails) {
        const emailRes = await sendApprovalEmail({ draft, publicBaseUrl });
        draft.emailStatus = emailRes.sent ? "emailed" : emailRes.reason;
        emailResults.push({ draftId: draft.id, ...emailRes });
      }
      store.pendingPosts.unshift(draft);
      store.processedSourceIds.push(sourceId);
      processed.add(sourceId);
      newDrafts.push(draft);
    }
  }

  return { newDrafts, emailResults };
}

export async function ingestExternalBandPosts({
  posts = [],
  store,
  publicBaseUrl = DEFAULT_PUBLIC_BASE_URL,
  sendEmails = true,
}) {
  const apiKey = resolveGeminiApiKey();
  const processed = new Set(store.processedSourceIds || []);
  const newDrafts = [];
  const emailResults = [];

  for (const post of posts) {
    const postKey = String(post.post_key || post.id || crypto.randomUUID().slice(0, 10));
    const sourceId = `band-post:${postKey}`;
    if (processed.has(sourceId)) continue;

    const writtenText = String(post.content || post.body || post.text || "").trim();
    const overallDescription = String(post.description || post.overallDescription || "").trim();
    const schedule = post.schedule || {};
    const scheduleContext = schedule.title || schedule.start_at || schedule.location || schedule.description
      ? `\nAttached BAND Event Schedule:\nTitle: ${schedule.title || ""}\nStarts: ${schedule.start_at || ""}\nEnds: ${schedule.end_at || ""}\nLocation: ${schedule.location || ""}\nEvent Description: ${schedule.description || ""}`
      : "";

    const photoUrl =
      post.photos?.[0]?.url ||
      post.imageUrl ||
      (Array.isArray(post.imageUrls) ? post.imageUrls[0] : "") ||
      "/assets/photos/01_unity_sanctuary_group_portrait.jpg";
    const photoData = photoUrl.startsWith("https://") ? await fetchRemoteImageAsBase64(photoUrl) : null;

    const fullContext = [
      `BAND Post Author: ${post.author?.name || post.author || "Mission Church Family"}`,
      post.title ? `Post Heading: ${post.title}` : "",
      writtenText ? `Post Body Text:\n${writtenText}` : "",
      overallDescription ? `Overall Description:\n${overallDescription}` : "",
      scheduleContext,
    ]
      .filter(Boolean)
      .join("\n\n");

    const structured = await extractStructuredPostWithGemini({
      apiKey,
      textContext: fullContext,
      imageBase64: photoData?.base64 || "",
      imageMimeType: photoData?.mimeType || "image/jpeg",
      fallback: {
        title: (post.title || schedule.title || "Mission Church BAND Update").slice(0, 70),
        badge: "BAND POST",
        category: "Youth & Fellowship",
        dateDisplay: schedule.start_at || post.createdAt || "Recent BAND Post",
        location: schedule.location || "Mission Church · 130 Highland Ave, Somerville, MA",
        summary: (writtenText || overallDescription || schedule.description || "New update from the Mission Church BAND community.").slice(0, 280),
        ctaLabel: "Open on BAND ↗",
      },
    });

    const draft = {
      id: `draft-band-${postKey}`,
      sourceId,
      sourceType: "band",
      sourceLabel: "BAND Post (Text + Description + Photo)",
      badge: structured.badge,
      category: structured.category,
      title: structured.title,
      dateDisplay: structured.dateDisplay,
      location: structured.location,
      summary: structured.summary,
      rawPostText: writtenText.slice(0, 1200),
      rawDescription: (overallDescription || schedule.description || "").slice(0, 1200),
      imageUrl: photoUrl,
      ctaLabel: structured.ctaLabel,
      externalUrl: post.postUrl || "https://www.band.us/n/ada0bcJfJ1f9z",
      status: "pending_approval",
      createdAt: new Date().toISOString(),
    };

    if (sendEmails) {
      const emailRes = await sendApprovalEmail({ draft, publicBaseUrl });
      draft.emailStatus = emailRes.sent ? "emailed" : emailRes.reason;
      emailResults.push({ draftId: draft.id, ...emailRes });
    }

    store.pendingPosts.unshift(draft);
    store.processedSourceIds.push(sourceId);
    processed.add(sourceId);
    newDrafts.push(draft);
  }

  return { newDrafts, emailResults };
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
