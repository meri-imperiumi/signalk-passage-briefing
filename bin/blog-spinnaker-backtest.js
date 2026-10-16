#!/usr/bin/env node
/**
 * Downwind-sail recommendation backtest (work doc #41, plan step 4):
 * runs the spinnaker advisor's gates over the 470-day blog backtest
 * dataset and scores the recommendations against the crew's actual
 * Parasailor deployments.
 *
 * What the doc requires the run to show: the recommendation should
 * have fired on the 2024-12 → 2026-05 trade-wind days (the crew flew
 * the Parasailor there), and should *not* fire on the 2022 Baltic
 * squally days. The calibration (work doc #38) changed the premise —
 * drawing sails no longer force Rough — so the run also measures
 * what payoff the model still sees: the comfort delta between the
 * working rig and the with-downwind-sail evaluation per recommended
 * hour.
 *
 * Usage:
 *   node bin/blog-spinnaker-backtest.js \
 *     --json ~/.cache/blog-backtest/blog-backtest-gust.ndjson.sails
 *
 * @file blog-spinnaker-backtest.js
 */

const os = require("node:os");
const path = require("node:path");
const { readFile } = require("node:fs/promises");

const DOWNWIND_RE =
  /\bparasailor\b|\bgennaker\b|\bspinnaker\b|\bcode\s*0\b|\basymmetric\b|\bspinnak[oe]r|\bspiburg\b/i;

/**
 * The crew's deployment envelope: the TWS range they actually flew
 * the downwind sail in (the learned floor; work doc #41). Empty when
 * they never flew one in the dataset.
 *
 * @param {Array<{twsKnots: number}>} flownHours
 * @returns {{minTwsKnots: number|null, maxTwsKnots: number|null}}
 */
function learnedEnvelope(flownHours) {
  const tws = flownHours
    .map((h) => h.twsKnots)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (tws.length === 0) {
    return { minTwsKnots: null, maxTwsKnots: null };
  }
  return {
    minTwsKnots: Math.round(tws[0] * 10) / 10,
    maxTwsKnots: Math.round(tws.at(-1) * 10) / 10,
  };
}

/**
 * CLI entry point.
 */
async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const jsonFile = option(
    "json",
    path.join(
      os.homedir(),
      ".cache",
      "blog-backtest",
      "blog-backtest-gust.ndjson.sails",
    ),
  );

  const physics = await import("../public/sereno-physics.mjs");
  const { evaluateDownwindSail, collectDownwindWindows } = await import(
    "../public/spinnaker-advisor.mjs"
  );

  const days = [];
  for (const line of (await readFile(jsonFile, "utf8")).split("\n")) {
    if (!line.trim()) {
      continue;
    }
    days.push(JSON.parse(line));
  }

  // Two downwind behavior classes from the crew's own logbook: the
  // dedicated downwind sail (Parasailor) and the poled-out working
  // sails (wing-on-wing) — the trades' downwind solution was the
  // poled-out rig, not the Parasailor. Each class learns its
  // envelope from the crew's own deployments: the p10-p90 TWS band,
  // with the ceiling stretchable by the payoff (the lazy-crew rule)
  // but the floor fixed at what the crew actually does.
  const CLASSES = {
    parasailor: /\bparasailor\b/i,
    "poled-out": /\bpoled out\b|wing on wing/i,
  };
  const flownByClass = { parasailor: [], "poled-out": [] };
  const flownIso = new Map();
  for (const day of days) {
    for (const hour of day.hours ?? []) {
      if (!hour.underway) {
        continue;
      }
      const text = hour.sailText ?? "";
      for (const [className, re] of Object.entries(CLASSES)) {
        if (re.test(text)) {
          flownByClass[className].push(hour);
          flownIso.set(hour.hourIso, className);
        }
      }
    }
  }
  const percentile = (values, p) =>
    values[
      Math.min(values.length - 1, Math.max(0, Math.floor(p * values.length)))
    ];
  // Ownership eras (bergie session): the Parasailor came aboard in
  // spring 2022 — earlier than every logged deployment, which is the
  // lazy-crew asymmetry in its purest form (two years of unlogged
  // worthiness). The poled-out working-sail class needs no era: the
  // working sails were always aboard.
  const OWNED_FROM = { parasailor: "2022-04-01", "poled-out": null };
  const envelopes = {};
  const classEras = {};
  for (const [className, hours] of Object.entries(flownByClass)) {
    const tws = hours
      .map((h) => h.twsKnots)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    envelopes[className] = {
      // Floor at what the crew actually does (p10); the ceiling at
      // the demonstrated maximum — with the "Sails set:" lines in the
      // join the crew's own usage reaches well past any percentile
      // cap (178 flown hours above p95), and the lazy-crew amendment
      // stretches upward, not downward
      minTwsKnots: Math.round(percentile(tws, 0.1) * 10) / 10,
      maxTwsKnots: Math.round(tws.at(-1) * 10) / 10,
    };
    const ownedFrom = OWNED_FROM[className];
    classEras[className] = {
      from: ownedFrom ?? hours.map((h) => h.hourIso.slice(0, 10)).sort()[0],
      to: "9999-12-31",
    };
    console.log(
      `${className}: ${hours.length} h flown, envelope ` +
        `${envelopes[className].minTwsKnots}-${envelopes[className].maxTwsKnots} kn, era ${classEras[className].from} → ${classEras[className].to}`,
    );
  }

  // Per-hour gate evaluation over every underway hour
  const TIERS = ["champagne", "easy", "sporty", "rough", "miserable"];
  const rank = new Map(TIERS.map((t, i) => [t, i]));
  const evaluated = [];
  for (const day of days) {
    for (const hour of day.hours ?? []) {
      if (!hour.underway) {
        continue;
      }
      const twaDeg =
        hour.twaRad != null
          ? Math.abs(((hour.twaRad * 180) / Math.PI + 540) % 360) - 180
          : null;
      const night =
        hour.lat != null && hour.lon != null
          ? physics.isNight(new Date(hour.hourIso), hour.lat, hour.lon)
          : null;
      // Every class whose era covers this hour is a candidate (the
      // production advisor evaluates the whole current inventory; the
      // backtest respects the crew's acquisition timeline) — the hour
      // qualifies when any of them covers the conditions
      const candidates = Object.entries(classEras)
        .filter(([, era]) => day.date >= era.from && day.date <= era.to)
        .map(([name]) => name);
      const perClass = candidates.map((name) => ({
        name,
        reason: evaluateDownwindSail({
          twsKnots: hour.twsKnots ?? NaN,
          twaDeg: twaDeg ?? NaN,
          awsKnots: hour.awsKnots ?? NaN,
          hsMeters: hour.hsMeters ?? undefined,
          gustFactor: hour.gustFactor ?? undefined,
          // This crew's own practice: a third of their flown
          // downwind hours are night hours — the learned nightOk
          // (the configured default stays conservative)
          night: night === true,
          nightOk: true,
          envelope: envelopes[name],
        }),
      }));
      const qualifying = perClass.filter((c) => c.reason == null);
      const className = qualifying[0]?.name ?? null;
      const reason =
        candidates.length === 0
          ? "no downwind sail aboard"
          : qualifying.length > 0
            ? null
            : perClass[0].reason;
      // The with-downwind-sail comfort: the crew hoists the sail —
      // canvas up, drawing (the three-way rule then suppresses the
      // slatting force the working rig carries)
      let comfortWithSail = hour.comfort;
      if (hour.hsMeters != null && hour.tpSeconds != null) {
        const withSail = physics.serenoComfort(
          {
            hsMeters: hour.hsMeters,
            tpSeconds: hour.tpSeconds,
            waveTravelDirectionRad: hour.waveTravelRad ?? null,
          },
          {
            sogKnots: hour.sogKnots ?? 0,
            headingRad: hour.headingRad ?? 0,
            waterlineLengthM: 9.4,
            kHeel: 0.35,
            kPitch: 0.4,
            sailState: "sailing",
          },
          { twsKnots: hour.twsKnots ?? 0, twaRad: hour.twaRad ?? Math.PI },
        );
        comfortWithSail = withSail.comfort;
      }
      evaluated.push({
        date: day.date,
        hourIso: hour.hourIso,
        hourMs: Date.parse(hour.hourIso),
        comfort: hour.comfort,
        comfortWithSail,
        slatting: Boolean(hour.slatting),
        sailState: hour.sailState ?? null,
        downwindClass: className,
        flownClass: flownIso.get(hour.hourIso) ?? null,
        flown: flownIso.has(hour.hourIso),
        qualifies: reason == null,
        reason,
        twsKnots: hour.twsKnots,
        twaDeg,
        twaRad: hour.twaRad,
        hsMeters: hour.hsMeters,
        llmScope: null,
      });
    }
  }

  // The payoff gate — re-derived against the calibrated model: the
  // three-way rule reads ANY drawing canvas easy, so the tier delta
  // of hoisting a downwind sail is zero and the tier comparison
  // cannot see the Parasailor's benefit. What the recommendation
  // predicts is the slatting REGIME itself (work doc #14's detection
  // applied predictively): residual swell with too little wind to
  // keep the working canvas loaded — the wash machine the crew
  // breaks out the downwind sail to avoid. Legacy semantics, no
  // sail state: the question is the working canvas, whatever the
  // crew currently has up.
  for (const hour of evaluated) {
    hour.payoff = physics.slattingRisk({
      hsMeters: hour.hsMeters ?? NaN,
      twsKnots: hour.twsKnots ?? NaN,
      twaRad: hour.twaRad ?? NaN,
    });
    const delta = rank.get(hour.comfortWithSail) - rank.get(hour.comfort);
    hour.delta = delta;
  }
  // Windows: consecutive qualifying hours at or over the hassle
  // threshold recommend
  const windows = collectDownwindWindows(
    evaluated.map((h) => ({
      ...h,
      qualifies: h.qualifies && h.payoff,
      night: h.reason === "night",
    })),
  );
  const recommendedHours = new Set();
  for (const window of windows) {
    for (const hour of window.hours_) {
      recommendedHours.add(hour.hourIso);
    }
  }

  // Scores against the crew's actual deployments
  const flownEvaluated = evaluated.filter((h) => h.flown);
  const inWindow = flownEvaluated.filter((h) =>
    recommendedHours.has(h.hourIso),
  );
  const recommended = evaluated.filter((h) => recommendedHours.has(h.hourIso));
  const recommendedFlown = recommended.filter((h) => h.flown);
  const recommendedNotFlown = recommended.filter((h) => !h.flown);
  const flownMissed = flownEvaluated.filter(
    (h) => !recommendedHours.has(h.hourIso),
  );

  // The payoff distribution over the recommended hours
  const deltaCounts = new Map();
  for (const hour of recommended) {
    const d = rank.get(hour.comfortWithSail) - rank.get(hour.comfort);
    deltaCounts.set(d, (deltaCounts.get(d) ?? 0) + 1);
  }

  console.log(`\n== windows: ${windows.length} recommending stretches ==`);
  const windowDays = new Map();
  for (const w of windows) {
    const date = new Date(w.startMs).toISOString().slice(0, 10);
    windowDays.set(date, (windowDays.get(date) ?? 0) + 1);
  }
  for (const [date, n] of [...windowDays.entries()].sort()) {
    console.log(`  ${date}: ${n} window(s)`);
  }

  console.log(
    `\n== crew deployment coverage: ${inWindow.length}/${flownEvaluated.length} flown hours inside recommendation windows ==`,
  );
  const missedReasons = new Map();
  for (const hour of flownMissed) {
    missedReasons.set(hour.reason, (missedReasons.get(hour.reason) ?? 0) + 1);
  }
  console.log(
    `  flown-but-not-recommended: ${flownMissed.length}`,
    [...missedReasons.entries()].map(([r, n]) => `${r}=${n}`).join(", "),
  );

  console.log(
    `\n== recommendations: ${recommended.length} h across ${windows.length} windows ==`,
  );
  console.log(
    `  hours the crew also flew: ${recommendedFlown.length}  ` +
      `hours they did not: ${recommendedNotFlown.length}`,
  );
  // The lazy-crew framing: recommended-but-not-flown hours are the
  // potential missed comfort — what did the crew actually experience
  // there (LLM tiers unavailable at hour level; the model's own tiers
  // and the slatting flag are what we have)
  const notFlownSlatting = recommendedNotFlown.filter((h) => h.slatting);
  const notFlownComfort = new Map();
  for (const hour of recommendedNotFlown) {
    notFlownComfort.set(
      hour.comfort,
      (notFlownComfort.get(hour.comfort) ?? 0) + 1,
    );
  }
  console.log(
    `  not-flown hours with model slatting flag: ${notFlownSlatting.length}`,
  );
  console.log(
    "  not-flown hour comfort:",
    [...notFlownComfort.entries()].map(([t, n]) => `${t}=${n}`).join(", "),
  );
  const stateMix = new Map();
  for (const hour of recommendedNotFlown) {
    const key = hour.sailState ?? "unknown";
    stateMix.set(key, (stateMix.get(key) ?? 0) + 1);
  }
  console.log(
    "  not-flown rig state:",
    [...stateMix.entries()].map(([s, n]) => `${s}=${n}`).join(", "),
  );
  console.log(
    "  comfort delta (with-sail minus as-sailed):",
    [...deltaCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([d, n]) => `${d >= 0 ? "+" : ""}${d}:${n}`)
      .join(", "),
  );

  // Negative control: the 2022 Baltic squally days must stay quiet
  const baltic = evaluated.filter((h) => h.date.startsWith("2022"));
  const balticRecommended = baltic.filter((h) =>
    recommendedHours.has(h.hourIso),
  );
  console.log(
    `\n== negative control (2022 Baltic): ${balticRecommended.length} recommended hours of ${baltic.length} underway ==`,
  );
  for (const hour of balticRecommended.slice(0, 10)) {
    console.log(
      `  ${hour.date} ${hour.hourIso.slice(11, 16)}Z tws ${hour.twsKnots?.toFixed(1)} twa ${hour.twaDeg?.toFixed(0)} slatting=${hour.slatting}`,
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Spinnaker backtest failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { learnedEnvelope, DOWNWIND_RE };
