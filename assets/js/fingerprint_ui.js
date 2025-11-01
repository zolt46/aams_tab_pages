// fingerprint_ui.js
import { openFpEventSource } from "./api.js";

const API_BASE = (window.AAMS_CONFIG && window.AAMS_CONFIG.API_BASE) || "";
const SITE     = window.FP_SITE || "site-01";

async function claimOnce() {
  try {
    const r = await fetch(`${API_BASE}/api/fp/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: SITE })
    });
    const j = await r.json();
    if (j && j.ok && j.person_id) {
      const me = { id: j.person_id, name: j.name, is_admin: !!j.is_admin };
      localStorage.setItem("aams_me", JSON.stringify(me));
      location.hash = me.is_admin ? "#/admin" : "#/user";
      return true;
    }
  } catch (_) {}
  return false;
}

function listenAndRedirect() {
  const es = openFpEventSource({
    site: SITE,
    onEvent: (p) => {
      const d = p && p.data;
      const r = p && p.resolved;
      if (d && d.type === "identify" && d.ok && r && r.person_id) {
        const me = { id: r.person_id, name: r.name, is_admin: !!r.is_admin };
        try { localStorage.setItem("aams_me", JSON.stringify(me)); } catch {}
        location.hash = me.is_admin ? "#/admin" : "#/user";
      }
    }
  });
  window.addEventListener("beforeunload", () => { try { es.close(); } catch {} });
  return es;
}

export async function initFpUser() {
  // 1) 1회용 티켓 먼저(페이지 들어오기 직전에 이미 찍힌 케이스 커버)
  const ok = await claimOnce();
  if (ok) return;
  // 2) 없으면 실시간으로만 대기
  listenAndRedirect();
}

export async function initFpAdmin() {
  const ok = await claimOnce();
  if (ok) return;
  listenAndRedirect();
}
