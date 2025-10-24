import {
  fetchFingerprintAssignments,
  assignFingerprint,
  deleteFingerprintForPerson,
  clearFingerprintMappings,
  fetchPersonnelById,
  openFpEventSource
} from "./api.js";
import {
  mountMobileHeader,
  getFpLocalBase,
  getMe,
  renderMeBrief,
  saveMe
} from "./util.js";

const SITE = window.FP_SITE || "site-01";
const HTML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const SENSOR_ERROR_MESSAGES = {
  timeout_or_no_finger: "지문이 인식되지 않았습니다. 다시 시도해 주세요.",
  image2tz_failed: "지문 이미지를 처리하지 못했습니다. 다시 시도해 주세요.",
  image2tz_failed_1: "첫 번째 스캔이 실패했습니다.",
  image2tz_failed_2: "두 번째 스캔이 실패했습니다.",
  create_model_failed: "지문 데이터를 결합하지 못했습니다.",
  store_model_failed: "센서에 지문을 저장하지 못했습니다.",
  delete_failed: "센서에서 해당 지문을 찾을 수 없습니다.",
  clear_failed: "센서 지문 데이터를 초기화하지 못했습니다.",
  sensor_not_ready: "지문 센서가 연결되어 있지 않습니다.",
  serial_not_ready: "지문 센서가 연결되어 있지 않습니다.",
  serial_write_failed: "지문 센서에 명령을 전달하지 못했습니다.",
  sensor_timeout: "지문 센서 응답이 지연되었습니다.",
  command_in_progress: "지문 센서에서 다른 작업을 처리 중입니다.",
  invalid_json: "요청 형식이 올바르지 않습니다."
};

const collator = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });

const state = {
  assignments: [],
  selectedPersonId: null,
  activeOperation: null,
  eventSource: null,
  busy: false,
  site: SITE,
  stageTimer: null
};

const refs = {
  personSelect: null,
  sensorInput: null,
  personInfo: null,
  enrollBtn: null,
  deleteBtn: null,
  clearBtn: null,
  enrollStatus: null,
  deleteStatus: null,
  stageMessage: null,
  summary: null,
  listSummary: null,
  tableWrap: null,
  refreshBtn: null,
  refreshLocalBtn: null,
  sensorConnection: null,
  sensorCount: null,
  sensorEvent: null
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] || ch);
}

function joinLocalUrl(base, path) {
  const cleanBase = String(base || "").trim().replace(/\/+$/, "");
  if (!path.startsWith("/")) {
    return `${cleanBase}/${path}`;
  }
  return `${cleanBase}${path}`;
}

function describeSensorError(code) {
  if (!code) return "센서 오류가 발생했습니다.";
  const normalized = String(code).toLowerCase();
  return SENSOR_ERROR_MESSAGES[normalized] || `센서 오류(${code})가 발생했습니다.`;
}

function describeError(err) {
  if (!err) return "알 수 없는 오류가 발생했습니다.";
  const responseError = err.response?.error || err.response?.reason;
  if (responseError) return describeSensorError(responseError);
  if (err.message) return err.message;
  return "알 수 없는 오류가 발생했습니다.";
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function computeNextSensorId(assignments) {
  const used = new Set();
  assignments.forEach((entry) => {
    if (Number.isInteger(entry.sensor_id) && entry.sensor_id > 0) {
      used.add(entry.sensor_id);
    }
  });
  let candidate = 1;
  while (candidate <= 2000 && used.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function formatPersonOption(entry) {
  const status = entry.sensor_id ? "등록" : "미등록";
  const name = [entry.rank, entry.name].filter(Boolean).join(" ") || entry.name || `ID ${entry.person_id}`;
  const detail = [entry.unit, entry.position].filter(Boolean).join(" · ");
  const parts = [`[${status}] ${name}`];
  if (detail) parts.push(detail);
  if (entry.sensor_id) parts.push(`#${entry.sensor_id}`);
  return parts.join(" · ");
}

function normalizeAssignment(row = {}) {
  return {
    person_id: Number(row.person_id) || Number(row.id) || null,
    name: row.name || "",
    rank: row.rank || "",
    unit: row.unit || row.unit_name || "",
    position: row.position || row.duty || "",
    user_id: row.user_id || "",
    military_id: row.military_id || row.serial || "",
    contact: row.contact || "",
    is_admin: !!row.is_admin,
    sensor_id: row.sensor_id != null ? Number(row.sensor_id) : null,
    site: row.site || null,
    last_enrolled: row.last_enrolled || null
  };
}

function getSelectedAssignment() {
  if (!Number.isInteger(state.selectedPersonId)) return null;
  return state.assignments.find((entry) => entry.person_id === state.selectedPersonId) || null;
}

function setOperationStatus(kind, message, { level = "info" } = {}) {
  const el = kind === "enroll" ? refs.enrollStatus : refs.deleteStatus;
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.dataset.level = level;
  } else {
    el.textContent = "";
    el.removeAttribute("data-level");
  }
}

function clearStageMessage() {
  if (state.stageTimer) {
    clearTimeout(state.stageTimer);
    state.stageTimer = null;
  }
  if (refs.stageMessage) {
    refs.stageMessage.textContent = "센서가 대기 중입니다.";
    refs.stageMessage.dataset.level = "idle";
  }
}

function updateStageMessage(message, { level = "info", autoClear = 8000 } = {}) {
  if (!refs.stageMessage) return;
  refs.stageMessage.textContent = message;
  refs.stageMessage.dataset.level = level;
  if (state.stageTimer) {
    clearTimeout(state.stageTimer);
    state.stageTimer = null;
  }
  if (autoClear && autoClear > 0) {
    state.stageTimer = setTimeout(() => {
      if (refs.stageMessage && refs.stageMessage.dataset.level === level) {
        clearStageMessage();
      }
    }, autoClear);
  }
}

function setBusy(busy) {
  state.busy = busy;
  const buttons = [refs.enrollBtn, refs.deleteBtn, refs.clearBtn, refs.refreshBtn, refs.refreshLocalBtn];
  buttons.forEach((btn) => {
    if (btn) btn.disabled = !!busy;
  });
  if (refs.personSelect) refs.personSelect.disabled = !!busy;
  if (refs.sensorInput) refs.sensorInput.disabled = !!busy && state.activeOperation?.type === "enroll";
}

async function callLocal(path, { method = "POST", body, timeoutMs = 18000 } = {}) {
  const base = getFpLocalBase();
  if (!base) throw new Error("로컬 브릿지 주소를 설정해 주세요.");
  const url = joinLocalUrl(base, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const options = { method, signal: controller.signal, headers: {} };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      throw new Error("로컬 브릿지 응답이 지연되었습니다.");
    }
    throw new Error("로컬 브릿지에 연결할 수 없습니다.");
  }
  clearTimeout(timer);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  if (!res.ok || (data && data.ok === false)) {
    const reason = data?.error || data?.message || `HTTP ${res.status}`;
    const error = new Error(reason);
    error.response = data;
    error.status = res.status;
    throw error;
  }
  return data || { ok: true };
}

function callLocalEnroll(sensorId) {
  return callLocal("/enroll", {
    body: {
      id: sensorId,
      timeoutMs: 65000,
      led: { mode: "breathing", color: "purple", speed: 18 },
      ledOff: { mode: "off" }
    },
    timeoutMs: 70000
  });
}

function callLocalDelete(sensorId, { allowMissing = false } = {}) {
  return callLocal("/delete", {
    body: { id: sensorId, allowMissing },
    timeoutMs: 18000
  });
}

function callLocalClear() {
  return callLocal("/clear", { body: {}, timeoutMs: 30000 });
}

function callLocalHealth() {
  return callLocal("/health", { method: "GET", timeoutMs: 6000 });
}

function callLocalCount() {
  return callLocal("/count", { method: "GET", timeoutMs: 8000 });
}

function updateSummary() {
  const total = state.assignments.length;
  const registered = state.assignments.filter((entry) => Number.isInteger(entry.sensor_id)).length;
  const nextId = computeNextSensorId(state.assignments);
  const summaryText = `사이트 ${state.site} · 등록 ${registered} / 총 ${total} · 다음 추천 ID ${nextId}`;
  if (refs.summary) refs.summary.textContent = summaryText;
  if (refs.listSummary) refs.listSummary.textContent = summaryText;
}

function populatePersonSelect() {
  if (!refs.personSelect) return;
  const previous = state.selectedPersonId;
  refs.personSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "인원을 선택하세요";
  refs.personSelect.appendChild(placeholder);

  const options = state.assignments.slice().sort((a, b) => {
    const hasA = Number.isInteger(a.sensor_id);
    const hasB = Number.isInteger(b.sensor_id);
    if (hasA !== hasB) return hasA ? -1 : 1;
    const nameCompare = collator.compare(a.name || "", b.name || "");
    if (nameCompare !== 0) return nameCompare;
    return (a.person_id || 0) - (b.person_id || 0);
  });

  options.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.person_id ? String(entry.person_id) : "";
    option.textContent = formatPersonOption(entry);
    refs.personSelect.appendChild(option);
  });

  if (previous && options.some((entry) => entry.person_id === previous)) {
    refs.personSelect.value = String(previous);
    state.selectedPersonId = previous;
  } else {
    refs.personSelect.value = "";
    state.selectedPersonId = null;
  }

  updateSelectedPersonInfo();
}

function updateSelectedPersonInfo() {
  if (!refs.personInfo) return;
  const assignment = getSelectedAssignment();
  if (!assignment) {
    refs.personInfo.textContent = "대상 인원을 선택해 주세요.";
    if (refs.sensorInput) refs.sensorInput.value = "";
    return;
  }
  const displayName = [assignment.rank, assignment.name].filter(Boolean).join(" ") || assignment.name || `ID ${assignment.person_id}`;
  const lines = [];
  lines.push(escapeHtml(displayName) + (assignment.is_admin ? " <span class=\"fp-chip fp-chip--admin\">ADMIN</span>" : ""));
  const unitLine = [assignment.unit, assignment.position].filter(Boolean).join(" · ");
  if (unitLine) lines.push(escapeHtml(unitLine));
  if (assignment.sensor_id) {
    lines.push(`현재 지문 ID: ${escapeHtml(`#${assignment.sensor_id}`)}`);
    if (assignment.last_enrolled) {
      lines.push(`마지막 등록: ${escapeHtml(formatDateTime(assignment.last_enrolled))}`);
    }
  } else {
    lines.push("현재 등록된 지문이 없습니다.");
  }
  refs.personInfo.innerHTML = lines.join("<br>");
  if (refs.sensorInput) {
    if (assignment.sensor_id) {
      refs.sensorInput.value = String(assignment.sensor_id);
    } else {
      refs.sensorInput.value = String(computeNextSensorId(state.assignments));
    }
  }
}

function renderAssignmentTable() {
  if (!refs.tableWrap) return;
  if (!state.assignments.length) {
    refs.tableWrap.innerHTML = '<p class="muted">표시할 인원이 없습니다.</p>';
    return;
  }
  const rows = state.assignments
    .slice()
    .sort((a, b) => {
      const hasA = Number.isInteger(a.sensor_id);
      const hasB = Number.isInteger(b.sensor_id);
      if (hasA !== hasB) return hasA ? -1 : 1;
      const byName = collator.compare(a.name || "", b.name || "");
      if (byName !== 0) return byName;
      return (a.person_id || 0) - (b.person_id || 0);
    })
    .map((entry) => {
      const hasSensor = Number.isInteger(entry.sensor_id);
      const chip = hasSensor
        ? '<span class="fp-chip fp-chip--ok">등록</span>'
        : '<span class="fp-chip">미등록</span>';
      const personName = escapeHtml([entry.rank, entry.name].filter(Boolean).join(" ") || entry.name || `ID ${entry.person_id}`);
      const adminChip = entry.is_admin ? ' <span class="fp-chip fp-chip--admin">ADMIN</span>' : '';
      const unit = escapeHtml([entry.unit, entry.position].filter(Boolean).join(" · ") || "-");
      const serial = escapeHtml(entry.military_id || entry.user_id || "-");
      const sensor = hasSensor ? `#${entry.sensor_id}` : "-";
      const site = escapeHtml(entry.site || state.site || "-");
      const last = escapeHtml(formatDateTime(entry.last_enrolled));
      const selectedClass = state.selectedPersonId === entry.person_id ? " class=\"is-selected\"" : "";
      return `<tr data-person="${entry.person_id || ""}" data-has-fp="${hasSensor ? "true" : "false"}"${selectedClass}>
        <td>${chip}</td>
        <td><div class="fp-person-name">${personName}${adminChip}</div></td>
        <td>${unit}</td>
        <td>${serial}</td>
        <td>${escapeHtml(sensor)}</td>
        <td>${site}</td>
        <td>${last}</td>
      </tr>`;
    })
    .join("");

  refs.tableWrap.innerHTML = `
    <div class="fp-table-scroll">
      <table class="fp-table" aria-describedby="fp-table-summary">
        <thead>
          <tr>
            <th scope="col">상태</th>
            <th scope="col">인원</th>
            <th scope="col">부대/직책</th>
            <th scope="col">군번/ID</th>
            <th scope="col">지문 ID</th>
            <th scope="col">사이트</th>
            <th scope="col">마지막 등록</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function updateLastEventSummary(event = {}, receivedAt) {
  if (!refs.sensorEvent) return;
  const time = receivedAt ? new Date(receivedAt) : new Date();
  const label = event.type
    ? event.type
    : event.stage
      ? `stage:${event.stage}`
      : event.error
        ? `error:${event.error}`
        : "event";
  if (!Number.isNaN(time.getTime())) {
    const timeText = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(time);
    refs.sensorEvent.textContent = `${label} · ${timeText}`;
  } else {
    refs.sensorEvent.textContent = label;
  }
}
async function refreshLocalStatus({ silent = false } = {}) {
  if (refs.sensorConnection && !silent) {
    refs.sensorConnection.textContent = "확인 중…";
    refs.sensorConnection.dataset.state = "unknown";
  }
  try {
    const [health, countRes] = await Promise.all([
      callLocalHealth(),
      callLocalCount().catch(() => null)
    ]);
    const connected = !!health?.serial?.connected;
    if (refs.sensorConnection) {
      refs.sensorConnection.textContent = connected
        ? health?.serial?.path || "연결됨"
        : "오프라인";
      refs.sensorConnection.dataset.state = connected ? "online" : "offline";
    }
    if (refs.sensorCount) {
      const countValue = countRes?.result?.count ?? countRes?.count ?? health?.identify?.last?.count;
      refs.sensorCount.textContent = Number.isFinite(countValue) ? String(countValue) : "-";
    }
  } catch (err) {
    if (refs.sensorConnection) {
      refs.sensorConnection.textContent = "오프라인";
      refs.sensorConnection.dataset.state = "offline";
    }
    if (refs.sensorCount) refs.sensorCount.textContent = "-";
  }
}

async function loadAssignments({ silent = true } = {}) {
  try {
    const rows = await fetchFingerprintAssignments();
    state.assignments = Array.isArray(rows) ? rows.map(normalizeAssignment) : [];
    updateSummary();
    populatePersonSelect();
    renderAssignmentTable();
  } catch (err) {
    console.error("[AAMS][admin-fp] 지문 현황 불러오기 실패", err);
    if (!silent) {
      setOperationStatus("enroll", "지문 현황을 불러오지 못했습니다.", { level: "error" });
    }
  }
}

async function ensureAdminProfile() {
  let me = getMe();
  if (!me?.id || !me?.is_admin) {
    location.hash = "#/admin-login";
    return null;
  }
  const needsDetail = !me.rank || !me.unit || !me.serial || !me.position;
  if (needsDetail) {
    try {
      const detail = await fetchPersonnelById(me.id);
      me = {
        ...me,
        rank: detail?.rank ?? me.rank,
        unit: detail?.unit ?? me.unit,
        position: detail?.position ?? me.position,
        duty: detail?.position ?? me.duty,
        serial: detail?.military_id ?? me.serial,
        military_id: detail?.military_id ?? me.military_id,
        contact: detail?.contact ?? me.contact
      };
      saveMe(me);
    } catch (err) {
      console.warn("[AAMS][admin-fp] 관리자 정보 갱신 실패", err);
    }
  }
  renderMeBrief(me);
  return me;
}

function handleSseEvent(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.site && state.site && payload.site !== state.site) return;
  const event = payload.data;
  if (!event) return;

  updateLastEventSummary(event, payload.received_at);

  if (event.stage) {
    const stageMsg = event.msg || event.message || `센서 단계: ${event.stage}`;
    updateStageMessage(stageMsg, { level: "info", autoClear: 9000 });
    return;
  }

  if (event.ok === false && state.activeOperation) {
    setOperationStatus(state.activeOperation.type, describeSensorError(event.error), { level: "error" });
    clearStageMessage();
  }

  if (event.type === "enroll" && state.activeOperation?.type === "enroll") {
    setOperationStatus("enroll", `센서 저장 완료 (ID ${event.id})`, { level: "success" });
    clearStageMessage();
  }
  if (event.type === "delete" && state.activeOperation?.type === "delete") {
    setOperationStatus("delete", `지문 ID ${event.id} 삭제 완료`, { level: "success" });
    clearStageMessage();
  }
  if (event.type === "clear" && state.activeOperation?.type === "clear") {
    setOperationStatus("delete", "센서 지문 데이터 초기화 완료", { level: "success" });
    clearStageMessage();
  }
}

async function handleEnroll() {
  if (state.busy) return;
  const assignment = getSelectedAssignment();
  if (!assignment) {
    setOperationStatus("enroll", "대상 인원을 선택해 주세요.", { level: "warning" });
    return;
  }
  const sensorId = Number.parseInt(refs.sensorInput?.value || "", 10);
  if (!Number.isInteger(sensorId) || sensorId <= 0) {
    setOperationStatus("enroll", "유효한 지문 ID를 입력해 주세요.", { level: "warning" });
    return;
  }
  const conflict = state.assignments.find((entry) => entry.person_id !== assignment.person_id && entry.sensor_id === sensorId);
  if (conflict) {
    const name = [conflict.rank, conflict.name].filter(Boolean).join(" ") || conflict.name || `ID ${conflict.person_id}`;
    const confirmMsg = `센서 ID ${sensorId}는 현재 ${name}에게 할당되어 있습니다. 이 인원의 지문을 대체하시겠습니까?`;
    if (!window.confirm(confirmMsg)) {
      setOperationStatus("enroll", "작업이 취소되었습니다.", { level: "warning" });
      return;
    }
  }

  state.activeOperation = { type: "enroll", personId: assignment.person_id, sensorId, startedAt: Date.now() };
  setOperationStatus("enroll", "센서 준비 중입니다. 지문 안내에 따라 진행해 주세요.", { level: "info" });
  updateStageMessage("센서에 손가락을 올려 두 번 스캔해 주세요.", { level: "info", autoClear: 10000 });
  setBusy(true);

  try {
    await callLocalEnroll(sensorId);
    setOperationStatus("enroll", "센서 응답을 확인하는 중입니다…", { level: "info" });
    await assignFingerprint({ sensorId, personId: assignment.person_id, site: state.site });
    if (assignment.sensor_id && assignment.sensor_id !== sensorId) {
      try {
        await callLocalDelete(assignment.sensor_id, { allowMissing: true });
      } catch (cleanupError) {
        console.warn("[AAMS][admin-fp] 이전 지문 삭제 실패", cleanupError);
      }
    }
    await loadAssignments({ silent: true });
    await refreshLocalStatus({ silent: true });
    setOperationStatus("enroll", `지문 등록이 완료되었습니다. (ID ${sensorId})`, { level: "success" });
  } catch (err) {
    console.error("[AAMS][admin-fp] 지문 등록 실패", err);
    setOperationStatus("enroll", describeError(err), { level: "error" });
  } finally {
    state.activeOperation = null;
    setBusy(false);
    clearStageMessage();
  }
}
async function handleDelete() {
  if (state.busy) return;
  const assignment = getSelectedAssignment();
  if (!assignment) {
    setOperationStatus("delete", "대상 인원을 선택해 주세요.", { level: "warning" });
    return;
  }
  if (!Number.isInteger(assignment.sensor_id)) {
    setOperationStatus("delete", "선택한 인원에 등록된 지문이 없습니다.", { level: "warning" });
    return;
  }
  const confirmMsg = `정말로 ${assignment.name || "선택된 인원"}의 지문 ID ${assignment.sensor_id}를 삭제하시겠습니까?`;
  if (!window.confirm(confirmMsg)) {
    setOperationStatus("delete", "작업이 취소되었습니다.", { level: "warning" });
    return;
  }

  state.activeOperation = { type: "delete", personId: assignment.person_id, sensorId: assignment.sensor_id, startedAt: Date.now() };
  setBusy(true);
  setOperationStatus("delete", "센서에서 지문을 삭제하는 중입니다…", { level: "info" });
  updateStageMessage("센서 지문을 삭제하고 있습니다.", { level: "info", autoClear: 6000 });

  try {
    await callLocalDelete(assignment.sensor_id, { allowMissing: true });
    await deleteFingerprintForPerson(assignment.person_id);
    await loadAssignments({ silent: true });
    await refreshLocalStatus({ silent: true });
    setOperationStatus("delete", "선택한 인원의 지문이 삭제되었습니다.", { level: "success" });
  } catch (err) {
    console.error("[AAMS][admin-fp] 지문 삭제 실패", err);
    setOperationStatus("delete", describeError(err), { level: "error" });
  } finally {
    state.activeOperation = null;
    setBusy(false);
    clearStageMessage();
  }
}

async function handleClear() {
  if (state.busy) return;
  if (!window.confirm("정말로 센서에 저장된 모든 지문을 삭제하시겠습니까?")) {
    return;
  }
  if (!window.confirm("모든 지문 데이터를 삭제합니다. 계속하시겠습니까?")) {
    setOperationStatus("delete", "작업이 취소되었습니다.", { level: "warning" });
    return;
  }

  state.activeOperation = { type: "clear", startedAt: Date.now() };
  setBusy(true);
  setOperationStatus("delete", "센서 지문을 초기화하는 중입니다…", { level: "info" });
  updateStageMessage("센서 초기화 중입니다. 잠시만 기다려 주세요.", { level: "info", autoClear: 8000 });

  try {
    await callLocalClear();
    await clearFingerprintMappings({ site: state.site });
    await loadAssignments({ silent: true });
    await refreshLocalStatus({ silent: true });
    setOperationStatus("delete", "센서와 시스템의 지문 데이터가 초기화되었습니다.", { level: "success" });
  } catch (err) {
    console.error("[AAMS][admin-fp] 지문 초기화 실패", err);
    setOperationStatus("delete", describeError(err), { level: "error" });
  } finally {
    state.activeOperation = null;
    setBusy(false);
    clearStageMessage();
  }
}

function setupEventSource() {
  if (window.__AAMS_FP_ADMIN_SOURCE) {
    try { window.__AAMS_FP_ADMIN_SOURCE.close(); } catch (_) {}
  }
  const es = openFpEventSource({ site: state.site, onEvent: handleSseEvent });
  window.__AAMS_FP_ADMIN_SOURCE = es;
  state.eventSource = es;

  const cleanup = () => {
    if (state.eventSource) {
      try { state.eventSource.close(); } catch (_) {}
      state.eventSource = null;
    }
    if (window.__AAMS_FP_ADMIN_SOURCE === es) {
      window.__AAMS_FP_ADMIN_SOURCE = null;
    }
  };

  const handleHashChange = () => {
    if (location.hash !== "#/admin-fp") {
      cleanup();
      window.removeEventListener("hashchange", handleHashChange);
    }
  };

  window.addEventListener("hashchange", handleHashChange);
  window.addEventListener("beforeunload", cleanup, { once: true });
}

export async function initAdminFingerprintManage() {
  await mountMobileHeader({
    title: "지문 관리",
    pageType: "subpage",
    showLogout: true,
    backTo: "#/admin",
    homeTo: "#/admin"
  });

  refs.personSelect = document.querySelector('[data-role="person-select"]');
  refs.sensorInput = document.querySelector('[data-role="sensor-id"]');
  refs.personInfo = document.querySelector('[data-role="person-info"]');
  refs.enrollBtn = document.querySelector('[data-role="enroll-btn"]');
  refs.deleteBtn = document.querySelector('[data-role="delete-btn"]');
  refs.clearBtn = document.querySelector('[data-role="clear-btn"]');
  refs.enrollStatus = document.querySelector('[data-role="enroll-status"]');
  refs.deleteStatus = document.querySelector('[data-role="delete-status"]');
  refs.stageMessage = document.querySelector('[data-role="stage-message"]');
  refs.summary = document.querySelector('[data-role="summary"]');
  refs.listSummary = document.querySelector('[data-role="list-summary"]');
  refs.tableWrap = document.getElementById('fp-assignment-table');
  refs.refreshBtn = document.querySelector('[data-role="refresh-btn"]');
  refs.refreshLocalBtn = document.querySelector('[data-role="refresh-local"]');
  refs.sensorConnection = document.querySelector('[data-role="sensor-connection"]');
  refs.sensorCount = document.querySelector('[data-role="sensor-count"]');
  refs.sensorEvent = document.querySelector('[data-role="sensor-event"]');

  setOperationStatus("enroll", "");
  setOperationStatus("delete", "");
  clearStageMessage();

  refs.personSelect?.addEventListener("change", () => {
    const value = refs.personSelect.value;
    if (!value) {
      state.selectedPersonId = null;
    } else {
      const parsed = Number.parseInt(value, 10);
      state.selectedPersonId = Number.isInteger(parsed) ? parsed : null;
    }
    updateSelectedPersonInfo();
    renderAssignmentTable();
  });
  refs.enrollBtn?.addEventListener("click", handleEnroll);
  refs.deleteBtn?.addEventListener("click", handleDelete);
  refs.clearBtn?.addEventListener("click", handleClear);
  refs.refreshBtn?.addEventListener("click", () => loadAssignments({ silent: false }));
  refs.refreshLocalBtn?.addEventListener("click", () => refreshLocalStatus({ silent: false }));

  await ensureAdminProfile();
  await loadAssignments({ silent: false });
  await refreshLocalStatus({ silent: true });
  setupEventSource();
}