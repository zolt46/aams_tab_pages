import { getApiBase } from './util.js';


async function _get(url){
const res = await fetch(url, { credentials: 'include' });
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
return res.json();
}
async function _post(url, body){
const res = await fetch(url, { method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
return res.json().catch(()=>({ ok:true }));
}


export async function fetchMyPendingApprovals(userId){
const API_BASE = getApiBase();
const candidates = [
`${API_BASE}/api/approvals?assignee=${encodeURIComponent(userId)}&status=APPROVED`,
`${API_BASE}/api/requests?owner=${encodeURIComponent(userId)}&status=READY_TO_EXECUTE`,
];
for (const url of candidates) {
try { return await _get(url); } catch {}
}
return [];
}


export async function executeRequest({ requestId, executorId }){
const API_BASE = getApiBase();
const payload = { request_id: requestId, executor_id: executorId };
const candidates = [
`${API_BASE}/api/requests/${requestId}/execute`,
`${API_BASE}/api/approvals/${requestId}/execute`,
`${API_BASE}/api/execute`
];
let lastErr;
for (const url of candidates) {
try { return await _post(url, payload); } catch(e){ lastErr = e; }
}
throw lastErr ?? new Error('No execution endpoint worked');
}


export async function adminAction({ requestId, action, actorId, reason }){
const API_BASE = getApiBase();
const path = action.toLowerCase();
const payload = { request_id: requestId, actor_id: actorId, reason };
const candidates = [
`${API_BASE}/api/requests/${requestId}/${path}`,
`${API_BASE}/api/approvals/${requestId}/${path}`,
`${API_BASE}/api/${path}`,
];
let lastErr;
for (const url of candidates) {
try { return await _post(url, payload); } catch(e){ lastErr = e; }
}
throw lastErr ?? new Error(`Admin action failed: ${action}`);
}