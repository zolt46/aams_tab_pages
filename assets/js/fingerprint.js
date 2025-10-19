// assets/js/fingerprint.js
import { mountMobileHeader, getApiBase, saveMe } from "./util.js";
import { listUsers, openFpEventSource } from "./api.js";

const API_BASE = (window.AAMS_CONFIG && window.AAMS_CONFIG.API_BASE) || "";
const SITE = window.FP_SITE || "site-01";

async function enrichAndSave(me) {
  try {
    const r = await fetch(`${API_BASE}/api/personnel/${encodeURIComponent(me.id)}`);
    const detail = r.ok ? await r.json() : null;
    // detail 예: { unit, rank, position, contact, ... }
    const merged = { ...me, ...(detail || {}) };
    saveMe(merged);                 // ← AAMS_ME에 완전한 me 저장
    return merged;
  } catch {
    saveMe(me);                     // 실패해도 최소 me 저장
    return me;
  }
}

// 1) 티켓 클레임
async function claimOnce() {
  try {
    const r = await fetch(`${API_BASE}/api/fp/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: SITE })
    });
    const j = await r.json();
    if (j && j.ok && j.person_id) {
      const base = { id: Number(j.person_id), name: j.name, is_admin: !!j.is_admin };
      const me = await enrichAndSave(base);   // ← 상세 merge
      location.hash = me.is_admin ? "#/admin" : "#/user";
      return true;
    }
  } catch {}
  return false;
}

function listenAndRedirect() {
  const es = openFpEventSource({
    site: SITE,
    onEvent: async (p) => {
      const d = p && p.data;
      const r = p && p.resolved;
      if (d && d.type === "identify" && d.ok && r && r.person_id) {
        const base = { id: Number(r.person_id), name: r.name, is_admin: !!r.is_admin };
        const me = await enrichAndSave(base); // ← 상세 merge
        location.hash = me.is_admin ? "#/admin" : "#/user";
      }
    }
  });
  window.addEventListener("beforeunload", () => { try { es.close(); } catch {} });
  return es;
}




// 사용자 지문: 사용자 선택 → #/user
export async function initFpUser() {
  await mountMobileHeader({ title: "사용자 선택", pageType: 'login', backTo: "#/" });
  // 1) 최근 1회용 티켓 먼저 시도 → 성공이면 즉시 이동, 실패면 계속 진행
  if (await claimOnce()) return;
  // 2) 없으면 실시간 이벤트 대기
  listenAndRedirect();
  const box = document.getElementById("user-list");
  box.innerHTML = `<div class="muted">불러오는 중…</div>`;
  try {
    const rows = await listUsers();
    if (!rows?.length) box.innerHTML = `<div class="muted">사용자가 없습니다.</div>`;
    else {
      const sorted = rows.slice().sort((a, b) => {
        if (!!a.is_admin === !!b.is_admin) {
          return String(a.name || "").localeCompare(String(b.name || ""), "ko", { sensitivity: "base" });
        }
        return a.is_admin ? 1 : -1;
      });
      const attr = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const escape = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      box.innerHTML = sorted.map(r => {
        const adminTag = r.is_admin ? '<span class="tag tag-admin">관리자</span>' : '';
        const unit = r.unit || r.unit_name || "";
        const name = escape(r.name || "사용자");
        const rank = r.rank ? ` <span class="muted">(${escape(r.rank)})</span>` : "";
        const unitLine = unit ? escape(unit) : "";
        const unitDisplay = unitLine || "-";
        return `
        <button class="item" data-id="${attr(r.id)}" data-admin="${r.is_admin ? "1" : "0"}"
                data-name="${attr(r.name)}" data-rank="${attr(r.rank)}"
                data-unit="${attr(unit)}" data-serial="${attr(r.military_id)}"
                data-position="${attr(r.position)}" data-contact="${attr(r.contact)}"
                data-userid="${attr(r.user_id)}">
          <span class="item-line">${name}${rank}</span>
          <span class="item-sub">${unitDisplay}${adminTag ? ` ${adminTag}` : ""}</span>
        </button>`;
      }).join("");
    }
  } catch (e) {
    const msg = String(e?.message || "오류가 발생했습니다.")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    box.innerHTML = `<div class="error">불러오기 실패: ${msg}</div>`;
  }

  box.addEventListener("click", (ev)=>{
    const b = ev.target.closest(".item"); if (!b) return;
    const me = {
      id: Number(b.getAttribute("data-id")),
      name: b.getAttribute("data-name"),
      rank: b.getAttribute("data-rank"),
      unit: b.getAttribute("data-unit"),
      serial: b.getAttribute("data-serial"),
      position: b.getAttribute("data-position"),
      duty: b.getAttribute("data-position"),
      contact: b.getAttribute("data-contact"),
      user_id: b.getAttribute("data-userid"),
      is_admin: b.getAttribute("data-admin") === "1"
    };
    localStorage.setItem("AAMS_ME", JSON.stringify(me));
    location.hash = "#/user";
  });
}



// 관리자 지문: 직전 로그인한 관리자 user_id만 노출 → 선택 시 #/admin
export async function initFpAdmin() {
  await mountMobileHeader({ title: "관리자 확인", pageType: 'login', backTo: "#/admin-login" });
  // 1) 최근 1회용 티켓 먼저 시도
  if (await claimOnce()) return;
  // 2) 없으면 실시간 이벤트 대기
  listenAndRedirect();
  const loginId = sessionStorage.getItem("AAMS_ADMIN_LOGIN_ID"); // e.g. 'adminA'
  const box = document.getElementById("admin-list");
  box.innerHTML = `<div class="muted">불러오는 중…</div>`;
  try {
    const rows = await listUsers({ role: "admin" });
    const filtered = rows.filter(r => String(r.user_id||"") === String(loginId||""));
    if (!filtered.length) {
      box.innerHTML = `<div class="error">직전 로그인한 관리자 계정(${loginId})을 찾을 수 없습니다.</div>`;
    } else {
      const attr = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const escape = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      box.innerHTML = filtered.map(r => `
        <button class="item" data-id="${attr(r.id)}"
                data-name="${attr(r.name)}" data-userid="${attr(r.user_id)}"
                data-rank="${attr(r.rank)}" data-unit="${attr(r.unit)}"
                data-position="${attr(r.position)}" data-contact="${attr(r.contact)}"
                data-serial="${attr(r.military_id)}">
          ${escape(r.name||"관리자")} (${escape(r.user_id)||"-"})
        </button>
      `).join("");
    }
  } catch (e) {
    box.innerHTML = `<div class="error">불러오기 실패: ${e.message}</div>`;
  }

  box.addEventListener("click", (ev)=>{
    const b = ev.target.closest(".item"); if (!b) return;
    const me = {
      id: Number(b.getAttribute("data-id")),
      name: b.getAttribute("data-name"),
      user_id: b.getAttribute("data-userid"),
      rank: b.getAttribute("data-rank"),
      unit: b.getAttribute("data-unit"),
      serial: b.getAttribute("data-serial"),
      position: b.getAttribute("data-position"),
      duty: b.getAttribute("data-position"),
      contact: b.getAttribute("data-contact"),
      is_admin: true
    };
    localStorage.setItem("AAMS_ME", JSON.stringify(me));
    location.hash = "#/admin";
  });
}
