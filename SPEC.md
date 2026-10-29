# Passage Outlook Signal K Plugin & Webapp

## 1. System Overview & Module Architecture

### 1.1 Directory & File Layout

```
signalk-passage-outlook/
├── package.json
├── index.js                     # Signal K Plugin Entrypoint & Lifecycle Manager
├── schema.json                    # Signal K Plugin Configuration Schema
├── lib/
│   ├── state-machine.js          # Connection & Navigation State Machine
│   ├── fetch-engine.js           # Multi-Endpoint Weather & METAREA Aggregator
│   ├── spool-watcher.js          # File Spool Watcher (VARA HF / inReach Fallback)
│   ├── history-backfill.js       # Logbook & History API Sail Preference Backfill
│   ├── sqlite-db.js              # SQLite Engine (WAL Mode & Matrix Store)
│   └── sereno-physics.js         # Shared Sereno Comfort & Monohull Motion Math
├── public/
│   ├── index.html                # Main Application Shell
│   ├── app.js                    # Web Component Registry & App Controller
│   ├── worker.js                 # Dedicated Isochrone Routing & Physics Web Worker
│   ├── css/
│   │   └── visuals.css           # Signal K Tactical Sci-Fi Palette (#003399 / #ffcc00)
│   └── components/
│       ├── passage-outlook.js    # Root Component Engine
│       ├── tactical-dashboard.js # Screen 1: 24h Exception Dashboard
│       ├── strategic-outlook.js  # Screen 2: Passage Summary & METAREA Text
│       └── horizon-sparkline.js  # Color-Coded Comfort Block SVG Generator
└── bin/
    └── backtest-cli.js           # History API Model Calibration & Tuning CLI

```

### 1.2 License & Dependency Constraints

* **License:** All code must be strictly compatible with **EUPL-1.2**.
* **Zero External Runtime Dependencies (Client):** The `public/` webapp must run on native ES Modules, Vanilla Web Components, and native Web Workers. No external frameworks (e.g., React, Vue, Tailwind) or charting libraries are permitted.
* **Server Runtime:** Node.js v20+ utilizing built-in `node:sqlite` (or `better-sqlite3`), native `fs/promises`, and native `fetch`.

---

## 2. Signal K Server Plugin Engine (`index.js`, `lib/state-machine.js`)

### 2.1 Plugin Configuration Schema (`schema.json`)

```json
{
  "type": "object",
  "properties": {
    "motoring_tws_threshold": {
      "type": "number",
      "title": "Motoring TWS Threshold (knots)",
      "default": 3.5
    },
    "drift_mode_enabled": {
      "type": "boolean",
      "title": "Enable Drift Mode (Zero Fuel / Current Drift)",
      "default": true
    },
    "waterline_length_m": {
      "type": "number",
      "title": "Waterline Length (meters)",
      "default": 9.4
    },
    "spool_directory": {
      "type": "string",
      "title": "Local GRIB/Text Ingestion Directory",
      "default": "/home/node/.signalk/spool/passage-outlook"
    },
    "k_heel": {
      "type": "number",
      "title": "Heeling Acceleration Multiplier Constant",
      "default": 0.35
    },
    "k_pitch": {
      "type": "number",
      "title": "Pitching Acceleration Multiplier Constant",
      "default": 0.40
    },
    "lines_of_interest_enabled": {
      "type": "boolean",
      "title": "Lines of Interest (ceremonial crossings)",
      "default": true
    },
    "hazard_events_enabled": {
      "type": "boolean",
      "title": "GDACS Hazard Events",
      "default": true
    },
    "hazard_min_alert_level": {
      "type": "string",
      "enum": ["green", "orange", "red"],
      "title": "Minimum GDACS Alert Level",
      "default": "orange"
    },
    "hazard_radius_offroute_nm": {
      "type": "number",
      "title": "Hazard Off-route Radius (nm)",
      "default": 500
    },
    "hazard_radius_ahead_nm": {
      "type": "number",
      "title": "Hazard Vessel Radius (nm)",
      "default": 1000
    },
    "hazard_max_age_hours": {
      "type": "number",
      "title": "Hazard Event Aging (hours)",
      "default": 72
    },
    "departure_daylight_auto": {
      "type": "boolean",
      "title": "Anchor Departure to Daylight (auto)",
      "default": true
    },
    "departure_prep_hours": {
      "type": "number",
      "title": "Departure Prep Delay (hours)",
      "default": 1.5
    },
    "departure_dawn_altitude_deg": {
      "type": "number",
      "title": "First Light Sun Altitude (degrees)",
      "default": -6
    }
  }
}

```

### 2.2 Connection & Execution State Machine

The plugin monitors `network.internet.state`, `navigation.state`, and `electrical.batteries.house.capacity.stateOfCharge` via the Signal K Delta subscription API.

```
                  +-----------------------------------+
                  |             OFFLINE               |
                  | (Watch Spool Directory for GRIBs) |
                  +-----------------+-----------------+
                                    |
            network.internet.state == 'online' | 'metered'
                                    |
                                    v
                  +-----------------------------------+
                  |         TRIGGER_ONESHOT           |
                  |   (Fetch Surface, Marine, CAPE)   |
                  +-----------------+-----------------+
                                    |
              +---------------------+---------------------+
              |                                           |
  network.internet.state == 'metered'         network.internet.state == 'online'
  OR navigation.state == 'sailing'            AND navigation.state in ['moored', 'anchored']
              |                               AND SoC > 0.95
              v                                           v
  +-----------------------+                   +-----------------------+
  |    STANDBY_OFFSHORE   |                   |    PERSISTENT_CRON    |
  |  (Wait for next window|                   |  (Fetch at 02, 08, 14,|
  |   or spool file)      |                   |   20:00 UTC runs)     |
  +-----------------------+                   +-----------------------+

```

* **Cron Schedule Rules:** Runs at `02:15`, `08:15`, `14:15`, and `20:15` UTC (15 minutes after major global ensemble publication windows).
* **Execution Guard:** Checks if `navigation.state === 'moored' | 'anchored'`. If `navigation.state === 'sailing'`, cron timers are disabled and data fetches are strictly tied to single explicit transitions of `network.internet.state` to `online` or `metered`.

### 2.3 Data Source Status Registry (work doc #23)

Every ingest path records the outcome of its latest cycle in a persistent per-source registry (`plugin/source-status.js`, persisted in `source-status.json`) so a moved URL or dead host is diagnosable mid-passage instead of surfacing only as absence of data. Covered sources: the weather fetch, per-zone bulletin/UKHO pulls, the configured extra bulletin feeds, the synoptic chart rasters, the GDACS hazard feed, the local celestial ephemeris, the automatic front detection over the weather provider's grid caches (its cycle note carries the run's freshness, coverage window, typing method and crossing count) and the landfall map sources (corridor DEM + Shortbread gazetteer presence, work doc #50 session), and — checked on the one-minute ticker — the Signal K sources themselves (required subscribed paths: internet state, navigation state, house SoC; optional: active route, energy outlook, route resources, polar, ship's time, logbook).

Each entry carries `id`, `label`, `kind`, `url`, `lastAttemptAt`, `lastSuccessAt`, `lastError` (`{class, message}`), `consecutiveFailures`, `expectedRefreshMs`, `note` (cycle detail for the expandable row — what the cycle actually saw, replaced every cycle) and `lastStatus` (`ok` / `fail` / `skip` / `absent`). Error classes are coarse and stable: `http-404`, `http-429`, `http-4xx`, `http-5xx`, `timeout`, `network`, `parse`, `unavailable`. Cycles the online gate skips record `offline-skipped` behavior via `lastStatus: "skip"` — never counted as failures. The registry serves at `GET /plugins/signalk-passage-briefing/sources` (diagnostics, not briefing content) and survives restarts.

---

## 3. Data Schemas & Structural Interfaces

### 3.1 Unified Weather Payload (`UnifiedWeatherPayload`)

Passed from backend fetch engine to frontend IndexedDB and Web Worker:

```typescript
interface UnifiedWeatherPayload {
  metadata: {
    fetchedAt: string;          // ISO timestamp
    source: 'api' | 'spool';
    models: string[];            // e.g., ['ECMWF-HRES', 'GFS']
  };
  waypoints: {
    lat: number;
    lon: number;
    distanceFromStartNm: number;
    forecasts: TimeStepForecast[];
  }[];
  metareaBulletin?: {
    header: string;
    issuedAt: string;
    bulletinText: string;
  };
  spaceEvents?: {
    kind: string;               // 'aurora' | 'comet' | 'conjunction' | 'opposition' | 'meteor' | 'moonPhase' | 'lunarEclipse' | 'solarEclipse' | 'satellite' | 'reentry' | 'launch'
    timestamp: string;          // ISO timestamp
    tactical: boolean;          // 24h dashboard banner vs strategic sky note
    description: string;
  }[];
  celestialNights?: {
    timestamp: string;          // ISO timestamp (night anchor)
    moonPhaseDeg: number;       // 0 = new, 90 = first quarter, 180 = full, 270 = third quarter
    moonIllumination: number;   // fraction 0-1
    civilDusk: string | null;   // ISO timestamps, null beyond polar day/night
    nauticalDusk: string | null;
    astronomicalDusk: string | null;
    astronomicalDawn: string | null;
    nauticalDawn: string | null;
    civilDawn: string | null;
  }[];
  hazardEvents?: {
    id: string;                 // GDACS event id
    type: string;               // 'EQ' | 'TC' | 'FL' | 'VO' | 'DR' | 'WF'
    alertLevel: string;         // 'green' | 'orange' | 'red'
    title: string;
    description: string;
    timestamp: string;          // ISO, newer of pubDate/datemodified
    lat: number;
    lon: number;
    distanceNm: number;         // from the admitting reference (vessel or route)
    bearingDeg: number;         // degrees true from the same reference
    link: string | null;        // GDACS event page
  }[];
  zoneTransitions?: {
    kind: 'enter' | 'leave';    // boundary crossing direction
    territory: { name: string; iso_ter: string };
    lat: number;                // crossing position
    lon: number;
    distanceFromStartNm: number;
    connectivity?: 'ocean';     // leave events: metered-ocean rules beyond
  }[];
  zonesHere?: {                 // here mode: waters the vessel sits in
    layer: string;              // 'internal' | 'archipelagic' | '12nm'
    name: string;
    iso_ter: string;
    territory: string;
  }[];
  zoneDisclaimer?: string;      // Marine Regions attribution + no-navigation notice
  energyHourly?: {
    timestamp: string;          // ISO hour stamp
    solarWh: number;            // total ideal generation (solar+wind+hydro+alternator)
    loadWh: number;             // house consumption
    netWh: number;              // solarWh - loadWh
    soc: number | null;         // ideal SoC 0-1 at hour end
  }[];                          // signalk-energy-predictor forecast, 48 h
  departure?: {
    assumed: boolean;           // auto daylight anchor vs crew override
    time: string;               // ISO — the schedule's anchor instant
    reason: string;             // 'underway' | 'next_dawn' | 'daylight_prep' | 'no_dawn' | 'manual'
  };
  trimmedFromNm?: number;       // when the plan trimmed to route progress (work doc #28):
                                // the boat's distance along the original plan; the
                                // payload's distances count from the boat
  capAlerts?: {
    id: string;                 // identifier + sent dedup key
    identifier: string;         // CAP identifier
    sent: string | null;        // ISO issue instant
    msgType: string | null;     // 'Alert' | 'Update' | 'Cancel' | ...
    senderName: string | null;
    event: string | null;       // e.g. 'Tsunami Warning'
    severity: string | null;    // 'extreme' | 'severe' | 'moderate' | 'minor'
    urgency: string | null;
    certainty: string | null;
    effective: string | null;
    expires: string | null;     // hard expiry — deterministic drop
    headline: string | null;
    description: string | null;
    instruction: string | null;
    web: string | null;
    areaDesc: string | null;
    geometry: {                 // native CAP geometry, mapped to the
      type: 'polygon' | 'bbox'; // bulletin-engine types (circle → polygon)
      coordinates: any;
    };
  }[];                          // CAP alerts near the vessel or route (work doc #24)
  fronts?: {                    // automatic synoptic front analysis from the weather
                                // provider's grid caches (work doc #50); present when a
                                // run covers the boat's waters, absent otherwise —
                                // informational only, never an alert source
    schema: 'fronts/v2';
    model: string;              // provider source name, e.g. 'gfs-0p25'
    run: string;                // model run instant, ISO
    method: 'thermal-front-parameter' | 'trough-wind-shift';
                                // trough-wind-shift when the cache carries no 850 hPa fields
    caveat: string;             // the automatic-analysis notice any render must carry
    provenance: { kind: 'fronts'; label: string; url: null; at: string };
    steps: {                    // per-forecast-step front lines (for later map rendering)
      time: string;             // ISO
      lines: {
        kind: 'cold' | 'warm' | 'stationary' | 'front' | 'trough';
                                // 'front': wind-shift line the pressure-only method
                                // could not type without 850 hPa data
        points: [number, number][];  // [lon, lat], 0.01°-rounded; longitudes may run
                                     // past 180 so date-line lines stay continuous
        length_km: number;
        strength: number;       // mean TFP (K/(100 km)²) or curvature (hPa/(100 km)²)
        shift_deg?: number;     // mean 10 m wind shift across a trough-located line
        motion_deg?: number;    // direction the front moves towards (degrees true)
        speed_kn?: number;      // the 850 hPa wind pushing it
        pressure_hpa: number;
      }[];
    }[];
    passages: {                 // tracked fronts crossing the boat's scheduled position
      time: string;             // ISO, interpolated between the bracketing steps
      kind: string;             // track kind at the crossing
      trackId: number;
      lat: number;              // crossing position on the schedule
      lon: number;
      shiftDeg: number | null;  // expected wind-shift context
      motionDeg: number | null;
      speedKn: number | null;
    }[];
  };

interface TimeStepForecast {
  timestamp: string;            // ISO timestamp
  surface: {
    tws: number;                // knots
    twd: number;                // degrees true
    mslp: number;               // hPa
    cloudCover: number | null;  // percent (0-100); null when the source carries none
    precip: number | null;      // mm/h; null when the source carries none
    precipProbability: number | null; // percent (0-100); null when unknown
  };
  marine: {
    hsCombined: number;         // meters
    tpCombined: number;         // seconds
    dirCombined: number;        // degrees true
    hsSwell: number;            // meters
    tpSwell: number;            // seconds
    dirSwell: number;           // degrees true
    hsWindSea: number;          // meters
    tpWindSea: number;          // seconds
    dirWindSea: number;         // degrees true
  };
  upperAir: {
    cape: number;               // J/kg
    kIndex: number;             // scalar
    precipitableWater: number;  // mm
    rh700: number;              // percentage (0-100)
    wind850kts: number;         // knots
  };
  current: {
    drift: number;              // knots
    set: number;                // degrees true
  };
}

```

### 3.2 Learned Sail Preference Matrix (`SailPreferenceMatrix`)

Stored in SQLite and loaded into memory:

```typescript
interface SailPreferenceMatrix {
  twsBinsKnots: number[];       // [0, 5, 10, 15, 20, 25, 30, 35, 40]
  twaBinsDegrees: number[];     // [0, 30, 60, 90, 120, 150, 180]
  matrix: {
    twsBin: number;
    twaBin: number;
    preferredSailState: string; // e.g., "MAIN_FULL_GENOA_100", "MAIN_REEF_1_GENOA_100"
    minTwsGustTrigger: number;
    samplesCount: number;
  }[];
}

```

---

## 4. History API Backfill & SQLite Matrix Engine (`lib/sqlite-db.js`, `lib/history-backfill.js`)

### 4.1 SQLite Schema & Initialization

Database path: `userDataDir/passage-outlook.sqlite`

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS logbook_sail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'REEF_INCREASE', 'REEF_DECREASE', 'SAIL_CHANGE'
  sail_state TEXT NOT NULL,  -- e.g., 'REEF_1_GENOA'
  notes TEXT
);

CREATE TABLE IF NOT EXISTS wind_history_cache (
  timestamp TEXT PRIMARY KEY,
  tws_avg REAL NOT NULL,
  tws_peak REAL NOT NULL,
  twa_avg REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS learned_sail_matrix (
  tws_bin INTEGER NOT NULL,
  twa_bin INTEGER NOT NULL,
  preferred_sail TEXT NOT NULL,
  avg_tws_trigger REAL NOT NULL,
  peak_gust_trigger REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (tws_bin, twa_bin)
);

```

### 4.2 History API Extraction Algorithm

For each logbook event recorded at $t_{\text{event}}$:

1. Query Signal K History API at `/signalk/v2/api/history/values`:
* Path: `environment.wind.speedTrue` & `environment.wind.angleTrue`
* Time Window: $[t_{\text{event}} - 15\text{ min}, t_{\text{event}}]$


2. Calculate:

$$\text{TWS}_{\text{avg}} = \frac{1}{N} \sum_{i=1}^{N} \text{TWS}_i$$


$$\text{TWS}_{\text{peak}} = \max(\text{TWS}_1, \text{TWS}_2, \dots, \text{TWS}_N)$$


$$\text{TWA}_{\text{avg}} = \operatorname{atan2}\left(\frac{1}{N}\sum \sin(\text{TWA}_i), \frac{1}{N}\sum \cos(\text{TWA}_i)\right)$$


3. Update `learned_sail_matrix` bin $(b_{\text{TWS}}, b_{\text{TWA}})$ using Exponential Moving Average ($\alpha = 0.2$):

$$\text{Trigger}_{\text{new}} = (1 - \alpha) \cdot \text{Trigger}_{\text{old}} + \alpha \cdot \text{TWS}_{\text{peak}}$$



---

## 5. Monohull Sereno Physics & Routing Engine

### 5.1 Step-Forward Isochrone Simulation Loop

Executed inside `public/worker.js` for time steps $\Delta t = 1.0\text{ hour}$:

```
                       [ Start Step Step i: t = t_i ]
                                     |
                       [ Interpolate Weather Vector ]
                                     |
           +-------------------------+-------------------------+
           |                                                   |
 [ TWS >= motoring_tws_threshold ]                  [ TWS < motoring_tws_threshold ]
           |                                                   |
           v                                                   v
 [ Lookup STW in Polars ]                          [ Check drift_mode_enabled ]
           |                                                   |
           |                                 +-----------------+-----------------+
           |                                 |                                   |
           |                          [ Mode == true ]                    [ Mode == false ]
           |                                 |                                   |
           |                                 v                                   v
           |                         STW = 0.0 kt                        STW = 4.5 kt
           |                         Fuel = 0.0 gal/h                    Fuel = 0.8 gal/h
           |                                 |                                   |
           +---------------------------------+-----------------------------------+
                                     |
                          [ Calculate SOG Vector ]
                     V_SOG = V_STW(heading) + V_current
                                     |
                     [ Advance Position: P_i -> P_{i+1} ]
                                     |
                  [ Evaluate Monohull Sereno Comfort ]

```

### 5.2 Monohull Sereno Comfort Index Formulation

A modified Sereno comfort scale, not a direct copy of the upstream planner's: the band thresholds and motion math derive from passage-weather, the tier names and their one-line meanings are this project's own, and the slatting & roll-dampening penalty below is a vector upstream has nothing of — a catamaran slats far less, and light-air discomfort rarely gets modeled.

#### Vector 1: Apparent Wind Speed Rating

$$AWS = \sqrt{TWS^2 + STW^2 + 2 \cdot TWS \cdot STW \cdot \cos(TWA)}$$

* $AWS < 12\text{ kt} \implies \mathbf{Champagne}$
* $12\text{ kt} \le AWS < 18\text{ kt} \implies \mathbf{Easy}$
* $18\text{ kt} \le AWS < 23\text{ kt} \implies \mathbf{Sporty}$
* $23\text{ kt} \le AWS < 33\text{ kt} \implies \mathbf{Rough}$
* $AWS \ge 33\text{ kt} \implies \mathbf{Miserable}$

#### Vector 2: Monohull Motion — Two Kernels, One Scale (work doc #56)

The motion rating runs one of two kernels per hour, chosen by what the boat's hull allows, never guessed: with a complete hull description (waterline, beam, canoe-body draught, displacement — all positive) and no known non-monohull form, the **spectral kernel** judges the hour from published seakeeping physics; anything missing keeps the hour on the **legacy kernel**, whose formulation is retained below unchanged as the fallback. The row carries which kernel ran (`motionKernel: jmo | legacy`), so the briefing never presents a hull-grounded number that does not exist.

The hull description resolves with explicit precedence: the vessel's published Signal K `design.*` value wins — the boat is the source of truth for its own hull (`design.length.value.waterline`, `design.beam`, `design.draft.value.canoe`, `design.displacement`) — and the configuration fields (`waterline_length_m` doubles as the LWL gap-filler, plus `hull_beam_m`, `hull_canoe_draft_m`, `hull_displacement_kg`, `hull_gm_m`, `hull_roll_period_s`, `hull_accel_point_m`, `hull_type`) fill only what the boat does not publish, displacement and stability being the usual gaps. All length defaults are 0 = follow the boat; a boat publishing only its LOA gets the LOA as the coarsest LWL stand-in (LWL ≤ LOA always — a length wrong by ~15% keeps the spectral kernel running where a missing one would silently drop it to the legacy fallback). What neither source provides stays missing — no defaults are invented. A known `catamaran` or `trimaran` hull type refuses the spectral kernel outright (the scale is monohull-adapted); the row flags the mismatch instead of silently applying wrong math.

##### Spectral kernel (primary): JMO 2004 closed-form motions on a PM spectrum

Origin: Jensen, Mansour & Olsen (2004), "Estimation of ship motions using closed-form expressions", *Ocean Engineering* 31(1) 61–85, [doi:10.1016/S0029-8018(03)00108-2](https://doi.org/10.1016/S0029-8018(03)00108-2) — closed-form heave, pitch and roll transfer functions for a box-shaped displacement monohull, implemented from the paper's published formulas (the DTU NetSSE transcription served as a notation cross-check only; it is GPL-3 and no code was taken). Spectrum: Pierson–Moskowitz in Bretschneider form, built from the combined sea the forecast step carries:

$$S(\omega) = \frac{5}{16} \cdot H_s^2 \cdot \frac{\omega_p^4}{\omega^5} \exp\left(-\frac{5}{4}\left(\frac{\omega_p}{\omega}\right)^4\right), \qquad m_0 = \int S \, d\omega = \frac{H_s^2}{16}$$

Forecasts publish the ECMWF energy period $T_{m-1}$ (`mwp`), so the peak period comes from the PM shape's analytic relation $T_{m-1} = \Gamma(5/4)\cdot(4/5)^{1/4}/\omega_p \approx 0.857\,T_p$: $T_p = 1.167 \cdot T_{m-1}$. Response moments integrate $|TF(\omega)|^2 S(\omega)\,d\omega$ over a log-spaced grid ($\omega \in [0.2, 2.4]$ rad/s, 48 bins), each bin mapped to the encounter frequency $\omega_e = \omega_0 - k\,U\cos\beta$ with $\beta$ the angle between heading and wave travel direction (0 = following seas) — only positive $\omega_e$ bins count.

**Heave and pitch** (per unit wave amplitude $a$, with $k = \omega_0^2/g$, $B = B_{hull}\cdot C_B$, Froude number $F_n = U/\sqrt{gL}$, $\alpha = 1 - F_n\sqrt{kL}\cos\beta$, $\omega_e = \omega_0 - kU\cos\beta$, $A = 2\sin(\omega_e^2 B/2g)\exp(-\omega_e^2 T_{draught}/g)$, $f = \sqrt{(1-kT)^2 + (A^2/kB\alpha^3)^2}$, $\kappa_{att} = e^{-kT}$, $k_e = |k\cos\beta|$):

$$|\eta_3/a| = \left|\frac{\kappa_{att} f}{k_e L/2}\sin\left(\frac{k_e L}{2}\right)\right| \cdot \left[(1 - 2kT\alpha^2)^2 + \left(\frac{A^2}{kB\alpha^2}\right)^2\right]^{-1/2}$$

$$|\eta_5/a| = \left|\frac{24\,\kappa_{att} f}{(k_e L)^2 L}\left(\sin\frac{k_e L}{2} - \frac{k_e L}{2}\cos\frac{k_e L}{2}\right)\right| \cdot \left[(1 - 2kT\alpha^2)^2 + \left(\frac{A^2}{kB\alpha^2}\right)^2\right]^{-1/2}$$

$C_B$ is the definition, not an estimate: displacement over the box $\rho L B T$ ($\rho = 1025$ kg/m³). **Vertical acceleration at the crew point** $x$ metres forward of the centre ($x = 0$ default, `hull_accel_point_m`): the point displacement is $z = \eta_3 - x\,\eta_5$, driven at the encounter frequency, $a_z\text{-TF} = \omega_e^2 |z|$. **Roll** uses the paper's one-degree-of-freedom formulation — the roll equation driven by the wave slope with the natural period and damping as the two hull parameters — because the two-parcel ship variant leaves its validity class (B/T ≈ 2–3.5, C_B ≈ 0.7–0.8) for small wide hulls (B/T > 4.5, low C_B) and over-predicts low-frequency excitation there; the retained two-parcel implementation exists as reference code only. With $r = \omega_e T_N / 2\pi$:

$$|\varphi/a| = \frac{(\omega_0^2/g)\,|\sin\beta|}{\sqrt{(1-r^2)^2 + (2\mu r)^2}}, \qquad T_N = \frac{2 f_{IMO} B}{\sqrt{GM}}, \; f_{IMO} = 0.4 \; (L < 45\text{ m, IMO A.685})$$

The damping ratio follows the sail state — the mainsail damps roll (PredictWind's wave-polar guidance: resonant roll roughly doubles with no main up): $\mu_{sailing} = 0.08$ drawing, $\mu_{bare} = 0.04$ motoring or unknown. The roll natural period comes from the directly measured value when entered (`hull_roll_period_s`: the dock roll test — push the shrouds, time full cycles — which the kernel prefers, because the IMO A.685 factor $f = 0.4$ behind the derivation is ship-calibrated and runs short for heavy full-keel yachts, whose real periods sit at 4–5 s where the formula gives ~2.6 s); otherwise from GM, which comes only from the configuration override (Signal K publishes no stability field). Without either, roll stays null and the deck-work verdict reports its absence. The near-resonance linear roll over-predicts (real hulls saturate); the payload labels all roll numbers as model estimates.

**ISO 2631-1 W_f weighting**: the comfort bands below were always defined on frequency-*weighted* acceleration; the spectral kernel applies the W_f motion-sickness weighting to the acceleration spectrum before banding (weight by $W_f(f_e)$, band on $\sqrt{\int W_f^2\,a\text{-TF}^2 S\,d\omega}$). The W_f filter set (band limits 0.08/0.63 Hz Butterworth, transition 0.25 Hz Q 0.86, upward step 0.0625/0.10 Hz Q 0.80, per ISO 2631-1 Annex A / ISO 8041) is implemented from the published cascade and reproduces the standard's 1/3-octave table to better than 0.01 dB across 0.1–2 Hz (tested).

**Crew-action verdicts** ride the same numbers, against PredictWind's published operational limits (work doc #56 origin issue): RMS roll > 4° means the crew cannot safely move and work on deck; weighted acceleration > 0.2 g means tasks become unsafe and seasickness likely. The two compose into the row's `deckWork` label: `ok`, `roll_limit` (hold the rail), `accel_limit` (hatches shut), `both_limits` — computed from the unslatted, unstabilized values, since these are operational thresholds, not comfort tiers.

**The roll metric votes its own Sereno tier** (work doc #56, Minerva calibration): $a_z$ cannot see roll, and the crew's worst days were roll days — on the Vava'u → Minerva passage the $a_z$ vector read all three days nearly identically while the crew's verdicts stepped Miserable → Rough → Sporty exactly as the RMS roll did (12.4° / 12.4° / 8.6°). The bands: ≥ 5° RMS caps the hour at **Sporty**, ≥ 9° at **Rough**, ≥ 13° at **Miserable**; below 5° roll does not vote. Provenance: the 4° line is PredictWind's deck-work anchor and the 5° floor sits just above it; the upper cuts are calibrated against this crew's own day-level verdicts on that passage — three data points, a first calibration for the corpus backtest to refine, with all roll figures labeled model estimates in the payload. The downwind-sail damping (0.78) applies to the roll figure as well (the stabilizer's purpose is roll; the ratio was measured on a_z pairs — a documented reuse assumption), while the slatting multiplier stays out of the roll vote: bare poles already double roll through the damping ratio, and the three-way rule suppresses slatting for drawing sails.

**Direction and period behavior** (locked as tests, per the skipper's rules of thumb): head seas hobby-horse — the vertical acceleration peaks going into the waves and fades running down; beam seas carry the roll — the roll excitation goes as $|\sin\beta|$ and vanishes dead head/following; and long swells matter less than steep chop of the same height — $\omega_e^2$ decay, the W_f curve and the wave-slope drive all shrink together, so a 3 m @ 12 s swell scores under half a 2 m @ 6 s sea in both vectors.

**Slating and downwind-sail damping apply unchanged**: the slatting multiplier (§ above) and the Parasailor-class damping factor act on the kernel's acceleration value before banding exactly as they do on the legacy value — the penalties are kernel-independent by design.

##### Legacy kernel (fallback): encounter-period sinusoid

Runs when the hull is incomplete, the hull type refuses, or the wave data is absent. Formulation unchanged — the constants and bands were calibrated together against the vessel's own history (SPEC §7), so they move as a pair:

1. **Wave Encounter Period ($T_e$):**

$$T_e = \frac{T_{p,\text{combined}}}{1 - \left(\frac{2\pi \cdot SOG \cdot 0.5144}{9.81 \cdot T_{p,\text{combined}}}\right) \cos(\alpha_{\text{wave}} - \text{Heading})}$$


2. **Base Acceleration ($a_{z,\text{base}}$):**

$$a_{z,\text{base}} = \frac{4\pi^2}{T_e^2} \cdot \frac{H_{s,\text{combined}}}{2}$$


3. **Heel Angle Estimation ($\phi$) & Heel Multiplier ($\mu_{\text{heel}}$):**

$$\phi = \phi_{\text{max}} \cdot \left(\frac{AWS}{25.0}\right) \cdot \sin(TWA), \quad \text{where } \phi_{\text{max}} = 25^\circ \text{ (0.436 rad)}$$


$$\mu_{\text{heel}} = 1.0 + k_{\text{heel}} \cdot \vert{}\sin\phi\vert{} \quad (k_{\text{heel}} = 0.35)$$


4. **Waterline Pitching Resonance ($\mu_{\text{pitch}}$):**
Given vessel $L_{\text{wl}} = 9.4\text{ m}$ and wave length $L_{\text{wave}} = \frac{9.81 \cdot T_{p,\text{combined}}^2}{2\pi}$:

$$\mu_{\text{pitch}} = 1.0 + k_{\text{pitch}} \cdot \exp\left(-\left(\frac{L_{\text{wave}} - L_{\text{wl}}}{L_{\text{wl}}}\right)^2\right) + \max\left(0, \frac{3.28 - (T_{p,\text{combined}} / H_{s,\text{combined}})}{3.28}\right)$$


5. **Effective Acceleration & ISO Rating:**

$$a_z = a_{z,\text{base}} \cdot \mu_{\text{heel}} \cdot \mu_{\text{pitch}}$$


* $a_z < 0.15\text{ m/s}^2 \implies \mathbf{Champagne}$
* $0.15 \le a_z < 0.315\text{ m/s}^2 \implies \mathbf{Easy}$
* $0.315 \le a_z < 0.630\text{ m/s}^2 \implies \mathbf{Sporty}$
* $0.630 \le a_z < 1.250\text{ m/s}^2 \implies \mathbf{Rough}$
* $a_z \ge 1.250\text{ m/s}^2 \implies \mathbf{Miserable}$

#### Slatting & Roll-Dampening Penalty (work doc #14)

On a monohull, aerodynamic pressure in the sails dampens roll. When
that pressure is lost but a residual swell remains, the snap-roll and
boom shock-loading can be worse than a gale — yet raw $a_z$ scores it
calm, because the sea state itself is modest. After the base rating:

1. **Glassy-calm gate:** if $H_{s,\text{combined}} < 0.6\text{ m}$ there is not enough wave energy to roll the hull — the penalty is skipped entirely.
2. **Dampening-loss thresholds:** otherwise the sails have lost their dampening pressure when
   * upwind / reaching ($|TWA| < 90°$): $TWS < 7.0\text{ kt}$
   * downwind / running ($|TWA| \ge 90°$): $TWS < 12.0\text{ kt}$ — the boat sails away from its wind, dropping apparent wind below flow-attachment.
3. **Washing-machine penalty:** when the regime is detected, the vertical acceleration is multiplied by $\mu_{\text{slat}} = 2.5$ before ISO banding, and the hour's tier is forced to at least **Rough**. The hourly row carries a `slatting` tag; the tactical dashboard renders slatting-triggered Rough blocks with a diagonal hatch (alternating `--comfort-rough` over the card background) so the skipper sees the discomfort is light-air slatting, not heavy weather — alter course for a better wave angle, drop the main and motor, or lock the boom down.



### 5.3 Hazard Proximity Ray-Casting Algorithm

For each 1-hour route segment $(P_i, P_{i+1})$ and each active note in `resources.notes`:

1. **Time-To-Target Calculation:** $t_{\text{intercept}} = t_0 + i \cdot \Delta t$.
2. **Bounding Box Filter:** Expand note boundary by $r = 5.0\text{ nm}$.
3. **Ray Casting (Point-In-Polygon):**
If note geometry is a polygon $V_1, V_2, \dots, V_k$, test whether interpolated point $P_{\text{interp}}(\tau) = (1-\tau)P_i + \tau P_{i+1}$ intersects the polygon:

$$\text{IntersectCount} = \sum_{j=1}^{k} \text{RayCrossesSegment}(P_{\text{interp}}, V_j, V_{j+1})$$


4. If $\text{IntersectCount} \pmod 2 \neq 0$ or distance to point position $d < r$, generate a **Proximity Alert** attached to time window $t_{\text{intercept}}$.

---

## 6. Client Web Components & UI Architecture

### 6.1 Design System Tokens (`public/css/visuals.css`)

```css
:root {
  --color-bg: #003399;
  --color-fg: #ffcc00;
  --color-champagne: #00ffcc;
  --color-easy: #00ff00;
  --color-sporty: #ffcc00;
  --color-rough: #ff6600;
  --color-miserable: #ff0000;
  --font-family: 'Courier New', Courier, monospace;
}

body {
  background-color: var(--color-bg);
  color: var(--color-fg);
  font-family: var(--font-family);
  margin: 0;
  padding: 8px;
}

```

### 6.2 Exception-Based Display Filtering Engine

Before passing Web Worker output to UI elements, pass raw calculations through `filterExceptions()`:

```javascript
function filterExceptions(simulationResult) {
  return {
    next24h: {
      comfortBlocks: simulationResult.hourlyComfort.slice(0, 24),
      sailChanges: simulationResult.sailEvents.filter(e => e.hoursFromNow <= 24),
      hazards: simulationResult.hazardAlerts.filter(h => h.hoursFromNow <= 24),
      solarYieldKwh: simulationResult.energy.netSolar24h,
      energyDeficitAlert: simulationResult.energy.netBalance24h < 0
    },
    passageSummary: {
      etaP10: simulationResult.eta.p10,
      etaP50: simulationResult.eta.p50,
      etaP90: simulationResult.eta.p90,
      totalMotorHours: simulationResult.motoringHours,
      totalFuelGal: simulationResult.fuelConsumptionGal,
      macroSeaAnomalies: simulationResult.seaStateAnomalies.filter(a => a.steepnessRatio < 3.28),
      convectiveWarnings: simulationResult.upperAirAnomalies.filter(u => u.cape > 1000 || u.kIndex > 28),
      // Rain-shower episodes: hours at or over the shower bar
      // (precip ≥ 0.5 mm/h or probability ≥ 50 %) merged into one
      // entry each with the peak rate and probability. The crew reads
      // probable rain as probable squalls in the tropics — info-level
      // timeline entries, not warnings
      rainEpisodes: mergeEpisodes(simulationResult.rainHours),
      // Meteor-shower nights evaluated along the track (work doc #37):
      // per (shower, night) spaceEvents gated at the night's nautical-dusk
      // anchor, the radiant checked at the track's forecasted position;
      // route payloads carry no fixed-position `meteor` spaceEvents —
      // these are the timeline's meteors. Here-mode payloads keep them
      // in `spaceEvents` (single position, no track)
      meteorEvents: simulationResult.meteorEvents
    }
  };
}

```

### 6.3 Custom Elements Definition

#### `<passage-outlook>` (App Root)

Component Shell. Manages WebSocket connection to Signal K, reads IndexedDB cache, posts payload to `worker.js`, and renders `<tactical-dashboard>` or `<strategic-outlook>` based on tab selection.

#### `<tactical-dashboard>` (Screen 1: Next 24h)

Displays:

1. `<horizon-sparkline>` SVG element.
2. Sail action cards **only** if `sailChanges.length > 0`.
3. Energy balance warning **only** if `energyDeficitAlert === true`.
4. Hazard alert banners **only** if `hazards.length > 0`.

#### `<strategic-outlook>` (Screen 2: Passage Summary)

Displays:

1. ETA Range Table (P10, P50, P90, Motor Hours, Fuel).
2. Macro Sea State warnings block.
3. Convective Warning block (CAPE / K-Index).
4. Raw METAREA text bulletin container.
5. `<source-status>` checklist (work doc #23): collapsed by default, summary line always visible ("12 sources, 1 FAIL"). Rows: last-attempt stamp (muted) | source label + kind | right-aligned monospace status bracket mapped by the pure `statusVerdict` view model — `[ OK ]` green, `[ WARN ]` orange (429/parse failures, or success stale beyond the source's expected refresh interval), `[ FAIL ]` red, `[ SKIP ]`/`[ N/A ]` muted. Tap expands the row's detail (cycle note first — what the cycle actually saw, e.g. a run's coverage window or a missing optional layer — then URL, last success, classified error, consecutive failures). The component polls `GET /plugins/signalk-passage-briefing/sources` at a minute rate and mutates only `textContent`/class attributes; expanded state persists in `localStorage`.

#### `<horizon-sparkline>` (SVG Renderer)

Renders a 24-column SVG bar chart where bar background color maps to `comfortLevel` (Champagne, Easy, Sporty, Rough, Miserable) and bar height represents $AWS$.

---

## 7. Backtest CLI Module (`bin/backtest-cli.js`)

### 7.1 Command Line Interface

```bash
node bin/backtest-cli.js \
  --history-url http://localhost:3000/signalk/v2/api/history \
  --start 2026-08-01T00:00:00Z \
  --end 2026-08-03T12:00:00Z \
  --output ./backtest-report.json

```

### 7.2 Calibration & Optimization Engine

1. **Extract Telemetry:** Queries historical `navigation.attitude` ($\text{roll}, \text{pitch}$) at 1 Hz over 15-minute sliding windows.
2. **Reconstruct Acceleration:**

$$a_{z,\text{measured}} = \sqrt{\operatorname{Var}\left(\frac{d^2\text{pitch}}{dt^2} \cdot 3.5\right) + \operatorname{Var}\left(\frac{d^2\text{roll}}{dt^2} \cdot 1.5\right) + 9.81^2 \cdot \operatorname{Var}(\sin\text{roll})}$$


3. **Loss Function (Mean Absolute Error):**

$$\mathcal{L}(k_{\text{heel}}, k_{\text{pitch}}) = \frac{1}{N}\sum_{i=1}^{N} \left\vert{} a_{z,\text{predicted}}^{(i)}(k_{\text{heel}}, k_{\text{pitch}}) - a_{z,\text{measured}}^{(i)} \right\vert{}$$


4. **Optimization Routine:** Executes Nelder-Mead simplex optimization to find optimal $(k_{\text{heel}}, k_{\text{pitch}})$.
5. **Output Confusion Matrix:**
Prints a $5 \times 5$ classification matrix comparing predicted vs. actual Sereno Comfort tiers across all evaluated passage windows.

## Implementation

Biome-checked JavaScript with JsDoc type annotations. Webapp as per `signalk-visuals.md` context document.
