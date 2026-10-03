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
    kind: string;               // 'aurora' | 'comet' | 'conjunction' | 'opposition' | 'meteor'
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
}

interface TimeStepForecast {
  timestamp: string;            // ISO timestamp
  surface: {
    tws: number;                // knots
    twd: number;                // degrees true
    mslp: number;               // hPa
    cloudCover: number | null;  // percent (0-100); null when the source carries none
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

#### Vector 1: Apparent Wind Speed Rating

$$AWS = \sqrt{TWS^2 + STW^2 + 2 \cdot TWS \cdot STW \cdot \cos(TWA)}$$

* $AWS < 12\text{ kt} \implies \mathbf{Champagne}$
* $12\text{ kt} \le AWS < 18\text{ kt} \implies \mathbf{Easy}$
* $18\text{ kt} \le AWS < 23\text{ kt} \implies \mathbf{Coffee}$
* $23\text{ kt} \le AWS < 33\text{ kt} \implies \mathbf{Rough}$
* $AWS \ge 33\text{ kt} \implies \mathbf{Sick}$

#### Vector 2: Monohull Vertical Acceleration ($a_z$)

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
* $0.315 \le a_z < 0.630\text{ m/s}^2 \implies \mathbf{Coffee}$
* $0.630 \le a_z < 1.250\text{ m/s}^2 \implies \mathbf{Rough}$
* $a_z \ge 1.250\text{ m/s}^2 \implies \mathbf{Sick}$

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
  --color-coffee: #ffcc00;
  --color-rough: #ff6600;
  --color-sick: #ff0000;
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
      convectiveWarnings: simulationResult.upperAirAnomalies.filter(u => u.cape > 1000 || u.kIndex > 28)
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

#### `<horizon-sparkline>` (SVG Renderer)

Renders a 24-column SVG bar chart where bar background color maps to `comfortLevel` (Champagne, Easy, Coffee, Rough, Sick) and bar height represents $AWS$.

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
