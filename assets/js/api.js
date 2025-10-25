// assets/js/api.js
import { getApiBase } from "./util.js";

const requestDetailCache = new Map();

function apiBase() {
  // same-origin 기본값 (로컬에서 index.html을 같은 서버로 서빙하면 빈 문자열로도 동작)
  return getApiBase() || "";
}

function wsBase() {
  const cfg = window.AAMS_CONFIG || {};
  if (cfg.WSS_BASE && typeof cfg.WSS_BASE === "string" && cfg.WSS_BASE.trim()) {
    return cfg.WSS_BASE.trim();
  }
  const base = cfg.API_BASE || "";
  if (base.startsWith("https://")) return base.replace(/^https:/i, "wss:");
  if (base.startsWith("http://")) return base.replace(/^http:/i, "ws:");
  if (typeof window !== "undefined" && window.location) {
    const origin = window.location.origin || "";
    if (origin.startsWith("https://")) return origin.replace(/^https:/i, "wss:");
    if (origin.startsWith("http://")) return origin.replace(/^http:/i, "ws:");
  }
  return "";
}

const wsMessageHandlers = new Set();
const wsTypeHandlers = new Map();
const wsStateHandlers = {
  open: new Set(),
  close: new Set(),
  error: new Set(),
  auth: new Set()
};

let ws = null;
let wsSite = null;
let wsAuthenticated = false;
let wsReconnectTimer = null;
let wsReconnectDelay = 2000;
const wsQueue = [];
let wsRequestCounter = 0;
const pendingRequests = new Map();

const defaultSite = () => (window.FP_SITE || "site-01");

function emitWsState(event, payload) {
  const handlers = wsStateHandlers[event];
  if (!handlers) return;
  handlers.forEach((handler) => {
    try { handler(payload); }
    catch (err) { console.warn(`[AAMS][ws] ${event} handler error`, err); }
  });
}

function emitWsMessage(message) {
  wsMessageHandlers.forEach((handler) => {
    try { handler(message); }
    catch (err) { console.warn("[AAMS][ws] message handler error", err); }
  });
  if (message && message.type) {
    const set = wsTypeHandlers.get(message.type);
    if (set) {
      set.forEach((handler) => {
        try { handler(message); }
        catch (err) { console.warn(`[AAMS][ws] handler error for ${message.type}`, err); }
      });
    }
  }
}

function rejectAllPending(reason) {
  if (!pendingRequests.size) return;
  const error = reason instanceof Error ? reason : new Error(String(reason || 'ws_closed'));
  pendingRequests.forEach((entry, key) => {
    if (entry?.timer) clearTimeout(entry.timer);
    try { entry.reject(error); }
    catch (err) { console.warn('[AAMS][ws] pending reject error', err); }
    pendingRequests.delete(key);
  });
}

function maybeResolvePending(message) {
  const requestId = message?.requestId;
  if (!requestId || !pendingRequests.has(requestId)) return;
  const entry = pendingRequests.get(requestId);
  const { responseTypes, match, rejectOnError = true, timer } = entry;
  const typeOk = !responseTypes || responseTypes.has(message.type);
  let matchOk = true;
  if (match && typeof match === 'function') {
    try {
      matchOk = !!match(message);
    } catch (err) {
      console.warn('[AAMS][ws] pending match error', err);
      matchOk = false;
    }
  }
  if (!typeOk || !matchOk) return;

  pendingRequests.delete(requestId);
  if (timer) clearTimeout(timer);

  const isError = message?.type === 'ERROR' || message?.ok === false;
  if (isError && rejectOnError !== false) {
    const err = new Error(message?.error || message?.reason || 'ws_error');
    err.response = message;
    err.code = message?.error || message?.code || 'ws_error';
    try { entry.reject(err); }
    catch (rejectErr) { console.warn('[AAMS][ws] pending reject error', rejectErr); }
    return;
  }

  try { entry.resolve(message); }
  catch (resolveErr) { console.warn('[AAMS][ws] pending resolve error', resolveErr); }
}

function flushWsQueue() {
  if (!wsAuthenticated) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (wsQueue.length) {
    const payload = wsQueue.shift();
    const site = payload.site || wsSite || defaultSite();
    try {
      ws.send(JSON.stringify({ ...payload, site }));
    } catch (err) {
      console.warn("[AAMS][ws] send failed, requeueing", err);
      wsQueue.unshift(payload);
      try { ws.close(); } catch (_) {}
      break;
    }
  }
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  const base = wsBase();
  if (!base) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 15000);
    try { connectWebSocket(wsSite); }
    catch (err) { console.warn("[AAMS][ws] reconnect failed", err); }
  }, wsReconnectDelay);
}

function resetReconnectDelay() {
  wsReconnectDelay = 2000;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

function getWsUrl() {
  const base = wsBase();
  if (!base) return "";
  return `${base.replace(/\/+$/, "")}/ws`;
}

function ensureSite(site) {
  const value = typeof site === "string" && site.trim() ? site.trim() : defaultSite();
  wsSite = value;
  return value;
}

function handleWsOpen() {
  resetReconnectDelay();
  wsAuthenticated = false;
  const site = wsSite || defaultSite();
  try {
    ws.send(JSON.stringify({ type: "AUTH_UI", site }));
  } catch (err) {
    console.warn("[AAMS][ws] auth send failed", err);
  }
  emitWsState("open", { site });
}

function handleWsClose(evt) {
  emitWsState("close", { code: evt?.code, reason: evt?.reason, site: wsSite });
  wsAuthenticated = false;
  ws = null;
  window.AAMS_WS = null;
  rejectAllPending(new Error('ws_closed'));
  scheduleWsReconnect();
}

function handleWsError(evt) {
  emitWsState("error", evt);
}

function handleWsMessage(event) {
  const raw = event?.data;
  if (!raw) return;
  let message;
  try {
    message = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
  } catch (err) {
    console.warn("[AAMS][ws] invalid message", err);
    return;
  }

  if (message.type === "AUTH_ACK") {
    if (message.role === "ui") {
      wsAuthenticated = true;
      flushWsQueue();
      emitWsState("auth", message);
    }
  } else if (message.type === "PING") {
    sendWebSocketMessage({ type: "PONG" });
  }

  emitWsMessage(message);
  maybeResolvePending(message);
}

export function connectWebSocket(site = defaultSite()) {
  ensureSite(site);
  const url = getWsUrl();
  if (!url) {
    console.warn("[AAMS][ws] WSS_BASE가 설정되지 않았습니다.");
    return null;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    return ws;
  }

  if (ws) {
    try { ws.close(); } catch (_) {}
  }

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.warn("[AAMS][ws] 연결 실패", err);
    scheduleWsReconnect();
    return null;
  }

  window.AAMS_WS = ws;
  wsAuthenticated = false;

  ws.addEventListener("open", handleWsOpen);
  ws.addEventListener("close", handleWsClose);
  ws.addEventListener("error", handleWsError);
  ws.addEventListener("message", handleWsMessage);

  return ws;
}

export function getWebSocket() {
  return ws;
}

export function onWebSocketMessage(handler) {
  if (typeof handler !== "function") return () => {};
  wsMessageHandlers.add(handler);
  return () => wsMessageHandlers.delete(handler);
}

export function onWebSocketEvent(type, handler) {
  if (!type || typeof handler !== "function") return () => {};
  const key = String(type);
  if (!wsTypeHandlers.has(key)) {
    wsTypeHandlers.set(key, new Set());
  }
  const set = wsTypeHandlers.get(key);
  set.add(handler);
  return () => {
    set.delete(handler);
    if (!set.size) wsTypeHandlers.delete(key);
  };
}

export function onWebSocketState(event, handler) {
  if (!wsStateHandlers[event] || typeof handler !== "function") return () => {};
  const set = wsStateHandlers[event];
  set.add(handler);
  return () => set.delete(handler);
}

export function sendWebSocketMessage(message) {
  if (!message || typeof message !== "object") return false;
  const payload = { ...message };
  if (!payload.site) payload.site = wsSite || defaultSite();

  if (ws && ws.readyState === WebSocket.OPEN && wsAuthenticated) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      console.warn("[AAMS][ws] send 실패, 큐에 저장합니다", err);
      wsQueue.push(payload);
      try { ws.close(); } catch (_) {}
      return false;
    }
  }

  wsQueue.push(payload);
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connectWebSocket(payload.site);
  }
  return false;
}

export function sendWebSocketRequest(message, { responseType, match, timeoutMs = 15000, rejectOnError = true } = {}) {
  if (!message || typeof message !== 'object') {
    throw new Error('message_required');
  }
  const requestId = message.requestId && String(message.requestId).trim()
    ? String(message.requestId).trim()
    : `req-${Date.now()}-${++wsRequestCounter}`;
  const payload = { ...message, requestId };
  if (!payload.site) payload.site = wsSite || defaultSite();
  const responseTypes = responseType
    ? (Array.isArray(responseType) ? new Set(responseType) : new Set([responseType]))
    : null;
  let timer = null;
  const promise = new Promise((resolve, reject) => {
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        const err = new Error('ws_timeout');
        err.code = 'timeout';
        err.requestId = requestId;
        reject(err);
      }, timeoutMs);
    }
    pendingRequests.set(requestId, { resolve, reject, timer, responseTypes, match, rejectOnError });
  });
  sendWebSocketMessage(payload);
  return { requestId, promise };
}

async function _get(url) {
  const r = await fetch(url); // credentials 옵션 제거됨
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

async function _post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    // credentials 옵션 제거됨
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  // ▼▼▼ [수정] 이 부분을 복원/확인하세요 ▼▼▼
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  try { return await r.json(); } catch { return { ok: true }; }
} // ⬅️ 함수의 닫는 괄호 '}' 추가
// ▲▲▲ [수정] _post 함수는 여기까지입니다 ▲▲▲

async function _del(url, body) {
  const opts = { method: "DELETE", headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  try { return await r.json(); } catch { return { ok: true }; }
}

/** =========================
 * 인원(personnel)
 * ========================= */
export async function listUsers({ role } = {}) {
  // server.js: GET /api/personnel (is_admin 포함)
  const rows = await _get(`${apiBase()}/api/personnel`);
  if (!role) return rows;
  if (role === "admin") return rows.filter(r => !!r.is_admin);
  if (role === "user")  return rows.filter(r => !r.is_admin);
  return rows;
}

/** =========================
 * 로그인 (관리자만 통과)
 * ========================= */
export async function verifyAdminCredential(user_id, password) {
  // server.js: POST /api/login { user_id, password }  (임시: 평문비교)
  const res = await _post(`${apiBase()}/api/login`, { user_id, password });
  // 관리자만 허용
  return !!res?.is_admin;
}

/** =========================
 * 요청/집행 (사용자 측)
 * ========================= */

// “나와 관련된 요청”을 서버에서 가져온 뒤, 집행 대기(= APPROVED)만 추려서 보여줌
const USER_EXECUTION_PIPELINE_STATUSES = new Set([
  "APPROVED",
  "DISPATCH_PENDING",
  "DISPATCHING",
  "DISPATCHED",
  "EXECUTING",
  "EXECUTED",
  "COMPLETED",
  "DISPATCH_FAILED",
  "EXECUTION_FAILED"
]);

export async function fetchMyPendingApprovals(userId) {
  // server.js: GET /api/requests/for_user/:uid
  const all = await _get(`${apiBase()}/api/requests/for_user/${encodeURIComponent(userId)}`);

  const rows = (all || [])
    .filter((r) => USER_EXECUTION_PIPELINE_STATUSES.has(String(r?.status || "").toUpperCase()))
    .map(toRequestRow);

  await enrichRequestsWithItems(rows);
  return rows;
}
export { fetchMyPendingApprovals as fetchUserPending };

// 집행
export async function executeRequest({ requestId, executorId, dispatch }) {

  const body = { executed_by: executorId };
  if (dispatch) {
    body.dispatch = dispatch;
  }
  return _post(`${apiBase()}/api/requests/${encodeURIComponent(requestId)}/execute`, body);
}

export async function markDispatchFailure({ requestId, reason, actorId }) {
  const body = {};
  if (reason) body.reason = reason;
  if (actorId) body.actor_id = actorId;
  return _post(`${apiBase()}/api/requests/${encodeURIComponent(requestId)}/dispatch_fail`, body);
}

export async function completeExecution({ requestId, actorId, eventId, result, statusReason }) {
  const body = {};
  if (actorId) body.actor_id = actorId;
  if (eventId) body.event_id = eventId;
  if (result) body.result = result;
  if (statusReason) body.status_reason = statusReason;
  return _post(`${apiBase()}/api/requests/${encodeURIComponent(requestId)}/execute_complete`, body);
}

/** =========================
 * 관리자 승인/거부/재오픈
 * ========================= */
export async function adminAction({ requestId, action, actorId, reason }) {
  const id = encodeURIComponent(requestId);
  const base = `${apiBase()}/api/requests/${id}`;

  if (action === "approve") {
    // server.js: POST /api/requests/:id/approve { approver_id }
    return _post(`${base}/approve`, { approver_id: actorId });
  }
  if (action === "reject") {
    // server.js: POST /api/requests/:id/reject { approver_id, reason }
    return _post(`${base}/reject`, { approver_id: actorId, reason: reason || "" });
  }
  if (action === "reopen") {
    // server.js: POST /api/requests/:id/reopen { actor_id }
    return _post(`${base}/reopen`, { actor_id: actorId });
  }
  throw new Error(`unknown admin action: ${action}`);
}


// =========================
// 관리자 대기건 목록
// =========================
export async function fetchAdminPending({ limit = 30 } = {}) {
  const base = apiBase();
  const tries = [
    `${base}/api/requests?status=SUBMITTED&limit=${limit}`,
    `${base}/api/requests/pending?limit=${limit}`,
    `${base}/api/requests?limit=${limit}`
  ];
  let data = null, lastErr;
  for (const url of tries) {
    try { data = await _get(url); if (data) break; } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr || new Error("대기건 API 응답 없음");
  const rows = Array.isArray(data) ? data : (data.rows || []);
  // 상태가 SUBMITTED/PENDING/WAITING/REQUESTED 인 것만 대기건으로 간주
  const pending = rows.filter(r => ["SUBMITTED","PENDING","WAITING","REQUESTED"].includes(r.status));
  const mapped = pending.map(toRequestRow);
  await enrichRequestsWithItems(mapped);
  return mapped;
}

// 사용자/관리자 공통 표준화
function toRequestRow(r){
  const submittedAt = r.submitted_at || r.requested_at || r.created_at || null;
  const approvedAt = r.approved_at || null;
  const executedAt = r.executed_at || null;
  const rejectedAt = r.rejected_at || null;
  const updatedAt = r.updated_at || approvedAt || executedAt || rejectedAt || r.created_at || null;
  const normalizedStatus = typeof r.status === "string" ? r.status.toUpperCase() : r.status;

  return {
    id: r.id,
    type: r.request_type || r.type,
    status: normalizedStatus,
    weapon_code: r.weapon_code || r.weapon?.code,
    ammo_summary: Array.isArray(r.ammo_items) && r.ammo_items.length
      ? r.ammo_items.map(it => `${it.caliber || it.type}×${it.qty}`).join(", ")
      : r.ammo_summary || null,
    requester_name: r.requester_name || r.requester?.name || r.user?.name,
    created_at: r.created_at || submittedAt || approvedAt || updatedAt,
    requested_at: submittedAt,
    approved_at: approvedAt,
    executed_at: executedAt,
    rejected_at: rejectedAt,
    updated_at: updatedAt,
    scheduled_at: r.scheduled_at || r.schedule_at || null,
    purpose: r.purpose || r.memo || r.notes || "",
    location: r.location || r.site || r.place || "",
    approver_id: r.approver_id || null,
    requester_id: r.requester_id,
    status_reason: r.status_reason || r.reason || "",
    raw: r
  };
}
export async function fetchPersonnelById(id) {
  if (!id) throw new Error("id required");
  return _get(`${apiBase()}/api/personnel/${encodeURIComponent(id)}`);
}

export async function fetchRequestDetail(id, { force = false } = {}) {
  if (!id) throw new Error("id required");
  const cacheKey = String(id);
  if (!force && requestDetailCache.has(cacheKey)) {
    return requestDetailCache.get(cacheKey);
  }
  const detail = await _get(`${apiBase()}/api/requests/${encodeURIComponent(id)}`);
  requestDetailCache.set(cacheKey, detail);
  return detail;
}

export function invalidateRequestDetail(id) {
  if (id === undefined || id === null) {
    requestDetailCache.clear();
    return;
  }
  requestDetailCache.delete(String(id));
}

export async function fetchDashboardSummary() {
  const base = apiBase();
  const [health, personnel, firearms, ammo, submitted] = await Promise.all([
    _get(`${base}/health/db`).catch(() => null),
    _get(`${base}/api/personnel`).catch(() => []),
    _get(`${base}/api/firearms`).catch(() => []),
    _get(`${base}/api/ammunition`).catch(() => []),
    _get(`${base}/api/requests?status=SUBMITTED`).catch(() => [])
  ]);

  const personCount = Array.isArray(personnel) ? personnel.length : 0;
  const firearmCount = health?.firearms_total ?? (Array.isArray(firearms) ? firearms.length : 0);
  const ammoCount = health?.ammo_total ?? (Array.isArray(ammo) ? ammo.length : 0);

  const admins = Array.isArray(personnel) ? personnel.filter((p) => p.is_admin).length : 0;
  let inDepot = 0, deployed = 0, maint = 0;
  if (Array.isArray(firearms)) {
    const statusMap = firearms.reduce((acc, row) => {
      const key = row.status || row.firearm_status || "";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    inDepot = statusMap["불입"] || statusMap["IN_DEPOT"] || 0;
    deployed = statusMap["불출"] || statusMap["DEPLOYED"] || 0;
    maint = statusMap["정비중"] || statusMap["MAINTENANCE"] || statusMap["MAINT"] || 0;
  }

  let totalAmmoQty = 0, lowAmmo = 0;
  if (Array.isArray(ammo)) {
    totalAmmoQty = ammo.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
    lowAmmo = ammo.filter((row) => (Number(row.quantity) || 0) <= 20).length;
  }

  const pending = Array.isArray(submitted) ? submitted.length : 0;

  return {
    person: personCount,
    firearm: firearmCount,
    ammo: ammoCount,
    admins,
    inDepot,
    deployed,
    maint,
    totalAmmoQty,
    lowAmmo,
    pending
  };
}

export async function fetchAdminRequestOverview({ limit = 60 } = {}) {
  const base = apiBase();
  const data = await _get(`${base}/api/requests?limit=${limit}`);
  const rows = Array.isArray(data) ? data : (data?.rows || []);
  const mapped = rows.map(toRequestRow);

 await enrichRequestsWithItems(mapped);

  const buckets = {
    pending: [],
    approved: [],
    rejected: [],
    executed: [],
    cancelled: [],
    other: []
  };

  mapped.forEach((row) => {
    switch (row.status) {
      case "SUBMITTED":
      case "PENDING":
      case "WAITING":
      case "REQUESTED":
        buckets.pending.push(row);
        break;
      case "APPROVED":
        buckets.approved.push(row);
        break;
      case "REJECTED":
        buckets.rejected.push(row);
        break;
      case "EXECUTED":
        buckets.executed.push(row);
        break;
      case "CANCELLED":
        buckets.cancelled.push(row);
        break;
      default:
        buckets.other.push(row);
    }
  });

  const counts = {
    pending: buckets.pending.length,
    approved: buckets.approved.length,
    rejected: buckets.rejected.length,
    executed: buckets.executed.length,
    cancelled: buckets.cancelled.length,
    other: buckets.other.length,
    total: mapped.length
  };

  const latestSubmitted = buckets.pending
    .map((row) => row.requested_at || row.created_at || row.updated_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] || null;

  const latestProcessed = mapped
    .filter((row) => ["APPROVED", "REJECTED", "EXECUTED", "CANCELLED"].includes(row.status))
    .map((row) => row.updated_at || row.approved_at || row.executed_at || row.rejected_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] || null;

  return { rows: mapped, buckets, counts, latestSubmitted, latestProcessed };
}

function formatFirearmItem(item = {}) {
  const number = item.firearm_number || item.serial || item.code || item.firearm_id;
  const type = item.firearm_type || item.weapon_type || item.type;
  if (number && type) return `${type} ${number}`.trim();
  return number || type || "";
}

function mapAmmoItem(item = {}) {
  const qty = item.quantity ?? item.qty ?? item.amount ?? null;
  const unit = item.unit || item.unit_label || (qty !== null && qty !== undefined ? "발" : "");
  const caliber = item.ammo_name || item.ammo_label || item.caliber || item.description || item.ammo_category || item.name || "";
  const type = item.ammo_category || item.category || item.type || "";
  return {
    caliber,
    type,
    name: item.ammo_name || item.name || caliber || type || "탄약",
    qty,
    unit
  };
}

function formatAmmoItemLabel(item = {}) {
  const base = item.caliber || item.name || item.type || "탄약";
  const parts = [base];
  if (item.qty !== undefined && item.qty !== null && item.qty !== "") {
    parts.push(`×${item.qty}`);
  }
  if (item.unit) {
    parts.push(item.unit);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

async function enrichRequestsWithItems(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const ids = rows
    .map((row) => row?.id)
    .filter((id) => id !== undefined && id !== null);
  if (!ids.length) return rows;

  const detailMap = await fetchRequestDetails(ids);

  rows.forEach((row) => {
    const detail = detailMap.get(String(row.id));
    if (!detail) return;

    const request = detail.request || {};
    const items = Array.isArray(detail.items) ? detail.items : [];
    const approvals = Array.isArray(detail.approvals) ? detail.approvals : [];
    const executions = Array.isArray(detail.executions) ? detail.executions : [];
    const firearms = items.filter((item) => item.item_type === "FIREARM");
    const ammoItemsRaw = items.filter((item) => item.item_type === "AMMO");

    if (!row.weapon_code && firearms.length) {
      const labels = firearms.map(formatFirearmItem).filter(Boolean);
      if (labels.length) {
        row.weapon_code = labels.join(", ");
        row.weapon_summary = row.weapon_summary || row.weapon_code;
      }
    }

    const ammoItems = ammoItemsRaw.map(mapAmmoItem).filter((item) => item.name || item.caliber || item.type);
    if (ammoItems.length) {
      row.ammo_items = ammoItems;
      if (!row.ammo_summary) {
        row.ammo_summary = ammoItems.map(formatAmmoItemLabel).join(", ");
      }
    }

    if (!row.status_reason && request.status_reason) {
      row.status_reason = request.status_reason;
    }
    if (!row.purpose && request.purpose) {
      row.purpose = request.purpose;
    }
    if (!row.location && request.location) {
      row.location = request.location;
    }

    const latestApproval = approvals
      .filter((entry) => entry && entry.decision === "APPROVE" && entry.decided_at)
      .sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at))[0];
    const latestReject = approvals
      .filter((entry) => entry && entry.decision === "REJECT" && entry.decided_at)
      .sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at))[0];
    const latestExecution = executions
      .filter((entry) => entry && entry.executed_at)
      .sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at))[0];


    row.requested_at = row.requested_at || request.submitted_at || request.requested_at || request.created_at || row.created_at;
    row.approved_at = row.approved_at || request.approved_at || latestApproval?.decided_at || null;
    row.executed_at = row.executed_at || request.executed_at || latestExecution?.executed_at || null;
    row.rejected_at = row.rejected_at || request.rejected_at || latestReject?.decided_at || null;
    row.updated_at = row.updated_at
      || request.updated_at
      || row.approved_at
      || row.executed_at
      || row.rejected_at
      || null;
    row.created_at = row.created_at || request.created_at || row.requested_at || row.updated_at;

    if (!row.approver_id && latestApproval?.approver_id) {
      row.approver_id = latestApproval.approver_id;
    }
    if (!row.approver_name && latestApproval?.approver_name) {
      row.approver_name = latestApproval.approver_name;
    }
    if (!row.status_reason && latestReject?.reason) {
      row.status_reason = latestReject.reason;
    }


    row.raw = {
      ...(row.raw || {}),
      request,
      items,
      approvals,
      executions,
      ammo_items: ammoItems,
      firearms
    };
  });

  return rows;
}

async function fetchRequestDetails(ids, { concurrency = 4 } = {}) {
  const uniqueIds = Array.from(new Set(ids.map((id) => String(id))));
  const results = new Map();
  if (!uniqueIds.length) return results;

  const queue = [...uniqueIds];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => (async () => {
    while (queue.length) {
      const nextId = queue.shift();
      if (!nextId) continue;
      try {
        const detail = await fetchRequestDetail(nextId);
        if (detail) {
          results.set(nextId, detail);
        }
      } catch (error) {
        console.warn("[AAMS][api] 요청 상세 불러오기 실패", error);
      }
    }
  })());

  await Promise.all(workers);
  return results;
}

// assets/js/api.js 맨 아래 근처에 추가
const FP_BASE = () => getApiBase() || "";

export async function fetchFpLast(site = "default") {
  const r = await fetch(`${FP_BASE()}/api/fp/last?site=${encodeURIComponent(site)}`);
  return r.ok ? r.json() : null;
}

export async function listFpMappings() {
  const r = await fetch(`${FP_BASE()}/api/fp/map`);
  return r.ok ? r.json() : [];
}

export function openFpEventSource({ site = "default", onEvent } = {}) {
  connectWebSocket(site);
  const unsubscribe = onWebSocketEvent("FP_EVENT", (message) => {
    if (message?.site && message.site !== site) return;
    if (typeof onEvent === "function") {
      const payload = message?.payload ?? message;
      try { onEvent(payload); }
      catch (err) { console.warn("[AAMS][fp] event handler error", err); }
    }
  });
  return {
    close() {
      try { unsubscribe(); } catch (_) {}
    }
  };
}

export async function fetchFingerprintAssignments() {
  return _get(`${FP_BASE()}/api/fp/assignments`);
}

export async function assignFingerprint({ sensorId, personId, site }) {
  if (!Number.isInteger(sensorId)) throw new Error("sensorId required");
  if (!Number.isInteger(personId)) throw new Error("personId required");
  const body = { sensor_id: sensorId, person_id: personId };
  if (site) body.site = site;
  return _post(`${FP_BASE()}/api/fp/map`, body);
}

export async function deleteFingerprintForPerson(personId) {
  if (!Number.isInteger(personId)) throw new Error("personId required");
  return _del(`${FP_BASE()}/api/fp/person/${encodeURIComponent(personId)}`);
}

export async function deleteFingerprintSensor(sensorId) {
  if (!Number.isInteger(sensorId)) throw new Error("sensorId required");
  return _del(`${FP_BASE()}/api/fp/map/${encodeURIComponent(sensorId)}`);
}

export async function clearFingerprintMappings({ site } = {}) {
  const base = `${FP_BASE()}/api/fp/map`;
  const url = site ? `${base}?site=${encodeURIComponent(site)}` : base;
  return _del(url);
}
