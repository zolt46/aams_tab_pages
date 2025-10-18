// assets/js/util.js
export function getApiBase() {
  // 1) 전역 설정 파일(config.js) 최우선
  if (window.AAMS_CONFIG && typeof window.AAMS_CONFIG.API_BASE === "string") {
    return window.AAMS_CONFIG.API_BASE;
  }
  // 2) meta 태그 (PC에서 이 방식 썼을 가능성)
  const meta = document.querySelector('meta[name="aams-api-base"]')?.content;
  if (meta) return meta;
  // 3) (백업) 로컬스토리지
  const saved = localStorage.getItem("AAMS_API_BASE");
  if (saved) return saved;
  // 4) 기본값: 같은 출처(역프록시가 /api로 붙어있는 경우)
  return "";
}

// (디버그) API Base가 비어있거나 건강하지 않으면 배너로 경고
export async function assertApiBaseHealthy() {
  const base = getApiBase();
  // 같은 출처("")라면 헬스 체크 스킵(프록시 환경일 수도 있음)
  if (!base) return;
  try {
    const r = await fetch(base + "/health", { credentials: "include" });
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    showTopBanner(
      `⚠️ API_BASE(${base}) 접근 실패: /health 확인 불가. ` +
      `config.js의 도메인을 다시 확인하세요. (${e.message || e})`
    );
  }
}

function showTopBanner(msg) {
  if (document.getElementById("aams-banner")) return;
  const div = document.createElement("div");
  div.id = "aams-banner";
  div.style.cssText = "position:sticky;top:0;z-index:9999;background:#B91C1C;color:#fff;padding:8px 12px;font-size:14px";
  div.textContent = msg;
  document.body.prepend(div);
}
