import {
  BusEndpoint,
  EVENT_HANDSHAKE,
  EVENT_READY,
  RPC_ERRORS,
  RpcError,
  windowPort,
} from "./chunk-4W6N34SD.js";

// src/extension.ts
var ExtensionClient = class {
  handshake;
  endpoint;
  constructor(endpoint, handshake) {
    this.endpoint = endpoint;
    this.handshake = handshake;
  }
  get context() {
    return this.handshake.context;
  }
  get apiVersion() {
    return this.handshake.apiVersion;
  }
  get capabilities() {
    return this.handshake.capabilities;
  }
  hasCapability(id) {
    return this.handshake.capabilities.includes(id);
  }
  /** Call a host API method. */
  call(method, params, opts) {
    return this.endpoint.call(method, params, opts);
  }
  /** Send a notification to the host. */
  notify(method, params) {
    this.endpoint.notify(method, params);
  }
  /**
   * Subscribe to host events matching wildcard patterns. Registers both the
   * host-side forwarding subscription and local dispatch; the returned
   * function tears down both.
   */
  async subscribe(patterns, handler) {
    const off = this.endpoint.onEvent(patterns, handler);
    let subscriptionId;
    try {
      const result = await this.call("events.subscribe", { patterns });
      subscriptionId = result.subscriptionId;
    } catch (err) {
      off();
      throw err;
    }
    return async () => {
      off();
      await this.call("events.unsubscribe", { subscriptionId }).catch(() => {});
    };
  }
  /** Host-persisted key/value state (see spec: State Storage). */
  state = {
    get: async (keys, scope) => {
      const result = await this.call("state.get", {
        ...(scope ? { scope } : {}),
        ...(keys ? { keys } : {}),
      });
      return result.values ?? {};
    },
    set: async (values, scope) => {
      await this.call("state.set", {
        ...(scope ? { scope } : {}),
        values,
      });
    },
  };
  /** Signal K data relayed by the host (capabilities signalk.stream / .put). */
  signalk = {
    /**
     * Subscribe to Signal K path values. The host publishes them as
     * `sk.<path>` events; this helper hides the event-name mapping and
     * establishes both the event-forwarding subscription and the host's
     * upstream Signal K subscription.
     */
    subscribe: async (paths, handler) => {
      const patterns = paths.map((p) => `sk.${p}`);
      const offEvents = await this.subscribe(patterns, (_name, params) =>
        handler(params),
      );
      let subscriptionId;
      try {
        const result = await this.call("signalk.subscribe", { paths });
        subscriptionId = result.subscriptionId;
      } catch (err) {
        await offEvents();
        throw err;
      }
      return async () => {
        await offEvents();
        await this.call("signalk.unsubscribe", { subscriptionId }).catch(
          () => {},
        );
      };
    },
    put: (path, value) => {
      return this.call("signalk.put", { path, value });
    },
  };
  /**
   * The host's visible routes (capability `routes`). Thin **typed** wrappers over
   * the host's `route.*` methods — each just delegates to `this.call(...)`, so a
   * plain-JS extension can call `client.call('route.replace', …)` directly and a
   * TypeScript extension gets the typed `client.route.replace(…)` sugar with no
   * behavioural difference. Follow lifecycle + mutations by subscribing to
   * `route.**` events (`RouteVisibleEvent` / `RouteDirtyEvent` / `RouteSavedEvent`
   * / `RouteHiddenEvent`). Further operations (rename/point ops) extend this
   * surface as the capability fills out.
   */
  route = {
    list: async () => {
      const result = await this.call("route.list");
      return result.routes ?? [];
    },
    create: async (opts) => {
      return await this.call("route.create", opts);
    },
    get: async (routeId) => {
      return await this.call("route.get", { routeId });
    },
    replace: async (routeId, points) => {
      return await this.call("route.replace", { routeId, points });
    },
    save: async (routeId, opts) => {
      return await this.call("route.save", {
        routeId,
        ...(opts ?? {}),
      });
    },
    show: async (ref) => {
      return await this.call("route.show", { ref });
    },
    hide: async (routeId) => {
      await this.call("route.hide", { routeId });
    },
    delete: async (routeId) => {
      await this.call("route.delete", { routeId });
    },
  };
  /**
   * The host's chart layers (capability `charts`). Thin **typed** wrappers over
   * the host's `chart.*` methods — a lightweight facade over the charts the host
   * already manages: enumerate them, toggle visibility, opacity and stacking
   * order (all batch). It does not create, add, or delete chart sources. Follow
   * changes (from any origin, including the host's own chart controls) by
   * subscribing to `chart.**` events (`ChartVisibilityEvent` / `ChartOpacityEvent`
   * / `ChartOrderEvent`) and re-reading `chart.list` where needed. As with every
   * wrapper, a plain-JS extension can call `client.call('chart.list', …)`
   * directly with no behavioural difference.
   */
  chart = {
    list: async () => {
      const result = await this.call("chart.list");
      return result.charts ?? [];
    },
    setVisibility: async (ids, visible) => {
      await this.call("chart.setVisibility", { ids, visible });
    },
    setOpacity: async (ids, opacity) => {
      await this.call("chart.setOpacity", { ids, opacity });
    },
    setOrder: async (order) => {
      await this.call("chart.setOrder", { order });
    },
  };
  /**
   * The host's night-vision display mode (capability `nightMode`). Read the
   * current `{ enabled, auto }` state, change it, and follow changes by
   * subscribing to the `nightMode.changed` event (`NightModeChangedEvent`).
   * `set` expresses the three states the spec defines: force on
   * (`{ enabled: true }`), force off (`{ enabled: false }`), follow the server
   * (`{ auto: true }`); setting `enabled` implies `auto: false`. As with every
   * wrapper, a plain-JS extension can call `client.call('nightMode.get' |
   * 'nightMode.set', …)` directly with no behavioural difference.
   */
  nightMode = {
    get: async () => {
      return await this.call("nightMode.get");
    },
    set: async (state) => {
      await this.call("nightMode.set", state);
    },
  };
  /**
   * The host's chart viewport (capability `map`). Read the current
   * `{ center, zoom, bounds }`, drive it, and follow it by subscribing to the
   * `map.view` event (`MapViewEvent`), which carries the same shape and fires
   * once per settled pan/zoom. Seed with `getView` so a follower has a view
   * before the first change. As with every wrapper, a plain-JS extension can
   * call `client.call('map.getView' | 'map.center' | 'map.fitBounds', …)`
   * directly with no behavioural difference.
   */
  map = {
    getView: async () => {
      return await this.call("map.getView");
    },
    center: async (position, zoom) => {
      await this.call("map.center", {
        position,
        ...(typeof zoom === "number" ? { zoom } : {}),
      });
    },
    fitBounds: async (bounds) => {
      await this.call("map.fitBounds", { bounds });
    },
  };
  close() {
    this.endpoint.close();
  }
};
function connectExtension(opts = {}) {
  const port =
    opts.port ??
    windowPort(globalThis.parent, {
      origin: "*",
    });
  const endpoint = new BusEndpoint({
    port,
    callTimeoutMs: opts.callTimeoutMs,
    onError: opts.onError,
  });
  const readyParams = opts.id ? { id: opts.id } : void 0;
  return new Promise((resolve, reject) => {
    let done = false;
    const off = endpoint.onEvent([EVENT_HANDSHAKE], (_name, params) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(new ExtensionClient(endpoint, params));
    });
    const interval = setInterval(
      () => endpoint.notify(EVENT_READY, readyParams),
      opts.readyIntervalMs ?? 250,
    );
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      endpoint.close();
      reject(
        new RpcError("Timed out waiting for host handshake", {
          code: RPC_ERRORS.TIMEOUT,
          reason: "HANDSHAKE_TIMEOUT",
        }),
      );
    }, opts.timeoutMs ?? 1e4);
    const cleanup = () => {
      off();
      clearInterval(interval);
      clearTimeout(timeout);
    };
    endpoint.notify(EVENT_READY, readyParams);
  });
}

export { connectExtension, ExtensionClient };
//# sourceMappingURL=chunk-7XRFPDQL.js.map
