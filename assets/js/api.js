// assets/js/api.js
import { getApiBase } from "./util.js";

const requestDetailCache = new Map();

function apiBase() {
  // same-origin 기본값 (로컬에서 index.html을 같은 서버로 서빙하면 빈 문자열로도 동작)
  return getApiBase() || "";
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
  // server.js: POST /api/requests/:id/execute  { executed_by }
  return _post(`${apiBase()}/api/requests/${encodeURIComponent(requestId)}/execute`, {
    executed_by: executorId
  });
  const body = { executed_by: executorId };
  if (dispatch) {
    body.dispatch = dispatch;
  }
  return _post(`${apiBase()}/api/requests/${encodeURIComponent(requestId)}/execute`, body);
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

export function openFpEventSource({ site="default", onEvent }) {
  const since = Number(localStorage.getItem("AAMS_LOGOUT_AT") || 0);
  const es = new EventSource(`${getApiBase()}/api/fp/stream?site=${encodeURIComponent(site)}&since=${since}`);
  es.onmessage = ev => { try { onEvent?.(JSON.parse(ev.data||"{}")); } catch {} };
  return es;
}

export async function fetchFpLast(site = "default") {
  const r = await fetch(`${FP_BASE()}/api/fp/last?site=${encodeURIComponent(site)}`);
  return r.ok ? r.json() : null;
}

export async function listFpMappings() {
  const r = await fetch(`${FP_BASE()}/api/fp/map`);
  return r.ok ? r.json() : [];
}
