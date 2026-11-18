# Mission Church COOLJC · Continuous-Scroll Web App & Google Cloud Platform

Modern, responsive website, AI Church Concierge, and automated event/newsletter ingestion backend for **Mission Church of Our Lord Jesus Christ** (130 Highland Avenue, Somerville, MA 02143).

- **Live Shareable Public URL:** https://mission-church-web-5jdy3d7zua-uc.a.run.app
- **Alternate Canonical Cloud Run URL:** https://mission-church-web-687901748717.us-central1.run.app

---

## 1. Tech Stack

- **Frontend:** Semantic HTML5, responsive CSS3 (Desktop, Tablet `768px`, and Mobile `390px` preview switcher + mobile bottom bar), and zero-framework Vanilla ES Modules (`public/`).
- **Backend API & Streaming:** Node.js `>=20` HTTP server (`src/server.js`) with HTTP `206 Partial Content` Range streaming for downloaded Facebook Worship Shorts (`/assets/shorts/*.mp4`) and REST endpoints.
- **AI Concierge & Multimodal Flyer Drafting:** Google **Gemini 2.5 Flash** (`src/services/gemini-concierge.js`, `src/services/sync-pipeline.js`) grounded on live schedules, Zoom credentials, ministries, and visitor FAQs.
- **Database:** **Google Cloud Firestore** (Native mode, `nam5` location) persisted via `src/services/firestore-store.js`.

---

## 2. Backend Infrastructure & Data Flow

```mermaid
flowchart LR
    GMAIL["Church Emails in Gmail<br/>(missionchurch1@gmail.com / Constant Contact)"] -->|Pub/Sub Watch + 15m Scheduler| SYNC["Cloud Run Sync Pipeline<br/>(src/services/sync-pipeline.js)"]
    BAND["BAND App Community<br/>(band.us/n/ada0bcJfJ1f9z)"] --> SYNC
    SYNC -->|Flyer Image + Subject| GEMINI["Gemini 2.5 Flash<br/>Drafts Title, Date & Summary"]
    GEMINI -->|Stores Draft| FS[("Cloud Firestore<br/>app_state/mission_church")]
    SYNC -->|Sends Signed Approve/Reject Email| ADMIN["Admin Inbox<br/>(phillipskevin386@gmail.com)"]
    ADMIN -->|1-Click Approve or Drawer UI| API["Cloud Run Node.js Server<br/>(src/server.js)"]
    API <--> FS
    SECRETS["Google Cloud Secret Manager<br/>(API Keys, OAuth & HMAC Secrets)"] --> API
    API --> WEB["Public Continuous-Scroll Website"]
```

### Cloud Components (All Hosted on Google Cloud)

1. **Google Cloud Run (`mission-church-web`, `us-central1`):** Runs the containerized Node.js application (`Dockerfile`). Scales automatically to zero when idle and wakes on traffic.
2. **Google Cloud Firestore (`(default)` database, `nam5`):** Stores live mutable state in `app_state/mission_church`, including published `feed` posts, `pendingPosts` awaiting admin approval, `processedSourceIds`, `prayerWall` requests and Amen counts, `ministrySubmissions`, `visitPlans`, and `syncState`.
3. **Google Cloud Secret Manager:** Injects sensitive credentials as runtime environment variables (`GEMINI_API_KEY`, Gmail OAuth credentials, and `APPROVAL_HMAC_SECRET`) without storing any secrets in Git.
4. **Cloud Pub/Sub (`mission-church-gmail-watch` → `mission-church-gmail-push-sub`) & Cloud Scheduler (`mission-church-watch-poll`, every 15 minutes):** Watches for incoming Mission Church emails and triggers `/api/admin/watch-poll` to draft new posts automatically.

---

## 3. Caching Strategy & Version Control

### How the Backend Is Cached
- **API Responses (`/api/*`):** Every API endpoint sends `Cache-Control: no-store`. Whenever you approve a drafted post, someone adds a Prayer Wall request, or a ministry form is submitted, all visitors see the updated state on their next load with zero stale API cache.
- **Database Reads/Writes:** `src/services/firestore-store.js` reads/writes directly to Cloud Firestore (`app_state/mission_church`) and caches only the GCP OAuth access token in memory until ~60 seconds before expiry. It also writes a local fallback copy to `src/data/church-data.json` for offline local testing.
- **Video Shorts (`/assets/shorts/*.mp4`):** Served with `Accept-Ranges: bytes` and HTTP `206 Partial Content` streaming so mobile and desktop browsers buffer and scrub videos smoothly without downloading the entire file upfront.

### What Lives in Version Control (GitHub) vs. Cloud Runtime
- **Tracked in GitHub (`phillipsk/mission-church-web`):**
  - All application source code (`src/`, `public/`, `scripts/`, `Dockerfile`, `.github/workflows/deploy-cloud-run.yml`).
  - Baseline church photography, flyers, downloaded Facebook Worship Shorts, and the initial seed snapshot (`src/data/church-data.json`).
- **NOT Tracked in GitHub (Protected Outside Version Control):**
  - `.env`, `.env.local`, and `local.properties` are ignored via `.gitignore` and `.dockerignore`.
  - Production secrets live in **Google Cloud Secret Manager** (`MISSION_CHURCH_GEMINI_API_KEY`, `MISSION_GMAIL_*`, `MISSION_APPROVAL_SECRET`) and the GitHub Actions deployment credential lives in GitHub Secrets (`GCP_SA_KEY`).
  - Live runtime user submissions, newly approved posts, and Prayer Wall updates live in **Cloud Firestore**, so redeploying code from GitHub never overwrites live church data.

---

## 4. End-to-End Post Approval Workflow (Gmail + BAND)

1. **Detection:** Cloud Pub/Sub (`POST /api/webhooks/gmail-push`) or Cloud Scheduler (`POST /api/admin/watch-poll` every 15 minutes) checks for new emails matching `missionchurch1@gmail.com` / Constant Contact / `band.us` and BAND community updates.
2. **AI Draft Preparation:** Gemini 2.5 Flash reads the email/post text and extracts any flyer image to draft a clean website card (`title`, `badge`, `category`, `dateDisplay`, `location`, `summary`), saving it in `pendingPosts`.
3. **Email Review & 1-Click Publish:** The server sends a preview email to `phillipskevin386@gmail.com` containing the flyer image, draft write-up, and HMAC-signed **Approve & Publish** / **Skip / Reject** buttons (and lists the draft inside the website's **Admin & AI Sync** drawer).

---

## 5. Local Development & Continuous Deployment

```bash
npm start
# Open http://localhost:8095
```

- **Refresh Facebook Shorts:** `npm run sync:shorts`
- **Authorize Gmail Read + Send OAuth:** `npm run auth:gmail`
- **Manual Deploy to Cloud Run:** `npm run deploy`
- **Automated CI/CD:** Every push to `main` triggers `.github/workflows/deploy-cloud-run.yml` using GitHub Secret `GCP_SA_KEY` to build and deploy a new Cloud Run revision automatically.
