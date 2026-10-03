/**
 * Signal K server plumbing for the webapp: REST fetch with timeout
 * and the delta WebSocket with exponential backoff. Subscription
 * filters carry `minRate` per the house rules — the app needs only
 * low-frequency data (environment mode, connectivity).
 *
 * @file components/sk-api.js
 */

const BASE = "/signalk/v1";

/**
 * Fetches JSON with an abort timeout.
 *
 * @param {string} url
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<any>} Parsed body
 */
export async function fetchJson(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, ...options });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Long-lived delta stream listener.
 *
 * Reconnects with exponential backoff (1 s doubling to 30 s, reset on
 * success) and reports connectivity so the UI can show an offline
 * state. Only low-rate paths are subscribed.
 *
 * @param {object} handlers
 * @param {(mode: string) => void} [handlers.onMode] -
 *   `vessels.self.environment.mode` ("day"/"night")
 * @param {(path: string, value: unknown) => void} [handlers.onTime] -
 *   `environment.time.timezoneOffset` / `environment.time.timezoneRegion`
 *   updates (signalk-ships-time), path-disambiguated
 * @param {(connected: boolean) => void} [handlers.onConnection]
 */
export function createStream({ onMode, onTime, onConnection }) {
  let ws = null;
  let attempt = 0;
  let closed = false;

  /** Paths the ship's-time subscription reports to {@link onTime}. */
  const TIME_PATHS = new Set([
    "environment.time.timezoneOffset",
    "environment.time.timezoneRegion",
  ]);

  const connect = () => {
    if (closed) {
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(
      `${proto}//${location.host}/signalk/v1/stream?subscribe=none`,
    );

    ws.onopen = () => {
      attempt = 0;
      onConnection?.(true);
      ws.send(
        JSON.stringify({
          context: "vessels.self",
          subscribe: [
            { path: "environment.mode", minRate: 5000, policy: "throttle" },
            // Ship's time changes only on zone crossings; a throttled
            // minute-rate subscription is plenty
            {
              path: "environment.time.timezoneOffset",
              minRate: 60000,
              policy: "throttle",
            },
            {
              path: "environment.time.timezoneRegion",
              minRate: 60000,
              policy: "throttle",
            },
          ],
        }),
      );
    };

    ws.onmessage = (event) => {
      try {
        const delta = JSON.parse(event.data);
        for (const update of delta.updates ?? []) {
          for (const { path, value } of update.values ?? []) {
            if (path === "environment.mode" && typeof value === "string") {
              onMode?.(value);
            } else if (TIME_PATHS.has(path) && value != null) {
              onTime?.(path, value);
            }
          }
        }
      } catch {
        // Malformed frame: ignore, the stream stays up
      }
    };

    ws.onclose = () => {
      onConnection?.(false);
      if (!closed) {
        const delay = Math.min(30000, 1000 * 2 ** attempt);
        attempt += 1;
        setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  };

  connect();

  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}

/**
 * The running watch schedule from signalk-watch-schedule (best
 * effort): shift boundaries for sail-work anchoring (route-sim),
 * extrapolated to the simulation horizon by rotation cycle in the
 * worker. Null when the plugin is absent or no watch is running —
 * the briefing then anchors canvas work to sunrise/sunset instead.
 *
 * @returns {Promise<{active: true, startedAt: number, cycleMs:
 *   number|null, shifts: Array<{startTime: number, endTime:
 *   number}>}|null>}
 */
export async function fetchWatchSchedule() {
  try {
    const state = await fetchJson(
      "/plugins/signalk-watch-schedule/api/state",
      8000,
    );
    if (state?.state?.onWatch !== true) {
      return null;
    }
    const cycleMin = state?.system?.cycleDuration;
    const shifts = (state?.schedule ?? [])
      .map((shift) => ({
        startTime: shift?.startTime,
        endTime: shift?.endTime,
      }))
      .filter((shift) => Number.isFinite(shift.startTime));
    if (shifts.length === 0) {
      return null;
    }
    return {
      active: true,
      startedAt: state.state.startedAt ?? null,
      cycleMs: Number.isFinite(cycleMin) ? cycleMin * 60000 : null,
      shifts,
    };
  } catch {
    return null; // No watch plugin or no running watch
  }
}

/**
 * The vessel's published timezone from the REST API (signalk-ships-time),
 * best effort: null when the server has none — the stream subscription
 * covers late arrivals. Leaf values arrive wrapped (`{value, ...}`)
 * on some server versions; unwrapped otherwise.
 *
 * @returns {Promise<{offset: number|string, region: string|null}|null>}
 */
export async function fetchShipTime() {
  const unwrap = (node) =>
    node && typeof node === "object" && "value" in node ? node.value : node;
  try {
    const time = await fetchJson(`${BASE}/api/vessels/self/environment/time`);
    const offset = unwrap(time?.timezoneOffset);
    const region = unwrap(time?.timezoneRegion);
    if (offset == null && region == null) {
      return null;
    }
    return { offset: offset ?? null, region: region ?? null };
  } catch {
    return null;
  }
}

/**
 * Hazard notes from the Signal K resources API (best effort — a
 * missing notes provider simply yields no alerts).
 *
 * @returns {Promise<Array<{id: string, description: string|null,
 *   position: {latitude: number, longitude: number}|null,
 *   feature: object|null}>>}
 */
export async function fetchNotes() {
  try {
    // SK v2 servers serve resources under /signalk/v2, older ones
    // under /signalk/v1 — probe in that order, both best-effort
    for (const version of ["v2", "v1"]) {
      try {
        const notes = await fetchJson(
          `${BASE.replace("/v1", `/${version}`)}/api/resources/notes`,
          8000,
        );
        if (notes && Object.keys(notes).length > 0) {
          return notes;
        }
      } catch {
        // Missing resource type or old server: try the next version
      }
    }
    return {};
    return Object.entries(notes ?? {}).map(([id, note]) => ({
      id,
      description: note?.description ?? note?.name ?? null,
      position: note?.position ?? null,
      feature: note?.feature ?? null,
    }));
  } catch {
    return [];
  }
}
