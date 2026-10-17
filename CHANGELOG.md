# Changelog

## [Unreleased]

### Fixed
- Timeline event pins sat systematically off their map geometry while keeping their spacing — most visibly the territorial-waters entering/leaving pins, which read against the boundary polygons but landed a mile or two along the route from where the route actually crosses the line (work doc #47 session map-offset report). The map representation derived every pin's position by hour-interpolating the simulated track, discarding the authoritative positions the events already carried: the boundary walk's own 1 nm-resolution crossing fix, and the ceremonial lines' crossing points interpolated on the raw sign-change segment. The simulated track itself bows slightly off the planned route (the current adds to the boat vector each step, no cross-current compensation) and the transition hours came from a distance-scale interpolation, so the round-trip through hour interpolation shifted the whole pin set together. Events that carry their own crossing position now pin there — exactly on the boundary the map draws — and the hour-interpolated track position fills in only where no authoritative position exists (sail changes, gybes, deployments: the boat's own simulated position is the right answer for those).
- The warnings map drew the route twice: a plain line along the route's waypoints and a second comfort-colored ribbon along the simulated hourly track — two nearly-coincident polylines that drift apart by the sim's current-induced bow, reading as a doubled route. One line now: the colorized route. The real route geometry (the viewed route's own sampled waypoints, so a route picked in the picker shows that route) carries the plan's encoding — each route point takes the attributes of the simulated row whose made-good distance covers it, and the run-length stretch coloring, motoring dashes and night dimming ride that single line. The separate waypoint line is gone; where no route geometry exists (here mode) nothing extra draws, and a payload without simulated rows still shows the route as one neutral stretch.
- The map's own warning shapes hovered silent: bulletin blocks (gale polygons, convergence zones, the dashed cardinal-bound swell boxes) carried a click-through to their console text card but no tooltip, so a shape like "IN THE AREA SOUTH OF 22S AND WEST OF 175E, EXPECT MODERATE SOUTHERLY SWELLS." gave no hint of what it was. Block shapes now carry the console card's first line as the hover label — the same convention the wider-area and CAP shapes already used; the card stays authoritative, the shape says what you are hovering.

## [0.12.7] - 2026-10-17

### Fixed
- The spinnaker advisor's timeline contradicted itself in five ways on a long downwind run (Tonga → Opua, work doc #41 session report). Two parallel recommendation systems both rendered "Deploy Parasailor" — the forward-looking deployment advisor and the older slatting-regime pass it was built to replace — so the crew was told to rig a sail that was already up, twice, with conflicting windows. The legacy pass (`downwindRecommendations`, its module and its render block) is gone; the advisor is the single voice, and its named-event gate now covers the legacy pass's extra retract reasons (probable rain squalls, convective air) as a `storm` gate. Pole advisories ran on the raw simulation rows, blind to both the anchored schedule and the deployment windows — recommending the spinnaker pole while the Parasailor was flying (it is not a poled-out run to improve) and inside stretches the timeline announced as motoring. They are now computed on the anchored schedule and skip motoring and deployment hours. Tacks and gybes were detected before twilight anchoring rewrote the rows, so maneuvers could appear inside announced motoring stretches — and a wind-side flip across engine-on hours was rendered as a crew gybe when the engine did the turning; maneuver detection now runs on the anchored schedule and suppresses flips across canvas-down gaps. And canvas-down events (motoring, adrift, storm tactics) were twilight-anchored like rig work: the engine announcement landed at dusk with stale conditions ("motoring at dusk, 10.9 kn of wind") and left an unexplained gap between a downwind take-down and the engine. Canvas-down is a propulsion decision, not canvas work — those events keep their detection time and honest conditions, and the rows carry the canvas-down rig from that moment.

## [0.12.6] - 2026-10-17

### Fixed
- Critical-hazard notifications re-alarmed at every server restart: the acknowledgement state persisted (0.12.5), but the published notification values did not, so the first escalation cycle after a restart re-raised the still-active cyclone as a fresh alarm. The state file now carries both maps — after a restart an identical notification republishes visually (restoring the notification path the server lost) without the sounder, a GDACS-refreshed message amends visually, and a storm escalated to red re-alarms for real. The gate is the pure `classifyPublish`, covered by tests together with the state-file round-trip.

### Added
- Wider-area severe warnings on the map (work doc #47): the bulletins we parse cover far more waters than the track filter keeps, and a gale 300 nm off the route is parsed, severe and geometric — but console noise. Those blocks now ride the payload as `metareaBulletin.wider` (from the same cached bulletins, deduped, capped at 24, never on the console) and the map draws them muted — grey dashed shapes beneath everything with "Off your waters" tooltips, excluded from the fit so the map stays anchored on the vessel's waters while the crew zooms and pans to the rest. The discard rule itself is untouched.
- A warnings map (work doc #47): the route and the warnings the console renders as text, drawn where they are. The route ribbon colors the plan the timeline reads — comfort-tier stretches (the tactical sparkline's palette), motoring dashes, night legs dimmed — and the unified timeline's events pin themselves where they happen, carrying the same emoji glyph the timeline row paints (⛵ ⇄ ⚡ 🌊 ⚑ ⚠ 🔋 ⚓…), one event list projected two ways with bidirectional click-through (pin click scrolls the timeline row; row click pans the map). Bulletin blocks draw from the geometry the filtering engine already computes — gale polygons and convergence zones as severity-colored areas (the console's own highlighter decides the color), trough axes as their stated corridor band, cardinal-bound areas dashed to read as the approximation they are, and tropical cyclone declarations plotted at their analysed position — each shape clicking through to its console text card, which stays authoritative. NHC advisory storms (the FORECAST/ADVISORY family) draw the full cyclone graphic from the parsed advisory: quadrant wind/seas rings colored by the severity ladder (64 KT+ deep red, 48–63 storm-force orange, 34–47 amber, seas teal), the dashed forecast track with each position's valid time and max wind, and a 🌀 centre marker; the fit frames the storm's forward coverage, not just its present position. The basemap comes from the server's configured charts (`/signalk/v1/api/resources/charts` — offline MBTiles and tile proxies work underway), with an online OSM fallback that stays switchable and slips underneath automatically when the configured chart yields no tiles. Leaflet is vendored (BSD-2, no CDN, no build tooling), following the dead-reckoning webapp's proven map lifecycle: the map is born with a concrete view, the mount is idempotent, and every fit is guarded — a hidden card, a tiny container or a degenerate geometry can no more produce a broken map than a broken render chain. All drawn layers unwrap into one longitude frame anchored at the boat, so South Pacific shapes spanning `178W`/`170E` draw as the short hop across the dateline instead of a line around the world.

## [0.12.5] - 2026-10-17

### Fixed
- The hazard acknowledgement state loaded at plugin-factory time, but Signal K exposes `app.getDataDirPath` only by `start()` — the plugin failed to start outright ("app.getDataDirPath is not a function"). The ack file now loads where the data dir is known to exist, with a regression test reproducing the server's factory-before-start ordering.

## [0.12.4] - 2026-10-17

### Fixed
- The tropical-cyclone notification flapped on/off 27 times in ~45 min (logbook 2026-10-16, TC ONE-26): every ticker republish sent a fresh value (re-alarming boards), a GDACS dip outlasted the 2-minute clear grace and the return re-raised, and the exposure envelope tightened whenever a compile switched the reference. Four layers of anti-flap: notifications publish through a three-tier gate (raise = first publish or state change, visual+sound; amendment = same state, new GDACS figures, visual only so sounders stay quiet; identical = silence); once raised, a cyclone notification latches — it stays warnable while the storm exists in the GDACS envelope at any alert level (the wide green filter feeds a new `retainLatched` carry-over) and clears only after an hour out of the matrix; the hazard filter admits via either envelope (1000 nm from the vessel or 500 nm off the route) instead of letting the closer reference tighten the band; and acknowledgements are level- and distance-aware, persisted on disk (`hazards-state.json`, 7-day prune) so restarts stay quiet — only a strictly higher level (orange → red) or a storm closed to half the acked distance re-alarms. GDACS refreshes now amend the notification text in place rather than clearing and re-raising.
- A `weather_source: "weather-api"` configuration on a server without the Weather API provider crashed `start()` outright — taking the warnings console, the bulletins and the hazard escalation down with it. The misconfiguration now degrades to Open-Meteo for the session and logs the error, so the rest of the plugin keeps working.
- Graceful-degradation regression suite (`tests/plugin-degradation.test.js`): the plugin boots and serves empty states on a bare server — position available, but no Weather API provider (auto falls back to Open-Meteo and briefs), no active route (here mode), no energy predictor (empty `energyHourly`/`energyEvents` ride the payload), no polar management (`/api/polar` serves null, webapp falls back), no Resources API (`/api/routes` serves 501), link never online (refresh 503, briefing `cached: false`), and the hazard escalation stays quiet over empty caches.
- A TC Wati storm warning (FQPS01 NFFN 2026-10-16 fixture) parsed geometry-less and was dropped whole by the track filter — the one bulletin the console must never miss. Four parsing gaps fixed: the GMDSS section anchor matched any line starting with "FORECAST" (the warning's own "FORECAST POSITION NEAR…" line split the warning section in half, leaving gale headers and cancel notices floating unanchored), so the bare `FORECAST`/`WARNINGS`/`SYNOPSIS` anchors now require heading-only lines; NFFN spells the hemispheres out in cyclone positions ("NEAR 12.1 SOUTH 163.0 WEST", line-wrapped anywhere), which defeated both the NEAR extraction and the coordinate parser — the paired lat+lon form is now contracted to the letter form in boilerplate stripping, leaving prose ("5 SOUTH OF T1") untouched; storm-declaration detection runs per paragraph inside the block, so a coalesced block leading with the "PART 1 : WARNING STORM WARNING 012" header still types as its storm's point (kept on any track) instead of merging into a geometry-less discard; and quadrant wind-radii lines ("WITHIN 95 NAUTICAL MILES IN SE QUADRANT") coalesce onto the storm's point anchor rather than the nearest area, so the full wind field rides with the warning. The result: a vessel far outside the warning areas still reads the complete storm warning, a vessel inside the gale polygon reads it whole (header, area, cancel notice), and "WITHIN 300 NAUTICAL MILES OF TROPICAL CYCLONE WATI CENTER" resolves through the collected feature instead of stopping at "OF TROPICAL".
- The `S OF`/`N OF` latitude abbreviations matched mid-word — "BETWEEN OF 16S" read as "…BETWEEn OF 16S" and clamped the band to 16S — so NFFN's stray-"OF" latitude-band phrasing ("IN THE AREA BETWEEN OF 16S AND 22S AND BETWEEN 156W AND 169W") widened to a pole-to-pole band. The abbreviations now require a word boundary, and the BETWEEN latitude pair parses as the band it states (16S–22S).

### Changed
- The energy predictor and polar management moved from the Signal K metadata's `requires` to `recommends`: the plugin consumes them purely through Signal K paths and the resources API, and the degradation suite proves it briefs, serves and escalates without either (built-in fallback polar, empty energy outlook). `signalk-internet` stays required — the online window drives every fetch gate.

## [0.12.3] - 2026-10-16

## [0.12.2] - 2026-10-16

### Changed
- Briefing payloads stopped carrying every forecast hour at every waypoint: the waypoints now ride an ETA-window throttle (a 15-waypoint / 7-day route went from ~1 MB to ~340 KB of JSON with no rendering change). The window opens 12 h before the arrival a fast boat (10 kn) would make and closes 48 h after the arrival a slow boat (2.5 kn) would make — steps outside are dropped, since the boat reads its neighbouring waypoints' data then — and inside the window the hourly steps beyond the first 24 h collapse to every third hour, the wave models' own native resolution (`weatherAt` interpolates). The horizon's last step always rides along (the simulator clamps to it), a guaranteed minimum span keeps coverage when the speed estimate is badly wrong, and the throttle applies to both source paths (Open-Meteo and the Weather API provider).

### Fixed
- The webapp console logged three requests that could never succeed (work doc #40/#30 session report): the "Next" compile pill and the sea-legs day checkpoints called `/api/api/status` and `/api/api/sea-legs` — a stray `api/` segment doubled into the plugin base ever since those two UI pieces shipped, 404ing on every load and silently hiding both features. The URLs now match the registered routes. The critical-hazard banner polled the Signal K REST notifications subtree (`vessels/self/notifications/navigation/briefing/hazards`), which 404s whenever no notification was ever raised on the server; the escalation's active list now also serves from the plugin's own `GET /api/hazards/active` (same data the delta stream carries, empty list when nominal) and the banner polls that.
- The route briefing had no manual refresh affordance on a fresh cache: the "Update now" button only existed in the no-cached strip and the outdated banner, so the crew couldn't regenerate an up-to-date-looking briefing (e.g. to pick up the throttled payload shape or a fresher forecast) — while conditions-here always carried its card-head button. The tactical view's "Next 24 Hours" card head now carries the same "Update now" in the same place, wired to the route refresh and disabled offline like its here-mode twin. The root also imports the components it instantiates — its connectedCallback runs during customElements.define, so the first renderRoute created an un-upgraded tactical-dashboard whose methods did not exist yet, aborting the boot with `tactical?.setOnline is not a function` on pages that loaded only the root module first.

## [0.12.1] - 2026-10-16

### Fixed
- Comfort tiers read "No data" on the Open-Meteo source path: the pinned GFS wave model (`ncep_gfswave025`) does not publish Open-Meteo's `wave_peak_period` variable at all (verified live: all-null at every hour while `wave_height`, `swell_wave_period` and `wind_wave_period` answer), so the Sereno resonance gate (`hsMeters != null && tpSeconds != null`) never passed. The fetch now also requests the mean `wave_period` series and falls back to it when peak is absent — a slightly different statistic, but the comfort model gets its period on every source path again. (The Weather API provider path, which maps `water.wavePeriod`, was never affected; briefings served by it kept their tiers.)

## [0.12.0] - 2026-10-16

### Added
- Proactive spinnaker-aware sail recommendations (work doc #41): the sail inventory's downwind sails (parasailor, gennaker, code zero, spinnaker — classified from the configured type and name, served on `GET /api/sails` and threaded into the simulation worker) are recommended for deployment when the forecast hour sits in the slatting regime on a reach or run — residual swell with too little true wind to keep the working canvas loaded, evaluated with the sail state unknown so the plan's rig cannot suppress its own regime — and the sail's envelope covers the conditions. The honest gates: under ~2 kn apparent wind the sail will not fill, configured wind limits bound the envelope (a conservative default ceiling replaces the learned one until the logbook teaches it), forecast gusts over the sail's maximum kill it, squall-risk hours, probable rain squalls and convective-air hours kill it, night kills it by default (configurable), and a qualifying stretch must hold the minimum deployment window (3 h — the hassle threshold; a two-hour blip gets no recommendation). The inventory's momentary `active` flag is not a gate — it means "currently flying right now", so a stowed Parasailor stays recommendable. The payoff is the with-sail tier recomputed from the row's raw motion acceleration and apparent wind, not the slatting-forced tier the plan's unknown rig would carry. The timeline renders the deployment in the sail-work style with the honest payoff (the worst tier the window holds) and the retract boundary's named reason: "Deploy Parasailor · holds Easy instead of slatting · until nightfall". Backtest validation against the logged Parasailor days (doc plan step 4) is follow-up work.
- Tropical-system tracking in the METAREA bulletin pipeline: RSMC Nadi-style declarations (`TROPICAL DEPRESSION 01F CENTER [1000HPA] WAS ANALYSED NEAR 10.1S 163.4W`) are collected as named features and kept on any track — a depression 650 nm east may still develop or head toward the boat, so the console shows the system wherever it is in the bulletin's waters. Its analysed position becomes the block's geometry (new `point` type, plotted as the note position by the notes publisher), blocks that distance themselves from it by name (`WITHIN 180 NAUTICAL MILES OF TD01F, EXPECT CLOCKWISE WINDS…`) now place themselves as a padded area around the centre instead of surviving as unplaceable fragments, and chain endpoints referencing it (`… 05S 161W TO TD01F`, `TROUGH T2 FM TD01F TO …`) splice the position into the chain. Named trough/front endpoints (`TO L2 TO L1`) resolve the same way. Fixture: the 2026-10-15 FQPS01 NFFN bulletin.

### Fixed
- Warning-section prose fragments no longer float: a bare "PART 1 : WARNING GALE WARNING 004…" header or an "AREA OF GALES SLOW MOVING." trailer carries no geography of its own, so it now lives or dies with the area paragraph it describes — a discarded area takes its warning header with it instead of leaving an unanchored fragment on the console, and a kept area reads as the complete warning (header, area, trailer, cancel notice) as one block. Anchoring is by extracted geometry, so a cardinal-bounds area ("BETWEEN 107W AND 116W", no coordinate pairs) anchors itself instead of merging into a coordinate-bearing neighbour. Only pure-prose fragments attach, so a spliced stray coordinate can never corrupt a neighbour's chain; a block with coordinates that still places to null keeps its own conservative severe-keyword keep, and a section with no anchored block at all (a text-only warning) passes through unchanged. Synopsis/forecast sections are untouched — per-paragraph filtering stays.
- OCR misread of the digit zero as a letter O (`NORTH OF O5S`) lost the latitude bound and widened the area to a pole-to-pole longitude band, keeping far-away waters on the console; an O opening a number run in these all-caps bulletins is always a zero.

### Fixed
- Solar eclipses at the sunrise edge were silently dropped: the solar-eclipse visibility gate compared the refracted Sun's centre altitude against the horizon, so an eclipse whose peak lands while the Sun's centre is still below the horizon but its upper limb has risen (refracted centre −0.11° on the 2021-06-10 partial from the US east coast) never reached the briefing even though it passes the sunrise-based horizon check the rest of the module's rise/set semantics use. The gate now uses Almanac's `sunIsUp` helper (bumped `@openwaters/almanac` to ^0.10.0 for it); the cloud gate and failure fallbacks are unchanged, as are the nautical-night and lunar-eclipse twilight thresholds.

## [0.11.1] - 2026-10-15

### Added
- Regime awareness in the route timeline and strategic headline (work doc #39): the fetch engine annotates each waypoint with its distance to land via the maritime-zones reader (tiles cached on disk, failures degrade to absent), the simulator classifies each hour's waters (archipelago/coastal/offshore) and fires timeline entries when they change as the boat moves, day checkpoints name their regime, and the strategic ETA table gains a Waters row with the per-day run-length summary.
- Route-list performance (bergie session perf pass): /api/routes serves from a stale-while-revalidate cache — the server's resources listing costs seconds per call regardless of payload, the list changes rarely, and only the active route's distance is computed (inactive weather-routing routes can be numerous and need nothing but name and id). The active flag and distance are stamped at serve time so a route switch reads correctly immediately.
- Downwind-sail deployment recommendations (work doc #41): the advisor runs before the comfort evaluation — forward horizons from the forecast (wind envelope, squall risk, night gate with continuation-not-start, sea-state ceiling, watch anchoring via the crew's handover schedule), and an established window (3 h+ hassle threshold) supersedes the slatting penalty it relieves: the Parasailor is up, drawing, damping the motion by the measured 0.78 ratio, with the rows marked so the crew knows the tier assumes the sail is up. The timeline renders deploy and take-down entries (anchored to watch changes, take-downs naming the breaking gate) plus pole advisories for deep runs past 150 deg TWA. Claims per class: the Parasailor's comfort claim is the measured one; reaching sails claim drive. Empty inventory keeps the advisor silent.
- Simulated rig feeds the three-way slatting rule: the simulator's modeled sail state rides in the vessel for `serenoComfort` — canvas up reads as sailing (motor-sailing keeps the sails drawing), NO_SAILS as motoring, an unset state keeps the legacy behavior — so the backtest-validated rule reaches the briefing itself and light-air motor-sailing with canvas up no longer forces Rough.

## [0.11.0] - 2026-10-15

### Added
- Blog backtest pilot (`bin/blog-backtest.js`): replays sailed days from the Lille Ø blog through the Sereno comfort model and sets the result against the crew's own words — the day window comes from consecutive blog `created` stamps, the crewed log entries (sail states, the crew's Douglas sea-state observations decoded from the logbook's Beaufort code) come from the logentries resource API, wind/speed/attitude/current/depth come from onboard history at the stored resolution, historical ERA5 waves and surface currents come from the Open-Meteo Marine archive at four track points (Pierson-Moskowitz wind-sea approximation as the labeled fallback), hours underway (hourly mean SOG ≥ 1.5 kn, overridable by sparse `navigation.state`) render per hour with archive-wave and PM tiers, the AWS/motion sub-tiers, measured attitude-reconstructed acceleration (steady hours only), and relative sea, current and land-lee angles, followed by day histograms, an inshore/offshore regime classification from sounding plus maritime-zones distance-to-land, and the quoted blog text. Summarize mode (`--summarize`) aggregates confusion matrices model-vs-narrative and model-vs-crew, the harshness-axis decomposition, slatting-by-AWS-and-wave-angle buckets, sea-legs passage-day gaps and current-opposition bins. Smoketests in `tests/blog-backtest.test.js`.
- LLM labeling pass (`bin/blog-llm-labels.js`): the one-time structured reading of every blog entry through the Cortecs API — comfort tier for the sailing parts only, narrative scope (sailing/anchored/mixed/land), slatting mentions with mitigation flag, fatigue, and the verbatim condition words — as the careful reading the keyword regexes cannot do; the labels join the summarize step via `--labels` for a scope-aware model-vs-LLM comparison.
- METAREA console area gating (bergie session, Tonga fix): the console headline belongs to the newest bulletin whose blocks actually match the vessel's waters, not to the newest cache entry whatever ocean it came from — a North Pacific synopsis ("LOW 59N167W … N OF 50N BETWEEN 170W AND 180W") no longer replaces the Fiji METAREA XIV warnings in Tonga. Entries and blocks whose own coordinates place them elsewhere are discarded even when severity keywords would have rescued unplaceable text; the standalone /api/bulletin route filters against the vessel position instead of an empty track; and the cardinal-bounds parser now accepts the NWS "N OF"/"S OF" abbreviations, so latitude bands no longer default pole-to-pole.
- Polar day/night naming (work doc #40 session feedback, prompted by signalk-energy-predictor #6): the celestial night entries classify each span explicitly (`polarNight`/`midnightSun` via an hourly altitude scan — no event-based no-crossing branch), the sky line says "polar night" / "midnight sun" instead of staying silent, and the route timeline fires entries when the sun regime begins or ends as the boat sails. The moon's once-a-month missing crossings read as "up all night" / "down all night" instead of stamps borrowed from a neighbouring night (the confusing new-moon numbers), and the night anchor falls back to civil dusk where nautical dusk does not exist.
- Sea-legs passage counter (work doc #40, informational): the plugin derives a restart-safe passage start by scanning the History API's navigation.state backward for the last stopped-to-underway transition (a stopgap behind a swappable seam until Signal K's trips resource lands), serves it on GET /api/sea-legs, and the route timeline gains neutral "Day N at sea" checkpoints on each passage day. No threshold math: the 470-day backtest found no support for exposure-based comfort easing — the crew-facing context stands on its own.
- Squall-risk episodes in the route timeline (`public/route-sim.mjs`, `public/components/models.mjs`): hours where the forecasted gust reaches 16 kn and at least double the base wind merge into a "Squall risk" timeline entry carrying the peak gust factor — the forecast itself saying the air is squally, where canvas may need to come off for the gusts and the reduced canvas then slats in the lulls. Gusts ride the hourly rows but deliberately never enter the comfort model: the 470-day backtest showed gust-peak tier evaluation overcalls the trades (hours with gusts 2+ bands above the mean sit predominantly on champagne/easy days).
- Slatting three-way rule in `public/sereno-physics.mjs` (`slattingRisk`): drawing sails suppress the forced-Rough flag, motoring keeps it only into steep head seas (Hs/Tp² at or over 0.02 — the 2022-09-12 broken-cars family), unknown sail state keeps the legacy behavior; sail state rides in `vessel.sailState`. Validated on the 470-day backtest harness: 53 days improved against the LLM narrative readings, 0 genuinely regressed (6 apparent regressions were histogram tie-break artifacts), harsher-rate down 10pp offshore / 4pp coastal / 2pp archipelago, protected gale days held at sporty-or-worse on motion alone. Sub-3 s encounter-period floor (`encounterPeriodFloorSeconds`) from the same harness pass: waves shorter than the waterline are bridged, not followed — 254 Baltic chop hours softened a tier, protected set untouched.
- Archive gust backfill (`bin/blog-gust-backfill.js`): ERA5 `wind_speed_10m`/`wind_gusts_10m` per hour onto the blog backtest dataset at the four track points — the gust-peak ground truth the onboard gust column cannot provide for the early years, plus the per-hour gust factor and an archive-vs-onboard sensor sanity check. Compare mode (`--compare baseline candidate`) turns the tool into the regression harness for comfort-model changes: protected-set violations (gale and crew-D5+ days must not read calmer), per-regime harsher-rate deltas, and LLM-label day-agreement movement.

## [0.10.0] - 2026-10-14

### Added
- Rain-shower episodes on the unified timeline (probable squalls): Open-Meteo `precipitation` (hourly mm/h) and `precipitation_probability` join the fetch, ride `weatherAt`'s interpolation under the same unknown-stays-null rule as cloud cover, and hours at or over the shower bar (≥ 0.5 mm/h rate or ≥ 50 % probability — whichever the model still publishes at that horizon) merge into contiguous `rainEpisodes` carrying the peak rate and probability. They render as info-level 🌧 timeline entries (“Rain showers · 2.5 mm/h · 80 % · until …”) — tropical rain rarely arrives without squalls, so probable rain is the crew's probable-squall advisory without claiming convection's warning weight. The sky line on tactical and here gains the now rain segment above the same bars (🌧 65 %, or 🌧 0.8 mm/h when the model publishes only a rate — drier hours stay quiet); Weather API provider mode publishes no precipitation fields and degrades to absent rather than inventing them.

### Changed
- Two comfort tiers renamed for the project's modified Sereno scale — `coffee` is now `sporty` ("Lively enough that a hot coffee needs a firm grip.") and `sick` is now `miserable` ("Nobody is enjoying this. Seasickness very likely.") — the canonical identifiers everywhere: physics module, CSS tier tokens (`--comfort-sporty`/`--comfort-miserable`), the embed widget's color map, the status-tile example mapping, and the Signal K value the plugin publishes. Briefings compiled before the rename serve raw old tier names — unstyled, never wrong-colored — until their next compile rewrites them; no compatibility mapping, one unambiguous scale.
- Sail-change and maneuver timeline entries name the point of sail: `Genoa 1 + Main — broad reach · 9.5 kn TWS · Hs 1.1 m · coffee · at dawn`. The signed TWA at the change point (nearest hourly step, wind-from-starboard positive, same convention as the maneuver tack calls) rides the event's conditions block as `twaDeg`; the timeline renders it as the standard angle-band text (close-hauled / close reach / beam reach / broad reach / running, sign-blind since the maneuver label already calls the tack). Payloads compiled before the field degrade to the previous detail line without inventing an angle.

### Fixed
- Conditions here showed two "Update now" buttons stacked when no cached conditions existed: the no-cached-conditions strip carried its own button while the conditions card head directly below always carries one. The strip now stays text-only in here mode (the card-head button is the refresh affordance there, present with and without cached data); the route-mode strip keeps its button, as the tab views have no other on-screen refresh.
- The comfort-scale legend (the ℹ️ popover) opened past the right edge of a phone screen, dragging the page into a sideways scroll with half the legend unreachable. While open it now pins to the viewport — clamped inside the window on both axes, flipping above the summary when the space below runs out, internally scrollable when taller than the screen, and repositioning on scroll, resize and tier-highlight changes.
- The conditions-here celestial & space events card rendered raw ISO timestamps (`2026-10-12T07:06:12.650Z Tiangong pass: …`) instead of the app's formatted stamps: the renderer read a `stamp` field the plugin never sets, falling through to the raw event timestamp. Events now render through the shared ship's-time formatter like every other view (`MM-DD HH:MM` with the zone offset, `MM-DD HH:MMZ` in UTC when the vessel publishes no timezone), per the Signal K visuals time-formatting rules.
- Energy timeline events rendered their detail stamps in UTC (`battery depleted by 06-22 03:00Z`) while the same rows' timeline stamp renders in ship's time — a leftover from before the ship's-time work, forcing the crew to do arithmetic between two renderings of the same instant. The `until`/`battery depleted by` details now use the shared ship's-time formatter like every other stamp.

## [0.9.0] - 2026-10-12

### Added
- The header always names when the served briefing was made: a quiet `Compiled MM-DD HH:MM` pill next to the connectivity and ship's-time pills, stamped from the payload's `fetchedAt` in ship's time on every load (route and here modes alike, any age — the stale-age banner stays the alarm past 24 h, this is the fact next to it). A briefing with no fetch time hides the pill rather than inventing a stamp; the label re-renders when the vessel's timezone arrives.
- The header names when the next briefing is scheduled: a quiet `Next MM-DD HH:MM` pill beside the Compiled stamp, showing the state machine's next cron window in ship's time (from `/api/status`, fetched with each briefing load). It hides when the plugin serves none — offline, or no cron scheduled — the same hide-rather-than-invent rule the compile stamp follows, and a hover title notes that a manual update can land earlier.
- Eclipse and moon-phase sky events (work doc #35): the ephemeris now emits discrete moon phase instants (`moonPhase` notes — "New Moon — darkest skies of the passage", "Full Moon — moonlit night watches") and visible eclipses with almanac's built-in observer visibility — lunar eclipses gated on the Moon up at peak, the Sun below the civil twilight line and the cloud gate; solar eclipses on the Sun above the horizon and the cloud gate. Timeline and here-view sky cards carry them like every other event; nothing new is fetched, all local computation. Like every computed-on-board item they carry no provenance record (work doc #31: absence never implies external authority) — pinned by a regression test so the weather provenance chain never leaks onto sky rows.
- Reentry watch and visible launches (work doc #36): the briefing now answers "could we see that from here?" for the two rarest sky events. Predicted satellite reentries come from Space-Track's TIP messages (the only machine-readable decay forecast; a free account configured once in the plugin, degrading to off without it), refined by CelesTrak element sets and propagated on board with the same SGP4 propagator as the station passes — the visible-event gate models both regimes the Cluster II SAMBA/TANGO deorbits taught us about: fireball at night out to the geometric horizon of the burn altitude (~1000 km), sunlit smoke streak by day readable only close, everything else correctly silent (the backtest that proved the Aitutaki→Niue crew could never have seen those two is now a permanent fixture test). Visible rocket launches come from Launch Library 2 (no account) and fire only for the classic twilight geometry — pad within ~650 nm and the observer in twilight while the vehicle climbs into sunlight — with the bearing to the pad and an honest windows-slip caveat. Both sources follow the house fetch rules: online-window fetches, data-directory caching (TIP 12 h, launch schedule 6 h, stale cache still answers offline), per-source status in the registry with the unconfigured reentry source recorded as absent, and every failure degrading to no events.
- Eye height above the water as plugin configuration (`celestial_eye_height_m`, default 0): sunrise, sunset and moonrise/set stamps in `celestialNights` — the timeline's night rows and the conditions-here sky line — correct for the dip of the vessel's raised horizon (a couple of minutes from cockpit height). Twilight lines are altitude angles, not horizon crossings, so they stay put.

### Changed
- Meteor showers are evaluated per night, not per peak instant (work doc #37): each shower's nominal peak is judged against the nights bracketing it — the peak night plus its neighbors, since real maxima drift ±1 night — at each night's nautical-dusk anchor, with the radiant altitude checked at the **forecasted position of that night** from the simulated track. A shower whose catalog peak hour lands in local daytime now fires for the dark nights around it instead of vanishing (the Eta Aquariids from New Zealand: 14:00 peak hour, radiant near zenith, moon dark — previously unreportable); descriptions word the bracket nights honestly ("climbing toward the peak" / "just past peak") so no night claims a maximum its darkness never held. The evaluation lives in a shared dependency-free module (`public/components/meteors.mjs`) run where the track lives — the simulation worker computes the route timeline's meteor nights from the track exactly like the sail changes, while here-mode payloads keep them from the server at the vessel position; route payloads no longer carry fixed-position `meteor` entries, so nothing double-reports. The static annual calendar stays (IMO publishes tables, not APIs) but moves into the shared module with its thresholds.
- The test runner no longer uses `--test-force-exit`: the flag was intermittently killing suites whose subtests register on timers, undercounting the run while everything passed. Without it the whole suite exits cleanly and the count is stable.
- The ephemeris engine is `@openwaters/almanac` (MIT, the maintained TypeScript port of astronomy-engine at a pinned commit, checked against JPL/USNO/Espenak fixtures over 1950–2100), replacing astronomy-engine — same math lineage and accuracy class, 21.9 KB vs 44 KB, and the twilight chain collapses from three chained searches to window event lists. Rise/set stamps shift by seconds (almanac uses the Sun's true semidiameter instead of a fixed −0.833°); everything else stays behaviorally identical. The npm package is ESM-only, loaded through `require(esm)` — the minimum Node moves to 22.12.0.

## [0.8.1] - 2026-10-08

### Added
- Branding on the webapp page (per the Signal K visuals spec): the plugin's app icon (`icon-256.png`) serves as favicon and the base canvas color ships as the `theme-color` meta, so browser chrome matches the console background in both day and night modes.

### Fixed
- The per-minute source-status tick no longer touches the logbook — fixes "Server unreachable: Fetch is aborted" with an empty route picker on production since 0.8.0. The checklist's logbook probe went through the resources API, whose `logentries` provider answers even a `limit: 1` listing by reading and schema-validating every day file — on a multi-year log that meant overlapping full-store scans every 60 s starving the server so `/api/status` and `/api/routes` blew the webapp's 8 s abort timeout. The logbook is a once-used learning resource (backfill), not an ongoing ingest source, so it leaves the data source statuses entirely; with no provider installed, backfill now fails loudly with the reason instead of silently reporting zero events.

## [0.8.0] - 2026-10-06

### Added
- Conditions tabs on the unified timeline (work doc #18): each entry carries a small colored tab on its left edge — the comfort tier color the tactical sparkline paints at that hour, so the passage's weather development reads at a glance. The tier comes from the simulated track's nearest hourly step; sail changes keep their own enriched conditions block as the authoritative tier, slatting renders as the sparkline's hatch stripes, and entries outside track coverage degrade to the unknown gray instead of inventing a tier.
- Provenance on every estimation and warning (work doc #31): a compact ↗ affordance where an external origin or on-board viewer exists, deep-linked to the specific record rather than a site front page — GDACS events link their gdacs.org event page (hazard notes on the timeline carry the same page through from the note), CAP alerts the sender's info page (feed URL as fallback), bulletin console blocks the feed rung the text arrived from, zone transitions the exact Marine Regions gazetteer record keyed by the boundary zone's MRGID (search-by-territory fallback when a source carries no MRGID; the here view's waters-you-are-in zone names link their records too), satellite passes a live tracker page keyed by the NORAD catalog number parsed from TLE line 1, and weather the on-board viewer deep link (`signalk-weather-map` webapp with `lat/lon/time/layer`, detected via the server's registered webapps — absent siblings serve no dead links) plus the external Open-Meteo forecast page rewritten to the item's own position: a simulated item links the patch of ocean the boat plans to be at, not the departure. Computed-on-board items carry no glyph: absence never implies external authority. Sky-event and official-alert rows on the conditions-here view get the same treatment.
- Night-darkness cloud cover (work doc #32): Open-Meteo `cloud_cover` rides the simulated track (interpolated in `weatherAt`, hourly rows and the compact `passageSummary.track`; unknown on either side of a span stays null, never blended or invented) and is stamped on every timeline item at its hour. Night entries render a ☁ beside the moon glyph, opacity scaling with cover (every night entry with a known cover carries the mark — clear nights show it faint, so an absent mark unambiguously means the source publishes none); night ETA rows in the strategic outlook get the same mark; provider mode stays honest with the moon glyph alone.
- Sky times on tactical and here (work doc #33): `celestialNights` entries gain `sunrise`/`sunset`/`moonrise`/`moonset` from `astronomy-engine` rise/set searches (null-degrading across polar day/night), and both views render a compact monospace sky line — sunset, nautical dusk (the briefing's night boundary), the moon's rise/set within the night window, and the now cloud cover from the first forecast step — so watch planning reads off one line instead of guesswork around dusk. Also fixed the conditions-here CAP empty state early-returning before the waters-you-are-in card could render.

### Changed
- The briefing refresh button reads "Update now" instead of "Fetch now" (matching loading strips "Updating briefing…" / "Updating conditions…"): from the crew's side the action regenerates the briefing with fresh weather — the fetching is the plugin's business, not the button's.

### Fixed
- The critical-hazard banner rendered always — an empty red strip with an ACK button above the webapp header even with no active alerts: the banner stylesheet's `display: flex` beats the browser's built-in `[hidden] { display: none }` regardless of specificity, so the `hidden` attribute did nothing (the `.tab-bar` already carried the `[hidden]` antidote; the banner and the embed-mode header now do too). With the bar permanently visible but empty, ACK had nothing to acknowledge. Also fixed red-on-red text: the banner painted message and background with the same `--color-red`, so a real emergency's message would have been invisible — text now uses the base canvas color per the codebase's text-on-color pattern.
- CAP alerts whose `<instruction>` carries a bare placeholder — PTWC ships a literal "N/A" on its tsunami information statements — rendered "N/A" as the crew's action line; the parser now treats the placeholder as no instruction, and the Official Alerts card renders no action row for them.

### Changed

- Logbook reading moved from signalk-logbook's on-disk YAML store to the Signal K v2 Resources API: the plugin now consumes the `logentries` resource type (the contract signalk-logbook documents in `docs/logentries-resource.md` and serves as its reference provider) through `app.resourcesApi` — in-process, no tokens, no filesystem coupling to another plugin's storage layout. The reader normalizes the resource representation at one boundary (`navigation.position` pathvalue for position, `environment.wind.speedOverGround` m/s → kn and `environment.wind.directionTrue` rad → deg for the wind snapshots); the sail-text parsing and event classification are unchanged. The source-status checklist row probes the resource type instead of the store directory. `bin/backfill-report.js` reads over the REST surface (`--url`/`--token`, a `readonly` token suffices) instead of a local YAML copy — usable ashore against any reachable server. The `yaml` dependency is dropped.

## [0.7.1] - 2026-10-05

### Fixed
- Notes resource `bbox` queries crossing the antimeridian now match notes on both sides of 180° (`plugin/notes-store.js`): a west edge east of the east edge — the natural way to frame a Pacific box around the seam — previously matched nothing, since no single longitude is simultaneously ≥ 170 and ≤ -175. Such a box now wraps the seam (matching west of the east edge or east of the west edge); regular west≤east boxes behave exactly as before

## [0.7.0] - 2026-10-04

### Added
- CAP (Common Alerting Protocol) source (work doc #24): official structured warnings as a second ingestion channel alongside the free-text bulletin pipeline. Feeds: direct CAP documents (the NWS Pacific tsunami center's PHEBCAP.xml is the default) and Filtered Alert Hub aggregations whose RSS items link to per-alert CAP documents (newest followed, bounded). The parser maps CAP's own geometry — polygons with the latitude-first order flipped (the classic CAP integration trap, regression-tested), circles approximated, zero-radius circles as placeable points — onto the bulletin-engine's geometry types and reuses its track-intersection tests. Severity gate (default Severe and above), deterministic `<expires>` expiry, identifier-based dedup with repolls updating in place. Surviving alerts ride the payload as `capAlerts`, render as an "Official Alerts" card in the tactical, strategic and conditions-here views — visually separate from the METAREA text (severity-coloured, expires stamp, instruction text attached), with an explicit "No official alerts in effect for these waters" empty state so silence is distinguishable from a dead feed — and publish as chart notes with the native polygon carried schema-safely in the note properties (the SK Note schema has no feature field) with centroid placement and scoped expiry. Each configured feed is a row in the #23 data source checklist, success and failure alike. Verified against the live PHEBCAP document and the live Filtered Alert Hub unfiltered feed.
- Critical hazard notifications (work doc #30): an escalation layer over the warning stream — GDACS events, CAP alerts, bulletin blocks — publishes Signal K notifications for the small subset that qualifies, so the right warnings interrupt dinner instead of waiting for the next glance at the plotter. The matrix requires both a hazard condition and an exposure condition: a GDACS TC at Red/Orange or a CAP hurricane/typhoon event escalates to `emergency` (impact near vessel or route, established by the compile-time filters); a CAP tsunami warning escalates to `emergency` while anchored or moored (a roadstead is shallow by definition) and to `error` when a live depth sounding exists (a transducer reading means shallow) — a tsunami observed in deep open water with no sounding stays a passive event; a bulletin gale/storm block escalates to `error` when its native geometry contains the vessel position *now*. Notifications publish at `notifications.navigation.briefing.hazards.<eventId>` via the standard delta path so every Signal K client sees them; two-cycle hysteresis prevents borderline flapping; acknowledged events are not re-raised until they leave the matrix and return; expiry clears deterministically. The webapp renders an interrupting full-width banner with an acknowledge button on both screens and polls the notifications subtree — an ack returns the notification to nominal for every connected client. Depth presence rides the watched-path subscription. The severity tiers are ordered so escalations stay rare enough to always be taken seriously.

## [0.6.0] - 2026-10-04

### Added

- Timezone change events along the route (work doc #19): the briefing now says when the clock itself changes — the moment a crew sets watches and re-plans arrival in local time. Offshore, the simulated track detects crossings of the 15° zone meridians (short-arc direction from the step's longitude delta, so the antimeridian reads "180°" either way) and the unified timeline renders them as `time` events (◷ glyph): "Crossing 165°E — solar time 1 h ahead/behind — clock change due", advising but never asserting what the crew does with the clock. Crossings inside territorial waters stay quiet — the local zone governs there — using distance stints folded from the plugin's enter/leave transitions. Territorial transitions (work doc #17) are now timezone-annotated: the IANA zone at the crossing point comes from vendored tz-lookup (CC0, ~72 KB single ES module under `public/vendor/tz-lookup/` — resolved by position, which sidesteps the multi-zone-country problem entirely, and consistent with signalk-ships-time's answer) and its UTC offset at the crossing instant from the platform's `Intl` database (DST handled, no dependency); `mergeTimeline` adds the "time zone UTC+13" line when the crossing's offset differs from the vessel's current zone, or when none is published. Stamps themselves stay in the current ship's zone.
- No-sails semantics: slatting and survival regimes (work doc #26). On a cruising boat a logged `NO_SAILS` means one of three things the old pipeline could not tell apart — the slatting regime (apparent wind too low to keep flow attached: canvas down so it stops banging, the engine drives), the survival regime (wind very high: nothing set, nobody motors into it) — or a propulsion/non-passage state (motor-sailing nights, anchorage entries). The learning pipeline now enforces that reading. The regimes are defined in the physics module: `SAILS_FILL_MIN_AWS_KNOTS` (7 kt apparent, mirroring the upwind slatting gate in apparent rather than true wind — motoring into light air is exactly when canvas slats) and `SAILS_MAX_AWS_KNOTS` (45 kt apparent — Beaufort 9 territory, deliberately decoupled from the comfort bands whose 33 kt line marks seasickness, not the rig decision; the vessel carries working canvas standing well into the forties), with `noSailsRegime()` answering slatting / survival / null. The learning gate folds a `NO_SAILS` observation into a rig bin only when its wind window justifies it — the window's average TWS below the point-of-sail slatting gates (7 kt upwind, 12 kt downwind, from the comfort model) or its peak gust at the survival floor; a mid-scale bare-poles observation still caches its wind window (idempotency intact) and stays in the logbook record, but never wins the bin, and the backfill counts it in a new `skippedNoSails` the UI reports ("7 bare-poles entries kept out of the matrix"). The simulation only accepts a `NO_SAILS` suggestion when the step's real apparent wind (boat speed and heading included) sits in a regime, so already-poisoned learned cells cannot depower a passage. The drive under an accepted canvas-down follows one shared rule for rows and events: survival — no drive, the water moves the boat, and the timeline names the decision "Storm tactics" rather than claiming a tactic (heave to, drogue, run off — proper storm tactics are their own work document, #27); becalmed with drift mode enabled — drift on the current alone; otherwise the engine pushes at motor speed with honest motor hours and fuel. A plan holding `NO_SAILS` no longer makes phantom polar speed with zero motor hours. The one-time migration on plugin start clears the learned matrix, its wind-history cache and the recorded events (guarded by `PRAGMA user_version`, logbook files untouched) so the next backfill rebuilds every bin under the new rules — the recency rule had let single bare-poles entries erase a bin's real rig, and that loss is unrecoverable from the matrix alone; empty bins degrade safely to "keep the current rig". **Upgrading crews must run the Logbook Backfill once after starting this version** (the webapp card, or `POST /plugins/.../api/backfill`) — until then the learned plan is empty and the simulation keeps whatever rig the plan already had.

### Changed

- Slatting has a name wherever the comfort tier shows: timeline details at sail changes and sparkline titles read "slatting" instead of the escalated "rough" — a 10 kn afternoon in a residual swell was rendering as weather it isn't, sending someone looking for wind that isn't there. The comfort explainer (ℹ️) carries a SLATTING entry with its thresholds ("wind < 7–12 kn by point of sail · swell ≥ 0.6 m").

### Fixed

- Phone timeline layout: the when-gutter (relative hours + date stamp + moon glyph) squeezed the event text to the side on narrow screens. On phone (below the app's 700 px layout breakpoint) each entry now renders on two lines — the date/time gutter on top at full width, glyph and event data beneath with the whole row's width available. Desktop layout unchanged.
- No more tacks and gybes with canvas down: the maneuver detector's sailing-step test now requires the plan's rig up — a course change under power or carried by the current is not a tack or gybe. This closes a real leak: drift rows carry `motoring: false` and can hold current-driven SOG above the sailing threshold, previously qualifying as sailing steps.

## [0.5.2] - 2026-10-04

### Fixed

- Cached briefings kept serving bulletin blocks computed at compile time, so filtering and parsing fixes only reached the crew after a re-fetch — on the Tactical route view the console still showed the pre-fix boilerplate while the freshly compiled conditions-here view was already clean. The `/api/briefing` serve path now recomputes the merged bulletin console from the bulletin cache against the payload's track on every serve (route and here mode alike, subsuming the old splice-when-missing logic): parsing and filtering improvements apply to cached briefings on the next page load, a payload compiled before a fresher bulletin arrived picks the newer merged view, and a payload whose bulletin cache is gone keeps its own compile-time console.
- Residual bulletin-console noise after the boilerplate rule went live: the EP1 seasonal coverage note ("FROM OCTOBER 15 TO APRIL 1, DUE TO THE CLIMATOLOGY…") survived by enumerating the newly added severity keywords (freezing spray, dense fog, volcanic ash), and the NWS area-header line ("NORTH PACIFIC EQUATOR TO 30N BETWEEN 140W AND 180W") parsed to a pole-to-pole box on its longitude band, intersecting every water on it — visible as far away as Fiji. Fixed both ways: the fixed NWS disclaimer paragraphs (seasonal note, sea-state definition, 1-minute-winds note, tropical-cyclone pointers, ice-free note, outreach appeal) are now stripped whole by their stable opening lines at cruft-cut time, and "EQUATOR" parses as a real southern bound (lat 0) in the cardinal-bounds reader, so "EQUATOR TO 30N" clips to the bulletin's actual hemisphere.
- Severity keyword false positives on product and office names: "HIGH SEAS FORECAST" (the masthead) no longer trips the HIGH SEAS keyword and "NATIONAL HURRICANE CENTER" no longer trips the HURRICANE keyword in the boilerplate classifier, so mastheads and forecaster footers cannot masquerade as warnings. HURRICANE and CYCLONE are now severity keywords (kept in sync with the webapp highlighter, which also gained freezing spray, dense fog and volcanic ash) — hurricane and tropical-cyclone paragraphs highlight and survive the console filter, as the crew intended: a cyclone near our waters is on our radar even when the exact bounding phrase parses loosely.
- The "Warnings On Your Waters" console drowned in bulletin boilerplate (day-one finding from the data-source checklist): the conservative keep for geometry-less blocks meant every NWS masthead, disclaimer ("SEAS GIVEN AS…", "SUPERSEDED BY…", "SECURITE"), section heading and forecaster footer from all four merged bulletins rendered as "warnings" while the actual warning paragraphs were correctly filtered out as off-waters. The block filter now drops blocks that carry neither parseable geography nor a severity keyword — transmission boilerplate is not a warning — with the product name "HIGH SEAS FORECAST" excluded from the severity match so the masthead cannot masquerade as a HIGH SEAS warning. Structured UKHO warnings are unaffected (they are warnings by definition). The severity keyword list gains freezing spray, dense fog and volcanic ash, synced to the webapp highlighter; a warning whose geography failed to parse still survives on its severity alone.
- NWS High Seas Forecast texts via the api.weather.gov product feed began with a `000` frame line and a bare WMO routing header (`FZPN03 KNHC 030838`), which became the bulletin header ("000") and a junk block in the console. The cruft cutter strips digit-only frame lines and routing headers without the trailing `Z`; the product code line (`HSFEP2`) survives and now serves as the bulletin header.
- The NWS api.weather.gov product resolver (configured HSF bulletin feeds) failed with `400 Bad Request`: the API started rejecting the `?limit=1` query parameter the resolver appended ("Query parameter limit is not recognized"), and the second resolution step fetched the graph's `id` field — a bare UUID, not a URL. The resolver now requests the bare locations URL, picks the newest iteration by `issuanceTime`, and follows `@id` (falling back to the UUID in the products URL). Fetch failures now carry the failing URL in the message so the source status checklist row detail names the exact request. Verified live: the NP feed returns the FZPN40 High Seas Forecast text.
- The UKHO structured-warnings source was dead twice over: the `/api/Warnings/Area/{XIV}` JSON endpoint no longer exists (the MSI site is server-rendered HTML now), and it was being queried for every resolved zone although the UKHO only coordinates NAVAREA I — other zones 404 forever. `ukhoWarningsUrl` now returns the Radio Navigational Warnings page for zone 1 and null otherwise, and the page's warning sections (reference, date-time group, full ANMB text in `<pre class="warning-description">`) parse into the same structured warning shape the old JSON fed, so the serve-time filtering pipeline is unchanged. Verified live: 28 in-force warnings parsed with references and timestamps.

### Added

- Data source status checklist (work doc #23): every ingest path — the weather fetch, the per-zone bulletin and UKHO pulls, the configured extra bulletin feeds, the synoptic chart rasters, the GDACS hazard feed and the local celestial ephemeris — now records the outcome of its latest cycle in a persistent per-source registry (`plugin/source-status.js`, survives restarts in `source-status.json`), and the webapp renders it as a collapsed-by-default checklist card in the strategic outlook. Error classification is coarse and stable (`http-404`, `http-429`, `http-4xx`, `http-5xx`, `timeout`, `network`, `parse`, `unavailable`) so a moved URL reads differently from a dead host; cycles skipped while the boat is offline record as `offline-skipped` and never count as failures — an offline boat shows a wall of `[ SKIP ]`, which is correct information, not an error state. The checklist also covers the Signal K side: the subscribed paths the state machine and payload compile consume (internet state, navigation state, house SoC required; active route and the energy outlook optional) and the resource sources (route resources, polar, ship's time, logbook) record availability every ticker minute — a required path with no value since startup reads `[ FAIL ]`, an absent optional source renders muted `[ N/A ]`. Brackets: `[ OK ]` green, `[ WARN ]` orange (429/parse failures, or success stale beyond the source's expected refresh interval), `[ FAIL ]` red, `[ SKIP ]`/`[ N/A ]` muted; the summary line ("12 sources, 1 FAIL") stays visible while collapsed, rows expand to URL, last success, classified error and consecutive-failure count. Served at `GET /plugins/signalk-passage-briefing/sources` for external diagnostics; polling at a minute rate, rows update in place.

## [0.5.1] - 2026-10-03

### Fixed
- Duplicate satellite-pass lines (ISS ×2, Tiangong ×3): CelesTrak's stations group lists several catalog entries per crewed station — the docked modules ISS (ZARYA), ISS (NAUKA) and CSS (TIANHE), CSS (WENTIAN), CSS (MENGTIAN) — all mapped to the same display name, so every pass was propagated and reported once per module. `parseTLEs` now keeps one element set per station, preferring the core module's (ZARYA, TIANHE).

## [0.5.0] - 2026-10-03

### Added
- The plan anchors to actual route progress (work doc #28, compile-time trim): the briefing is forward-looking — when the course provider reports the vessel navigating the briefed route (`navigation.course.activeRoute` with `pointIndex`, verified against `@signalk/course-provider`'s published shape, `reverse` honored), the plan starts where the boat is and sails to the point it is heading for, then the remaining points. Sailed legs drop out; ETA, comfort, sail work, lines of interest, landfall and territorial waters all describe the remaining passage, and events in already-sailed water disappear naturally. The payload stamps the trim point (`trimmedFromNm`, the boat's distance along the original plan); no progress (or a briefing for a non-active route) serves the full plan exactly as before.
- Daylight-anchored departure time (work doc #15): while the boat is moored, the whole forecast schedule anchors to a realistic departure instead of "now" — nobody casts off at 02:40 because the forecast said so. Auto mode: underway sails from now; night at the start position waits for next first light (civil dawn, −6° sun altitude at the route's first waypoint); day adds the prep delay (1.5 h, configurable 0.5–3) unless the sun would set within it, in which case the anchor is the next dawn — never an immediate departure right before dark (the recorded decision). The pure helper (`assumedDepartureTime` in sereno-physics) detects a rising sun crossing with 5-minute steps bounded at 18 h and states what it assumed (`reason`), including a polar `no_dawn` fallback. The tactical and strategic views share a departure control (Auto / Now / First light / +1 h / +2 h / custom) whose manual choice overrides auto until it is put back; the root owns the state, re-checks the anchor every 10 minutes, and re-simulates only when the anchor moved more than 10 minutes so the view doesn't flap around dawn. The tactical chip states the anchor ("First light 10-05 06:00 +13"), the strategic ETA header says "Assumed departure first light …" ("Underway — from now" when sailing), sparkline titles read wall-clock stamps while shifted, and a delayed departure appears in the timeline as a ⚓ event ("Departure at first light" / "Departure after prep"). The served payload carries the same `departure` metadata so external consumers see numbers consistent with the auto assumption. While underway the plan keeps advancing: navigation.state rides the live stream, so a moored → underway flip re-anchors to now immediately and the 10-minute check keeps the schedule fresh. SPEC §2.1/§3.1 updated.
- Energy forecast consumption (work doc #10): the briefing finally powers its energy views — in the predictor's own terms. signalk-energy-predictor's hourly forecast (`electrical.energy.prediction.forecast.hourly`, the whole 48 h series as one delta value) and its outlook paths (`status`, `net`, `surplus` + window, `timeToEmpty`) are subscribed like any other Signal K path; the hourly series adapts into the frozen `energyHourly` consumer contract at compile time (the contract's `solarWh` carries total ideal generation: solar + wind + hydro + alternator) and rides the briefing payload so the offline hours re-derive from the cache. The 24 h solar-yield strip and the deficit banner work for the first time; the conditions-here view gains an "Energy 24h" line (the passage strip's here-mode sibling at SOG 0). New in the timeline: the predictor's own energy events — **surplus** is forecast curtailment (battery full while yield continues; the event carries the curtailed Wh and its window, "run opportunistic loads"), **deficit** and **critical** come from the outlook status (the event carries the 24 h net and, when the trajectory names one, the depletion time) — no independent re-derivation with invented thresholds.
- Territorial waters transitions along the route (work doc #17): the briefing now says where the route crosses the boundaries that change the practical picture on board — entering or leaving a country's internal, archipelagic or 12 NM waters (the metered-ocean data boundary, customs and discharge rules). Built on `@openwaters/maritime-zones` (MIT) over the Marine Regions Maritime Boundaries Geodatabase (VLIZ, CC-BY 4.0 — the "not for navigation, no legal value" disclaimer rides the payload and renders wherever zones do). Corridor tiles (about 8 MB for a 900 nm crossing) download during the online window into the plugin data directory and answer offline afterwards; the boundary walk resamples the route at 1 nm so short territorial hops are not missed. The route simulation timestamps each crossing against the passage schedule, the unified timeline renders enter/leave events (leave events carry the "ocean data rules beyond this point" connectivity note), and here mode reports the waters the vessel sits in right now in the conditions view. Missing tiles, older Node (the package needs ≥ 24, the plugin allows 22.5) or a failed download degrade to no zone data — never a failed briefing. — entering or leaving a country's internal, archipelagic or 12 NM waters (the metered-ocean data boundary, customs and discharge rules). Built on `@openwaters/maritime-zones` (MIT) over the Marine Regions Maritime Boundaries Geodatabase (VLIZ, CC-BY 4.0 — the "not for navigation, no legal value" disclaimer rides the payload and renders wherever zones do). Corridor tiles (about 8 MB for a 900 nm crossing) download during the online window into the plugin data directory and answer offline afterwards; the boundary walk resamples the route at 1 nm so short territorial hops are not missed. The route simulation timestamps each crossing against the passage schedule, the unified timeline renders enter/leave events (leave events carry the "ocean data rules beyond this point" connectivity note), and here mode reports the waters the vessel sits in right now in the conditions view. Missing tiles, older Node (the package needs ≥ 24, the plugin allows 22.5) or a failed download degrade to no zone data — never a failed briefing.
- GDACS hazard events also surface in the conditions-here view: earthquakes, cyclones and floods near the vessel are critical while stationary, so the here view lists them (Red events highlighted) alongside the passage timeline.
- GDACS hazard event feed (work doc #22): earthquakes, tropical cyclones, floods and volcanic activity from the EU JRC's `gdacs.org/xml/rss.xml`, fetched during the online window and cached in `weather/hazards.json` with id-based dedup (repolls update in place). Events filter route-relative — alert level at or above the configured minimum (default Orange), within 500 nm of the route corridor or 1000 nm of the vessel, and no older than 72 h — and ride the briefing payload as `hazardEvents`, render in the unified timeline as `hazard` events with the alert level setting the severity, and publish as georeferenced `resources/notes` chart notes (category `hazard-event`, provenance `GDACS`) with scoped expiry that leaves the METAREA notes and other clients' notes untouched. Zero XML dependencies: a targeted extractor reads the stable RSS shape; malformed items skip without costing the feed.
- Slatting & roll-dampening penalty in the Sereno comfort index (work doc #14): a residual swell (combined Hs ≥ 0.6 m) with too little wind to keep the sails loaded — below 7 kn upwind, below 12 kn downwind — now scores as the wash machine it is: the vertical acceleration carries a 2.5× discomfort multiplier before banding and the hour is forced to at least Rough. The hourly rows tag `slatting: true`, and the tactical dashboard's sparkline renders those Rough blocks with a diagonal hatch (alternating `--comfort-rough` over the card background) so the skipper sees the discomfort is light-air slatting, not heavy weather. SPEC §5.2 amended.
- Real-world bulletin fixtures (work doc #4 follow-up): ten received-as-is High Seas texts — NHC Atlantic T1/T2, OPC East Pacific EP1, NHC EP2, Honolulu North and South Pacific (NP/SP), Fiji NAVAREA XIV, MetService NZ Subtropic, Australian BoM Western X and an NHC hurricane advisory — live under `tests/fixtures/bulletins/` with a per-family regression suite asserting issue metadata, issuer and geography extraction.
- The bulletin engine now parses the NHC/OPC/PHFO High Seas families: compact coordinate pairs (`13N67W`, no separator) normalize into the spaced form; a hemisphere-less second number that is not the dateline shorthand is rejected as prose ("07N TO 31N" is two latitudes, not 7N 31E); issue lines from NHC (`0430 UTC SAT OCT 3 2026`), PHFO (`1130 UTC TUE FEB 17 2026`), Fiji (`OCT 022000 UTC`, mixed case `Oct` from the WMO bulletin sets), MetService New Zealand (`Wellington issued at 021856UTC`) and the Australian BoM (`commencing 2300 UTC 2 October 2026`) all parse to real timestamps; `.FORECASTER <NAME>.` lines identify the issuer when no `ISSUED BY` exists, and a leading article is trimmed ("Issued by the Australian Government Bureau of Meteorology").
- NWS's renamed Gulf is normalized back to the crew's name: "GULF OF AMERICA" reads "GULF OF MEXICO" everywhere the cleaned bulletin text is shown or matched.
- Lines of interest (work doc #1): the briefing detects where the planned passage crosses the traditional ceremonial lines — the equator (Shellback ceremony), the tropics, the polar circles (Blue Nose / Red Nose), the prime meridian and the antimeridian (Domain of the Golden Dragon, with the calendar skip/repeat note) — reading the simulated track, so each crossing's position, distance from start and ETA come from the boat's own schedule rather than the forecast window. The crossings ride the unified passage timeline as `line` events (⌀ glyph, the general form the timeline was built for) instead of a separate strategic block; `passageSummary.linesOfInterest` carries the data, `lines_of_interest_enabled` (default on) turns the feature off.
- Celestial ephemeris engine (work doc #3 Phase 2): the sky is computed, not fetched. A new `plugin/celestial-ephemeris.js` module built on `astronomy-engine` (MIT, zero transitive dependencies — the dependency decision is made) derives planetary conjunctions and oppositions during nautical night, and meteor shower peaks (static annual calendar) gated to dark, clear, visible nights: moon set or a crescent, radiant able to clear 20° from the vessel's latitude, forecast cloud cover under 30 %. Bright station passes (ISS, Tiangong) are propagated locally from CelesTrak two-line elements with `satellite.js` (MIT — the SGP4 propagator call resolved) in `plugin/satellite-source.js`, reported when the pass peaks over 15° in nautical night under a clear enough sky. Every event passes the full tactical visibility gate the work document specifies — nautical night, altitude over 15° to clear the marine boundary-layer haze, cloud cover, moonlight — and the Phase-1 aurora alert is upgraded onto the same gate (nautical night replaces the sunset-based check; moonlit or overcast nights no longer raise aurora banners). Briefing payloads gain `celestialNights` — per-night twilight times (civil, nautical, astronomical) and moon phase/illumination — and `TimeStepForecast` gains `surface.cloudCover` (Open-Meteo `cloud_cover`; the Weather API provider publishes none and maps null, which leaves the cloud gate open).
- The timeline's night stamps show the actual moon phase instead of a fixed crescent: `mergeTimeline` picks one of the eight moon glyphs (🌑🌒🌓🌔🌕🌖🌗🌘) for each night-flagged event from the payload's `celestialNights`, falling back to ☾ for payloads that predate the field. The strategic ETA table's night-arrival markers (P10/P50/P90) get the same treatment.
- **METAREA notes now carry provenance: who published, when.** Every note the bulletin pipeline serves in `resources/notes` is stamped in its `properties` with `publishedBy` — the issuing authority parsed from the bulletin header ("ISSUED BY FIJI METEOROLOGICAL SERVICE …" → `FIJI METEOROLOGICAL SERVICE`), falling back to `signalk-passage-briefing` when the bulletin names no service (structured UKHO warnings, some NWS products) — and `publishedAt`, the bulletin's issue time. Chart plotters can show the line "Published on 10-03 12:00Z by FIJI METEOROLOGICAL SERVICE" straight from the resource; the DR webapp's note detail surface does.

## [0.4.0] - 2026-10-03

### Added

- Sail changes are scheduled when the crew can act on them:
  recommendation-driven canvas changes anchor to the *previous watch
  handover* when a watch schedule is running (signalk-watch-schedule;
  boundaries are extrapolated across the forecast horizon from the
  rotation cycle, and the watch boundary wins over sunlight),
  otherwise to the next sunrise/sunset. Several detections between
  boundaries collapse into one change carrying the last suggested
  state, no-op re-rigs are dropped, and the timeline says which
  anchor applied ("watch change" / "at dusk" / "at dawn"). Tacks and
  gybes stay at their tactical times.
- Unified passage timeline: a new `<passage-timeline>` component and
  `mergeTimeline()` view model render every event source — sail
  changes, planned tacks and gybes, convective risk, macro sea state,
  territorial waters transitions, sky events and hazard notes — as
  one chronological list with a time gutter, kind glyph and severity
  colour. The tactical dashboard renders the 24 h slice, the
  strategic outlook the whole passage; the per-type blocks (Sail
  Work, Convective Risk, Macro Sea State, Sky Notes) and the tactical
  hazard banners are replaced by it. The exception view now carries
  the whole-route hazard list in `passageSummary.hazards` (the 24 h
  `next24h.sailChanges` and `next24h.hazards` slices are gone — the
  timeline slices itself).
- Sail-change events in the timeline carry the forecast conditions
  at the change point (nearest simulated hour): true wind, sea state
  and Sereno comfort tier — "Main 1 reef — 14.2 kn TWS · Hs 1.5 m ·
  coffee" — so the crew knows what they are rigging into. The
  simulation's hourly rows now include wave height and period.
- Ship's time display: the webapp reads the vessel's published
  timezone (`environment.time.timezoneOffset` / `.timezoneRegion`, as
  served by signalk-ships-time) over the REST API and the delta
  stream, and renders briefing stamps in ship's time (`MM-DD HH:MM
  +13`) instead of UTC, falling back to UTC `Z` when no offset is
  published. The offset rides on every stamp so a zone crossing
  mid-passage reads honestly; a header pill names the zone (IANA
  region when known, else the offset).
- Weather source selection (`weather_source`: `auto` / `weather-api` /
  `open-meteo`, default `auto`): when the server has the Weather API
  and a provider answers — signalk-weather-router-plus serving its
  decoded ECMWF run — waypoint forecasts for the here and route
  briefing windows are read from it in-process (`app.weatherApi`)
  instead of Open-Meteo, so the briefing reasons from the same
  forecast the router planned with and offshore fetches stay local.
  Provider responses (Signal K units) map onto the payload
  conventions (knots, degrees true, hPa); combined sea only — swell
  and wind-sea partitions and the upper-air fields behind the
  convective warnings degrade to absent. A failed Weather API fetch
  falls back to Open-Meteo for that window; the forced choices never
  fall back.

### Changed

- Convective warnings read as episodes, not hourly spam: consecutive
  anomalies (and steep-sea anomalies alike) merge into one timeline
  event with a time range and peak values — "CAPE 713 J/kg · K 28.6 ·
  until 10-05 05:38Z". Severity follows the peak: CAPE ≥ 400 J/kg (the
  bar where weather services start coloring the index) or K-index ≥ 30
  is a red alert, while the unstable-air band below it (K ≥ 28 with
  low CAPE) still shows as an orange warning with units and sane
  precision instead of being dropped or inflated.

### Fixed

- The webapp flags stale cached briefings: when a served payload was
  compiled more than a day ago, a banner above the briefing shows the
  compile stamp and age with a Fetch now affordance, instead of
  presenting a multi-day-old timeline's `+Xh` labels as upcoming.
- The plugin re-fetches stale briefings without waiting for an edge
  trigger: the oneshot fires only when the internet state changes and
  cron windows only run while moored and charged, so a server that
  stays up for days while the machine sits in STANDBY_OFFSHORE kept
  serving a briefing sliding into the past. The one-minute ticker now
  re-fetches (trigger `stale`) when online and the cached briefing
  (active route, else last briefed, else here) is older than the
  route TTL — at most once per six hours, and only when something is
  actually cached.

- Bulletin geography now resolves named synoptic features in area
  bounds: `SOUTH OF 09S AND WEST OF CF` and `SOUTH OF 10S, BETWEEN
  150W AND CF` compose a polygon from the cold front's defining
  chain (clipped to the stated latitude bounds, closed across the
  antimeridian with a margin so western-Pacific vessels stay in
  west-of-front areas) instead of falling back to a hemisphere-wide
  box that matched every vessel south of the bound.

- Coordinate chains accept the Fiji/NFFN bulletin conventions the
  strict parser dropped: the dateline written as bare `180` (`TROUGH
  T3 12S 175E 14S 180 15S 177W`) and the equator written as `EQT`
  (`EQT 177E`). Prose numbers (`280600 UTC`, `20 TO 30 KNOTS`) are
  still rejected, and a rejected span no longer swallows a following
  coordinate pair.

## [0.3.0] - 2026-09-28

### Added

- ETA percentile rows in the strategic outlook flag night arrivals
  with a moon marker: arrival day/night is computed at the
  destination for each of P10/P50/P90.

- "No sails" stretches now say why the canvas is down: `No sails -
  drifting` when the plan drifts below the motoring wind threshold,
  `Motoring` when the engine pushes — reconciling the sail-work
  queue with a zero engine-hours plan (drift mode).

### Changed

- Strategic outlook layout: motor hours and fuel use the shared
  stat styling, and the sail-work queue renders as cards (tack/gybe
  highlighted) like the tactical action queue.

- "Warnings On Your Waters" and the synoptic surface-analysis chart
  now also appear on the tactical dashboard, not just the strategic
  view; the chart's night palette follows the document mode via its
  own observation (it previously never inverted when embedded).
  Shared card/stat styles moved into the common shadow-DOM base
  stylesheet.

- Sail-change events no longer flap when the forecast sits on a
  matrix bin edge: a suggested state must hold through a full
  simulation step before it enters the sail-work queue.

- Fuel is handled in liters end to end (SI — no imperial units):
  the motor burn rate is configurable as `Motor Fuel Consumption
  (liters per hour)` with a 1.8 l/h default, and the strategic ETA
  table shows e.g. `72.0 l` instead of gallons.

- The tactical "Next 24 Hours" hero readout is labeled `AWS` and
  shows its unit: `AWS 17.0 kn` instead of a bare number. (Signal K
  carries wind in SI m/s internally; the briefing displays the
  nautical kn.)

- Sail-change cards in the tactical dashboard and the sail-work
  timeline in the strategic outlook render the canonical sail-state
  keys as human-readable labels: `GENOA_1_30_FURLED_MAIN_1_REEF`
  reads "Genoa 1 30% furled + Main 1 reef", `NO_SAILS` reads "No
  sails". Unparseable keys still fall back to the raw form.

### Fixed

- A scheduled (oneshot/cron) refresh no longer fails forever when
  the last briefed route has been deleted from resources: the stale
  `last-route` pointer is removed and the refresh falls back to
  keeping conditions-here fresh. Previously every cycle died with
  `Briefing refresh failed (oneshot): Resource not found!`.

- The scheduled (oneshot/cron) route refresh no longer pulls the
  bulletin stack twice per cycle: the briefing refresh already
  fetches bulletins and synoptics for the track, so the outer
  duplicate pass is gone.

- SWPC solar-weather timestamps are UTC but carry no offset, so
  they were parsed in the server's local timezone: on a boat far
  from Greenwich the entire Kp forecast window shifted and aurora
  alerts degraded. Offsetless timestamps are now read as UTC.

- Switching the route selector between "Conditions here" and a route
  now actually swaps the view: the tactical/strategic shell is
  rebuilt for the served mode (previously the tabbed views never
  came back after visiting conditions-here, so route selection
  appeared to do nothing). Stale model data from the previous
  selection is dropped instead of flashing.

- Selecting "Conditions here" in the route picker now actually
  serves conditions-here: the briefing API treated an empty `route`
  parameter as "serve the route being sailed", so the selection
  silently returned the same route view. An explicit `?route=`
  (even empty) now selects; only a fully omitted parameter falls
  back to the active route.

- The webapp shows a loading state while a briefing loads or
  refreshes (compiles can take tens of seconds on a slow link —
  silence read as a broken app), and timed-out requests say the
  server is busy and to retry instead of surfacing the cryptic
  engine abort text. Rapid mode switching can no longer apply a
  stale response after a newer one.

## [0.2.1] - 2026-09-28

## [0.2.0] - 2026-09-28

### Fixed

- The route simulation crashed with `startTime.getTime is not a
  function` when the caller passed the payload's ISO timestamp
  string instead of a Date — simulatePassage now accepts both.

- The plotter widget HTML and JS are cache-busted with the plugin
  version, so widget updates actually reach the host's iframe —
  a stale cached copy was showing a removed Open button.

- The plotter tile drops its tap-to-open attempts entirely: the host
  sandbox blocks pop-ups AND top-frame navigation (even
  user-activated — verified on board, `allow-top-navigation-by-user-
  activation` is not set), so the only "escape" was crushing the
  webapp into the 1×1 frame. The tile is a pure mini summary; the
  full briefing opens from the host app list or a host panel, and
  the v1 open-panel request remains the spec-level fix.

- Warning notes are placed at the point of the warning area nearest
  the vessel (clamped into the bounding box, nearest vertex for
  axis lines) instead of the box center — a quarter-ocean area's
  center sits a thousand miles from the crew, outside any useful
  near-me query radius on resources/notes.
- Notes are schema-conservative (title/description/position/url/
  mimeType/properties/timestamp only) — unknown top-level fields are
  the classic resources write rejection — and provenance rides in
  `properties.sourcePlugin`. Notes write failures are logged with
  the server's reason and retried against the signalk-resources
  provider id.

- The plotter tile is now a mini summary: prominent colored comfort
  tier, route, age with a STALE marker when the briefing is past its
  window, and an `Open ↗` link (`target="_top"`) to the full webapp —
  replacing tap handling that could only ever navigate the widget's
  own 1×1 frame inside the host sandbox (pop-ups and top navigation
  are both blocked there, verified on board).

- The plotter tile received no values when its iframe connected
  after the last compile: the tile paths are now re-emitted on every
  60s cron tick (delta cost is five small values), the widget
  subscribes to the new stale/ageHours paths too, and its tap tries
  pop-up, then the parent window, then takes over its own frame —
  whatever the host sandbox permits.

- The BoM radiofax hosts stall connections from the boat outright
  (no response, fetch abort): zones 10 and 14 are parked under an
  `_unverified` map section so refreshes no longer stall on doomed
  fetches — zone 14 rides chartless until a reachable South Pacific
  product is verified against
  [otherfax.txt](https://tgftp.nws.noaa.gov/fax/otherfax.txt).
- Synoptic fetch timeout capped at 8s per candidate mirror.

- A half-migrated synoptic-source candidate-list change shipped a
  `pick.urls is not iterable` error that failed every here refresh on
  board. Consistent again, with per-candidate mirrors and loud
  failure records (zone, url, error) instead of silent drops.
- The published tile comfort tier is computed with the webapp's own
  model (`models.mjs` hereHourly) and stored on the payload, which
  the conditions-here view also reads — one implementation, one
  cached value, no drift between tile and view.
- Tile tap: when the host sandbox blocks the pop-up entirely, the
  widget navigates its own frame to the brief webapp as the final
  fallback.

- Bulletin geography parsing, corrected against a live NFFN
  bulletin: two-coordinate trough axes now parse as open lines (the
  NFFN style omits `TO` separators, so `10S 160E 12S 166E` produced
  no geometry at all and the discard rule passed the block
  unfiltered); `WITHIN 100 NAUTICAL MILES` now matches the band
  regex (only `NM` did); `SOUTH OF 10S` built its box on the wrong
  side (lat −10..90 instead of −90..−10), dropping the area block
  that contained the vessel while keeping far-away bands. Wrapped
  chains unfold before band expansion. Regression test uses the live
  bulletin text.
- The SBDB comet query negotiates its field list against the live
  endpoint (the documented `r` field is rejected for `sb-kind=c`);
  when current distances are unavailable the parse falls back to a
  perihelion-brightness estimate, labelled as such in Sky Notes.

- The forecast request listed `precipitable_water`, which Open-Meteo
  rejects (`400 Cannot initialize ... Variable`) — every forecast
  fetch failed with it, so nothing ever cached on board. Removed;
  the upper-air fields (CAPE, K-index, RH/wind at pressure levels)
  are unaffected. Doc #3 Phase 2's precipitable-water sky gate needs
  a different source when Phase 2 lands.
- `GET /api/briefing` returns `200` with an empty payload
  (`{mode, payload: null, cached: false}`) when nothing is cached
  instead of a 404, so the webapp renders its refresh strip rather
  than logging a failed request.

- The webapp's "Fetch now" button sent a GET to the POST-only
  `/api/briefing/refresh` route (fetchJson had no method option), so
  the button 404ed against a real server; it now issues a POST.

- On-board first-run issues: the webapp now fetches its REST API from
  the absolute `/plugins/signalk-passage-briefing/api` mount (SK v2
  serves the webapp itself under `/@<scope>/<name>/`, where the old
  relative `api/…` base resolved against the wrong root and every
  route 404ed — same mount as the energy-predictor webapp on this
  server); refresh failures land in the plugin *error* state instead
  of the status line; and failed internet fetches now include the
  response body (e.g. Open-Meteo's `reason`) in the error so the
  status says why, not just which URL returned which code.

### Added

- `GET /api/brief-meta` serves the current tile view (comfort tier,
  route, generatedAt, staleness, age hours, hasNew) — the plotter
  widget pulls it on connect so the mini summary is populated right
  away instead of waiting for the next delta emission.

- The plugin registers as the server's `notes` resource provider
  (there is none by default on SK v2, so writes were failing and
  queries returned nothing). The provider is read-only and serves
  only the metarea warnings the bulletin pipeline publishes — other
  clients' notes belong to their own future providers — with
  position/distance/bbox/limit query filtering per the resources
  query docs, durable in the plugin data dir. The publisher writes
  into the store directly and prunes expired warnings.
- METAREA warnings as Signal K Notes (work doc #12): after each
  bulletin filter pass the placeable blocks are published as
  georeferenced `resources/notes` — title from the first sentence,
  verbatim description, representative position (antimeridian-safe),
  category/subject/zone/source properties, timestamp from the
  bulletin. Notes link the cached synoptic chart when one exists for
  the zone. Ids are content-addressed (republish updates in place),
  blocks that drop out of the filtered set have their notes deleted,
  start re-syncs manifest vs server, and a
  `publish_metarea_notes` toggle (default on) clears owned notes
  when disabled. Publishing is local-only, never internet-gated.

- Status Tiles integration (work doc #13): the tile paths gain
  `navigation.briefing.stale` (boolean freshness verdict — 3h here,
  26h for route briefings — recomputed on every emission) and
  `navigation.briefing.ageHours`; the ticker re-emits the tile paths
  every 5th tick so widgets connecting after the last compile still
  receive values. A read-only `statusTileExamples` resource provider
  ships a copyable Comfort tile (tier colors, amber on stale,
  Age/Route footer).
- The conditions-here view renders warnings, the synoptic chart and
  the celestial-events card as siblings instead of cards nested
  inside the conditions card.
- Plotter tile tap: pop-up first, then navigate the widget frame
  itself — the host sandbox blocks pop-ups, and the probe-then-open
  dance only added failure modes.

- Zone 14 synoptic chart repointed to the BoM difacs web host
  (www.bom.gov.au/difacs/IDX0032/IDX0532.gif) after the anon FTP
  hosts proved unreachable from the boat; GIF charts are cached and
  served as-is (browsers render them natively), so the omggif
  decoder is not needed and was removed again. TIFF charts still
  convert to grayscale PNG via the vendored UTIF.

- Styling pass per the house UI spec: shadow-DOM components carried
  no panel styling (document-level visuals.css cannot pierce a
  shadow root), so the webapp rendered as unstyled text. A shared
  `sk-base-css.js` subset — panels with 2px corner brackets, theme
  tints, tracked uppercase headings, hardware buttons/selects/inputs
  with 48px touch targets, data tables, consoles — now precedes every
  component's own styles. Palette custom properties still inherit
  from the host page for day/night reactivity.

- The plotter tile shows the current comfort tier:
  `navigation.briefing.comfort` is published alongside the other tile
  paths, computed at compile time from the payload's first forecast
  step through the Sereno comfort model at SOG 0 (same math as the
  conditions-here view), seeded from the cache after a restart.
- Bulletin blocks now carry the extracted `geometry` (bbox
  coordinates, polygon/axis-line rings with the WITHIN-nm buffer)
  alongside the geometry type, and `BETWEEN 165W AND 135W` longitude
  pairs parse as area bounds — the NFFN swell statement east of a
  vessel at 174W is now correctly discarded.
- The tile's tap opens the brief webapp by probing the SK v2 app
  mount (`/@<scope>/<name>/`) before the v1 `/plugins/` mount.

- Synoptic surface-analysis chart in the strategic screen (work doc
  #11): a bundled `synoptic-map.json` maps GMDSS zone integers to
  per-agency chart URLs (NOAA TGFTP backbone, BoM radiofax for the
  Tasman/South Pacific) with 00Z/12Z time-aware selection and static
  entries; charts download on the same online-transition gate as the
  weather, convert from TIFF to compact grayscale PNG via the
  vendored pure-JS UTIF decoder plus a hand-rolled zlib PNG encoder
  (no native image dependency), cache as `synoptic-<zone>.png` with
  metadata, and skip re-downloads for the already-cached valid hour.
  `GET /api/synoptic` serves the position-zone chart; the strategic
  screen renders it in a figure that inverts for the night palette
  and stays omitted when nothing is cached. Zones without a usable
  chart (e.g. the unverified Chile source) are absent from the map
  and a logged no-op. `biome.json` added to keep the vendored decoder
  out of formatting.

- An ℹ️ next to the comfort tier (tactical dashboard and
  conditions-here) expanding an explainer for the Sereno comfort
  scale — what each tier means and the apparent-wind / vertical-motion
  lines that drop it — with the current tier highlighted. The scale
  data (`COMFORT_SCALE_INFO`) lives in the shared physics module.

- Logbook backfill controls in the webapp root (collapsed by
  default, available in every mode including conditions-here): runs
  `POST /api/backfill` (optional from/to date range) from the
  browser session and shows the learned summary. The route is
  auth-gated server-side, so the webapp session is the interface;
  the backfill report stays available as `bin/backfill-report.js`.

- Zone-targeted bulletin sources wired end to end (work doc #9): the
  NOAA TGFTP fast path now activates through a configurable
  station→zone table (`bulletin_stations`, seeded with the doc's
  FQPS01/NFFN for NAVAREA XIV) fetched before the GMDSS portal
  fallback; the UKHO Admiralty MSI JSON is fetched per resolved zone
  (`msi.admiralty.co.uk/api/Warnings/Area/{zone}`), stored raw and
  parsed tolerantly (`parseUkhoWarnings` — canonical shape
  fixture-tested, response shape and `[lat, lon]` coordinate order
  need one on-board verification) into structured blocks that skip
  the regex pipeline entirely. `/api/bulletin` and the payload
  `metareaBulletin` now merge track-filtered blocks from the newest
  cached entries across ingestion paths (text and structured),
  deduped by text. `/api/bulletin/refresh` performs the zone-targeted
  pull against the vessel position before the configured extra feeds.

- Plotter-extension brief tile (work doc #8): the plugin registers a
  read-only `plotterExtensions` resource provider (API v1 manifest,
  1x1 iframe widget, `whileEnabled`) and serves the widget assets
  from a public, non-admin-gated `/plotterext/<id>/` prefix (minimal
  static handler, traversal-guarded). The plugin publishes
  `navigation.briefing.generatedAt` / `.route` / `.hasNew` flat
  paths over the Signal K stream — the tile is bus-only — seeded
  from the cache after a restart; a `signalk.put` to
  `navigation.briefing.acknowledgedAt` (persisted across restarts)
  clears the NEW badge. The widget state machine lives in the pure
  `brief-ext-model.js` (muted / available / new with age string);
  tap opens the brief webapp in a new browser context (documented
  fallback until the v1 widget→host open-panel request is settled);
  long-press asks the host for config/remove; night mode supported
  when offered. `signalk-plotterext-bus` 0.11.0 dist is vendored
  under `public/vendor/plotterext-bus/` (MIT), same policy as the
  dead-reckoning plugin. The webapp gains an `?embed=1` compact
  chrome (header hidden) for plotter dialogs.

- Celestial & space weather, Phase 1 (work doc #3):
  `plugin/celestial-source.js` fetches the NOAA SWPC planetary
  K-index forecast and the JPL Small-Body Database comet query during
  the internet window and attaches coarse-gated `spaceEvents` to both
  briefing payloads (route departure position and here). Aurora
  alerts require a predicted Kp ≥ 5, a magnetic latitude equatorward
  reach matching the Kp (dipole approximation, ~65° at Kp 5 down to
  ~45° at Kp 9), and local night at the vessel — "Aurora possible:
  Kp 7 predicted tonight. Look south." Naked-eye comets (apparent
  magnitude from M1/K1/r/Δ brighter than 6.0) surface as strategic
  sky notes. Each source degrades independently; blocked hosts cost
  nothing. Tactical banners and a strategic "Sky Notes" block render
  them; the conditions-here view lists them in its events block.

- Planned tacks & gybes (work doc #5): the simulation records per-step
  heading, wind direction and distance made good, and a pure
  `tack-gybe.js` module classifies signed-TWA crossings between
  established wind sides — through the bow as tacks, through the
  stern as gybes — with a 25° wobble guard and interpolated crossing
  position, distance and ETA. Maneuvers merge into the sail-event
  queue (time-sorted), ride the tactical sail-action cards ("Tack to
  starboard ~14:20, 12 kt"), and surface as a whole-route "Sail
  Work" timeline in the strategic outlook. Motoring and drift legs
  are never maneuvers.

- Empty-state conditions view (work doc #7): with no active or
  explicitly requested route, `/api/briefing` serves a **here
  payload** — the UnifiedWeatherPayload shape with a single waypoint
  at the vessel's position and 24 forward hourly steps, cached as
  `weather/here.json` with a 3 h staleness flag. The cron/oneshot
  fetch keeps it fresh while moored or anchored (`POST
  /api/briefing/refresh` without a route re-fetches it), and
  bulletin filtering runs against the position alone. The webapp
  derives the mode from the served payload: an explicit "Conditions
  here" entry in the route picker leads it whenever no route is
  being sailed, rendering the new `<conditions-here>` view (no
  tabs): position, conditions now (wind/gust/sea/current/pressure
  trend), the 24 h comfort sparkline evaluated at SOG 0 (Sereno
  apparent wind ≈ true wind at anchor), filtered warnings, and —
  once work doc #3 lands — celestial/space events.
- Plugin skeleton: Signal K lifecycle (`plugin/index.js`) with the SPEC
  §2.1 configuration schema, delta subscriptions for
  `network.internet.state`, `navigation.state` and house state of
  charge, and a one-minute cron ticker.
- Connection & navigation state machine (`plugin/state-machine.js`,
  SPEC §2.2): OFFLINE / TRIGGER_ONESHOT / STANDBY_OFFSHORE /
  PERSISTENT_CRON with edge-triggered oneshot fetches, the four UTC
  publication windows (02:15, 08:15, 14:15, 20:15) and the execution
  guard that disables cron fetching while sailing.
- SQLite engine (`plugin/sqlite-db.js`, SPEC §4.1): WAL-mode
  `node:sqlite` store with the logbook sail events, wind history cache
  and learned sail preference matrix tables, plus the SPEC §3.2/§4.2
  binning and EMA helpers. Extended beyond the SPEC schema with a
  `night` column on the sail events and matrix bins: the crew reefs
  deeper at the evening watch change than conditions alone require,
  and the day/night behaviors are learned separately.
- Sereno comfort & monohull motion physics
  (`public/sereno-physics.mjs`, SPEC §5.2): apparent wind and vertical
  acceleration comfort tiers, encounter period with the surf guard,
  heel and waterline-pitch resonance multipliers, steepness ratio and
  the learned-matrix sail suggestion lookup, plus dependency-free sun
  altitude for the day/night bucket. Shared between the browser worker
  and the server as a plain ES module.
- Logbook sail-change event source (`plugin/logbook-source.js`):
  reads `signalk-logbook`'s on-disk YAML day files, parses the
  `Sails set:` / `Sailing with` / `Motor stopped, sailing with` /
  `Sails down` entries (including manually edited ones) into
  REEF_INCREASE / REEF_DECREASE / SAIL_CHANGE events with per-entry
  wind and position, filtering free-text noise against the
  `@signalk/sailsconfiguration` inventory when available. This module
  is the swap point for the coming logbook Resource API.
- Sail preference backfill (`plugin/history-backfill.js`, SPEC §4.2):
  wind window statistics (TWS avg/peak, circular-mean TWA) from
  either the logbook's own wind snapshots (default, works ashore) or
  the Signal K History API (for the on-board run), cached and folded
  into the learned matrix with the α = 0.2 EMA; idempotent via the
  wind history cache. REST routes `GET /api/matrix`,
  `GET /api/events`, `GET /api/logbook-events` and
  `POST /api/backfill`.
- Backfill report CLI (`bin/backfill-report.js`): runs the backfill
  over a logbook store and reports the conditions per sail combination
  (day/night) next to the whole-sail wind limits from
  `@signalk/sailsconfiguration`, plus the learned matrix.
- Sail inventory reader (`plugin/sails-configuration.js`): reads the
  `@signalk/sailsconfiguration` store (m/s wind limits, reef
  configurations as remaining areas in m²) for priors and annotation.
- Fetch engine (`plugin/fetch-engine.js`, SPEC §3.1): builds the
  UnifiedWeatherPayload along route waypoints sampled evenly from the
  route geometry (great-circle interpolation). Surface wind, gusts,
  pressure, CAPE and pressure-layer fields come from the Open-Meteo
  forecast API (K-index computed from T850/T700/T500 + dewpoints),
  the combined sea and its wind sea/swell partitions from GFS-Wave,
  surface current from SMOC. Marine and current endpoints degrade
  gracefully; per-attempt timeouts and retry with backoff on 429/5xx.
- Payload cache: fetched briefings are persisted per route
  (`weather/latest-<route>.json` plus dated snapshots, pruned to the
  newest eight) so the boat can run ~23h offline on the last fetch
  window; REST routes `GET /api/routes`, `GET /api/briefing` (cached,
  works offline), `GET /api/cached` and `POST /api/briefing/refresh`
  (internet only, refuses while offline). Cron/oneshot triggers
  prefer the route currently being sailed
  (`navigation.course.activeRoute`, resolved the same way as in the
  dead-reckoning plugin) and fall back to the last briefed route.
- Step-forward isochrone simulation (`public/route-sim.mjs`, SPEC
  §5.1): hourly advance along the sampled route with the §5.1 speed
  decision tree (polar sailing / drift mode / motoring), current set
  and drift added to the boat vector, partial-hour arrivals, Sereno
  comfort per hour, learned sail-change suggestions anchored to the
  watch-change day/night buckets, steep-sea and convective anomaly
  detection, hazard-note alerts (polygon containment or 5 nm point
  radius) and a three-run TWS perturbation pseudo-ensemble producing
  ETA p10/p50/p90 plus the 24 h energy balance.
- Polar performance lookup (`public/polar.mjs`): consumes the
  vessel's canonical `polars` resource table (SI axes, bilinear with
  the pinch/hull-speed edge semantics shared with signalk-polar-tools)
  and the `polars.performanceFactor` derating, falling back to a
  built-in conservative monohull polar when no polar is active. REST
  route `GET /api/polar` resolves the active polar server-side.
- Simulation web worker (`public/worker.js`): runs the passage
  simulation off the main thread and replies with the result plus its
  pre-filtered exception views (next-24h blocks, passage summary).
- Two-screen webapp (SPEC §6): root `<passage-outlook>` shell with
  hash-based tabs (tactical 24h / strategic passage), route picker
  preselecting the active route, offline pill from the Signal K
  stream, and a stale-briefing strip offering a refresh when the
  link is up. `<tactical-dashboard>` shows the current comfort tier,
  the 24h `<horizon-sparkline>` (comfort-tier colors, AWS heights)
  and exception-only sail/energy/hazard alerts;
  `<strategic-outlook>` the ETA percentile table, motor plan,
  macro sea-state and convective warnings plus the METAREA bulletin
  console. Day/night reactive per `environment.mode` (throttled
  delta subscription), exponential-backoff reconnects, granular DOM
  updates only, zero dependencies. Pure view models
  (`public/components/models.mjs`) are Node-tested; `GET /api/config`
  serves the simulation-relevant plugin settings to the worker.
- Backtest & calibration CLI (`bin/backtest-cli.js` +
  `plugin/backtest.js`, SPEC §7): replays the vessel's history
  through the Sereno motion model — attitude component paths from
  the History API (`/signalk/v2/api/history/values`, same contract
  as the signalk-polar-tools replays) are reconstructed into
  measured RMS vertical acceleration per 15-minute sliding window,
  Nelder-Mead tunes (k_heel, k_pitch) on the MAE loss, and a 5×5
  predicted-vs-measured comfort confusion matrix reports the fit.
  Sea state falls back to a Pierson-Moskowitz wind-sea
  approximation when no wave history is recorded; the report JSON
  records resolution, sample and window counts.
- GMDSS bulletin filtering engine (`plugin/bulletin-engine.js`,
  work doc #4): strips ZCZC/NNNN and routing headers, filters on the
  NAVTEX B_2 subject indicator (B_1 station letter vs B_2 subject
  distinguished - `ZCZC GA14` is subject A), segments on GMDSS
  section anchors including NWS `.WARNINGS.` style, extracts
  coordinate chains and cardinal bounds into geometry (antimeridian-
  safe: seam-spanning polygons and unwrapped cardinal boxes), and
  drops blocks whose warning area does not intersect the route
  track. Axis-line warnings ("WITHIN 120NM EAST OF AXIS") expand by
  the declared band before the test.
- Zone resolution & sources (`plugin/zone-source.js` +
  `public/gmdss-zones-min.json`, work doc #9): bundled low-res
  GeoJSON zone polygons resolve the active NAVAREA/METAREA zones
  from the route (smallest-containing-polygon wins on overlap,
  routes straddling a boundary activate both zones), and only those
  zones are fetched - NOAA TGFTP raw text when the station is
  configured (NFFN for XIV), WMO GMDSS portal as fallback, UKHO MSI
  JSON URL available for NAVAREA warnings. Antimeridian routes
  (Tonga to Opua) verified end to end in tests.
- Bulletin ingestion & cache (`plugin/bulletin-source.js`): online-
  gated like the weather fetches, raw texts cached on disk
  (`weather/bulletins.json`, newest 20 kept) so warnings stay
  available through the offline hours; per-source failures skip
  without losing the rest. Extra custom feeds configurable via
  `bulletin_urls`.
- Briefing integration: the freshest cached bulletin is filtered
  against the route track and attached to the payload as
  `metareaBulletin` (with segmented `blocks`), spliced into older
  cached briefings at serve time; REST routes `GET /api/bulletin`
  and `POST /api/bulletin/refresh`.
- Strategic screen rendering: filtered warning blocks in a
  scrolling console with severe-keyword highlighting (GALE, STORM,
  SQUALL, ROUGH SEAS, ...), raw bulletin text as fallback.
- README with credits; the `yaml` runtime dependency for reading the
  logbook store.
- Smoketests for the physics, the logbook source, the backfill, the
  state machine, the SQLite store and the plugin lifecycle.
