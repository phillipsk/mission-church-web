import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runGmailSync } from "../src/services/sync-pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const ENV_LOCAL_PATH = path.join(PROJECT_DIR, ".env.local");
const DEFAULT_CLIENT_JSON =
  "/Users/phillipsk7461/Downloads/client_secret_173955115617-vfsf3v5pkicqfaqc8o87ijtsuek4mrt9.apps.googleusercontent.com.json";
const REDIRECT_PORT = Number(process.env.GMAIL_AUTH_PORT || 8096);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

function loadClientConfig() {
  const clientPath = process.env.GMAIL_CLIENT_JSON || DEFAULT_CLIENT_JSON;
  if (!fs.existsSync(clientPath)) {
    throw new Error(`OAuth client JSON not found at ${clientPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(clientPath, "utf8"));
  const block = raw.installed || raw.web;
  if (!block?.client_id || !block?.client_secret) {
    throw new Error("Invalid OAuth client JSON: missing client_id or client_secret");
  }
  return block;
}

function upsertEnvLocal(entries) {
  const existing = fs.existsSync(ENV_LOCAL_PATH) ? fs.readFileSync(ENV_LOCAL_PATH, "utf8").split(/\r?\n/) : [];
  const keys = new Set(Object.keys(entries));
  const kept = existing.filter((line) => {
    const k = line.split("=", 1)[0].trim();
    return line.trim() && !keys.has(k);
  });
  for (const [k, v] of Object.entries(entries)) {
    kept.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_LOCAL_PATH, kept.join("\n") + "\n", { mode: 0o600 });
}

function syncSecretToGcp(secretName, secretValue) {
  try {
    const projectId = process.env.GCP_PROJECT_ID || "gen-lang-client-0150678391";
    try {
      execFileSync("gcloud", ["secrets", "describe", secretName, "--project", projectId], { stdio: "ignore" });
    } catch {
      execFileSync("gcloud", ["secrets", "create", secretName, "--replication-policy=automatic", "--project", projectId], {
        stdio: "ignore",
      });
    }
    execFileSync("gcloud", ["secrets", "versions", "add", secretName, "--data-file=-", "--project", projectId], {
      input: secretValue,
      stdio: ["pipe", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const client = loadClientConfig();
  const authUrl = new URL(client.auth_uri || "https://accounts.google.com/o/oauth2/auth");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify"
  );
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("login_hint", "phillipskevin386@gmail.com");

  console.log("=== Gmail Watch & Approval Send OAuth Setup (phillipskevin386@gmail.com) ===");
  console.log(`Listening for OAuth callback on ${REDIRECT_URI}`);
  console.log("AUTHORIZATION_URL=" + authUrl.toString());

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", REDIRECT_URI);
    const error = reqUrl.searchParams.get("error");
    const code = reqUrl.searchParams.get("code");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h2>Authorization failed: ${error}</h2><p>You may close this tab.</p>`);
      console.error("OAuth denied:", error);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Waiting for Google OAuth callback...");
      return;
    }

    try {
      const tokenRes = await fetch(client.token_uri || "https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: client.client_id,
          client_secret: client.client_secret,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok || !tokenJson.access_token) {
        throw new Error(tokenJson.error_description || tokenJson.error || "Token exchange failed");
      }

      const envUpdates = {
        GMAIL_CLIENT_ID: client.client_id,
        GMAIL_CLIENT_SECRET: client.client_secret,
      };
      if (tokenJson.refresh_token) {
        envUpdates.GMAIL_REFRESH_TOKEN = tokenJson.refresh_token;
      }
      upsertEnvLocal(envUpdates);
      Object.assign(process.env, envUpdates);
      process.env.GMAIL_ACCESS_TOKEN = tokenJson.access_token;

      if (tokenJson.refresh_token) {
        syncSecretToGcp("MISSION_GMAIL_CLIENT_ID", client.client_id);
        syncSecretToGcp("MISSION_GMAIL_CLIENT_SECRET", client.client_secret);
        syncSecretToGcp("MISSION_GMAIL_REFRESH_TOKEN", tokenJson.refresh_token);
      }

      const syncPreview = await runGmailSync();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<h2>Gmail Connected!</h2><p>Saved OAuth credentials to .env.local and tested from:missionchurch1@gmail.com (found ${syncPreview.messagesFound} messages). You can close this window.</p>`
      );
      console.log("GMAIL_OAUTH_SUCCESS", JSON.stringify({ mode: syncPreview.mode, messagesFound: syncPreview.messagesFound }));
      server.close();
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Token exchange failed: " + err.message);
      console.error("Token exchange error:", err.message);
      server.close();
      process.exit(1);
    }
  });

  server.listen(REDIRECT_PORT, "127.0.0.1");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
