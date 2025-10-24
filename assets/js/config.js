(function () {
  const DEFAULT_API_BASE = 'https://aams-api.onrender.com';
  const DEFAULT_FP_BASE = '';

  const STORAGE_KEYS = {
    API: 'AAMS_API_BASE',
    FP: 'AAMS_FP_LOCAL_BASE',
    FP_SOURCE: 'AAMS_FP_LOCAL_BASE_SOURCE'
  };

  function sanitizeHttpsUrl(value, { allowHttp = false } = {}) {
    if (!value) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      console.warn('[AAMS][config] 잘못된 URL 무시됨:', raw);
      return '';
    }
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'https:') {
      // ok
    } else if (allowHttp && protocol === 'http:') {
      console.warn('[AAMS][config] 개발용 HTTP 주소 사용:', raw);
    } else {
      console.warn('[AAMS][config] HTTPS가 아닌 주소 무시됨:', raw);
      return '';
    }

    parsed.hash = '';
    parsed.search = '';
    const origin = parsed.origin;
    if (!origin) return '';
    const pathname = parsed.pathname.replace(/\/$/, '');
    return `${origin}${pathname}`;
  }

  function readMeta(name) {
    if (typeof document === 'undefined') return '';
    const el = document.querySelector(`meta[name="${name}"]`);
    if (!el) return '';
    const value = el.getAttribute('content');
    return value ? value.trim() : '';
  }

  let storageWarned = false;
  function warnStorage(action, err) {
    if (storageWarned) return;
    storageWarned = true;
    if (err) {
      console.warn(`[AAMS][config] localStorage ${action} 실패`, err);
    } else {
      console.warn(`[AAMS][config] localStorage ${action} 실패`);
    }
  }

  function readStorage(key) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? '' : value;
    } catch (err) {
      warnStorage('read', err);
      return '';
    }
  }

  function writeStorage(key, value) {
    try {
      if (value == null || value === '') {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    } catch (err) {
      warnStorage('write', err);
    }
  }

  const params = new URLSearchParams(window.location.search || '');
  const overrideApi = (params.get('api_base') || params.get('api') || '').trim();
  const overrideFp = (params.get('fp_base') || params.get('fp') || params.get('local_fp') || '').trim();
  const resetFp = params.get('reset_fp') || params.get('clear_fp');
  const resetApi = params.get('reset_api') || params.get('clear_api');

  const initialConfig = (typeof window.AAMS_CONFIG === 'object' && window.AAMS_CONFIG) || {};

  if (resetApi) {
    writeStorage(STORAGE_KEYS.API, null);
  }
  if (resetFp) {
    writeStorage(STORAGE_KEYS.FP, null);
    try {
      sessionStorage.removeItem(STORAGE_KEYS.FP_SOURCE);
    } catch (_) {}
  }

  const config = {
    API_BASE: DEFAULT_API_BASE,
    LOCAL_FP_BASE: DEFAULT_FP_BASE
  };

  let manualApiLocked = false;
  let manualFpLocked = false;

  function setApiBase(candidate, { persist = false, source = 'unknown', force = false } = {}) {
    const sanitized = sanitizeHttpsUrl(candidate);
    if (!sanitized) return false;
    if (!force && manualApiLocked && config.API_BASE && config.API_BASE !== sanitized) {
      return false;
    }
    if (config.API_BASE !== sanitized) {
      config.API_BASE = sanitized;
    }
    if (persist) {
      writeStorage(STORAGE_KEYS.API, sanitized);
      manualApiLocked = true;
    }
    window.AAMS_PUBLIC_API_BASE = sanitized;
    return true;
  }

  function setFpBase(candidate, { persist = false, source = 'unknown', force = false } = {}) {
    const sanitized = sanitizeHttpsUrl(candidate);
    if (!sanitized) {
      if (candidate) {
        console.warn('[AAMS][config] LOCAL_FP_BASE 설정 무시됨(HTTPS 필수):', candidate, source);
      }
      return false;
    }
    if (!force && manualFpLocked && config.LOCAL_FP_BASE && config.LOCAL_FP_BASE !== sanitized) {
      return false;
    }
    if (config.LOCAL_FP_BASE !== sanitized) {
      config.LOCAL_FP_BASE = sanitized;
    }
    if (persist) {
      writeStorage(STORAGE_KEYS.FP, sanitized);
      manualFpLocked = true;
      try {
        sessionStorage.setItem(STORAGE_KEYS.FP_SOURCE, source);
      } catch (_) {}
    }
    window.FP_LOCAL_BASE = sanitized;
    return true;
  }

  function applyStoredValues() {
    const storedApi = readStorage(STORAGE_KEYS.API).trim();
    if (storedApi) {
      if (setApiBase(storedApi, { persist: false, source: 'storage', force: true })) {
        manualApiLocked = true;
      }
    }
    const storedFp = readStorage(STORAGE_KEYS.FP).trim();
    if (storedFp) {
      if (setFpBase(storedFp, { persist: false, source: 'storage', force: true })) {
        manualFpLocked = true;
      }
    }
  }

  function applyMeta() {
    const metaApi = readMeta('aams-api-base');
    if (metaApi) {
      setApiBase(metaApi, { persist: false, source: 'meta' });
    }
    const metaFp = readMeta('aams-fp-base');
    if (metaFp) {
      setFpBase(metaFp, { persist: false, source: 'meta' });
    }
  }

  function applyInitialConfig() {
    if (initialConfig.API_BASE) {
      setApiBase(initialConfig.API_BASE, { source: 'initial' });
    }
    if (initialConfig.LOCAL_FP_BASE) {
      setFpBase(initialConfig.LOCAL_FP_BASE, { source: 'initial' });
    }
  }

  function applyQueryOverrides() {
    if (overrideApi) {
      if (setApiBase(overrideApi, { persist: true, source: 'query', force: true })) {
        manualApiLocked = true;
      }
    }
    if (overrideFp) {
      if (setFpBase(overrideFp, { persist: true, source: 'query', force: true })) {
        manualFpLocked = true;
      }
    }
  }

  function applyEnv(env, { source = 'env', allowOverride = false } = {}) {
    if (!env || typeof env !== 'object') return;
    const api = env.API_BASE || env.VITE_API_URL || env.VITE_APP_API_URL || env.VITE_PUBLIC_API_URL;
    if (api) {
      const force = allowOverride || !manualApiLocked;
      setApiBase(api, { source, force });
    }
    const fp = env.LOCAL_FP_BASE || env.VITE_FP_BASE || env.VITE_LOCAL_FP_URL || env.VITE_PUBLIC_FP_URL;
    if (fp) {
      const force = allowOverride || !manualFpLocked;
      const applied = setFpBase(fp, { source, force });
      if (applied && !manualFpLocked && !allowOverride) {
        window.dispatchEvent(
          new CustomEvent('aams:local-base-change', { detail: { base: config.LOCAL_FP_BASE, source: 'env' } })
        );
      }
    }
    if (env.FP_SITE) {
      window.FP_SITE = String(env.FP_SITE).trim() || window.FP_SITE;
    }
  }

  applyInitialConfig();
  applyMeta();
  applyStoredValues();
  applyQueryOverrides();

  if (!config.API_BASE) {
    setApiBase(DEFAULT_API_BASE, { source: 'default' });
  }
  if (!config.LOCAL_FP_BASE && DEFAULT_FP_BASE) {
    setFpBase(DEFAULT_FP_BASE, { source: 'default' });
  }

  function joinApiUrl(base, path) {
    if (!base) return '';
    const trimmed = base.replace(/\/+$/, '');
    return `${trimmed}${path}`;
  }

  async function fetchRemoteEnv() {
    const base = config.API_BASE || DEFAULT_API_BASE;
    const sanitizedBase = sanitizeHttpsUrl(base);
    if (!sanitizedBase) return;
    const params = new URLSearchParams();
    if (window.FP_SITE) {
      params.set('site', String(window.FP_SITE));
    }
    const suffix = params.toString();
    const url = joinApiUrl(sanitizedBase, `/api/tab/env.json${suffix ? `?${suffix}` : ''}`);
    try {
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) {
        return;
      }
      const payload = await res.json().catch(() => null);
      if (payload?.env) {
        applyEnv(payload.env, { source: 'remote-env' });
      }
      if (Array.isArray(payload?.bridge?.hints) && payload.bridge.hints.length) {
        window.AAMS_BRIDGE_HINTS = payload.bridge.hints.slice(0, 8);
      }
    } catch (err) {
      console.warn('[AAMS][config] 원격 환경 정보 로드 실패', err);
    }
  }

  window.AAMS_CONFIG = config;
  window.FP_LOCAL_BASE = config.LOCAL_FP_BASE;
  window.FP_SITE = window.FP_SITE || 'site-01';

  window.__applyAamsEnv = function applyAamsEnv(env) {
    applyEnv(env);
  };

  if (window.__AAMS_ENV__) {
    applyEnv(window.__AAMS_ENV__);
  }

  fetchRemoteEnv();
})();
