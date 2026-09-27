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
 * @param {(connected: boolean) => void} [handlers.onConnection]
 */
export function createStream({ onMode, onConnection }) {
  let ws = null;
  let attempt = 0;
  let closed = false;

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
 * Hazard notes from the Signal K resources API (best effort — a
 * missing notes provider simply yields no alerts).
 *
 * @returns {Promise<Array<{id: string, description: string|null,
 *   position: {latitude: number, longitude: number}|null,
 *   feature: object|null}>>}
 */
export async function fetchNotes() {
  try {
    const notes = await fetchJson(`${BASE}/api/resources/notes`);
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
