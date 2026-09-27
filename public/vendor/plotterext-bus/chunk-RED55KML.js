import {
  BusEndpoint,
  EVENT_HANDSHAKE,
  EVENT_READY,
  matchesAny,
  RPC_ERRORS,
  RpcError,
} from "./chunk-4W6N34SD.js";

// src/host.ts
var HostConnection = class {
  endpoint;
  context;
  hostInfo;
  subs = /* @__PURE__ */ new Map();
  onSubscriptionsChanged;
  adoptCallerId;
  subSeq = 0;
  constructor(opts) {
    this.hostInfo = opts.hostInfo;
    this.context = opts.context;
    this.onSubscriptionsChanged = opts.onSubscriptionsChanged;
    this.adoptCallerId = opts.adoptCallerId ?? false;
    this.endpoint = new BusEndpoint({
      port: opts.port,
      callTimeoutMs: opts.callTimeoutMs,
      onError: opts.onError,
    });
    for (const [name, handler] of Object.entries(opts.methods ?? {})) {
      this.endpoint.registerMethod(name, handler);
    }
    this.endpoint.registerMethod("events.subscribe", (params) =>
      this.handleSubscribe(params),
    );
    this.endpoint.registerMethod("events.unsubscribe", (params) =>
      this.handleUnsubscribe(params),
    );
    this.endpoint.onEvent([EVENT_READY], (_name, params) =>
      this.sendHandshake(params),
    );
  }
  registerMethod(name, handler) {
    this.endpoint.registerMethod(name, handler);
  }
  /**
   * Publish an event to this context. Delivered only when the context has a
   * matching subscription; returns whether it was delivered.
   */
  publish(eventName, params) {
    if (!this.hasSubscriber(eventName)) return false;
    this.endpoint.notify(eventName, params);
    return true;
  }
  hasSubscriber(eventName) {
    for (const [, patterns] of this.subs) {
      if (matchesAny(patterns, eventName)) return true;
    }
    return false;
  }
  /** Union of currently subscribed patterns. */
  subscribedPatterns() {
    const all = /* @__PURE__ */ new Set();
    for (const [, patterns] of this.subs) {
      for (const p of patterns) all.add(p);
    }
    return [...all];
  }
  close() {
    this.endpoint.close();
    this.subs.clear();
  }
  sendHandshake(ready) {
    const context =
      this.adoptCallerId && ready?.id
        ? { ...this.context, id: ready.id }
        : this.context;
    this.endpoint.notify(EVENT_HANDSHAKE, {
      ...this.hostInfo,
      context,
    });
  }
  handleSubscribe(params) {
    const patterns = params?.patterns;
    if (
      !Array.isArray(patterns) ||
      patterns.length === 0 ||
      !patterns.every((p) => typeof p === "string" && p.length > 0)
    ) {
      throw new RpcError(
        "events.subscribe requires a non-empty patterns array",
        {
          code: RPC_ERRORS.INVALID_PARAMS,
          reason: "INVALID_PATTERNS",
        },
      );
    }
    const subscriptionId = `sub-${++this.subSeq}`;
    this.subs.set(subscriptionId, patterns);
    this.onSubscriptionsChanged?.(this.subscribedPatterns());
    return { subscriptionId };
  }
  handleUnsubscribe(params) {
    const id = params?.subscriptionId;
    if (typeof id !== "string" || !this.subs.has(id)) {
      throw new RpcError("Unknown subscriptionId", {
        code: RPC_ERRORS.INVALID_PARAMS,
        reason: "UNKNOWN_SUBSCRIPTION",
      });
    }
    this.subs.delete(id);
    this.onSubscriptionsChanged?.(this.subscribedPatterns());
    return {};
  }
};

export { HostConnection };
//# sourceMappingURL=chunk-RED55KML.js.map
