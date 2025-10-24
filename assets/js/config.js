(function(){
  const DEFAULT_API_BASE = "https://aams-api.onrender.com";
  const guessLocalFpBase = (() => {
    try {
      const loc = window?.location;
      if (!loc) return "";
      if (loc.protocol === "http:" && loc.origin && loc.origin !== "null") {
        return loc.origin;
      }
    } catch (err) {
      console.warn("[AAMS][config] FP 기본 경로 추정 실패", err);
    }
    return "";
  })();
  const DEFAULT_FP_BASE = guessLocalFpBase || "http://127.0.0.1:8790";

  const initialConfig = (typeof window.AAMS_CONFIG === "object" && window.AAMS_CONFIG) || {};
  const config = {
    API_BASE: initialConfig.API_BASE || DEFAULT_API_BASE,
    LOCAL_FP_BASE: initialConfig.LOCAL_FP_BASE || DEFAULT_FP_BASE
  };

  let storageWarned = false;
  const warnStorage = (action, err) => {
    if (storageWarned) return;
    storageWarned = true;
    if (err) {
      console.warn(`[AAMS][config] localStorage ${action} 실패`, err);
    } else {
      console.warn(`[AAMS][config] localStorage ${action} 실패`);
    }
  };

  const readStorage = (key) => {
    try {
      const value = localStorage.getItem(key);
      return value == null ? "" : value;
    } catch (err) {
      warnStorage("read", err);
      return "";
    }
  };

  const writeStorage = (key, value) => {
    try {
      if (value == null || value === "") {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    } catch (err) {
      warnStorage("write", err);
    }
  };

  const params = new URLSearchParams(window.location.search || "");
  const overrideApi = (params.get("api_base") || params.get("api") || "").trim();
  const overrideFp = (params.get("fp_base") || params.get("fp") || params.get("local_fp") || "").trim();
  const resetFp = params.get("reset_fp") || params.get("clear_fp");
  const resetApi = params.get("reset_api") || params.get("clear_api");

  const storedApi = readStorage("AAMS_API_BASE").trim();
  const storedFp = readStorage("AAMS_FP_LOCAL_BASE").trim();

  if (resetApi) {
    writeStorage("AAMS_API_BASE", null);
  }
  if (resetFp) {
    writeStorage("AAMS_FP_LOCAL_BASE", null);
  }

  if (overrideApi) {
    config.API_BASE = overrideApi;
    writeStorage("AAMS_API_BASE", overrideApi);
  } else if (storedApi) {
    config.API_BASE = storedApi;
  }

  if (overrideFp) {
    config.LOCAL_FP_BASE = overrideFp;
    writeStorage("AAMS_FP_LOCAL_BASE", overrideFp);
  } else if (storedFp) {
    config.LOCAL_FP_BASE = storedFp;
  }

  if (!config.API_BASE) {
    config.API_BASE = DEFAULT_API_BASE;
  }
  if (!config.LOCAL_FP_BASE) {
    config.LOCAL_FP_BASE = DEFAULT_FP_BASE;
  }

  window.AAMS_CONFIG = config;
  window.FP_LOCAL_BASE = config.LOCAL_FP_BASE;
  window.FP_SITE = window.FP_SITE || "site-01";

  if (overrideFp) {
    try {
      sessionStorage.setItem("AAMS_FP_LOCAL_BASE_SOURCE", "query");
    } catch {}
  }
})();