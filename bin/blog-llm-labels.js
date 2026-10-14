#!/usr/bin/env node
/**
 * LLM labeling pass over the blog entries — the one-time backtest
 * companion to `bin/blog-backtest.js`. Sends every entry to the
 * Cortecs API (OpenAI-compatible) and asks for a structured reading:
 * the crew's comfort tier for the sailing parts only, whether the
 * narrative sits at sea or at anchor, slatting mentions and whether
 * they were mitigated, fatigue mentions, and the raw condition words.
 *
 * The regex keyword tier in blog-backtest.js stays as the cheap
 * baseline; these labels are the careful reading the keyword net can't
 * do (negation, mitigation, anchorage-vs-sailing scope).
 *
 * Usage:
 *   node bin/blog-llm-labels.js --logs ../log/_logs \
 *     --json $TMPDIR/blog-llm-labels.ndjson
 *
 * Options:
 *   --logs <dir>        Blog entry directory
 *   --json <file>       NDJSON output (one label per line, resumable)
 *   --since <date>      Only entries from this date on
 *   --dates <list>      Explicit comma-separated dates
 *   --model <id>        Cortecs model (default gemini-3.5-flash-lite)
 *   --concurrency <n>   Parallel requests (default 4)
 *
 * The API key comes from CORTECS_API_KEY, or pi's auth.json.
 *
 * @file blog-llm-labels.js
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { open } = require("node:fs/promises");

const { loadEntries } = require("./blog-backtest.js");

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const CORTECS_BASE_URL = "https://api.cortecs.ai/v1";

const RUBRIC = `You are labeling sailing blog entries for a comfort-model backtest.

Comfort tiers (worst to best): miserable, rough, sporty, easy, champagne.
- champagne: flat calm, glassy, millpond, drifting
- easy: pleasant, gentle, comfortable sailing
- sporty: lively, brisk, lumpy, squally — requires attention, still fun
- rough: uncomfortable, wet, banging, hard work, gear strained
- miserable: gale, survival conditions, nobody enjoying it

Rate ONLY the sailing/underway parts of the narrative (ignore time at anchor, in harbour, or ashore). scope describes where the narrative sits: sailing (mostly underway), anchored (mostly riding at anchor or moored), mixed (roughly equal), land (mostly ashore/project day). slatting = light-air sail flapping or flopping over residual swell; slatting_mitigated = the crew deployed countermeasures (kept sails on to stabilise, motorsailing, reefed for stability). fatigue = tiredness or broken sleep mentioned. sea_state_words = the condition words the entry uses, verbatim (e.g. "lumpy", "glassy"). notes = anything notable for the backtest, one sentence max.`;

const LABEL_SCHEMA = {
  name: "entry_label",
  strict: true,
  schema: {
    type: "object",
    properties: {
      comfort_tier: {
        type: "string",
        enum: ["champagne", "easy", "sporty", "rough", "miserable"],
      },
      confidence: { type: "number" },
      scope: { type: "string", enum: ["sailing", "anchored", "mixed", "land"] },
      slatting_mentioned: { type: "boolean" },
      slatting_mitigated: { type: "boolean" },
      fatigue: { type: "boolean" },
      sea_state_words: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
    },
    required: [
      "comfort_tier",
      "confidence",
      "scope",
      "slatting_mentioned",
      "slatting_mitigated",
      "fatigue",
      "sea_state_words",
      "notes",
    ],
  },
};

/**
 * Resolves the Cortecs API key: CORTECS_API_KEY env, else pi's
 * auth.json.
 *
 * @returns {string|null}
 */
function cortecsKey() {
  if (process.env.CORTECS_API_KEY) {
    return process.env.CORTECS_API_KEY;
  }
  try {
    const auth = JSON.parse(
      fs.readFileSync(
        path.join(os.homedir(), ".pi", "agent", "auth.json"),
        "utf8",
      ),
    );
    return auth?.cortecs?.key ?? null;
  } catch {
    return null;
  }
}

/**
 * Labels one entry through the Cortecs chat completions API.
 *
 * @param {object} params
 * @param {object} params.entry - Parsed blog entry
 * @param {string} params.key - API key
 * @param {string} params.model - Model id
 * @returns {Promise<object>} The parsed label
 */
async function labelEntry({ entry, key, model }) {
  const prose = (entry.body ?? "").slice(0, 12000);
  const response = await fetch(`${CORTECS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: RUBRIC },
        {
          role: "user",
          content: `Entry (${entry.date} — ${entry.meta.title ?? ""}):\n${prose}`,
        },
      ],
      temperature: 0,
      response_format: { type: "json_schema", json_schema: LABEL_SCHEMA },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(
      `Cortecs ${response.status}: ${await response.text().then((t) => t.slice(0, 200))}`,
    );
  }
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const label = JSON.parse(content);
  label.date = entry.date;
  label.title = entry.meta.title ?? entry.file;
  label.model = model;
  return label;
}

/**
 * CLI entry point.
 */
async function main() {
  const option = (name, fallback) => {
    const args = process.argv.slice(2);
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const logsDir = option(
    "logs",
    path.join(__dirname, "..", "..", "log", "_logs"),
  );
  const jsonFile = option("json", null);
  const since = option("since", null);
  const model = option("model", DEFAULT_MODEL);
  const concurrency = Number(option("concurrency", "4"));
  const datesArg = (option("dates", "") ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const limit = Number(option("limit", "0"));

  const key = cortecsKey();
  if (!key) {
    console.error("No Cortecs API key (CORTECS_API_KEY or pi auth.json)");
    process.exit(1);
  }
  if (!jsonFile) {
    console.error(
      "Usage: node bin/blog-llm-labels.js --json <out.ndjson> [--logs dir] [--since date] [--dates list] [--model id]",
    );
    process.exit(1);
  }

  const entries = await loadEntries(logsDir);
  let targets =
    datesArg.length > 0
      ? entries.filter((e) => datesArg.includes(e.date))
      : entries.filter((e) => !since || e.date >= since);
  if (limit > 0) {
    targets = targets.slice(0, limit);
  }

  // Resume: skip dates the output already carries
  const doneDates = new Set();
  try {
    const { createReadStream } = require("node:fs");
    const { createInterface } = require("node:readline");
    const existing = createInterface({ input: createReadStream(jsonFile) });
    for await (const line of existing) {
      if (!line.trim()) {
        continue;
      }
      try {
        doneDates.add(JSON.parse(line).date);
      } catch {
        // Skip corrupt lines
      }
    }
  } catch {
    // New file
  }
  targets = targets.filter((e) => !doneDates.has(e.date));
  console.error(
    `labeling ${targets.length} entries with ${model} (${concurrency} at a time)`,
  );

  const handle = await open(jsonFile, "a");
  const stream = handle.createWriteStream();
  let cursor = 0;
  let failures = 0;

  async function worker(id) {
    while (cursor < targets.length) {
      const entry = targets[cursor++];
      let label = null;
      for (let attempt = 1; attempt <= 3 && !label; attempt++) {
        try {
          label = await labelEntry({ entry, key, model });
        } catch (error) {
          if (attempt === 3) {
            failures++;
            console.error(`[${id}] -- ${entry.date}: ${error.message}`);
          } else {
            await new Promise((r) => setTimeout(r, attempt * 2000));
          }
        }
      }
      if (label) {
        stream.write(`${JSON.stringify(label)}\n`);
        console.error(
          `[${id}] ${entry.date} ${label.comfort_tier} (${label.scope})`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  await new Promise((resolve) => stream.end(resolve));
  await handle.close();
  console.error(
    `done: ${targets.length - failures} labeled, ${failures} failed`,
  );
}

module.exports = { labelEntry, cortecsKey, RUBRIC, LABEL_SCHEMA };

if (require.main === module) {
  main().catch((error) => {
    console.error(`LLM labeling failed: ${error.message}`);
    process.exit(1);
  });
}
