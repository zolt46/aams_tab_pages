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
  // 집행 대기건: APPROVED
  return (all || []).filter(r => r.status === "APPROVED");
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
    type: r.type,                         // ISSUE | RETURN | ...
    status: r.status,
    weapon_code: r.weapon_code || r.weapon?.code,
    ammo_summary: Array.isArray(r.ammo_items) && r.ammo_items.length
      ? r.ammo_items.map(it => `${it.caliber || it.type}×${it.qty}`).join(", ")
      : r.ammo_summary || null,
    requester_name: r.requester_name || r.requester?.name || r.user?.name,
    created_at: r.created_at || r.requested_at || r.approved_at || r.updated_at
  };
}
