// src/protocol.ts
var BUS_ID = "plotterExt/1";
var RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HOST_ERROR: -32e3,
  TIMEOUT: -32001,
  CONNECTION_CLOSED: -32002,
};
var RpcError = class _RpcError extends Error {
  code;
  data;
  constructor(message, opts = {}) {
    super(message);
    this.name = "RpcError";
    this.code = opts.code ?? RPC_ERRORS.HOST_ERROR;
    const data = { ...(opts.data ?? {}) };
    if (opts.reason !== void 0) data.reason = opts.reason;
    this.data = Object.keys(data).length > 0 ? data : void 0;
  }
  get reason() {
    return typeof this.data?.reason === "string" ? this.data.reason : void 0;
  }
  toErrorObject() {
    return {
      code: this.code,
      message: this.message,
      ...(this.data ? { data: this.data } : {}),
    };
  }
  static fromErrorObject(err) {
    return new _RpcError(err.message, { code: err.code, data: err.data });
  }
  /** Normalize any thrown value into an RpcError suitable for the wire. */
  static from(err) {
    if (err instanceof _RpcError) return err;
    if (err instanceof Error) {
      return new _RpcError(err.message, { code: RPC_ERRORS.INTERNAL_ERROR });
    }
    return new _RpcError(String(err), { code: RPC_ERRORS.INTERNAL_ERROR });
  }
};
var EVENT_READY = "bus.ready";
var EVENT_HANDSHAKE = "bus.handshake";

// src/wildcard.ts
function matchesPattern(pattern, name) {
  if (pattern === name) return true;
  return match(pattern.split("."), 0, name.split("."), 0);
}
function match(p, pi, n, ni) {
  while (pi < p.length) {
    const seg = p[pi];
    if (seg === "**") {
      if (pi === p.length - 1) return true;
      for (let skip = ni; skip <= n.length; skip++) {
        if (match(p, pi + 1, n, skip)) return true;
      }
      return false;
    }
    if (ni >= n.length) return false;
    if (seg !== "*" && seg !== n[ni]) return false;
    pi++;
    ni++;
  }
  return ni === n.length;
}
function matchesAny(patterns, name) {
  for (const pattern of patterns) {
    if (matchesPattern(pattern, name)) return true;
  }
  return false;
}

// src/codec.ts
function wrap(msg) {
  return { bus: BUS_ID, msg };
}
function unwrap(data) {
  if (typeof data !== "object" || data === null) return null;
  const env = data;
  if (env.bus !== BUS_ID) return null;
  return isJsonRpcMessage(env.msg) ? env.msg : null;
}
function isJsonRpcMessage(v) {
  if (typeof v !== "object" || v === null) return false;
  const m = v;
  if (m.jsonrpc !== "2.0") return false;
  if (typeof m.method === "string") {
    return (
      m.id === void 0 || typeof m.id === "string" || typeof m.id === "number"
    );
  }
  const idOk =
    typeof m.id === "string" || typeof m.id === "number" || m.id === null;
  if (!idOk) return false;
  const hasResult = "result" in m;
  const err = m.error;
  const hasError =
    typeof err === "object" &&
    err !== null &&
    typeof err.code === "number" &&
    typeof err.message === "string";
  return hasResult ? !("error" in m) : hasError;
}
function isRequest(msg) {
  return "method" in msg && "id" in msg && msg.id !== void 0;
}
function isNotification(msg) {
  return "method" in msg && (!("id" in msg) || msg.id === void 0);
}
function isResponse(msg) {
  return !("method" in msg);
}

// src/port.ts
function windowPort(peer, opts = {}) {
  const listenWindow = opts.listenWindow ?? globalThis;
  const origin = opts.origin ?? listenWindow.location?.origin ?? "*";
  return {
    post(data) {
      peer.postMessage(data, origin);
    },
    listen(handler) {
      const fn = (ev) => {
        if (ev.source !== peer) return;
        if (origin !== "*" && ev.origin !== origin) return;
        handler(ev.data);
      };
      listenWindow.addEventListener("message", fn);
      return () => listenWindow.removeEventListener("message", fn);
    },
  };
}
function messagePort(port) {
  return {
    post(data) {
      port.postMessage(data);
    },
    listen(handler) {
      const fn = (ev) => handler(ev.data);
      port.addEventListener("message", fn);
      port.start?.();
      return () => port.removeEventListener("message", fn);
    },
  };
}

// src/endpoint.ts
var DEFAULT_CALL_TIMEOUT_MS = 1e4;
var BusEndpoint = class {
  callTimeoutMs;
  port;
  unlisten;
  onError;
  pending = /* @__PURE__ */ new Map();
  methods = /* @__PURE__ */ new Map();
  eventHandlers = /* @__PURE__ */ new Set();
  idPrefix = Math.random().toString(36).slice(2, 8);
  seq = 0;
  closed = false;
  constructor(opts) {
    this.port = opts.port;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.onError =
      opts.onError ?? ((err) => console.warn("[plotterext-bus]", err));
    this.unlisten = this.port.listen((data) => this.onData(data));
  }
  registerMethod(name, handler) {
    this.methods.set(name, handler);
  }
  unregisterMethod(name) {
    this.methods.delete(name);
  }
  /**
   * Handle incoming notifications whose names match any of the wildcard
   * patterns. Returns an unsubscribe function. This is local dispatch only;
   * telling the peer which events to forward is a separate concern
   * (`events.subscribe`).
   */
  onEvent(patterns, fn) {
    const entry = { patterns, fn };
    this.eventHandlers.add(entry);
    return () => this.eventHandlers.delete(entry);
  }
  /** Send a notification (an event) to the peer. */
  notify(method, params) {
    this.send({
      jsonrpc: "2.0",
      method,
      ...(params !== void 0 ? { params } : {}),
    });
  }
  /** Call a method on the peer; resolves with its result. */
  call(method, params, opts = {}) {
    if (this.closed) {
      return Promise.reject(
        new RpcError("Bus endpoint is closed", {
          code: RPC_ERRORS.CONNECTION_CLOSED,
          reason: "CLOSED",
        }),
      );
    }
    const id = `${this.idPrefix}-${++this.seq}`;
    const timeoutMs = opts.timeoutMs ?? this.callTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new RpcError(`Call timed out after ${timeoutMs}ms: ${method}`, {
                  code: RPC_ERRORS.TIMEOUT,
                  reason: "TIMEOUT",
                }),
              );
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      this.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== void 0 ? { params } : {}),
      });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.unlisten();
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(
        new RpcError("Bus endpoint closed", {
          code: RPC_ERRORS.CONNECTION_CLOSED,
          reason: "CLOSED",
        }),
      );
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }
  send(msg) {
    if (this.closed) return;
    this.port.post(wrap(msg));
  }
  onData(data) {
    const msg = unwrap(data);
    if (!msg) return;
    if (isResponse(msg)) {
      this.onResponse(msg);
    } else if (isRequest(msg)) {
      void this.onRequest(msg);
    } else if (isNotification(msg)) {
      this.onNotification(msg.method, msg.params);
    }
  }
  onResponse(msg) {
    if (msg.id === null) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if ("error" in msg) {
      p.reject(RpcError.fromErrorObject(msg.error));
    } else {
      p.resolve(msg.result);
    }
  }
  async onRequest(msg) {
    const handler = this.methods.get(msg.method);
    if (!handler) {
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: RPC_ERRORS.METHOD_NOT_FOUND,
          message: `Method not found: ${msg.method}`,
        },
      });
      return;
    }
    try {
      const result = await handler(msg.params, { endpoint: this });
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: result === void 0 ? null : result,
      });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: RpcError.from(err).toErrorObject(),
      });
    }
  }
  onNotification(name, params) {
    for (const entry of [...this.eventHandlers]) {
      if (matchesAny(entry.patterns, name)) {
        try {
          entry.fn(name, params);
        } catch (err) {
          this.onError(err);
        }
      }
    }
  }
};

export {
  BUS_ID,
  BusEndpoint,
  EVENT_HANDSHAKE,
  EVENT_READY,
  isJsonRpcMessage,
  isNotification,
  isRequest,
  isResponse,
  matchesAny,
  matchesPattern,
  messagePort,
  RPC_ERRORS,
  RpcError,
  unwrap,
  windowPort,
  wrap,
};
//# sourceMappingURL=chunk-4W6N34SD.js.map
