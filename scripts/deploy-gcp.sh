#!/usr/bin/env bash
set -euo pipefail

# Automated Google Cloud Run Deployment for Mission Church Web & AI Concierge
# Usage:
#   ./scripts/deploy-gcp.sh [GCP_PROJECT_ID] [REGION]

PROJECT_ID="${1:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${2:-us-central1}"
SERVICE_NAME="mission-church-web"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <GCP_PROJECT_ID> [REGION]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_PROPS="/Users/phillipsk7461/StudioProjects/BibleBible/local.properties"

echo "==> Targeting GCP Project: $PROJECT_ID ($REGION)"
gcloud config set project "$PROJECT_ID"

echo "==> Enabling Cloud Run, Secret Manager, Cloud Build, and Artifact Registry..."
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

upsert_secret() {
  local secret_name="$1"
  local secret_value="$2"
  if ! gcloud secrets describe "$secret_name" >/dev/null 2>&1; then
    gcloud secrets create "$secret_name" --replication-policy="automatic"
  fi
  printf "%s" "$secret_value" | gcloud secrets versions add "$secret_name" --data-file=-
}

if [[ -z "${GEMINI_API_KEY:-}" && -f "$LOCAL_PROPS" ]]; then
  GEMINI_API_KEY="$(grep -E '^GEMINI_API_KEY=' "$LOCAL_PROPS" | head -n1 | cut -d'=' -f2- | tr -d '\r\n' || true)"
fi

if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  upsert_secret "MISSION_CHURCH_GEMINI_API_KEY" "$GEMINI_API_KEY"
else
  echo "WARNING: GEMINI_API_KEY not found; ensure MISSION_CHURCH_GEMINI_API_KEY exists in Secret Manager."
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet >/dev/null

SECRETS_ARG="GEMINI_API_KEY=MISSION_CHURCH_GEMINI_API_KEY:latest"
for pair in \
  "GMAIL_CLIENT_ID=MISSION_GMAIL_CLIENT_ID" \
  "GMAIL_CLIENT_SECRET=MISSION_GMAIL_CLIENT_SECRET" \
  "GMAIL_REFRESH_TOKEN=MISSION_GMAIL_REFRESH_TOKEN" \
  "APPROVAL_HMAC_SECRET=MISSION_APPROVAL_SECRET"; do
  env_key="${pair%%=*}"
  sec_name="${pair#*=}"
  if gcloud secrets describe "$sec_name" >/dev/null 2>&1; then
    SECRETS_ARG="${SECRETS_ARG},${env_key}=${sec_name}:latest"
  fi
done

echo "==> Deploying $SERVICE_NAME to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --source "$PROJECT_DIR" \
  --region "$REGION" \
  --allow-unauthenticated \
  --max-instances=3 \
  --min-instances=0 \
  --memory=512Mi \
  --cpu=1 \
  --set-env-vars="GEMINI_MODEL=gemini-2.5-flash,GCP_PROJECT_ID=${PROJECT_ID},PUBLIC_BASE_URL=https://mission-church-web-5jdy3d7zua-uc.a.run.app" \
  --set-secrets="$SECRETS_ARG"

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format='value(status.url)')"
echo "Deployed Mission Church Web & AI Concierge at: $SERVICE_URL"
