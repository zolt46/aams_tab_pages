// assets/js/fingerprint.js
import { mountMobileHeader } from "./util.js";
import { listUsers } from "./api.js";

// 사용자 지문: 사용자 선택 → #/user
export async function initFpUser() {
  await mountMobileHeader({ title: "지문 인식", backTo: "#/", disableBack: true });
  const box = document.getElementById("user-list");
  box.innerHTML = `<div class="muted">불러오는 중…</div>`;
  try {
    const rows = await listUsers({ role: "user" });
    if (!rows?.length) box.innerHTML = `<div class="muted">사용자가 없습니다.</div>`;
    else {
      box.innerHTML = rows.map(r => `
        <button class="item" data-id="${r.id}"
                data-name="${r.name||""}" data-rank="${r.rank||""}"
                data-unit="${r.unit||""}" data-serial="${r.military_id||""}">
          ${r.name||"사용자"} ${r.rank?`(${r.rank})`:""} · ${r.unit||""}
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
      is_admin: false
    };
    localStorage.setItem("AAMS_ME", JSON.stringify(me));
    location.hash = "#/user";
  });
}

// 관리자 지문: 직전 로그인한 관리자 user_id만 노출 → 선택 시 #/admin
export async function initFpAdmin() {
  await mountMobileHeader({ title: "관리자 지문 인식", backTo: "#/admin-login", disableBack: true });
  const loginId = sessionStorage.getItem("AAMS_ADMIN_LOGIN_ID"); // e.g. 'adminA'
  const box = document.getElementById("admin-list");
  box.innerHTML = `<div class="muted">불러오는 중…</div>`;
  try {
    const rows = await listUsers({ role: "admin" });
    const filtered = rows.filter(r => String(r.user_id||"") === String(loginId||""));
    if (!filtered.length) {
      box.innerHTML = `<div class="error">직전 로그인한 관리자 계정(${loginId})을 찾을 수 없습니다.</div>`;
    } else {
      box.innerHTML = filtered.map(r => `
        <button class="item" data-id="${r.id}"
                data-name="${r.name||""}" data-userid="${r.user_id||""}">
          ${r.name||"관리자"} (${r.user_id||"-"})
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
      is_admin: true
    };
    localStorage.setItem("AAMS_ME", JSON.stringify(me));
    location.hash = "#/admin";
  });
}
