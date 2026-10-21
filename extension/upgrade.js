/* Reads only a bundled local release marker. No remote executable code is downloaded. */
globalThis.RadarUpgrade = (() => {
  async function ensure(backend) {
    if (!chrome.runtime.getManifest || !chrome.runtime.reload || typeof fetch !== "function") return false;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    let release;
    try {
      const response = await fetch(chrome.runtime.getURL("release.json"), { cache: "no-store", signal: controller.signal });
      if (!response.ok) return false;
      release = await response.json();
    } catch { return false; }
    finally { clearTimeout(timer); }
    if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^[\w-]{1,80}$/.test(release.buildId)) return false;
    const version = chrome.runtime.getManifest().version;
    const backendMatches = !backend || backend.buildId === release.buildId;
    if (version === release.version && backendMatches) return false;
    const current = await chrome.storage.local.get(["runtimeUpdateAttempt"]);
    if (current.runtimeUpdateAttempt?.buildId === release.buildId && Date.now() - current.runtimeUpdateAttempt.at < 60000) {
      throw Error("新版尚未完成启动，请稍等后刷新工作台；已保存的资料仍在本机。");
    }
    const allowedView = ["jobs", "applications", "profile", "sources"].includes(location.hash.slice(1)) ? location.hash : "#jobs";
    await chrome.storage.local.set({ pendingRuntimeUpdate: { version: release.version, buildId: release.buildId,
      returnUrl: chrome.runtime.getURL("dashboard.html") + allowedView },
      runtimeUpdateAttempt: { buildId: release.buildId, at: Date.now() } });
    const message = document.querySelector("#notice");
    if (message) message.textContent = `正在升级到 ${release.version}，将自动恢复工作台…`;
    chrome.runtime.reload();
    return true;
  }
  return { ensure };
})();
