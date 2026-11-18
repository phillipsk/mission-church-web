import fs from "node:fs";
import path from "node:path";

const LOCAL_PROPS_CANDIDATES = [
  path.resolve(process.cwd(), "local.properties"),
  "/Users/phillipsk7461/StudioProjects/BibleBible/local.properties",
];

export function resolveGeminiApiKey() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }
  for (const candidate of LOCAL_PROPS_CANDIDATES) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const lines = fs.readFileSync(candidate, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("GEMINI_API_KEY=")) {
          const val = trimmed.slice("GEMINI_API_KEY=".length).trim();
          if (val) return val;
        }
      }
    } catch {
      // Ignore unreadable local.properties
    }
  }
  return "";
}

function buildSystemContext(data) {
  const { church, sundaySchedule, weeklyVirtualSchedule, feed, ministries, faqs, shorts } = data;
  const upcomingSummary = feed
    .slice(0, 8)
    .map((e) => `- ${e.title} (${e.dateDisplay}) @ ${e.location}: ${e.summary}`)
    .join("\n");
  const zoomSummary = weeklyVirtualSchedule
    .map(
      (z) =>
        `- ${z.title} (${z.cadence} · ${z.timeLabel}): Zoom ID ${z.zoomId}, Passcode ${z.zoomPasscode}${z.zoomUrl ? `, Direct Link: ${z.zoomUrl}` : ""}`
    )
    .join("\n");
  const faqSummary = faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n\n");
  const shortsSummary = shorts
    .slice(0, 6)
    .map((s) => `- "${s.title}" by ${s.speaker} (${s.date}, ${s.duration}) — ${s.scripture}: ${s.caption}`)
    .join("\n");

  return `You are the warm, knowledgeable, welcoming AI Church Concierge for **${church.name}** (${church.denomination}) in Somerville, MA.
Always answer accurately using ONLY the verified church facts below. Be concise, encouraging, well-structured (use short bullet points where helpful), and hospitable to both first-time guests and church members.

CHURCH CORE DETAILS:
- Pastor: ${church.pastor}
- Church Administrator: ${church.administrator}
- 2026 Theme: "${church.themeTitle}" (${church.themeScripture})
- Location: ${church.address} (Directions: ${church.directionsUrl})
- Phone: ${church.phone} | Email: ${church.email}
- Sunday Schedule:
${sundaySchedule.map((s) => `  • ${s.time}: ${s.title} (${s.location}) — ${s.description}`).join("\n")}

WEEKLY VIRTUAL GATHERINGS & ZOOM DETAILS:
${zoomSummary}

INTERACTIVE PUBLIC MINISTRIES:
1. Tabitha's Closet: ${ministries.interactiveThree[0].description} Facebook: ${church.social.tabithasClosetFb}
2. Shepherd's Kitchen (10th Year Food Pantry): ${ministries.interactiveThree[1].description} Next distribution: ${ministries.interactiveThree[1].nextDistribution}. Items: ${ministries.interactiveThree[1].items.join(", ")}. Facebook: ${church.social.shepherdsKitchenFb}
3. Counseling Ministry: ${ministries.interactiveThree[2].description} Zoom ID: ${ministries.interactiveThree[2].zoomId}, Passcode: ${ministries.interactiveThree[2].zoomPasscode}. Official Intake Form: ${ministries.interactiveThree[2].intakeFormUrl}

RECENT EVENTS & FEED:
${upcomingSummary}

RECENT WORSHIP SHORTS / VIDEO NUGGETS:
${shortsSummary}

GIVING CHANNELS:
- Cash App: ${church.giving.cashApp.handle} (${church.giving.cashApp.url})
- Venmo: ${church.giving.venmo.handle} (${church.giving.venmo.url})
- 2026 Building Fund Pledge: ${church.giving.buildingFundUrl}
- Note: ${church.giving.note}

FIRST-TIME VISITOR FAQs:
${faqSummary}

If someone asks something not covered above (like private individual matters), warmly invite them to call ${church.phone}, email ${church.email}, or submit the Confidential Counseling Ministry / Visit request right on this website.`;
}

function deriveSuggestedActions(question, replyText) {
  const combined = `${question} ${replyText}`.toLowerCase();
  const actions = [];

  if (combined.includes("shepherd") || combined.includes("pantry") || combined.includes("food")) {
    actions.push({ label: "Open Shepherd's Kitchen Portal", action: "open-ministry", target: "shepherds-kitchen" });
  }
  if (combined.includes("tabitha") || combined.includes("cloth") || combined.includes("coat") || combined.includes("donat")) {
    actions.push({ label: "Open Tabitha's Closet", action: "open-ministry", target: "tabithas-closet" });
  }
  if (combined.includes("counsel") || combined.includes("intake") || combined.includes("support") || combined.includes("care")) {
    actions.push({ label: "Open Counseling Portal", action: "open-ministry", target: "counseling-ministry" });
  }
  if (combined.includes("sunday") || combined.includes("visit") || combined.includes("park") || combined.includes("wear") || combined.includes("address")) {
    actions.push({ label: "Plan a Sunday Visit", action: "scroll", target: "#visit-section" });
  }
  if (combined.includes("zoom") || combined.includes("bible study") || combined.includes("prayer") || combined.includes("abundant")) {
    actions.push({ label: "View Zoom Rooms", action: "scroll", target: "#zoom-hub" });
  }
  if (combined.includes("give") || combined.includes("tithe") || combined.includes("cashapp") || combined.includes("venmo") || combined.includes("building")) {
    actions.push({ label: "Go to Giving", action: "scroll", target: "#give-section" });
  }
  if (actions.length === 0) {
    actions.push({ label: "Explore Ministries", action: "scroll", target: "#ministries-section" });
    actions.push({ label: "Watch Worship Shorts", action: "scroll", target: "#shorts-section" });
  }
  return actions.slice(0, 3);
}

function deterministicFallback(question, data) {
  const q = question.toLowerCase();
  const { church } = data;

  if (q.includes("shepherd") || q.includes("pantry") || q.includes("food")) {
    const sk = data.ministries.interactiveThree[1];
    return `**Shepherd's Kitchen** is celebrating its **10th year** serving our community!\n\n• **Schedule:** 1st Saturday of every month, **9:15 AM – 11:00 AM** (while supplies last). Next distribution: **${sk.nextDistribution}**.\n• **Location:** ${church.address}\n• **Available Items:** Milk, eggs, fresh produce, juice, meat, and canned goods.\n• **Volunteering:** Volunteers arrive at **8:15 AM**. You can register or leave a dietary note directly in the **Shepherd's Kitchen** interactive portal below.`;
  }
  if (q.includes("tabitha") || q.includes("cloth") || q.includes("coat")) {
    return `**Tabitha's Closet** provides new and gently used seasonal clothing, coats, and essentials for families in need.\n\nYou can **request clothing assistance** by size/category or **schedule a gently used clothing drop-off** directly in the **Tabitha's Closet** interactive portal on this page, or visit our Tabitha's Closet Facebook page.`;
  }
  if (q.includes("counsel") || q.includes("intake")) {
    const cm = data.ministries.interactiveThree[2];
    return `Our **Counseling Ministry** (*"Pray on it, Pray over it, Pray through it"*) offers confidential, prayerful support with lay counselors.\n\n• **Monthly Gathering:** Last Friday of every month at **8:00 PM** on Zoom (ID: **${cm.zoomId}**, Passcode: **${cm.zoomPasscode}**).\n• **Confidential Intake:** You can submit a request right inside the **Counseling Ministry** interactive portal or open the official intake form.`;
  }
  if (q.includes("zoom") || q.includes("bible study") || q.includes("prayer") || q.includes("abundant")) {
    return `Here are our weekly **Zoom Gatherings**:\n\n• **Monday Morning Prayer:** Mondays 6:00/6:30 AM · ID \`820 2250 7181\` · Passcode \`683745\`\n• **Weekly Prayer Line (Tue–Thu):** 7:00–7:10 AM · ID \`820 2250 7181\` · Passcode \`683745\`\n• **Tuesday Bible Study (Bishop Mitchell):** Tuesdays 7:30 PM · ID \`819 0334 5217\` · Passcode \`823028\`\n• **Abundant Life Groups:** Tue & Thu 7:30 PM (Passcode \`ALG2022\`)\n• **Friday Prayer / Counseling:** Fridays 8:00 PM · ID \`832 5047 3693\` · Passcode \`012849\``;
  }
  if (q.includes("give") || q.includes("tithe") || q.includes("cash") || q.includes("venmo") || q.includes("building")) {
    return `You can support **${church.name}** through:\n\n• **Cash App:** \`${church.giving.cashApp.handle}\`\n• **Venmo:** \`${church.giving.venmo.handle}\`\n• **2026 Building Fund Pledge:** Supports painting, handicap ramps, and sanctuary sound upgrades.\n• **In Person:** During Sunday worship.\n\nPlease include a memo (such as *tithe*, *offering*, or *building fund*). For non-cash donations, reach Administrator **${church.administrator}** at **${church.email}** or **${church.phone}**.`;
  }
  if (q.includes("sunday") || q.includes("time") || q.includes("where") || q.includes("park") || q.includes("wear") || q.includes("visit") || q.includes("pastor")) {
    return `We'd love to welcome you to **${church.name}**!\n\n• **Address:** ${church.address} (lots on both sides + across the street, wheelchair & lift accessible)\n• **Sundays:** 10:00 AM Prayer · 10:30 AM Sunday School & Next Steps · 11:30 AM Fellowship Hall Refreshments · **12:00 PM Worship Service**\n• **What to Wear:** Come comfortable—most members wear Sunday Best.\n• **Pastor:** **${church.pastor}** greets every guest personally after worship!`;
  }
  return `Welcome to **${church.name}** (*2026 Theme: "${church.themeTitle}" — ${church.themeScripture}*).\n\n• **Sundays:** 10:00 AM Prayer · 10:30 AM Sunday School · 12:00 PM Worship at **${church.address}**\n• **Interactive Ministries:** Scroll down to interact directly with **Tabitha's Closet**, **Shepherd's Kitchen**, and the **Counseling Ministry**, or call **${church.phone}**.`;
}

export async function askChurchConcierge({ message, history = [], churchData }) {
  const apiKey = resolveGeminiApiKey();
  const systemPrompt = buildSystemContext(churchData);

  if (!apiKey) {
    const reply = deterministicFallback(message, churchData);
    return {
      reply,
      modelUsed: "grounded-local-fallback",
      suggestedActions: deriveSuggestedActions(message, reply),
    };
  }

  const modelsToTry = [process.env.GEMINI_MODEL || "gemini-2.5-flash", "gemini-2.0-flash"];
  const contents = [];

  for (const turn of history.slice(-6)) {
    if (!turn || !turn.text) continue;
    contents.push({
      role: turn.role === "model" ? "model" : "user",
      parts: [{ text: String(turn.text).slice(0, 1500) }],
    });
  }
  contents.push({ role: "user", parts: [{ text: message }] });

  for (const model of modelsToTry) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 600,
          },
        }),
      });
      clearTimeout(timeout);

      if (!res.ok) continue;
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("")
        .trim();

      if (text) {
        return {
          reply: text,
          modelUsed: model,
          suggestedActions: deriveSuggestedActions(message, text),
        };
      }
    } catch {
      // Try next model or fallback
    }
  }

  const reply = deterministicFallback(message, churchData);
  return {
    reply,
    modelUsed: "grounded-local-fallback",
    suggestedActions: deriveSuggestedActions(message, reply),
  };
}
