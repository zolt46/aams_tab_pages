// assets/js/api.js
import { getApiBase } from "./util.js";

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
export async function fetchMyPendingApprovals(userId) {
  // server.js: GET /api/requests/for_user/:uid
  const all = await _get(`${apiBase()}/api/requests/for_user/${encodeURIComponent(userId)}`);
  // 집행 대기건: APPROVED → 사용자 카드 렌더링과 동일한 포맷으로 변환
  return (all || [])
    .filter(r => r.status === "APPROVED")
    .map(toRequestRow);
}
export { fetchMyPendingApprovals as fetchUserPending };

// 집행
export async function executeRequest({ requestId, executorId }) {
  // server.js: POST /api/requests/:id/execute  { executed_by }
  return _post(`${apiBase()}/api/requests/${encodeURIComponent(requestId)}/execute`, {
    executed_by: executorId
  });
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
  return pending.map(toRequestRow);
}

// 사용자/관리자 공통 표준화
function toRequestRow(r){
  return {
    id: r.id,
    type: r.request_type || r.type,
    status: r.status,
    weapon_code: r.weapon_code || r.weapon?.code,
    ammo_summary: Array.isArray(r.ammo_items) && r.ammo_items.length
      ? r.ammo_items.map(it => `${it.caliber || it.type}×${it.qty}`).join(", ")
      : r.ammo_summary || null,
    requester_name: r.requester_name || r.requester?.name || r.user?.name,
    created_at: r.created_at || r.requested_at || r.submitted_at || r.approved_at || r.updated_at,
    updated_at: r.updated_at || r.approved_at || r.rejected_at || r.executed_at || r.created_at,
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
    .map((row) => row.created_at || row.updated_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] || null;

  return { rows: mapped, buckets, counts, latestSubmitted };
}
