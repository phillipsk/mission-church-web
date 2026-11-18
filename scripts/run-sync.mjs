import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBandSync, runGmailSync, scanLocalFlyers } from "../src/services/sync-pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

async function main() {
  console.log("==> Running Mission Church Cloud Ingestion Sync...");
  const [gmail, band, flyers] = await Promise.all([
    runGmailSync(),
    runBandSync(publicDir),
    scanLocalFlyers(publicDir),
  ]);
  console.log(JSON.stringify({ gmail, band, flyersCount: flyers.length, flyers }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
