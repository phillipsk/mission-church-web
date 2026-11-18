# Mission Church COOLJC · Continuous-Scroll Web App & AI Platform

Modern, responsive website and Google Cloud backend for **Mission Church of Our Lord Jesus Christ** (130 Highland Avenue, Somerville, MA 02143).

## Tech Stack (Native Web + Cloud Architecture)

- **Frontend:** Semantic HTML5, responsive CSS3 (Grid, Flexbox, Glassmorphism, Desktop / Tablet `768px` / Mobile `390px` preview switcher, mobile bottom app bar), and zero-dependency Vanilla JavaScript ES Modules (`public/`).
- **Backend:** Native Node.js `>=20` HTTP server (`src/server.js`) with HTTP `206 Partial Content` Range streaming for downloaded Facebook Worship Shorts and REST endpoints (`/api/bootstrap`, `/api/chat`, `/api/ministries/interact`, `/api/visit`, `/api/admin/sync`, `/api/admin/parse-flyer`).
- **AI Concierge & Vision Flyer Parser:** Google **Gemini 2.5 Flash** (`src/services/gemini-concierge.js`, `src/services/sync-pipeline.js`) grounded on live church schedules, Zoom IDs/passcodes, ministries, and visitor FAQs.
- **Cloud Hosting & CI/CD:** Dockerized container deployed to **Google Cloud Run** (`us-central1`) with **Google Cloud Secret Manager** for API keys and `.github/workflows/deploy-cloud-run.yml` for continuous deployment on every push to `main`.

## Local Development

```bash
npm start
# Open http://localhost:8095 (or set PORT=8080)
```

## Sync & OAuth Scripts

- **Refresh Facebook Shorts (Reels) locally:** `npm run sync:shorts`
- **Run Gmail + BAND + Flyer Vision sync:** `npm run sync:pipeline`
- **Authorize Gmail API (`phillipskevin386@gmail.com` reading `from:missionchurch1@gmail.com`):** `npm run auth:gmail`

## Deploying to Google Cloud Run

```bash
npm run deploy
```

Or run `./scripts/deploy-gcp.sh <GCP_PROJECT_ID> <REGION>`.

### Continuous Deployment Pipeline (GitHub → Cloud Run)

Once deployed, pushing any commit to `main` triggers `.github/workflows/deploy-cloud-run.yml`. To enable automated pushes from GitHub Actions without manual CLI deploys, set either:
1. GitHub repository variables `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT` (recommended keyless OIDC), or
2. GitHub repository secret `GCP_SA_KEY` (service account JSON with Cloud Run Admin, Cloud Build Editor, Artifact Registry Writer, and Service Account User roles).
