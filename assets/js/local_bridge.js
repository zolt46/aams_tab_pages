import { getFpLocalBase } from "./util.js";

const DEFAULT_TIMEOUT_MS = 18000;
const PROXY_WINDOW_NAME = "aams-fp-bridge";
const HANDSHAKE_TIMEOUT_MS = 10000;

let proxyWindow = null;
let proxyOrigin = "";
let proxyToken = "";
let proxyReady = false;
let proxyReadyPromise = null;
let proxyReadyResolve = null;
let proxyReadyReject = null;
let proxyHandshakeTimer = null;
let requestSeq = 0;

function isLoopbackHostname(hostname = "") {
  const name = hostname.toLowerCase();
  if (name === "localhost" || name === "127.0.0.1") return true;
  if (name === "[::1]" || name === "::1") return true;
  if (name.startsWith("127.")) return true;
  return false;
}

function isRemoteLoopbackBlocked(url) {
  if (typeof window === "undefined") return false;
  try {
    const resolved = new URL(url, window.location.href);
    if (!isLoopbackHostname(resolved.hostname)) {
      return false;
    }
    const pageHost = window.location.hostname || "";
    if (!pageHost) {
      return false;
    }
    if (isLoopbackHostname(pageHost)) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}
const pendingProxyRequests = new Map();

function createError(message, { code, response, status, cause } = {}) {
  const err = new Error(message || "");
  if (code) err.code = code;
  if (response !== undefined) err.response = response;
  if (status !== undefined) err.status = status;
  if (cause !== undefined) err.cause = cause;
  return err;
}

function joinLocalUrl(base, path) {
  const cleanBase = String(base || "").trim();
  if (!cleanBase) return path;
  if (!path.startsWith("/")) {
    return cleanBase.replace(/\/+$/, "") + "/" + path;
  }
  return cleanBase.replace(/\/+$/, "") + path;
}

function extractOrigin(url) {
  try {
    const resolved = new URL(url, window.location.href);
    return resolved.origin;
  } catch (err) {
    return "";
  }
}

function ensureAbortController() {
  if (typeof AbortController === "undefined") {
    return null;
  }
  try {
    return new AbortController();
  } catch (_) {
    return null;
  }
}

function parseJson(text) {
  if (text == null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function shouldForceProxy(url) {
  if (!url || typeof window === "undefined") return false;
  try {
    const resolved = new URL(url, window.location.href);
    if (resolved.protocol === "http:" && window.isSecureContext) {
      return true;
    }
  } catch (_) {}
  return false;
}

function isMixedContentError(error) {
  if (!error || typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  if (error.name === "TypeError") return true;
  const msg = String(error.message || "").toLowerCase();
  if (!msg) return false;
  if (msg.includes("failed to fetch")) return true;
  if (msg.includes("mixed") && msg.includes("content")) return true;
  if (msg.includes("block") && msg.includes("active content")) return true;
  if (msg.includes("networkerror")) return true;
  return false;
}

function cleanupProxy({ keepWindow = false, error } = {}) {
  proxyReady = false;
  if (proxyHandshakeTimer) {
    clearTimeout(proxyHandshakeTimer);
    proxyHandshakeTimer = null;
  }
  proxyReadyPromise = null;
  proxyReadyResolve = null;
  proxyReadyReject = null;
  if (!keepWindow && proxyWindow && !proxyWindow.closed) {
    try { proxyWindow.close(); } catch (_) {}
  }
  proxyWindow = null;
  proxyOrigin = "";
  proxyToken = "";
  if (pendingProxyRequests.size) {
    const rejection = error || createError("로컬 브릿지 창과의 연결이 종료되었습니다.", { code: "proxy_closed" });
    for (const { reject, timer } of pendingProxyRequests.values()) {
      if (timer) clearTimeout(timer);
      reject(rejection);
    }
    pendingProxyRequests.clear();
  }
}

function ensureProxyMessageListener() {
  if (ensureProxyMessageListener._installed) return;
  window.addEventListener("message", (event) => {
    if (!proxyOrigin) return;
    if (event.origin !== proxyOrigin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.token !== proxyToken) return;

    if (data.type === "fp-proxy-ready") {
      proxyReady = true;
      if (proxyHandshakeTimer) {
        clearTimeout(proxyHandshakeTimer);
        proxyHandshakeTimer = null;
      }
      if (proxyReadyResolve) {
        proxyReadyResolve();
      }
      proxyReadyPromise = null;
      proxyReadyResolve = null;
      proxyReadyReject = null;
      return;
    }

    if (data.type === "fp-proxy-closed") {
      const err = createError("로컬 브릿지 창이 닫혔습니다.", { code: "proxy_closed" });
      if (proxyReadyReject) {
        proxyReadyReject(err);
      }
      cleanupProxy({ error: err });
      return;
    }

    if (data.type === "fp-proxy-response") {
      const entry = pendingProxyRequests.get(data.id);
      if (!entry) return;
      pendingProxyRequests.delete(data.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (data.transportError) {
        const err = createError(
          data.error || "로컬 브릿지 창 요청에 실패했습니다.",
          { code: data.code || "proxy_transport_failed" }
        );
        entry.reject(err);
        return;
      }
      entry.resolve({
        ok: data.ok,
        status: data.status,
        data: data.json !== undefined ? data.json : null,
        text: data.text !== undefined ? data.text : "",
        headers: data.headers || {},
        error: data.error
      });
      return;
    }
  });
  ensureProxyMessageListener._installed = true;
}

async function ensureProxyWindow(targetUrl) {
  const origin = extractOrigin(targetUrl);
  if (!origin) {
    throw createError("로컬 브릿지 주소를 확인할 수 없습니다.", { code: "invalid_origin" });
  }
  if (isRemoteLoopbackBlocked(targetUrl)) {
    throw createError(
      "현재 기기에서는 127.0.0.1 로컬 브릿지에 접근할 수 없습니다. 브릿지 PC의 IP 주소를 설정해 주세요.",
      { code: "loopback_unreachable" }
    );
  }
  if (proxyWindow && !proxyWindow.closed && proxyOrigin === origin) {
    if (proxyReady) return;
    if (proxyReadyPromise) {
      return proxyReadyPromise;
    }
  }

  cleanupProxy();

  proxyOrigin = origin;
  proxyToken = `tok_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  proxyReady = false;

  const allowedOrigin = (window.location && window.location.origin && window.location.origin !== "null")
    ? window.location.origin
    : "";
  const params = new URLSearchParams();
  if (allowedOrigin) {
    params.set("origin", allowedOrigin);
  }
  params.set("token", proxyToken);
  params.set("title", "AAMS 로컬 브릿지 연결");
  const proxyUrl = `${origin.replace(/\/+$/, "")}/bridge-proxy.html?${params.toString()}`;

  const opened = window.open(proxyUrl, PROXY_WINDOW_NAME, "width=520,height=720");
  if (!opened) {
    cleanupProxy();
    throw createError("로컬 브릿지 창을 열 수 없습니다. 브라우저에서 팝업을 허용해 주세요.", {
      code: "proxy_popup_blocked"
    });
  }
  proxyWindow = opened;
  if (typeof opened.focus === "function") {
    try { opened.focus(); } catch (_) {}
  }

  ensureProxyMessageListener();

  proxyReadyPromise = new Promise((resolve, reject) => {
    proxyReadyResolve = resolve;
    proxyReadyReject = (err) => {
      const finalError = err instanceof Error ? err : createError("로컬 브릿지 창 연결에 실패했습니다.", {
        code: "proxy_handshake_failed"
      });
      cleanupProxy({ error: finalError });
      reject(finalError);
    };
  });

  proxyHandshakeTimer = setTimeout(() => {
    if (proxyReady) return;
    if (proxyReadyReject) {
      proxyReadyReject(createError(
        "로컬 브릿지 창 연결에 실패했습니다. 창이 차단되었는지 확인하세요.",
        { code: "proxy_handshake_timeout" }
      ));
    }
  }, HANDSHAKE_TIMEOUT_MS);

  return proxyReadyPromise;
}

async function requestViaProxy(url, options) {
  await ensureProxyWindow(url);
  const id = `req_${Date.now().toString(36)}_${(++requestSeq).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      pendingProxyRequests.delete(id);
      reject(createError("로컬 브릿지 응답이 지연되었습니다.", { code: "proxy_timeout" }));
    }, timeoutMs + 2000);
    pendingProxyRequests.set(id, { resolve, reject, timer });
    try {
      proxyWindow.postMessage({
        type: "fp-proxy-request",
        token: proxyToken,
        id,
        url,
        method: options.method,
        headers: options.headers,
        body: options.body,
        timeoutMs
      }, proxyOrigin);
    } catch (err) {
      clearTimeout(timer);
      pendingProxyRequests.delete(id);
      reject(createError("로컬 브릿지 창과 통신할 수 없습니다.", {
        code: "proxy_post_failed",
        cause: err
      }));
    }
  });
}

async function requestViaFetch(url, options) {
  const controller = ensureAbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller ? controller.signal : undefined
    });
    const contentType = res.headers?.get ? (res.headers.get("content-type") || "") : "";
    let data = null;
    let text = "";
    if (contentType.includes("application/json")) {
      try {
        data = await res.json();
      } catch (err) {
        data = null;
        text = await res.text().catch(() => "");
      }
    } else {
      text = await res.text().catch(() => "");
    }
    return { ok: res.ok, status: res.status, data, text, headers: { "content-type": contentType } };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw createError("로컬 브릿지 응답이 지연되었습니다.", { code: "timeout" });
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildRequestOptions(options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const headers = { ...(options.headers || {}) };
  let body = options.body;

  const hasJsonHeader = Object.keys(headers).some((key) => key.toLowerCase() === "content-type" && String(headers[key]).includes("application/json"));

  if (body !== undefined && body !== null) {
    if (typeof body === "object" && !(body instanceof FormData) && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
      if (!hasJsonHeader) {
        headers["Content-Type"] = "application/json";
      }
      if (headers["Content-Type"] && String(headers["Content-Type"]).includes("application/json")) {
        body = JSON.stringify(body);
      }
    } else if (typeof body === "string") {
      if (!hasJsonHeader) {
        headers["Content-Type"] = "application/json";
      }
    }
  }

  if (method === "GET" || method === "HEAD") {
    body = undefined;
  }

  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    normalizedHeaders[key] = value;
  }

  return { method, timeoutMs, headers: normalizedHeaders, body };
}

async function makeLocalRequest(path, options = {}) {
  const base = getFpLocalBase();
  if (!base) {
    throw createError("로컬 브릿지 주소를 설정해 주세요.", { code: "missing_base" });
  }
  const url = joinLocalUrl(base, path);
  const requestOptions = buildRequestOptions(options);

  if (isRemoteLoopbackBlocked(url)) {
    throw createError(
      "현재 기기에서는 127.0.0.1 로컬 브릿지에 접근할 수 없습니다. 브릿지 PC의 IP 주소를 설정해 주세요.",
      { code: "loopback_unreachable" }
    );
  }

  if (shouldForceProxy(url)) {
    return requestViaProxy(url, requestOptions);
  }

  try {
    return await requestViaFetch(url, requestOptions);
  } catch (error) {
    if (isMixedContentError(error) || error?.code === "proxy_timeout") {
      return requestViaProxy(url, requestOptions);
    }
    throw error;
  }
}

function normalizePayload(result) {
  if (!result) return { ok: false, data: null };
  if (result.data !== null && result.data !== undefined) {
    return { ok: result.ok, status: result.status, data: result.data, error: result.error };
  }
  if (result.text) {
    const parsed = parseJson(result.text);
    if (parsed !== null) {
      return { ok: result.ok, status: result.status, data: parsed, error: result.error };
    }
  }
  return { ok: result.ok, status: result.status, data: null, error: result.error };
}

export async function callLocalJson(path, options = {}) {
  let response;
  try {
    response = await makeLocalRequest(path, options);
  } catch (error) {
    if (error?.code === "timeout" || error?.code === "proxy_timeout") {
      throw createError("로컬 브릿지 응답이 지연되었습니다.", { code: "timeout", cause: error });
    }
    if (error?.code === "proxy_popup_blocked") {
      throw error;
    }
    if (error?.code === "loopback_unreachable") {
      throw error;
    }
    if (error?.code === "proxy_post_failed" || error?.code === "proxy_handshake_timeout" || error?.code === "proxy_handshake_failed" || error?.code === "proxy_closed") {
      throw error;
    }
    if (isMixedContentError(error)) {
      throw createError("보안 연결에서 로컬 브릿지를 직접 호출할 수 없습니다. 로컬 브릿지 창 연결을 다시 시도해 주세요.", {
        code: "mixed_content_blocked",
        cause: error
      });
    }
    if (error instanceof Error) {
      if (error.code) {
        throw error;
      }
      throw createError("로컬 브릿지에 연결할 수 없습니다.", {
        code: "local_fetch_failed",
        cause: error
      });
    }
    throw createError("로컬 브릿지에 연결할 수 없습니다.", { code: "local_fetch_failed", cause: error });
  }

  const payload = normalizePayload(response);
  const data = payload.data;
  const ok = payload.ok && (data == null || data.ok !== false);

  if (!ok) {
    const reason = (data && (data.error || data.message)) || payload.error || `HTTP ${payload.status || 0}`;
    const err = createError(reason || "로컬 브릿지 요청이 실패했습니다.", {
      code: data?.error || payload.error || "local_command_failed",
      response: data,
      status: payload.status
    });
    throw err;
  }

  return data || { ok: true };
}

export async function ensureLocalBridgeProxy() {
  const base = getFpLocalBase();
  if (!base) {
    throw createError("로컬 브릿지 주소를 설정해 주세요.", { code: "missing_base" });
  }
  const url = joinLocalUrl(base, "/health");
  if (isRemoteLoopbackBlocked(url)) {
    throw createError(
      "현재 기기에서는 127.0.0.1 로컬 브릿지에 접근할 수 없습니다. 브릿지 PC의 IP 주소를 설정해 주세요.",
      { code: "loopback_unreachable" }
    );
  }
  await ensureProxyWindow(url);
}

export function isLocalProxyActive() {
  return !!proxyWindow && !proxyWindow.closed && proxyReady;
}

window.addEventListener("beforeunload", () => {
  cleanupProxy();
});