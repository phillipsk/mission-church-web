import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore, saveStore } from "../src/services/firestore-store.js";
import { ingestExternalBandPosts, runBandSync } from "../src/services/sync-pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

/**
 * Syncs BAND App posts (written post text + overall description + attached schedules + images)
 * from either BAND OpenAPI (`BAND_ACCESS_TOKEN`) or a local exported JSON file passed as `--file=path.json`.
 */
async function main() {
  const fileArg = process.argv.find((a) => a.startsWith("--file="));
  const store = await loadStore();

  let posts = [];
  if (fileArg) {
    const filePath = path.resolve(fileArg.slice("--file=".length));
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    posts = Array.isArray(parsed) ? parsed : parsed.items || parsed.posts || [];
  } else {
    const bandRes = await runBandSync(PUBLIC_DIR);
    if (bandRes.mode === "live-band-openapi" && Array.isArray(bandRes.items)) {
      posts = bandRes.items;
    } else {
      console.log(
        JSON.stringify(
          {
            status: "awaiting-band-token-or-file",
            note: "Provide BAND_ACCESS_TOKEN or --file=band-posts.json (containing post text, overall description, schedule, and photo URLs), or POST directly to /api/admin/ingest-band-posts.",
            syncedAlbums: bandRes.curatedAlbumsCount,
          },
          null,
          2
        )
      );
      return;
    }
  }

  const res = await ingestExternalBandPosts({
    posts,
    store,
    sendEmails: process.env.SEND_APPROVAL_EMAILS !== "0",
  });
  await saveStore(store);
  console.log(JSON.stringify({ ok: true, newDrafts: res.newDrafts.length, emailResults: res.emailResults }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
