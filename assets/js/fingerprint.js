// assets/js/fingerprint.js
import { mountMobileHeader } from "./util.js";
import { listUsers } from "./api.js";

// 사용자 지문: 사용자 선택 → #/user
export async function initFpUser() {
  await mountMobileHeader({ title: "사용자 선택", pageType: 'login', backTo: "#/" });
  const box = document.getElementById("user-list");
  box.innerHTML = `<div class="muted">불러오는 중…</div>`;
  try {
    const rows = await listUsers({ role: "user" });
    if (!rows?.length) box.innerHTML = `<div class="muted">사용자가 없습니다.</div>`;
    else {
      const attr = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const escape = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      box.innerHTML = rows.map(r => `
        <button class="item" data-id="${attr(r.id)}"
                data-name="${attr(r.name)}" data-rank="${attr(r.rank)}"
                data-unit="${attr(r.unit)}" data-serial="${attr(r.military_id)}"
                data-position="${attr(r.position)}" data-contact="${attr(r.contact)}">
          ${escape(r.name||"사용자")} ${r.rank?`(${escape(r.rank)})`:""} · ${escape(r.unit)}
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
      rank: b.getAttribute("data-rank"),
      unit: b.getAttribute("data-unit"),
      serial: b.getAttribute("data-serial"),
      position: b.getAttribute("data-position"),
      duty: b.getAttribute("data-position"),
      contact: b.getAttribute("data-contact"),
      is_admin: false
    };
    localStorage.setItem("AAMS_ME", JSON.stringify(me));
    location.hash = "#/user";
  });
}

// 관리자 지문: 직전 로그인한 관리자 user_id만 노출 → 선택 시 #/admin
export async function initFpAdmin() {
  await mountMobileHeader({ title: "관리자 확인", pageType: 'login', backTo: "#/admin-login" });
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
