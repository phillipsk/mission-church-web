const state = {
  data: null,
  activeFeedCategory: "All",
  feedQuery: "",
  activeGalleryCategory: "All",
  activeMinistry: "shepherds-kitchen",
  activeShortsTab: "facebook",
  faqQuery: "",
  chatHistory: [],
  activeVideoEl: null,
};

const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatSimpleMarkdown(text) {
  const safe = esc(text);
  return safe
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function showToast(msg) {
  let toast = qs("#mission-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "mission-toast";
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#120e14",
      color: "#ecd363",
      padding: "10px 18px",
      borderRadius: "999px",
      fontWeight: "700",
      fontSize: "13px",
      zIndex: "99",
      boxShadow: "0 12px 32px rgba(0,0,0,0.3)",
    });
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.display = "block";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.display = "none";
  }, 2600);
}

async function copyText(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${label}: ${text}`);
  } catch {
    showToast(text);
  }
}

function downloadIcsEvent(item) {
  const start = new Date(item.dateIso || Date.now());
  const end = new Date(item.endIso || start.getTime() + 90 * 60 * 1000);
  const toIcsDate = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Mission Church COOLJC//Somerville MA//EN",
    "BEGIN:VEVENT",
    `UID:${item.id}@missionchurchcooljc.com`,
    `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(start)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${item.title}`,
    `LOCATION:${item.location || "130 Highland Ave, Somerville, MA 02143"}`,
    `DESCRIPTION:${(item.summary || "").replace(/\n/g, " ")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${item.id || "mission-event"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Calendar file (.ics) downloaded");
}

function setupPreviewSwitcher() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("preview")) {
    document.body.classList.add("is-preview-embed");
    return;
  }

  const stage = qs("#device-stage");
  const bezel = qs("#device-bezel");
  const iframe = qs("#device-iframe");
  const label = qs("#device-label");
  const appShell = qs("#app-shell");
  const buttons = qsa(".vp-btn");

  const setViewport = (mode) => {
    buttons.forEach((b) => b.classList.toggle("active", b.dataset.vp === mode));
    if (mode === "desktop") {
      stage.classList.add("hidden");
      stage.setAttribute("aria-hidden", "true");
      appShell.classList.remove("hidden");
      iframe.src = "about:blank";
      return;
    }
    appShell.classList.add("hidden");
    stage.classList.remove("hidden");
    stage.setAttribute("aria-hidden", "false");
    bezel.classList.toggle("is-tablet", mode === "tablet");
    bezel.classList.toggle("is-mobile", mode === "mobile");
    label.textContent = mode === "tablet" ? "Tablet Preview (768px)" : "Mobile Preview (390px)";
    iframe.src = `${window.location.pathname}?preview=${mode}`;
  };

  buttons.forEach((btn) => btn.addEventListener("click", () => setViewport(btn.dataset.vp)));
  qs("#exit-preview-btn")?.addEventListener("click", () => setViewport("desktop"));
}

function renderNextGathering() {
  const { weeklyVirtualSchedule } = state.data;
  const now = new Date();
  const candidates = [
    {
      title: "Sunday Morning Worship Service",
      dayOfWeek: 0,
      hour: 12,
      minute: 0,
      meta: "Sundays · 10:00 AM Prayer · 10:30 AM School · 12:00 PM Worship",
      desc: "130 Highland Ave, Somerville, MA. Greeters & ushers welcome every visitor; parking on both sides & across the street.",
      type: "in-person",
    },
    ...weeklyVirtualSchedule.map((item) => ({
      title: item.title,
      dayOfWeek: item.dayOfWeek,
      hour: item.hour,
      minute: item.minute,
      meta: `${item.cadence} · ${item.timeLabel} · ${item.location}`,
      desc: item.description,
      zoomId: item.zoomId,
      zoomPasscode: item.zoomPasscode,
      zoomUrl: item.zoomUrl,
      type: "zoom",
    })),
  ];

  let nextItem = candidates[0];
  let bestDiff = Infinity;
  for (const c of candidates) {
    const target = new Date(now);
    const dayOffset = (c.dayOfWeek - now.getDay() + 7) % 7;
    target.setDate(now.getDate() + dayOffset);
    target.setHours(c.hour, c.minute, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 7);
    }
    const diff = target.getTime() - now.getTime();
    if (diff < bestDiff) {
      bestDiff = diff;
      nextItem = c;
    }
  }

  const hoursLeft = Math.floor(bestDiff / (1000 * 60 * 60));
  const daysLeft = Math.floor(hoursLeft / 24);
  const remHours = hoursLeft % 24;
  qs("#ng-countdown").textContent = daysLeft > 0 ? `IN ${daysLeft}D ${remHours}H` : `IN ${Math.max(1, hoursLeft)}H`;
  qs("#ng-title").textContent = nextItem.title;
  qs("#ng-meta").textContent = nextItem.meta;
  qs("#ng-desc").textContent = nextItem.desc;

  const actionsEl = qs("#ng-actions");
  if (nextItem.type === "zoom") {
    actionsEl.innerHTML = `
      <button type="button" class="btn btn-gold btn-sm" id="copy-next-zoom">Copy Zoom ID: ${esc(nextItem.zoomId)} (Code: ${esc(nextItem.zoomPasscode)})</button>
      ${nextItem.zoomUrl ? `<a href="${esc(nextItem.zoomUrl)}" target="_blank" rel="noopener" class="btn btn-glass btn-sm">Launch Zoom ↗</a>` : ""}
    `;
    qs("#copy-next-zoom")?.addEventListener("click", () => {
      copyText(`Zoom ID: ${nextItem.zoomId} | Passcode: ${nextItem.zoomPasscode}`, "Zoom details copied");
    });
  } else {
    actionsEl.innerHTML = `
      <a href="${esc(state.data.church.directionsUrl)}" target="_blank" rel="noopener" class="btn btn-gold btn-sm">Get Directions ↗</a>
      <a href="#visit-section" class="btn btn-glass btn-sm">Plan Your Visit</a>
    `;
  }
}

function renderShorts() {
  const carousel = qs("#shorts-carousel");
  const ytGrid = qs("#youtube-nuggets-grid");
  const isYt = state.activeShortsTab === "youtube";

  carousel.classList.toggle("hidden", isYt);
  ytGrid.classList.toggle("hidden", !isYt);

  if (isYt) {
    ytGrid.innerHTML = state.data.youtubeNuggets
      .map(
        (n) => `
      <article class="yt-card">
        <iframe class="yt-frame" src="${esc(n.embedUrl)}" title="${esc(n.title)}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
        <div class="yt-body">
          <div>
            <strong>${esc(n.title)}</strong>
            <div class="short-meta">${esc(n.duration)} · YouTube Nugget</div>
          </div>
          <a href="${esc(n.url)}" target="_blank" rel="noopener" class="mini-link-btn">YouTube ↗</a>
        </div>
      </article>
    `
      )
      .join("");
    return;
  }

  carousel.innerHTML = state.data.shorts
    .map(
      (s) => `
    <article class="short-card" id="short-card-${esc(s.id)}">
      <div class="short-video-box">
        <video
          src="${esc(s.videoUrl)}"
          poster="${esc(s.posterUrl)}"
          preload="metadata"
          playsinline
          controls
        ></video>
        <div class="short-overlay-top">
          <span class="short-pill">${esc(s.duration)}</span>
          <span class="short-pill">${esc(s.views)}</span>
        </div>
        <button class="short-play-btn" type="button" aria-label="Play ${esc(s.title)}">▶</button>
      </div>
      <div class="short-body">
        <span class="short-meta">${esc(s.date)} · ${esc(s.scripture)}</span>
        <h3 class="short-title">${esc(s.title)}</h3>
        <p class="short-caption">${esc(s.caption)}</p>
        <div class="short-actions">
          <button type="button" class="mini-link-btn ask-short-btn" data-short-title="${esc(s.title)}">✦ Ask AI</button>
          <a href="${esc(s.permalink)}" target="_blank" rel="noopener" class="mini-link-btn">FB Reel ↗</a>
        </div>
      </div>
    </article>
  `
    )
    .join("");

  qsa(".short-card", carousel).forEach((card) => {
    const video = qs("video", card);
    const playBtn = qs(".short-play-btn", card);
    playBtn.addEventListener("click", () => {
      if (state.activeVideoEl && state.activeVideoEl !== video) {
        state.activeVideoEl.pause();
      }
      if (video.paused) {
        video.play();
        state.activeVideoEl = video;
      } else {
        video.pause();
      }
    });
    video.addEventListener("play", () => {
      if (state.activeVideoEl && state.activeVideoEl !== video) {
        state.activeVideoEl.pause();
      }
      state.activeVideoEl = video;
      playBtn.classList.add("is-playing");
      playBtn.textContent = "❚❚";
    });
    video.addEventListener("pause", () => {
      playBtn.classList.remove("is-playing");
      playBtn.textContent = "▶";
    });
  });

  qsa(".ask-short-btn", carousel).forEach((btn) => {
    btn.addEventListener("click", () => {
      openChatAndAsk(`Tell me more about the message "${btn.dataset.shortTitle}" and how it connects to Mission Church's theme.`);
    });
  });
}

function renderFeed() {
  const grid = qs("#feed-grid");
  const query = state.feedQuery.trim().toLowerCase();
  const filtered = state.data.feed.filter((item) => {
    const catMatch = state.activeFeedCategory === "All" || item.category === state.activeFeedCategory;
    const textMatch =
      !query ||
      [item.title, item.summary, item.dateDisplay, item.location, item.category]
        .join(" ")
        .toLowerCase()
        .includes(query);
    return catMatch && textMatch;
  });

  if (!filtered.length) {
    grid.innerHTML = `<div class="feed-card"><div class="feed-card-body"><h3>No matching announcements</h3><p class="feed-summary">Clear your search filter or ask the AI Concierge for help.</p></div></div>`;
    return;
  }

  grid.innerHTML = filtered
    .map(
      (item) => `
    <article class="feed-card">
      <div class="feed-card-media">
        <img src="${esc(item.imageUrl)}" alt="${esc(item.title)}" loading="lazy" />
        <span class="feed-badge">${esc(item.badge)}</span>
      </div>
      <div class="feed-card-body">
        <span class="feed-source">${esc(item.sourceLabel)}</span>
        <h3 class="feed-title">${esc(item.title)}</h3>
        <div class="feed-date">${esc(item.dateDisplay)}</div>
        <p class="feed-summary">${esc(item.summary)}</p>
        <div class="feed-actions">
          ${
            item.externalUrl
              ? `<a href="${esc(item.externalUrl)}" target="_blank" rel="noopener" class="chip-action chip-action-primary">${esc(item.ctaLabel)}</a>`
              : `<button type="button" class="chip-action chip-action-primary feed-cta-btn" data-action="${esc(item.ctaAction || "")}">${esc(item.ctaLabel || "Learn More")}</button>`
          }
          <button type="button" class="chip-action feed-ics-btn" data-id="${esc(item.id)}">+ Calendar</button>
          ${
            item.zoomId
              ? `<button type="button" class="chip-action feed-zoom-btn" data-zoom="${esc(`Zoom ID: ${item.zoomId} | Passcode: ${item.zoomPasscode}`)}">Copy Zoom</button>`
              : ""
          }
          <button type="button" class="chip-action feed-ai-btn" data-title="${esc(item.title)}">✦ Ask AI</button>
        </div>
      </div>
    </article>
  `
    )
    .join("");

  qsa(".feed-ics-btn", grid).forEach((btn) => {
    btn.addEventListener("click", () => {
      const found = state.data.feed.find((f) => f.id === btn.dataset.id);
      if (found) downloadIcsEvent(found);
    });
  });

  qsa(".feed-zoom-btn", grid).forEach((btn) => {
    btn.addEventListener("click", () => copyText(btn.dataset.zoom, "Zoom details copied"));
  });

  qsa(".feed-ai-btn", grid).forEach((btn) => {
    btn.addEventListener("click", () => openChatAndAsk(`Give me full details about "${btn.dataset.title}".`));
  });

  qsa(".feed-cta-btn", grid).forEach((btn) => {
    btn.addEventListener("click", () => handleFeedAction(btn.dataset.action));
  });
}

function handleFeedAction(action) {
  if (!action) return;
  if (action.startsWith("open-ministry:")) {
    const id = action.split(":")[1] === "counseling" ? "counseling-ministry" : action.split(":")[1];
    selectMinistryWorkspace(id);
    qs("#ministry-workspace")?.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (action === "scroll-visit") {
    qs("#visit-section")?.scrollIntoView({ behavior: "smooth" });
  } else if (action === "scroll-ministries") {
    qs("#ministries-section")?.scrollIntoView({ behavior: "smooth" });
  } else if (action.startsWith("play-short:")) {
    const shortId = action.split(":")[1];
    const card = qs(`#short-card-${shortId}`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    qs("video", card)?.play().catch(() => {});
  }
}

function renderZoomHub() {
  const grid = qs("#zoom-cards-grid");
  grid.innerHTML = state.data.weeklyVirtualSchedule
    .map(
      (z) => `
    <article class="zoom-card">
      <span class="zoom-cadence">${esc(z.cadence)} · ${esc(z.timeLabel)}</span>
      <h4>${esc(z.title)}</h4>
      <div class="zoom-creds">ID: ${esc(z.zoomId)}<br/>Passcode: ${esc(z.zoomPasscode)}</div>
      <div class="zoom-card-actions">
        <button type="button" class="chip-action copy-zoom-btn" data-copy="${esc(`Zoom ID: ${z.zoomId} | Passcode: ${z.zoomPasscode}`)}">Copy ID &amp; Code</button>
        ${z.zoomUrl ? `<a href="${esc(z.zoomUrl)}" target="_blank" rel="noopener" class="chip-action chip-action-primary">Join Zoom ↗</a>` : ""}
      </div>
    </article>
  `
    )
    .join("");

  qsa(".copy-zoom-btn", grid).forEach((b) => {
    b.addEventListener("click", () => copyText(b.dataset.copy, "Copied"));
  });
}

function renderMinistries() {
  const { interactiveThree, allDepartments } = state.data.ministries;
  const spotGrid = qs("#interactive-ministries-grid");
  spotGrid.innerHTML = interactiveThree
    .map(
      (m) => `
    <article class="spotlight-card ${state.activeMinistry === m.id ? "is-selected" : ""}">
      <img src="${esc(m.imageUrl)}" alt="${esc(m.name)}" class="spotlight-img" loading="lazy" />
      <div class="spotlight-body">
        <span class="spotlight-tagline">${esc(m.tagline)}</span>
        <h3>${esc(m.name)}</h3>
        <p class="feed-summary">${esc(m.description)}</p>
        <div class="feed-actions">
          <button type="button" class="chip-action chip-action-primary open-mw-btn" data-ministry="${esc(m.id)}">Explore More ↓</button>
          ${
            m.externalUrl
              ? `<a href="${esc(m.externalUrl)}" target="_blank" rel="noopener" class="chip-action">${esc(m.externalLabel)}</a>`
              : `<a href="${esc(m.intakeFormUrl)}" target="_blank" rel="noopener" class="chip-action">${esc(m.externalLabel)}</a>`
          }
        </div>
      </div>
    </article>
  `
    )
    .join("");

  qsa(".open-mw-btn", spotGrid).forEach((btn) => {
    btn.addEventListener("click", () => {
      selectMinistryWorkspace(btn.dataset.ministry);
      qs("#ministry-workspace")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  qs("#all-ministries-grid").innerHTML = allDepartments
    .map(
      (d) => `
    <div class="dept-card">
      <h4>${esc(d.name)}</h4>
      <p>${esc(d.focus)}</p>
    </div>
  `
    )
    .join("");

  renderMinistryWorkspace();
}

function selectMinistryWorkspace(id) {
  state.activeMinistry = id;
  qsa(".mw-tab").forEach((t) => t.classList.toggle("active", t.dataset.mw === id));
  qsa(".spotlight-card").forEach((card, idx) => {
    const m = state.data.ministries.interactiveThree[idx];
    card.classList.toggle("is-selected", m?.id === id);
  });
  renderMinistryWorkspace();
}

function renderMinistryWorkspace() {
  const container = qs("#ministry-workspace-body");
  const ministry = state.data.ministries.interactiveThree.find((m) => m.id === state.activeMinistry) || state.data.ministries.interactiveThree[1];

  if (ministry.id === "shepherds-kitchen") {
    container.innerHTML = `
      <div class="mw-grid">
        <div>
          <span class="eyebrow">SHEPHERD'S KITCHEN · 10TH YEAR FOOD PANTRY</span>
          <h3>${esc(ministry.nextDistribution)}</h3>
          <p class="muted">${esc(ministry.description)}</p>
          <img src="${esc(ministry.flyerUrl)}" alt="Shepherd's Kitchen December Food Pantry Flyer" class="mw-flyer" />
          <div class="tag-cloud">${ministry.items.map((i) => `<span class="tag-item">✓ ${esc(i)}</span>`).join("")}</div>
        </div>
        <form id="mw-interact-form" class="stacked-form">
          <h4>Connect with Shepherd's Kitchen</h4>
          <label class="field">
            <span>How would you like to engage?</span>
            <select name="mode">${ministry.modes.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select>
          </label>
          <div class="form-row-2">
            <label class="field"><span>Your Name *</span><input name="name" required minlength="2" placeholder="Full name" /></label>
            <label class="field"><span>Phone or Email *</span><input name="contact" required placeholder="617-555-0199 or email" /></label>
          </div>
          <label class="field">
            <span>Household Size, Dietary Note, or Volunteer Role</span>
            <textarea name="details" rows="3" placeholder="e.g., Family of 4 requesting Dec 5 reminder, or signing up for 8:15 AM setup..."></textarea>
          </label>
          <div class="hero-actions">
            <button type="submit" class="btn btn-primary btn-sm">Submit Shepherd's Kitchen Request</button>
            <a href="${esc(ministry.externalUrl)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Visit Pantry Facebook ↗</a>
          </div>
          <p id="mw-form-status" class="form-status" aria-live="polite"></p>
        </form>
      </div>
    `;
  } else if (ministry.id === "tabithas-closet") {
    container.innerHTML = `
      <div class="mw-grid">
        <div>
          <span class="eyebrow">TABITHA'S CLOSET · CLOTHING & CARE</span>
          <h3>Clothing Assistance &amp; Community Donations</h3>
          <p class="muted">${esc(ministry.description)}</p>
          <img src="${esc(ministry.imageUrl)}" alt="Mission Church Outreach and Tabitha's Closet" class="mw-flyer" />
          <p class="muted"><strong>Accepted &amp; Available Categories:</strong></p>
          <div class="tag-cloud">${ministry.categories.map((c) => `<span class="tag-item">${esc(c)}</span>`).join("")}</div>
        </div>
        <form id="mw-interact-form" class="stacked-form">
          <h4>Tabitha's Closet Interactive Portal</h4>
          <label class="field">
            <span>Action Type</span>
            <select name="mode">${ministry.modes.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select>
          </label>
          <div class="form-row-2">
            <label class="field"><span>Your Name *</span><input name="name" required minlength="2" placeholder="Full name" /></label>
            <label class="field"><span>Phone or Email *</span><input name="contact" required placeholder="Best contact info" /></label>
          </div>
          <div class="field">
            <span>Categories Needed or Donating</span>
            <div class="checkbox-grid">
              ${ministry.categories.map((c) => `<label class="check-pill"><input type="checkbox" name="cat" value="${esc(c)}" /> <span>${esc(c)}</span></label>`).join("")}
            </div>
          </div>
          <label class="field">
            <span>Sizes, Ages, or Preferred Drop-off Time</span>
            <textarea name="details" rows="3" placeholder="e.g., Looking for boys size 8 winter coat, or donating 2 bags of gently used sweaters..."></textarea>
          </label>
          <div class="hero-actions">
            <button type="submit" class="btn btn-primary btn-sm">Submit Tabitha's Closet Request</button>
            <a href="${esc(ministry.externalUrl)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Tabitha's Closet FB ↗</a>
          </div>
          <p id="mw-form-status" class="form-status" aria-live="polite"></p>
        </form>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="mw-grid">
        <div>
          <span class="eyebrow">COUNSELING MINISTRY · SPIRITUAL CARE</span>
          <h3>Confidential Care &amp; Monthly Zoom Service</h3>
          <p class="muted">${esc(ministry.description)}</p>
          <img src="${esc(ministry.imageUrl)}" alt="Mission Church Counseling and Prayer Ministry" class="mw-flyer" />
          <div class="zoom-creds">
            <strong>Last Friday Monthly · 8:00 PM (Next: Nov 20, 2026)</strong><br/>
            Zoom ID: ${esc(ministry.zoomId)} · Passcode: ${esc(ministry.zoomPasscode)}
          </div>
          <div class="hero-actions" style="margin-top: 12px; margin-bottom: 0;">
            <a href="${esc(ministry.zoomUrl)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Join Counseling Zoom ↗</a>
            <a href="${esc(ministry.intakeFormUrl)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm">Official Google Intake Form ↗</a>
          </div>
        </div>
        <form id="mw-interact-form" class="stacked-form">
          <h4>Request Confidential Lay Counselor Connection</h4>
          <p class="muted">${esc(ministry.privacyNote)}</p>
          <label class="field">
            <span>Support Preference</span>
            <select name="mode">${ministry.modes.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select>
          </label>
          <div class="form-row-2">
            <label class="field"><span>Your Name *</span><input name="name" required minlength="2" placeholder="First or full name" /></label>
            <label class="field"><span>Confidential Email or Phone *</span><input name="contact" required placeholder="Best private contact" /></label>
          </div>
          <label class="field">
            <span>How can our care team support you?</span>
            <textarea name="details" rows="4" placeholder="Share briefly what you'd like prayer or guidance for (kept strictly confidential)..."></textarea>
          </label>
          <button type="submit" class="btn btn-primary btn-sm">Send Confidential Request</button>
          <p id="mw-form-status" class="form-status" aria-live="polite"></p>
        </form>
      </div>
    `;
  }

  const form = qs("#mw-interact-form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = qs("#mw-form-status");
    const fd = new FormData(form);
    const cats = fd.getAll("cat").join(", ");
    status.textContent = "Submitting...";
    try {
      const res = await fetch("/api/ministries/interact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ministry: ministry.id,
          mode: fd.get("mode"),
          name: fd.get("name"),
          contact: fd.get("contact"),
          category: cats,
          details: fd.get("details"),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Unable to submit");
      status.style.color = "#1f6f4a";
      status.textContent = json.message;
      form.reset();
      await refreshBootstrapSilently();
    } catch (err) {
      status.style.color = "#a11a26";
      status.textContent = err.message;
    }
  });
}

function renderPrayerWall() {
  const list = qs("#prayer-wall-list");
  list.innerHTML = state.data.prayerWall
    .map(
      (p) => `
    <article class="prayer-card">
      <div class="prayer-card-top">
        <span>${esc(p.name)}</span>
        <span>${esc(p.category)}</span>
      </div>
      <p>${esc(p.request)}</p>
      <button type="button" class="amen-btn" data-id="${esc(p.id)}">🙏 Pray for This (${Number(p.amens || 0)})</button>
    </article>
  `
    )
    .join("");

  qsa(".amen-btn", list).forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const res = await fetch(`/api/prayer/${encodeURIComponent(btn.dataset.id)}/amen`, { method: "POST" });
        const json = await res.json();
        if (res.ok) {
          btn.textContent = `🙏 Praying Together (${json.amens})`;
          const item = state.data.prayerWall.find((x) => x.id === btn.dataset.id);
          if (item) item.amens = json.amens;
        }
      } catch {
        // Ignore transient click errors
      }
    });
  });
}

function renderFaqs() {
  const list = qs("#faq-list");
  const q = state.faqQuery.trim().toLowerCase();
  const items = state.data.faqs.filter((f) => !q || f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q));
  list.innerHTML = items
    .map(
      (f, i) => `
    <div class="faq-item">
      <button type="button" class="faq-trigger" aria-expanded="${i === 0 ? "true" : "false"}">
        <span>${esc(f.q)}</span>
        <span>${i === 0 ? "−" : "+"}</span>
      </button>
      <div class="faq-answer ${i === 0 ? "" : "hidden"}">${esc(f.a)}</div>
    </div>
  `
    )
    .join("");

  qsa(".faq-trigger", list).forEach((btn) => {
    btn.addEventListener("click", () => {
      const answer = btn.nextElementSibling;
      const isOpen = !answer.classList.contains("hidden");
      answer.classList.toggle("hidden", isOpen);
      btn.setAttribute("aria-expanded", String(!isOpen));
      btn.lastElementChild.textContent = isOpen ? "+" : "−";
    });
  });
}

function renderGallery() {
  const grid = qs("#gallery-grid");
  const photos = (state.data.curatedPhotos || []).filter((p) => {
    if (state.activeGalleryCategory === "All") return true;
    return p.role.toLowerCase().includes(state.activeGalleryCategory.toLowerCase());
  });

  grid.innerHTML = photos
    .slice(0, 16)
    .map(
      (p) => `
    <button type="button" class="gallery-card" data-src="${esc(p.localUrl)}" data-title="${esc(p.role)}" data-album="${esc(p.albumName)}">
      <img src="${esc(p.localUrl)}" alt="${esc(p.role)}" loading="lazy" />
      <div class="gallery-cap">
        <strong>${esc(p.albumName)}</strong>
        <small>${esc(p.role)}</small>
      </div>
    </button>
  `
    )
    .join("");

  qsa(".gallery-card", grid).forEach((card) => {
    card.addEventListener("click", () => {
      qs("#lightbox-img").src = card.dataset.src;
      qs("#lightbox-title").textContent = card.dataset.title;
      qs("#lightbox-album").textContent = `BAND Album: ${card.dataset.album}`;
      qs("#lightbox").classList.remove("hidden");
    });
  });
}

function renderAdminDrawer() {
  const { syncState, ministrySubmissions, visitPlans } = state.data;
  qs("#admin-sync-cards").innerHTML = `
    <div class="sync-card">
      <strong>Gmail Pipeline</strong>
      <span>${esc(syncState.gmail.senderFilter)} → ${esc(syncState.gmail.targetInbox)}</span>
      <p>${esc(syncState.gmail.status)}</p>
    </div>
    <div class="sync-card">
      <strong>BAND App (${esc(syncState.bandApp.bandId)})</strong>
      <span>${esc(syncState.bandApp.status)}</span>
    </div>
    <div class="sync-card">
      <strong>Facebook Reels</strong>
      <span>${esc(syncState.facebookReels.status)}</span>
    </div>
  `;

  const allSubs = [
    ...ministrySubmissions.map((s) => ({
      badge: s.ministry,
      title: `${s.name} · ${s.mode}`,
      detail: `${s.contact}${s.category ? " · " + s.category : ""}${s.details ? " — " + s.details : ""}`,
    })),
    ...visitPlans.map((v) => ({
      badge: "Sunday Visit RSVP",
      title: `${v.name} (${v.partySize} guests)`,
      detail: `${v.visitDate || "Upcoming Sunday"} ${v.contact} ${v.note}`,
    })),
  ];

  qs("#admin-submissions-list").innerHTML = allSubs.length
    ? allSubs
        .slice(0, 12)
        .map(
          (item) => `
        <div class="submission-row">
          <strong>[${esc(item.badge)}] ${esc(item.title)}</strong>
          <div>${esc(item.detail)}</div>
        </div>
      `
        )
        .join("")
    : `<div class="submission-row">No new ministry or visit submissions yet in this session. Try submitting a request in Tabitha's Closet, Shepherd's Kitchen, or Plan a Visit!</div>`;
}

async function openChatAndAsk(promptText) {
  qs("#chat-drawer").classList.remove("hidden");
  qs("#chat-input").value = promptText;
  await submitChatMessage(promptText);
}

async function submitChatMessage(text) {
  const messagesEl = qs("#chat-messages");
  const inputEl = qs("#chat-input");
  const trimmed = text.trim();
  if (!trimmed) return;

  inputEl.value = "";
  const userBubble = document.createElement("div");
  userBubble.className = "chat-msg chat-msg-user";
  userBubble.innerHTML = `<p>${esc(trimmed)}</p>`;
  messagesEl.appendChild(userBubble);

  const thinkingBubble = document.createElement("div");
  thinkingBubble.className = "chat-msg chat-msg-bot";
  thinkingBubble.innerHTML = `<p>Looking up live Mission Church details...</p>`;
  messagesEl.appendChild(thinkingBubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: trimmed, history: state.chatHistory }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Chat unavailable");

    qs("#chat-model-badge").textContent = `Powered by ${json.modelUsed}`;
    state.chatHistory.push({ role: "user", text: trimmed }, { role: "model", text: json.reply });

    const actionsHtml = (json.suggestedActions || [])
      .map(
        (a) =>
          `<button type="button" class="prompt-chip chat-suggested-action" data-action="${esc(a.action)}" data-target="${esc(a.target)}">${esc(a.label)}</button>`
      )
      .join("");

    thinkingBubble.innerHTML = `<p>${formatSimpleMarkdown(json.reply)}</p>${actionsHtml ? `<div class="chat-action-row">${actionsHtml}</div>` : ""}`;
    qsa(".chat-suggested-action", thinkingBubble).forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.action === "open-ministry") {
          selectMinistryWorkspace(btn.dataset.target);
          qs("#ministry-workspace")?.scrollIntoView({ behavior: "smooth", block: "center" });
        } else if (btn.dataset.action === "scroll") {
          qs(btn.dataset.target)?.scrollIntoView({ behavior: "smooth" });
        }
      });
    });
  } catch (err) {
    thinkingBubble.innerHTML = `<p>${esc(err.message)}</p>`;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function wireStaticListeners() {
  qs("#mobile-menu-toggle")?.addEventListener("click", () => {
    qs("#mobile-drawer")?.classList.toggle("hidden");
  });
  qsa(".mobile-nav-link").forEach((a) =>
    a.addEventListener("click", () => qs("#mobile-drawer")?.classList.add("hidden"))
  );

  qsa("[data-open-ministry]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectMinistryWorkspace(btn.dataset.openMinistry);
      qs("#ministry-workspace")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  qsa("[data-shorts-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeShortsTab = btn.dataset.shortsTab;
      qsa("[data-shorts-tab]").forEach((b) => b.classList.toggle("active", b === btn));
      renderShorts();
    });
  });

  qsa("#feed-filters .filter-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeFeedCategory = btn.dataset.category;
      qsa("#feed-filters .filter-chip").forEach((b) => b.classList.toggle("active", b === btn));
      renderFeed();
    });
  });

  qs("#feed-search")?.addEventListener("input", (e) => {
    state.feedQuery = e.target.value;
    renderFeed();
  });

  qsa(".mw-tab").forEach((btn) => {
    btn.addEventListener("click", () => selectMinistryWorkspace(btn.dataset.mw));
  });

  qs("#prayer-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const status = qs("#prayer-form-status");
    const fd = new FormData(form);
    status.textContent = "Sharing prayer request...";
    try {
      const res = await fetch("/api/ministries/interact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ministry: "prayer-wall",
          mode: "prayer",
          name: fd.get("name"),
          category: fd.get("category"),
          details: fd.get("details"),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Unable to post prayer");
      state.data.prayerWall.unshift(json.prayerItem);
      renderPrayerWall();
      form.reset();
      status.style.color = "#ecd363";
      status.textContent = json.message;
    } catch (err) {
      status.style.color = "#ffb3b3";
      status.textContent = err.message;
    }
  });

  qs("#visit-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const status = qs("#visit-form-status");
    const fd = new FormData(form);
    status.textContent = "Saving visit plan...";
    try {
      const res = await fetch("/api/visit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fd.get("name"),
          partySize: Number(fd.get("partySize") || 1),
          visitDate: fd.get("visitDate"),
          contact: fd.get("contact"),
          note: fd.get("note"),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save visit");
      status.style.color = "#1f6f4a";
      status.textContent = json.message;
      form.reset();
      await refreshBootstrapSilently();
    } catch (err) {
      status.style.color = "#a11a26";
      status.textContent = err.message;
    }
  });

  qs("#faq-search")?.addEventListener("input", (e) => {
    state.faqQuery = e.target.value;
    renderFaqs();
  });

  qsa("#gallery-filters .filter-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeGalleryCategory = btn.dataset.gallery;
      qsa("#gallery-filters .filter-chip").forEach((b) => b.classList.toggle("active", b === btn));
      renderGallery();
    });
  });

  qs("#close-lightbox")?.addEventListener("click", () => qs("#lightbox").classList.add("hidden"));
  qs("#lightbox")?.addEventListener("click", (e) => {
    if (e.target.id === "lightbox") qs("#lightbox").classList.add("hidden");
  });

  // Chat controls
  const toggleChat = (open) => {
    qs("#chat-drawer").classList.toggle("hidden", !open);
    if (open) qs("#chat-input")?.focus();
  };
  qs("#chat-fab")?.addEventListener("click", () => toggleChat(true));
  qs("#header-ai-btn")?.addEventListener("click", () => toggleChat(true));
  qs("#hero-ai-btn")?.addEventListener("click", () => toggleChat(true));
  qs("#mbb-ai-btn")?.addEventListener("click", () => toggleChat(true));
  qs("#close-chat-btn")?.addEventListener("click", () => toggleChat(false));

  qsa(".prompt-chip[data-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => submitChatMessage(btn.dataset.prompt));
  });
  qs("#chat-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    submitChatMessage(qs("#chat-input").value);
  });

  // Admin Sync Drawer controls
  const toggleAdmin = (open) => {
    qs("#admin-drawer").classList.toggle("hidden", !open);
    if (open) renderAdminDrawer();
  };
  qs("#open-admin-btn")?.addEventListener("click", () => toggleAdmin(true));
  qs("#mobile-admin-btn")?.addEventListener("click", () => {
    qs("#mobile-drawer")?.classList.add("hidden");
    toggleAdmin(true);
  });
  qs("#close-admin-btn")?.addEventListener("click", () => toggleAdmin(false));

  qs("#trigger-sync-btn")?.addEventListener("click", async () => {
    const out = qs("#admin-sync-output");
    out.classList.remove("hidden");
    out.textContent = "Running Gmail (missionchurch1@gmail.com) & BAND App sync...";
    const res = await fetch("/api/admin/sync", { method: "POST" });
    const json = await res.json();
    state.data.syncState = json.syncState || state.data.syncState;
    renderAdminDrawer();
    out.innerHTML = `<pre style="margin:0;white-space:pre-wrap;">${esc(JSON.stringify(json, null, 2))}</pre>`;
  });

  qs("#scan-flyers-btn")?.addEventListener("click", async () => {
    const out = qs("#admin-sync-output");
    out.classList.remove("hidden");
    out.textContent = "Scanning Downloads church flyers using Gemini Vision...";
    const res = await fetch("/api/admin/parse-flyer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = await res.json();
    out.innerHTML = (json.scanned || [])
      .map(
        (s) => `
        <div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.12);">
          <strong>${esc(s.title)}</strong> <small style="color:#ecd363;">[${esc(s.source)}]</small><br/>
          <span>${esc(s.dateDisplay)} · ${esc(s.location)}</span><br/>
          <small>${esc(s.summary)}</small>
        </div>`
      )
      .join("");
  });
}

async function refreshBootstrapSilently() {
  try {
    const res = await fetch("/api/bootstrap");
    if (res.ok) {
      state.data = await res.json();
      renderAdminDrawer();
    }
  } catch {
    // Ignore background refresh failures
  }
}

async function init() {
  setupPreviewSwitcher();
  wireStaticListeners();

  const res = await fetch("/api/bootstrap");
  state.data = await res.json();

  if (state.data.geminiConfigured) {
    qs("#chat-model-badge").textContent = "Gemini AI Connected · Grounded on live church data";
  }

  renderNextGathering();
  renderShorts();
  renderFeed();
  renderZoomHub();
  renderMinistries();
  renderPrayerWall();
  renderFaqs();
  renderGallery();
}

init().catch((err) => {
  console.error("Failed to initialize Mission Church app:", err);
});
