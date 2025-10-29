import {
  fetchRequestDetail,
  executeRequest,
  markDispatchFailure,
  completeExecution,
  invalidateRequestDetail,
  connectWebSocket,
  onWebSocketEvent,
  sendWebSocketMessage
} from "./api.js";
import { getMe } from "./util.js";
import { buildDispatchPayload, dispatchRobotViaLocal } from "./user.js";
import {
  loadExecuteContext,
  setExecuteContext,
  updateExecuteContext,
  clearExecuteContext
} from "./execute_context.js";

const SITE = window.FP_SITE || "site-01";

const DOT_ROWS = 48;
const DOT_COLS = 80;
const DOT_COUNT = DOT_ROWS * DOT_COLS;

const EYE_WIDTH = 24;
const EYE_HEIGHT = 24;
const EYE_ROW = 10;
const LEFT_EYE_COL = 8;
const RIGHT_EYE_COL = DOT_COLS - LEFT_EYE_COL - EYE_WIDTH;
const PUPIL_WIDTH = 6;
const PUPIL_HEIGHT = 6;

const BOOT_TIMING = {
  scatterIntro: 360,
  scatterAlign: 420,
  revealSteps: 22,
  revealDelay: 60,
  holdWord: 420,
  disperseDelay: 320,
  blink: 360,
  settle: 420
};

const SHUTDOWN_TIMING = {
  blink: 360,
  settle: 360,
  revealSteps: 18,
  revealDelay: 60,
  holdWord: 380,
  dissolveSteps: 14,
  dissolveDelay: 60,
  scatterDelay: 320,
  finalPause: 280
};

const WAITING_MESSAGES = [
  "경로 확보 중",
  "안전 점검 중",
  "전달 시퀀스 준비",
  "시각 검증 준비"
];

const FAILURE_STAGES = new Set([
  "dispatch-failed",
  "execution-failed",
  "report-failed",
  "invalid",
  "missing"
]);

function normalizeHashTarget(raw) {
  if (!raw) return "#/";
  const trimmed = String(raw).trim();
  if (!trimmed) return "#/";
  if (trimmed.startsWith("#/")) return trimmed;
  if (trimmed.startsWith("#")) {
    const rest = trimmed.slice(1).replace(/^\/+/, "");
    return rest ? `#/${rest}` : "#/";
  }
  if (trimmed.startsWith("/")) {
    return `#${trimmed.replace(/^\/+/, "")}`;
  }
  return `#/${trimmed.replace(/^#?\/+/, "")}`;
}

function isLockdownHashAllowed(hash, allowAdmin = false) {
  const normalized = normalizeHashTarget(hash);
  if (LOCKDOWN_ALLOWED_HASHES.has(normalized)) return true;
  if (allowAdmin && normalized === "#/fp-admin") return true;
  return false;
}

function enforceLockdownHash(preferred) {
  const target = preferred ? normalizeHashTarget(preferred) : normalizeHashTarget(lockdownGuard?.allowAdmin ? "#/fp-admin" : "#/execute");
  if (location.hash !== target) {
    location.hash = target;
  }
}

function updateGlobalLockdownGuard() {
  if (!lockdownGuard) {
    delete window.AAMS_LOCKDOWN_GUARD;
    return;
  }
  window.AAMS_LOCKDOWN_GUARD = {
    shouldBlock(targetHash) {
      return !isLockdownHashAllowed(targetHash, lockdownGuard.allowAdmin);
    },
    enforce(targetHash) {
      const normalized = normalizeHashTarget(targetHash);
      if (isLockdownHashAllowed(normalized, lockdownGuard.allowAdmin)) {
        enforceLockdownHash(normalized);
      } else {
        enforceLockdownHash();
      }
    }
  };
}

function setLockdownGuard({ allowAdmin = false } = {}) {
  if (!lockdownGuard) {
    const handler = (event) => {
      const target = normalizeHashTarget(location.hash);
      if (!isLockdownHashAllowed(target, lockdownGuard.allowAdmin)) {
        event?.preventDefault?.();
        enforceLockdownHash();
      }
    };
    lockdownGuard = { allowAdmin: !!allowAdmin, handler };
    window.addEventListener("hashchange", handler, true);
  } else {
    lockdownGuard.allowAdmin = lockdownGuard.allowAdmin || !!allowAdmin;
  }
  updateGlobalLockdownGuard();
}

function allowLockdownAdminAccess() {
  setLockdownGuard({ allowAdmin: true });
  enforceLockdownHash("#/fp-admin");
}

function clearLockdownGuard() {
  if (lockdownGuard?.handler) {
    window.removeEventListener("hashchange", lockdownGuard.handler, true);
  }
  lockdownGuard = null;
  delete window.AAMS_LOCKDOWN_GUARD;
}

let executeContext = null;
let actionContainer;
let actionText;
let actionButton;
let lockdownContainer;
let lockdownText;
let lockdownButton;
let currentInteraction = null;
let lockdownActive = false;
let lockdownState = null;

let lockdownGuard = null;

const LOCKDOWN_SESSION_FLAG = "AAMS_LOCKDOWN_MODE";
const LOCKDOWN_ALLOWED_HASHES = new Set(["#/execute"]);
const GENERIC_STATUS_PATTERNS = [
  /준비/,
  /대기/,
  /안전 절차/,
  /시각 검증 준비/,
  /안전 점검/
];

function normalizeLockdownPayload(raw = {}) {
  const activeRaw = raw.active;
  const active = !(activeRaw === false || activeRaw === "false" || activeRaw === 0 || activeRaw === "0");
  const triggeredAt = raw.triggeredAt || raw.triggered_at || (active ? Date.now() : null);
  const clearedAt = raw.clearedAt || raw.cleared_at || (!active ? Date.now() : null);
  const reason = raw.reason || raw.error || (active ? "lockdown" : "unlock");
  const message = raw.message || (active ? "락다운 상태" : "락다운 해제");
  const stage = raw.stage || "lockdown";
  const meta = raw.meta || raw.details || null;
  return {
    ...raw,
    active,
    triggeredAt,
    clearedAt,
    reason,
    message,
    stage,
    meta
  };
}

const LETTER_TEMPLATES = {
  A: [
    "  ###  ",
    " #   # ",
    " #   # ",
    " ##### ",
    " #   # ",
    " #   # "
  ],
  M: [
    " #   # ",
    " ## ## ",
    " # # # ",
    " #   # ",
    " #   # ",
    " #   # "
  ],
  S: [
    "  #### ",
    " #     ",
    " ###   ",
    "    #  ",
    "    #  ",
    " ####  "
  ]
};

function buildSparkleExtra() {
  const offset = Math.max(2, Math.floor(EYE_HEIGHT * 0.4));
  const coords = [
    [EYE_ROW - offset, LEFT_EYE_COL - 3],
    [EYE_ROW - Math.floor(offset * 0.7), LEFT_EYE_COL - 5],
    [EYE_ROW - Math.floor(offset * 0.5), LEFT_EYE_COL - 2],
    [EYE_ROW - offset, RIGHT_EYE_COL + EYE_WIDTH + 3],
    [EYE_ROW - Math.floor(offset * 0.7), RIGHT_EYE_COL + EYE_WIDTH + 5],
    [EYE_ROW - Math.floor(offset * 0.5), RIGHT_EYE_COL + EYE_WIDTH + 2]
  ];
  return {
    points: coordsIndices(coords),
    accent: true
  };
}

const STAGE_BASE_EXPRESSION = {
  queued: "focus",
  "detail-loading": "focus",
  "dispatch-ready": "focus",
  "await-local": "focus",
  "auto-dispatch": "smile",
  executing: "determined",
  completed: "smile",
  "dispatch-failed": "sad",
  "execution-failed": "sad",
  "report-failed": "sad",
  invalid: "sad",
  missing: "sad"
};

const LEFT_EYE = { row: EYE_ROW, col: LEFT_EYE_COL };
const RIGHT_EYE = { row: EYE_ROW, col: RIGHT_EYE_COL };

const EXPRESSIONS = {
  sleep: createExpression({ leftEye: "closed", rightEye: "closed", leftPupil: "none", rightPupil: "none" }),
  idle: createExpression({ leftEye: "open", rightEye: "open", leftPupil: "center", rightPupil: "center" }),
  focus: createExpression({ leftEye: "soft", rightEye: "soft", leftPupil: "center", rightPupil: "center" }),
  determined: createExpression({ leftEye: "narrow", rightEye: "narrow", leftPupil: "center", rightPupil: "center" }),
  lookLeft: createExpression({ leftEye: "open", rightEye: "open", leftPupil: "left", rightPupil: "left" }),
  lookRight: createExpression({ leftEye: "open", rightEye: "open", leftPupil: "right", rightPupil: "right" }),
  lookUp: createExpression({ leftEye: "open", rightEye: "open", leftPupil: "up", rightPupil: "up" }),
  lookDown: createExpression({ leftEye: "open", rightEye: "open", leftPupil: "down", rightPupil: "down" }),
  blink: createExpression({ leftEye: "closed", rightEye: "closed", leftPupil: "none", rightPupil: "none" }),
  wink: createExpression({ leftEye: "open", rightEye: "closed", leftPupil: "center", rightPupil: "none" }),
  winkLeft: createExpression({ leftEye: "closed", rightEye: "open", leftPupil: "none", rightPupil: "center" }),
  smile: createExpression({ leftEye: "soft", rightEye: "soft", leftPupil: "center", rightPupil: "center" }),
  calm: createExpression({ leftEye: "soft", rightEye: "soft", leftPupil: "down", rightPupil: "down" }),
  sad: createExpression({ leftEye: "narrow", rightEye: "narrow", leftPupil: "down", rightPupil: "down" }),
  sparkle: createExpression({ leftEye: "open", rightEye: "open", leftPupil: "center", rightPupil: "center", extras: [buildSparkleExtra()] }),
  celebrate: createExpression({ leftEye: "open", rightEye: "open", leftPupil: "up", rightPupil: "up", extras: [buildSparkleExtra()] }),
  surprised: createExpression({ leftEye: "open", rightEye: "open", leftPupil: "center", rightPupil: "center" })
};


const EXPRESSION_ALIASES = {
  happy: "smile",
  success: "celebrate",
  celebrate: "celebrate",
  saluting: "celebrate",
  proud: "celebrate",
  sparkle: "sparkle"
};

let screenEl;
let gridEl;
let statusEl;
let exitBtn;
let dots = [];
let baseExpression = "sleep";
let activeExpression = "sleep";
let microTimer = null;
let ambientAnimTimer = null;
let ambientTimer = null;
let ambientMessages = [];
let ambientIndex = 0;
let statusLabel = "";
let statusMessage = "";
let ambientMessage = "";
let currentStageKey = null;
let exitAutoTimer = null;
let exiting = false;

export async function initExecutionPage() {
  screenEl = document.getElementById("execute-screen");
  gridEl = document.getElementById("execute-grid");
  statusEl = document.getElementById("execute-status");
  exitBtn = document.getElementById("execute-exit");

  if (!screenEl || !gridEl || !statusEl) {
    console.error("[AAMS][execute] 필수 요소를 찾지 못했습니다.");
    return;
  }

  window.onbeforeunload = null;
  connectWebSocket(SITE);
  onWebSocketEvent("ROBOT_EVENT", handleRobotEvent);
  onWebSocketEvent("LOCKDOWN_STATUS", handleLockdownStatus);
  sendWebSocketMessage({ type: "LOCKDOWN_STATUS_REQUEST", site: SITE });

  exiting = false;
  stopAmbientMessages();
  stopAmbientAnimations();

  if (exitBtn) {
    exitBtn.hidden = true;
    exitBtn.disabled = false;
    exitBtn.addEventListener("click", () => {
      powerDownAndExit();
    });
  }

  actionContainer = document.createElement("div");
  actionContainer.className = "execute-action";
  actionContainer.hidden = true;
  actionContainer.setAttribute("hidden", "");
  actionText = document.createElement("p");
  actionText.className = "execute-action-text";
  actionButton = document.createElement("button");
  actionButton.type = "button";
  actionButton.className = "execute-action-button";
  actionButton.addEventListener("click", handleInteractionClick);
  actionContainer.appendChild(actionText);
  actionContainer.appendChild(actionButton);
  screenEl.appendChild(actionContainer);

  lockdownContainer = document.createElement("div");
  lockdownContainer.className = "execute-lockdown";
  lockdownContainer.hidden = true;
  lockdownText = document.createElement("p");
  lockdownText.className = "execute-lockdown-text";
  lockdownButton = document.createElement("button");
  lockdownButton.type = "button";
  lockdownButton.className = "execute-lockdown-button";
  lockdownButton.textContent = "락 해제 (관리자)";
  lockdownButton.addEventListener("click", handleLockdownUnlock);
  lockdownContainer.appendChild(lockdownText);
  lockdownContainer.appendChild(lockdownButton);
  screenEl.appendChild(lockdownContainer);

  gridEl.style.setProperty("--cols", String(DOT_COLS));
  gridEl.style.setProperty("--rows", String(DOT_ROWS));

  createDotGrid();
  applyExpression("sleep");

  const context = loadExecuteContext();
  executeContext = context;
  if (!context || !context.requestId) {
    setStatus("집행 요청을 찾을 수 없습니다", "사용자 페이지로 돌아갑니다.", "error");
    await wait(1200);
    await powerDownAndExit({ immediate: true });
    return;
  }

  if (context.lockdown && context.lockdown.active) {
    enterLockdown(context.lockdown, { persist: false });
  } else if (context.interaction && context.interaction.active && !lockdownActive) {
    showInteraction(context.interaction, { persist: false });
  } else if (context.interaction && !context.interaction.active) {
    clearInteraction(null, { persist: false });
    try {
      executeContext = updateExecuteContext((prev) => ({ ...prev, interaction: null }));
    } catch (err) {
      console.warn("[AAMS][execute] 컨텍스트 초기화 실패:", err);
    }
  }

  if (!lockdownActive) {
    await playBootSequence();
  }
  await runExecutionFlow(context);
}
async function runExecutionFlow(initialContext) {
  if (!initialContext || !initialContext.requestId) {
    updateStage("missing", "집행 요청을 찾을 수 없습니다", "사용자 페이지로 돌아갑니다.", { level: "error" });
    enableExit({ autoDelay: 2000 });
    return;
  }

  let context = executeContext = setExecuteContext({ ...initialContext, state: initialContext.state || "pending" });
  const requestId = context.requestId;
  const me = context.executor && context.executor.id ? context.executor : getMe();

  if (!context.executor && me) {
    context = executeContext = updateExecuteContext((prev) => ({ ...prev, executor: sanitizeExecutor(me) }));
  }

  updateStage("queued", "준비", "승인 확인");

  let detail = context.detail || null;
  if (!detail) {
    try {
      detail = await fetchRequestDetail(requestId, { force: true });
      context = executeContext = updateExecuteContext((prev) => ({ ...prev, detail }));
    } catch (err) {
      await handleFailure(context, "요청 정보 조회 실패", err, { stage: "invalid", actorId: me?.id });
      return;
    }
  }

  let dispatch = context.dispatch || null;
  if (!dispatch) {
    dispatch = buildDispatchPayload({ requestId, row: context.row, detail, executor: me });
    context = executeContext = updateExecuteContext((prev) => ({ ...prev, dispatch }));
  }

  updateStage("dispatch-ready", "정렬", "시퀀스 구성");

  let serverResult = context.serverResult || null;
  if (!serverResult) {
    try {
      serverResult = await executeRequest({ requestId, executorId: me?.id, dispatch });
      context = executeContext = updateExecuteContext((prev) => ({ ...prev, serverResult }));
    } catch (err) {
      await handleFailure(context, "집행 명령 등록 실패", err, { stage: "dispatch-failed", actorId: me?.id });
      return;
    }
  }

  const dispatchFromServer = serverResult?.dispatch || dispatch;
  const payloadEnvelope = context.payloadEnvelope || serverResult?.payload || null;
  const bridgePayload = context.bridgePayload
    || payloadEnvelope?.bridgePayload
    || serverResult?.bridgePayload
    || serverResult?.payload?.bridgePayload
    || null;
  const localPayload = bridgePayload || context.localPayload || payloadEnvelope || null;
  const requiresManual = !!(localPayload && serverResult?.bridge?.manualRequired !== false);
  context = executeContext = updateExecuteContext((prev) => ({
    ...prev,
    dispatch: dispatchFromServer,
    payloadEnvelope,
    bridgePayload,
    localPayload,
    requiresManual
  }));

  updateStage("await-local", "연결", "로컬 확인");

  if (!requiresManual || !localPayload) {
    updateStage("auto-dispatch", "자동 실행", "로봇 진행", { level: "success", expression: "smile" });
    invalidateRequestDetail(requestId);
    enableExit({ autoDelay: 12000 });
    return;
  }

  updateStage("executing", "동작", "로봇 제어");

  let localResult = context.localResult || null;
  let alreadyDispatched = !!context.localDispatched;
  if (!localResult) {
    if (!alreadyDispatched) {
      context = executeContext = updateExecuteContext((prev) => ({ ...prev, localDispatched: true }));
      alreadyDispatched = true;
    }
    try {
      const payloadTimeout = Number(localPayload?.timeoutMs);
      const timeoutMs = Number.isFinite(payloadTimeout) && payloadTimeout > 0
        ? Math.max(payloadTimeout, 180000)
        : 180000;
      const lastEventSnapshot = executeContext?.lastRobotEvent || null;
      localResult = await dispatchRobotViaLocal(localPayload, {
        timeoutMs,
        resume: alreadyDispatched,
        lastEvent: lastEventSnapshot
      });
      context = executeContext = updateExecuteContext((prev) => ({ ...prev, localResult, state: "local-finished" }));
    } catch (err) {
      context = executeContext = updateExecuteContext((prev) => ({ ...prev, localDispatched: false }));
      stopAmbientMessages();
      await handleFailure(context, "로컬 장비 호출 실패", err, { stage: "dispatch-failed", actorId: me?.id });
      return;
    }
  }

  stopAmbientMessages();

  const job = localResult?.job || null;
  const jobStatus = String(job?.status || job?.state || "").toLowerCase();
  const completionMessage = job?.message
    || job?.result?.message
    || job?.summary?.message
    || (job?.summary?.actionLabel && job?.summary?.includes?.label
      ? `${job.summary.actionLabel} ${job.summary.includes.label}`
      : "장비 제어 완료");

  if (jobStatus && !["success", "succeeded", "done", "completed"].includes(jobStatus)) {
    await handleFailure(
      context,
      "장비 동작 오류",
      new Error(job?.message || job?.error || job?.result?.message || "장비 제어 실패"),
      { stage: "execution-failed", actorId: me?.id, job }
    );
    return;
  }

  updateStage("completed", "완료", completionMessage, { level: "success", expression: "smile" });

  if (!context.completionReported) {
    try {
      await completeExecution({
        requestId,
        actorId: me?.id,
        eventId: serverResult?.event_id,
        result: job,
        statusReason: completionMessage
      });
      context = executeContext = updateExecuteContext((prev) => ({ ...prev, completionReported: true, state: "completed" }));
    } catch (err) {
      await handleFailure(context, "집행 결과 반영 실패", err, { stage: "report-failed", actorId: me?.id, job });
      return;
    }
  }

  invalidateRequestDetail(requestId);
  enableExit({ autoDelay: 90000 });
}

function updateStage(stageKey, label, message, { level = "info", expression } = {}) {
  currentStageKey = stageKey;
  const resolved = expression || STAGE_BASE_EXPRESSION[stageKey] || (level === "error" ? "sad" : level === "success" ? "smile" : "focus");
  setBaseExpression(resolved);
  if (stageKey === "executing") {
    startAmbientMessages(WAITING_MESSAGES);
  } else {
    stopAmbientMessages();
  }
  setStatus(label, message, level);
  if (stageKey === "completed") {
    playCelebrationSequence();
    return;
  }
  if (FAILURE_STAGES.has(stageKey)) {
    stopAmbientAnimations();
  } else {
    startAmbientAnimations();
  }
}

const MAX_STATUS_LENGTH = 160;

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return typeof text.normalize === "function" ? text.normalize("NFC") : text;
}

function truncateStatus(text) {
  if (!text) return "";
  return text.length > MAX_STATUS_LENGTH ? `${text.slice(0, MAX_STATUS_LENGTH - 1)}…` : text;
}

function normalizeLevel(level) {
  const normalized = String(level || "info").toLowerCase();
  if (normalized === "warning" || normalized === "warn") return "warning";
  if (normalized === "error" || normalized === "danger" || normalized === "fail") return "error";
  if (normalized === "success" || normalized === "ok" || normalized === "done") return "success";
  return "info";
}

function setStatus(label, message, level = "info") {
  statusLabel = normalizeText(label);
  statusMessage = normalizeText(message);
  ambientMessage = "";
  if (statusEl) {
    statusEl.setAttribute("data-level", normalizeLevel(level));
  }
  applyStatus();
}

function setAmbientText(text) {
  ambientMessage = normalizeText(text);
  applyStatus();
}

function applyStatus() {
  if (!statusEl) return;
  let full = "";
  if (ambientMessage) {
    full = ambientMessage;
  } else {
    full = statusMessage || statusLabel || "";
  }
  const safe = full || "\u00A0";
  const display = truncateStatus(safe);
  statusEl.textContent = display;
  statusEl.title = safe === "\u00A0" ? "" : safe;
}
function startAmbientMessages(messages) {
  stopAmbientMessages();
  if (!Array.isArray(messages) || !messages.length) return;
  ambientMessages = messages.slice();
  ambientIndex = 0;
  setAmbientText(ambientMessages[ambientIndex]);
  ambientTimer = setInterval(() => {
    ambientIndex = (ambientIndex + 1) % ambientMessages.length;
    setAmbientText(ambientMessages[ambientIndex]);
  }, 3200);
}

function stopAmbientMessages() {
  ambientMessages = [];
  ambientIndex = 0;
  if (ambientTimer) {
    clearInterval(ambientTimer);
    ambientTimer = null;
  }
  setAmbientText("");
}

function startAmbientAnimations() {
  stopAmbientAnimations();
  const schedule = () => {
    const options = pickAmbientExpressions();
    if (!options.length) return;
    const choice = options[Math.floor(Math.random() * options.length)];
    const duration = choice === "blink" ? 260 : 420;
    playMicroExpression(choice, duration);
    ambientAnimTimer = setTimeout(schedule, randomInt(2200, 5200));
  };
  ambientAnimTimer = setTimeout(schedule, randomInt(1400, 2800));
}

function stopAmbientAnimations() {
  if (ambientAnimTimer) {
    clearTimeout(ambientAnimTimer);
    ambientAnimTimer = null;
  }
  if (microTimer) {
    clearTimeout(microTimer);
    microTimer = null;
    applyExpression(baseExpression);
  }
}

function playCelebrationSequence() {
  stopAmbientAnimations();
  const fallback = resolveExpressionName(baseExpression === "sad" ? "smile" : baseExpression || "smile");
  applyExpression("celebrate");
  setTimeout(() => {
    setBaseExpression(fallback);
    applyExpression(fallback);
    if (!FAILURE_STAGES.has(currentStageKey)) {
      startAmbientAnimations();
      setTimeout(() => {
        playMicroExpression("wink", 260);
      }, 600);
    }
  }, 1400);
}

function pickAmbientExpressions() {
  const base = baseExpression;
  if (base === "sleep") return [];
  if (base === "sad") return ["blink", "lookLeft", "lookRight", "lookDown"];
  if (base === "smile") return ["blink", "wink", "winkLeft", "lookLeft", "lookRight", "sparkle"];
  if (base === "determined" || base === "focus") return ["blink", "lookLeft", "lookRight", "lookUp", "lookDown"];
  if (base === "calm") return ["blink", "lookLeft", "lookRight", "lookDown", "lookUp"];
  return ["blink", "lookLeft", "lookRight", "wink", "winkLeft", "lookUp", "lookDown", "sparkle", "celebrate"];
}

function playMicroExpression(name, duration = 400) {
  const resolved = resolveExpressionName(name);
  if (!EXPRESSIONS[resolved]) return;
  applyExpression(resolved);
  if (microTimer) clearTimeout(microTimer);
  microTimer = setTimeout(() => {
    microTimer = null;
    applyExpression(baseExpression);
  }, duration);
}

function setBaseExpression(name) {
  const resolved = resolveExpressionName(name);
  baseExpression = resolved;
  if (!microTimer) {
    applyExpression(resolved);
  }
}

function applyExpression(name) {
  const resolved = resolveExpressionName(name);
  const pattern = EXPRESSIONS[resolved] || EXPRESSIONS.idle;
  renderPattern(pattern);
  activeExpression = resolved;
  if (screenEl) {
    screenEl.setAttribute("data-expression", resolved);
  }
}

function resolveExpressionName(name) {
  if (name && EXPRESSIONS[name]) return name;
  if (name && EXPRESSION_ALIASES[name]) return EXPRESSION_ALIASES[name];
  return "idle";
}

function createDotGrid() {
  dots = [];
  if (!gridEl) return;
  gridEl.innerHTML = "";
  for (let i = 0; i < DOT_COUNT; i += 1) {
    const dot = document.createElement("span");
    dot.className = "execute-dot";
    dot.setAttribute("aria-hidden", "true");
    gridEl.appendChild(dot);
    dots.push(dot);
  }
}

function renderPattern(pattern) {
  if (!dots.length) return;
  const on = pattern?.on || EXPRESSIONS.idle.on;
  const accent = pattern?.accent || EXPRESSIONS.idle.accent;
  dots.forEach((dot, index) => {
    const active = on.has(index);
    dot.classList.toggle("is-on", active);
    dot.classList.toggle("is-accent", active && accent.has(index));
  });
}

function randomScatter(count) {
  if (!dots.length) return;
  const total = DOT_COUNT;
  const sampleCount = Math.max(0, Math.min(count, total));
  const indices = Array.from({ length: total }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const onSet = new Set(indices.slice(0, sampleCount));
  const accentCount = Math.max(0, Math.floor(sampleCount * 0.2));
  const accentSet = new Set(indices.slice(0, accentCount));
  dots.forEach((dot, index) => {
    const active = onSet.has(index);
    dot.classList.toggle("is-on", active);
    dot.classList.toggle("is-accent", active && accentSet.has(index));
  });
}

function shuffleList(values) {
  const arr = Array.from(values);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function revealPattern(pattern, { steps = 14, delay = 48 } = {}) {
  if (!pattern || !pattern.on || !pattern.on.size) return;
  const order = shuffleList(pattern.on);
  const chunk = Math.max(1, Math.ceil(order.length / steps));
  const onSet = new Set();
  const accentSet = new Set(pattern.accent || []);
  for (let i = 0; i < order.length; i += chunk) {
    for (let j = i; j < Math.min(order.length, i + chunk); j += 1) {
      onSet.add(order[j]);
    }
    renderPattern({ on: onSet, accent: accentSet });
    await wait(delay);
  }
}

async function dissolvePattern(pattern, { steps = 12, delay = 50, scatterRatio = 0 } = {}) {
  if (!pattern || !pattern.on || !pattern.on.size) {
    if (scatterRatio > 0) {
      randomScatter(Math.floor(DOT_COUNT * scatterRatio));
    } else {
      randomScatter(0);
    }
    return;
  }
  const order = shuffleList(pattern.on);
  const chunk = Math.max(1, Math.ceil(order.length / steps));
  const onSet = new Set(pattern.on);
  const accentSet = new Set(pattern.accent || []);
  for (let i = 0; i < order.length; i += chunk) {
    for (let j = i; j < Math.min(order.length, i + chunk); j += 1) {
      const value = order[j];
      onSet.delete(value);
      accentSet.delete(value);
    }
    renderPattern({ on: onSet, accent: accentSet });
    await wait(delay);
  }
  const scatterCount = scatterRatio > 0 ? Math.floor(DOT_COUNT * scatterRatio) : 0;
  if (scatterCount > 0) {
    randomScatter(scatterCount);
  } else {
    randomScatter(0);
  }
}

function composeWordLines(word = "AAMS") {
  const letters = word.toUpperCase().split("");
  const rows = LETTER_TEMPLATES.A.length;
  const gap = "  ";
  const lines = Array.from({ length: rows }, () => "");
  letters.forEach((char, index) => {
    const template = LETTER_TEMPLATES[char] || LETTER_TEMPLATES.A;
    for (let row = 0; row < rows; row += 1) {
      lines[row] += template[row] || "";
      if (index !== letters.length - 1) {
        lines[row] += gap;
      }
    }
  });
  return lines;
}

function buildBootWordPattern(word = "AAMS") {
  const lines = composeWordLines(word);
  const rows = lines.length;
  const cols = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const scale = Math.max(2, Math.floor(Math.min(DOT_ROWS / (rows + 4), DOT_COLS / (cols + 4))));
  const offsetRow = Math.floor((DOT_ROWS - rows * scale) / 2);
  const offsetCol = Math.floor((DOT_COLS - cols * scale) / 2);
  const on = new Set();
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const char = lines[r][c] || " ";
      if (char !== "#") continue;
      for (let sr = 0; sr < scale; sr += 1) {
        for (let sc = 0; sc < scale; sc += 1) {
          const rr = offsetRow + r * scale + sr;
          const cc = offsetCol + c * scale + sc;
          if (rr >= 0 && rr < DOT_ROWS && cc >= 0 && cc < DOT_COLS) {
            on.add(idx(rr, cc));
          }
        }
      }
    }
  }
  return { on, accent: new Set() };
}

async function playBootSequence() {
  if (screenEl) screenEl.dataset.scene = "boot";
  if (gridEl) gridEl.classList.add("is-boot");
  setStatus("웨이크업", "시스템 점화");
  randomScatter(Math.floor(DOT_COUNT * 0.08));
  await wait(BOOT_TIMING.scatterIntro);
  setStatus("웨이크업", "신호 정렬");
  randomScatter(Math.floor(DOT_COUNT * 0.12));
  await wait(BOOT_TIMING.scatterAlign);
  const wordPattern = buildBootWordPattern();
  setStatus("웨이크업", "AAMS 온라인");
  await revealPattern(wordPattern, {
    steps: BOOT_TIMING.revealSteps,
    delay: BOOT_TIMING.revealDelay
  });
  await wait(BOOT_TIMING.holdWord);
  renderPattern(wordPattern);
  await wait(BOOT_TIMING.settle);
  randomScatter(Math.floor(DOT_COUNT * 0.06));
  await wait(BOOT_TIMING.disperseDelay);
  applyExpression("blink");
  await wait(BOOT_TIMING.blink);
  if (gridEl) gridEl.classList.remove("is-boot");
  if (screenEl) screenEl.dataset.scene = "active";
  setBaseExpression("idle");
  setStatus("준비", "임무 대기");
  startAmbientAnimations();
}

async function powerDownAndExit({ immediate = false, target = "#/user" } = {}) {
  if (exiting) return;
  exiting = true;
  if (exitAutoTimer) {
    clearTimeout(exitAutoTimer);
    exitAutoTimer = null;
  }
  stopAmbientMessages();
  stopAmbientAnimations();
  if (exitBtn) exitBtn.disabled = true;
  if (screenEl) screenEl.dataset.scene = "shutdown";
  if (gridEl) gridEl.classList.add("is-shutdown");

  if (!immediate) {
    setStatus("종료", "안전 절차 진행");
    await wait(SHUTDOWN_TIMING.blink);
    await wait(260);
    setBaseExpression("sleep");
    applyExpression("sleep");
    await wait(SHUTDOWN_TIMING.settle);
    const wordPattern = buildBootWordPattern();
    await revealPattern(wordPattern, {
      steps: SHUTDOWN_TIMING.revealSteps,
      delay: SHUTDOWN_TIMING.revealDelay
    });
    await wait(SHUTDOWN_TIMING.holdWord);
    await dissolvePattern(wordPattern, {
      steps: SHUTDOWN_TIMING.dissolveSteps,
      delay: SHUTDOWN_TIMING.dissolveDelay,
      scatterRatio: 0.06
    });
    await wait(SHUTDOWN_TIMING.scatterDelay);
    randomScatter(0);
    await wait(SHUTDOWN_TIMING.finalPause);
  }

  try {
    clearExecuteContext();
  } catch (err) {
    console.warn("[AAMS][execute] 컨텍스트 정리 실패:", err);
  }
  window.onbeforeunload = null;
  location.hash = target || "#/user";
}

function enableExit({ label = "사용자 페이지로 돌아가기", autoDelay = 90000 } = {}) {
  if (!exitBtn || lockdownActive) return;
  exitBtn.hidden = false;
  exitBtn.disabled = false;
  exitBtn.textContent = label;
  if (exitAutoTimer) {
    clearTimeout(exitAutoTimer);
    exitAutoTimer = null;
  }
  if (typeof autoDelay === "number" && autoDelay > 0) {
    exitAutoTimer = setTimeout(() => {
      powerDownAndExit();
    }, autoDelay);
  }
}

async function handleFailure(context, title, error, { stage = "dispatch-failed", actorId = null, job = null } = {}) {
  const message = extractErrorMessage(error);
  console.error("[AAMS][execute]", stage, error);
  updateStage(stage, title, message, { level: "error", expression: "sad" });
  
  clearInteraction(null, { persist: true });

  let current = context || loadExecuteContext() || {};
  if (current.requestId) {
    executeContext = updateExecuteContext((prev) => ({ ...prev, state: "failed", error: message }));
    if (!current.failureReported) {
      try {
        await markDispatchFailure({ requestId: current.requestId, reason: message, actorId });
        executeContext = updateExecuteContext((prev) => ({ ...prev, failureReported: true }));
      } catch (reportErr) {
        console.warn("[AAMS][execute] 오류 보고 실패:", reportErr);
      }
    }
    invalidateRequestDetail(current.requestId);
  }

  if (stage === "lockdown" || job?.stage === "lockdown" || job?.result?.lockdown) {
    const lockdownPayload = job?.result?.lockdown || (job?.progress?.event === "lockdown" ? job.progress : null) || {
      stage: job?.stage || stage,
      message,
      reason: job?.error || message
    };
    enterLockdown({
      ...lockdownPayload,
      active: true,
      requestId: current.requestId || null,
      triggeredAt: Date.now()
    });
  }

  enableExit({ autoDelay: 90000 });
}

function extractErrorMessage(err) {
  if (!err) return "알 수 없는 오류";
  if (typeof err === "string") return err;
  const message = err.message || String(err);
  const match = message.match(/HTTP\s+\d+\s*:\s*(.+)$/i);
  if (match) {
    const tail = match[1].trim();
    try {
      const parsed = JSON.parse(tail);
      if (parsed && typeof parsed === "object") {
        return parsed.error || parsed.message || message;
      }
    } catch (_) {
      return tail;
    }
    return tail;
  }
  return message;
}

function sanitizeExecutor(executor = {}) {
  if (!executor || typeof executor !== "object") return null;
  const cleaned = {
    id: executor.id || executor.user_id || null,
    name: executor.name || null,
    rank: executor.rank || null,
    unit: executor.unit || executor.unit_name || null
  };
  Object.keys(cleaned).forEach((key) => {
    if (cleaned[key] === undefined || cleaned[key] === null) delete cleaned[key];
  });
  return Object.keys(cleaned).length ? cleaned : null;
}
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function idx(row, col) {
  return row * DOT_COLS + col;
}

function mergeInto(target, source) {
  if (!source) return;
  if (source instanceof Set) {
    source.forEach((value) => target.add(value));
    return;
  }
  if (Array.isArray(source)) {
    source.forEach((value) => {
      if (typeof value === "number" && value >= 0 && value < DOT_COUNT) {
        target.add(value);
      }
    });
  }
}

function shouldSuppressStatusMessage(message, job = {}) {
  const normalized = normalizeText(message);
  if (!normalized) return false;
  const stage = String(job.stage || "").toLowerCase();
  if (!stage || stage.includes("dispatch") || stage.includes("initialize")) return false;
  if (FAILURE_STAGES.has(job.stage)) return false;
  return GENERIC_STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function rectCoords(row, col, height, width) {
  const coords = [];
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr >= 0 && rr < DOT_ROWS && cc >= 0 && cc < DOT_COLS) {
        coords.push(idx(rr, cc));
      }
    }
  }
  return coords;
}

function coordsIndices(points) {
  const coords = [];
  for (const [row, col] of points) {
    if (row >= 0 && row < DOT_ROWS && col >= 0 && col < DOT_COLS) {
      coords.push(idx(row, col));
    }
  }
  return coords;
}

function normalizeExtra(extra) {
  if (!extra) return null;
  if (Array.isArray(extra)) {
    if (!extra.length) return null;
    const points = [];
    extra.forEach((value) => {
      if (typeof value === "number") {
        if (value >= 0 && value < DOT_COUNT) points.push(value);
      } else if (Array.isArray(value) && value.length >= 2) {
        points.push(...coordsIndices([value]));
      }
    });
    return points.length ? { points, accent: false } : null;
  }
  if (typeof extra === "object") {
    if (Array.isArray(extra.points)) {
      const filtered = extra.points.filter((value) => typeof value === "number" && value >= 0 && value < DOT_COUNT);
      if (filtered.length) {
        return { points: filtered, accent: !!extra.accent };
      }
    }
    if (Array.isArray(extra.coords)) {
      const converted = coordsIndices(extra.coords);
      if (converted.length) {
        return { points: converted, accent: !!extra.accent };
      }
    }
  }
  return null;
}

function createExpression({
  leftEye = "open",
  rightEye = "open",
  leftPupil = "center",
  rightPupil = "center",
  extras = []
} = {}) {
  const on = new Set();
  const accent = new Set();

  const leftEyePixels = buildEye(LEFT_EYE, leftEye);
  const rightEyePixels = buildEye(RIGHT_EYE, rightEye);
  mergeInto(on, leftEyePixels);
  mergeInto(on, rightEyePixels);

  const leftPupilPixels = buildPupil(LEFT_EYE, leftPupil);
  const rightPupilPixels = buildPupil(RIGHT_EYE, rightPupil);
  mergeInto(accent, leftPupilPixels);
  mergeInto(accent, rightPupilPixels);
  mergeInto(on, leftPupilPixels);
  mergeInto(on, rightPupilPixels);

  const extraList = Array.isArray(extras) ? extras : [extras];
  extraList.forEach((extra) => {
    const normalized = normalizeExtra(extra);
    if (!normalized) return;
    mergeInto(on, normalized.points);
    if (normalized.accent) {
      mergeInto(accent, normalized.points);
    }
  });

  return Object.freeze({ on, accent });
}

function buildEye(anchor, mode = "open") {
  const { row, col } = anchor;
  if (mode === "closed") {
    return rectCoords(row + Math.floor(EYE_HEIGHT / 2), col, 1, EYE_WIDTH);
  }
  let height = EYE_HEIGHT;
  let top = row;
  let verticalScale = 1;
  if (mode === "soft") {
    height = Math.max(6, Math.floor(EYE_HEIGHT * 0.85));
    top = row + Math.floor((EYE_HEIGHT - height) / 2);
    verticalScale = 1.15;
  } else if (mode === "narrow") {
    height = Math.max(4, Math.floor(EYE_HEIGHT * 0.55));
    top = row + Math.floor((EYE_HEIGHT - height) / 2);
    verticalScale = 0.85;
  }
  return ellipseIndices(top, col, EYE_WIDTH, height, { verticalScale });
}

function ellipseIndices(top, col, width, height, { verticalScale = 1 } = {}) {
  const coords = [];
  const rx = width / 2;
  const ry = height / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const normX = (x + 0.5 - rx) / rx;
      const normY = (y + 0.5 - ry) / (ry * verticalScale || 1);
      if (normX * normX + normY * normY <= 1) {
        const rr = top + y;
        const cc = col + x;
        if (rr >= 0 && rr < DOT_ROWS && cc >= 0 && cc < DOT_COLS) {
          coords.push(idx(rr, cc));
        }
      }
    }
  }
  return coords;
}

function buildPupil(anchor, direction = "center") {
  const { row, col } = anchor;
  if (direction === "none") return [];
  const centerRow = row + Math.floor(EYE_HEIGHT / 2) - Math.floor(PUPIL_HEIGHT / 2);
  const centerCol = col + Math.floor((EYE_WIDTH - PUPIL_WIDTH) / 2);
  let targetRow = centerRow;
  let targetCol = centerCol;
  if (direction === "left") targetCol = col + 2;
  if (direction === "right") targetCol = col + EYE_WIDTH - PUPIL_WIDTH - 2;
  if (direction === "up") targetRow = row + 2;
  if (direction === "down") targetRow = row + EYE_HEIGHT - PUPIL_HEIGHT - 2;
  return rectCoords(targetRow, targetCol, PUPIL_HEIGHT, PUPIL_WIDTH);
}

function handleRobotEvent(eventMessage) {
  if (!eventMessage || eventMessage.type !== "ROBOT_EVENT") return;
  const job = eventMessage.job || {};
  const requestId = eventMessage.requestId ?? job.requestId ?? job.request_id ?? null;
  const current = executeContext || loadExecuteContext() || {};
  if (current.requestId && requestId && String(requestId) !== String(current.requestId)) {
    return;
  }

  const progress = job.progress || {};
  const eventType = progress.event || null;
  const updates = { lastRobotEvent: { job, receivedAt: Date.now(), requestId: current.requestId || requestId || null } };

  if (eventType === "await_user" && !lockdownActive) {
    const interaction = {
      stage: progress.stage || job.stage || "await_user",
      message: progress.message || job.message || "사용자 입력 대기",
      token: progress.token || null,
      allowCancel: !!progress.allowCancel,
      requestId: current.requestId || requestId || null,
      meta: progress.meta || null,
      receivedAt: Date.now()
    };
    showInteraction(interaction);
    updates.interaction = interaction;
  }

  if (eventType === "await_user_done") {
    clearInteraction(progress);
    updates.interaction = null;
  }

  if (eventType === "lockdown" || job.stage === "lockdown") {
    const lockdownPayload = {
      stage: progress.stage || job.stage || "lockdown",
      message: progress.message || job.message || "탄약 변동 감지",
      reason: progress.reason || job.error || eventMessage.error || "lockdown",
      meta: progress.meta || null,
      requestId: current.requestId || requestId || null,
      active: true,
      triggeredAt: Date.now()
    };
    enterLockdown(lockdownPayload);
    updates.lockdown = lockdownPayload;
  }

  if (!lockdownActive) {
    const statusMessage = progress.message || job.message || null;
    const level = progress.level || job.progress?.level || null;
    if (statusMessage && !shouldSuppressStatusMessage(statusMessage, job)) {
      setStatus("동작", statusMessage, level || "info");
    }
  }

  if (Object.keys(updates).length) {
    executeContext = updateExecuteContext((prev) => ({ ...prev, ...updates }));
  }
}

function handleLockdownStatus(message) {
  if (!message) return;
  if (message.site && message.site !== SITE) return;
  const payload = normalizeLockdownPayload(message);
  if (payload.active) {
    enterLockdown(payload);
  } else {
    exitLockdown(payload);
  }
}

function showInteraction(interaction, { persist = true } = {}) {
  if (!interaction || lockdownActive) return;
  if (!interaction.token) {
    console.warn("[AAMS][execute] 토큰이 없는 상호작용 요청을 무시합니다.", interaction);
    return;
  }
  const normalized = {
    ...interaction,
    active: true,
    updatedAt: Date.now()
  };
  currentInteraction = normalized;
  if (screenEl) {
    screenEl.setAttribute("data-interaction", interaction.stage || "await");
  }
  const rawMessage = normalizeText(interaction.message);
  const message = rawMessage && rawMessage.trim() ? rawMessage.trim() : "사용자 확인이 필요합니다.";
  const rawButtonLabel = normalizeText(
    (interaction.meta && interaction.meta.buttonLabel)
      || interaction.buttonLabel
      || "준비 완료"
  );
  const buttonLabel = rawButtonLabel && rawButtonLabel.trim() ? rawButtonLabel.trim() : "준비 완료";

  if (actionText) {
    actionText.textContent = message;
  }
  if (actionButton) {
    actionButton.disabled = false;
    actionButton.textContent = buttonLabel;
  }
  if (actionContainer) {
    if (message || buttonLabel) {
      actionContainer.hidden = false;
      actionContainer.removeAttribute("hidden");
    } else {
      actionContainer.hidden = true;
      actionContainer.setAttribute("hidden", "");
    }
  }
  if (persist) {
    executeContext = updateExecuteContext((prev) => ({ ...prev, interaction: normalized }));
  }
}

function clearInteraction(progress, { persist = true } = {}) {
  currentInteraction = null;
  if (screenEl) {
    screenEl.removeAttribute("data-interaction");
  }
  if (actionContainer) {
    actionContainer.hidden = true;
    actionContainer.setAttribute("hidden", "");
  }
  if (actionButton) {
    actionButton.disabled = false;
    actionButton.textContent = "";
  }
  if (actionText) {
    actionText.textContent = "";
  }
  if (persist) {
    executeContext = updateExecuteContext((prev) => ({ ...prev, interaction: null }));
  }
}

function handleInteractionClick() {
  if (!currentInteraction || lockdownActive) return;
  if (!currentInteraction.token) {
    console.warn("[AAMS][execute] 상호작용 토큰이 없습니다.");
    return;
  }
  if (actionButton) {
    actionButton.disabled = true;
    actionButton.textContent = "전송 중…";
  }
  const context = executeContext || loadExecuteContext() || {};
  sendWebSocketMessage({
    type: "ROBOT_INTERACTION",
    requestId: context.requestId || currentInteraction.requestId || null,
    token: currentInteraction.token,
    stage: currentInteraction.stage,
    action: "resume",
    meta: { source: "execute-ui", sentAt: Date.now() }
  });
}

function enterLockdown(lockdown, { persist = true } = {}) {
  const payload = normalizeLockdownPayload(lockdown || {});
  payload.active = true;
  payload.requestId = payload.requestId || (executeContext && executeContext.requestId) || null;
  clearInteraction(null, { persist });
  lockdownActive = true;
  lockdownState = payload;

  try {
    sessionStorage.setItem(LOCKDOWN_SESSION_FLAG, "1");
  } catch (err) {
    console.warn("[AAMS][execute] 락다운 세션 플래그 설정 실패:", err);
  }

  stopAmbientMessages();
  stopAmbientAnimations();
  setBaseExpression("sad");
  applyExpression("sad");

  setLockdownGuard();
  document.body.classList.add("lockdown-mode");

  if (screenEl) {
    screenEl.dataset.scene = "active";
    screenEl.setAttribute("data-lockdown", "true");
    screenEl.removeAttribute("data-interaction");
  }
  if (exitBtn) {
    exitBtn.hidden = true;
    exitBtn.disabled = true;
  }
  if (actionContainer) {
    actionContainer.hidden = true;
  }
  if (lockdownButton) {
    lockdownButton.disabled = false;
    lockdownButton.textContent = "락 해제 (관리자)";
  }

  const alertText = `${lockdownState.message}\n비상. 정책에 의거하여 시스템을 락다운합니다.`;
  setStatus("비상", alertText, "error");

  if (lockdownContainer) {
    lockdownContainer.hidden = false;
  }
  if (lockdownText) {
    lockdownText.textContent = normalizeText(alertText);
  }

  window.onbeforeunload = () => "시스템이 락다운 상태입니다. 관리자 승인이 필요합니다.";

  if (persist) {
    executeContext = updateExecuteContext((prev) => ({ ...prev, lockdown: lockdownState, interaction: null }));
  }
}

function exitLockdown(payload = {}, { persist = true } = {}) {
  const previousState = lockdownState || {};
  const wasActive = !!previousState.active;
  const normalized = normalizeLockdownPayload({ ...lockdownState, ...payload, active: false });
  lockdownActive = false;
  lockdownState = normalized;

  clearLockdownGuard();
  window.onbeforeunload = null;
  sessionStorage.removeItem(LOCKDOWN_SESSION_FLAG);
  document.body.classList.remove("lockdown-mode");

  if (screenEl) {
    screenEl.removeAttribute("data-lockdown");
    screenEl.removeAttribute("data-interaction");
  }
  if (lockdownContainer) {
    lockdownContainer.hidden = true;
  }
  if (lockdownButton) {
    lockdownButton.disabled = true;
  }
  if (exitBtn) {
    exitBtn.hidden = false;
    exitBtn.disabled = false;
  }
  if (actionContainer) {
    actionContainer.hidden = true;
  }
  if (actionButton) {
    actionButton.disabled = false;
  }

  clearInteraction(null, { persist });

  const statusMessage = payload.clearedMessage
    || payload.clearMessage
    || (payload.message && payload.message !== previousState.message ? payload.message : null)
    || "락다운이 해제되었습니다.";
  setStatus("해제", statusMessage, "success");
  if (persist) {
    executeContext = updateExecuteContext((prev) => ({ ...prev, lockdown: null }));
  }
  const explicitRedirect = payload.redirect === true;
  const preventRedirect = payload.redirect === false;
  const shouldRedirect = !preventRedirect && (payload.forceRedirect || explicitRedirect || wasActive);
  if (shouldRedirect) {
    Promise.resolve().then(() => {
      powerDownAndExit({ immediate: true, target: "#/fp-user" }).catch((err) => {
        console.warn("[AAMS][execute] 락다운 해제 후 이동 실패", err);
      });
    });
  }
}

function handleLockdownUnlock() {
  if (!lockdownActive) return;
  if (lockdownButton) {
    lockdownButton.disabled = true;
    lockdownButton.textContent = "관리자 인증 이동 중…";
  }
  executeContext = updateExecuteContext((prev) => ({
    ...prev,
    lockdown: { ...(prev.lockdown || lockdownState || {}), acknowledgedAt: Date.now(), acknowledged: true }
  }));
  sessionStorage.setItem(LOCKDOWN_SESSION_FLAG, "1");
  allowLockdownAdminAccess();
  if (normalizeHashTarget(location.hash) !== "#/fp-admin") {
    location.hash = "#/fp-admin";
  }
}