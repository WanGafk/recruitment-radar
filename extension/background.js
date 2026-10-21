importScripts("shared.js", "sources.js");
const R = Radar, S = RadarSources;
let ready;
let scanTask = null;
let queuedProfileScan = false;
let writes = Promise.resolve();
const serialWrite = (fn) => { const task = writes.then(fn); writes = task.catch(() => {}); return task; };

async function initialize() {
  if (ready) return ready;
  ready = (async () => {
    const data = await chrome.storage.local.get(null);
    if (data.schemaVersion !== 2) {
      const old = Array.isArray(data.matches) ? data.matches : [];
      const legacy = old.map((j) => ({ ...j, id: R.hash(R.canonical(j.detailUrl)), detailUrl: R.canonical(j.detailUrl),
        company: /^(智联|BOSS|前程无忧|国聘)$/.test(j.company) ? "" : j.company,
        sourceIds: [j.sourceId], description: j.summary || "", legacy: true, kind: "job",
        publishedAt: null, updatedAt: null, lastCheckedAt: null, detailVerified: false })).filter((j) => j.detailUrl);
      const sources = [...R.SOURCES];
      for (const oldSource of data.sources || []) {
        const preset = sources.find((s) => s.id === oldSource.id);
        if (preset) continue;
        sources.push({ ...oldSource, id: oldSource.id || R.hash(oldSource.url), adapter: "manual", enabled: false });
      }
      await chrome.storage.local.set({ schemaVersion: 2, sourceCatalogVersion: R.SOURCE_CATALOG, profile: R.profile(data.profile), sources,
        jobs: R.mergeJobs([], legacy), applications: data.applications || {}, sourceStatus: {}, scanLogs: [],
        scan: null, lastSuccessAt: null, intervalMinutes: Number(data.intervalMinutes) || 30 });
    } else if (data.scan?.running) {
      await chrome.storage.local.set({ scan: { ...data.scan, running: false, outcome: "interrupted",
        error: "上次扫描被浏览器中断，请重新检查；旧记录不代表本次已更新。", completedAt: new Date().toISOString() },
        sourceStatus: Object.fromEntries(Object.entries(data.sourceStatus || {}).map(([id, status]) => [id,
          status.running ? { ...status, running: false, ok: false, message: "上次读取被中断，请重新检查" } : status])) });
    }
    if (data.schemaVersion === 2 && data.sourceCatalogVersion !== R.SOURCE_CATALOG) {
      const oldSources = data.sources || [];
      const sources = R.SOURCES.map((preset) => ({ ...preset, ...(oldSources.find((s) => s.id === preset.id) ? { enabled: Boolean(oldSources.find((s) => s.id === preset.id).enabled) } : {}) }));
      sources.push(...oldSources.filter((s) => !sources.some((preset) => preset.id === s.id)));
      const jobs = (data.jobs || []).map((j) => /\/student\/company\/(?:-|null|undefined|0)\//i.test(j.companyUrl || "") ? { ...j, companyUrl: "" } : j);
      await chrome.storage.local.set({ sources, jobs, sourceCatalogVersion: R.SOURCE_CATALOG });
    }
    const accessState = await chrome.storage.local.get(["jobs", "applications", "applyAccessSchema"]);
    if (accessState.applyAccessSchema !== 1) {
      const migrateAccess = (job) => {
        if (!job || job.applyInfo || !job.detailVerified || !job.description || !job.detailCheckedAt) return job;
        const applyInfo = S.applicationInfo(job, "", job.detailUrl, job.description);
        applyInfo.checkedAt = job.detailCheckedAt;
        applyInfo.evidence = applyInfo.routes.length ? "从此前已读取的招聘正文提取投递方式；沿用原核实时间" : "此前正文未找到明确校外投递方式，需重新核实";
        return { ...job, applyInfo };
      };
      await chrome.storage.local.set({ jobs: (accessState.jobs || []).map(migrateAccess), applications: Object.fromEntries(Object.entries(accessState.applications || {}).map(([id, record]) => [id, { ...record, job: migrateAccess(record.job) }])), applyAccessSchema: 1 });
    }
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

async function resetAlarm() {
  const { intervalMinutes = 30 } = await chrome.storage.local.get("intervalMinutes");
  await chrome.alarms.clear("recruitment-radar-scan");
  await chrome.alarms.create("recruitment-radar-scan", { periodInMinutes: Math.max(15, Number(intervalMinutes) || 30), delayInMinutes: 1 });
}
async function resumeAfterUpdate() {
  const { pendingRuntimeUpdate } = await chrome.storage.local.get("pendingRuntimeUpdate");
  if (!pendingRuntimeUpdate || pendingRuntimeUpdate.buildId !== R.BUILD_ID) return;
  const base = chrome.runtime.getURL("dashboard.html");
  let hash = "#jobs";
  try {
    const requested = new URL(pendingRuntimeUpdate.returnUrl);
    if (requested.origin === new URL(base).origin && requested.pathname === new URL(base).pathname &&
      ["#jobs", "#applications", "#profile", "#sources"].includes(requested.hash)) hash = requested.hash;
  } catch {}
  const returnUrl = `${base}?build=${encodeURIComponent(R.BUILD_ID)}${hash}`;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.filter((tab) => tab.url?.split(/[?#]/)[0] === base);
  if (existing.length) await Promise.all(existing.map((tab) => chrome.tabs.update(tab.id, { url: returnUrl })));
  else await chrome.tabs.create({ url: returnUrl });
  await chrome.storage.local.set({ pendingRuntimeUpdate: null, lastUpgrade: { version: R.VERSION, buildId: R.BUILD_ID, at: Date.now() } });
}
async function startRuntime() {
  await initialize();
  const results = await Promise.allSettled([resetAlarm(), resumeAfterUpdate()]);
  for (const result of results) if (result.status === "rejected") console.error(result.reason);
}
chrome.runtime.onInstalled.addListener(() => startRuntime().catch(console.error));
chrome.runtime.onStartup.addListener(() => startRuntime().catch(console.error));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "recruitment-radar-scan") startScan("all").catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  route(message).then(respond).catch((e) => respond({ ok: false, error: e.message }));
  return true;
});

async function route(message) {
  await initialize();
  if (message.type === "initialize") return { ok: true, version: R.VERSION, buildId: R.BUILD_ID };
  if (message.type === "scanNow") {
    const { profile } = await chrome.storage.local.get("profile");
    if (!R.profileReady(R.profile(profile))) throw Error("请先建立求职档案，至少填写一个目标岗位，再检查招聘。");
    const alreadyRunning = Boolean(scanTask);
    if (alreadyRunning && message.restartAfterCurrent) {
      queuedProfileScan = true;
      return { ok: true, started: false, queued: true, message: "资料已保存；当前检查结束后，将自动按新资料重新检索。" };
    }
    startScan("all").catch(console.error);
    return { ok: true, started: !alreadyRunning, message: alreadyRunning ? "扫描已在进行，结果会逐项更新。" : "已开始联网检查，关闭弹窗后仍会继续。" };
  }
  if (message.type === "readCurrentPage") {
    if (scanTask) return { ok: false, error: "请等待当前扫描结束后读取当前网页。" };
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !R.safeUrl(tab.url)) throw Error("请先打开实际招聘网页；浏览器设置页和插件页面不能读取。");
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: S.collectPage });
    if (!injection?.result || injection.result.url !== tab.url) throw Error("网页发生跳转，请等岗位列表加载后重新读取。");
    startScan("current", injection.result).catch(console.error);
    return { ok: true, message: "正在解析当前网页；仅有链接但未公开日期的记录会标记待核实。" };
  }
  if (message.type === "openDashboard") {
    const base = chrome.runtime.getURL("dashboard.html");
    const hash = ["jobs", "applications", "profile", "sources"].includes(message.view) ? `#${message.view}` : "";
    const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url?.split(/[?#]/)[0] === base);
    if (tabs[0]) {
      const url = new URL(tabs[0].url); if (hash) url.hash = hash;
      await chrome.tabs.update(tabs[0].id, { active: true, ...(hash ? { url: url.href } : {}) });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else await chrome.tabs.create({ url: base + hash });
    return { ok: true };
  }
  if (message.type === "saveProfile") {
    const next = R.profile(message.profile);
    if (!R.profileReady(next)) throw Error("请至少填写一个目标岗位，例如会计、前端开发、机械工程师。");
    const intervalMinutes = [15, 30, 60, 180].includes(Number(message.intervalMinutes)) ? Number(message.intervalMinutes) : 30;
    await chrome.storage.local.set({ profile: next, intervalMinutes });
    let warning = "";
    try { await resetAlarm(); } catch { warning = "资料已保存，但自动检查计划暂未更新；仍可手动检查。"; }
    return { ok: true, profile: next, warning };
  }
  if (message.type === "saveSources") return serialWrite(async () => {
    if (scanTask) throw Error("正在检查来源，请等待本次结束后修改来源设置。");
    const { sources = [] } = await chrome.storage.local.get("sources");
    const patch = message.patch || {};
    const source = sources.find((s) => s.id === message.id);
    if (source) source.enabled = Boolean(patch.enabled);
    else if (R.safeUrl(patch.url)) {
      if (sources.some((s) => R.canonical(s.url) === R.canonical(patch.url))) throw Error("该来源已存在，请直接启用已有来源。");
      sources.push({ id: R.hash(patch.url), name: R.text(patch.name) || new URL(patch.url).hostname,
      url: R.safeUrl(patch.url), adapter: "html", enabled: true });
    }
    else throw Error("来源不存在或链接无效");
    await chrome.storage.local.set({ sources });
    return { ok: true };
  });
  if (message.type === "saveApplication") return serialWrite(async () => {
    const data = await chrome.storage.local.get(["jobs", "applications"]);
    const job = data.jobs?.find((j) => j.id === message.jobId) || data.applications?.[message.jobId]?.job;
    if (!job) throw Error("找不到对应岗位，请重新打开列表");
    if (!R.STAGES[message.stage]) throw Error("无效的求职阶段");
    const applications = data.applications || {}, previous = applications[job.id];
    const now = new Date().toISOString();
    applications[job.id] = { ...previous, job, stage: message.stage, createdAt: previous?.createdAt || now,
      updatedAt: now, interviewAt: message.interviewAt === undefined ? previous?.interviewAt || "" : R.text(message.interviewAt).slice(0, 80),
      notes: message.notes === undefined ? previous?.notes || "" : String(message.notes).slice(0, 6000),
      companyChecked: message.companyChecked === undefined ? Boolean(previous?.companyChecked) : Boolean(message.companyChecked),
      companyCheckedAt: message.companyChecked === false ? null : message.companyChecked === true && !previous?.companyChecked ? now : previous?.companyCheckedAt || null,
      history: [...(previous?.history || []), ...(previous?.stage !== message.stage ? [{ stage: message.stage, at: now }] : [])].slice(-50) };
    await chrome.storage.local.set({ applications });
    return { ok: true };
  });
  if (message.type === "refreshDetail") {
    if (scanTask) throw Error("正在扫描，请等待完成后核实详情");
    const { jobs = [], applications = {}, profile } = await chrome.storage.local.get(["jobs", "applications", "profile"]);
    const job = jobs.find((j) => j.id === message.jobId) || applications[message.jobId]?.job;
    if (!job) throw Error("岗位不存在");
    const response = await S.request(job.detailUrl);
    const enriched = S.enrichResponse(job, response.content, response.url);
    return serialWrite(async () => {
      if (scanTask) throw Error("招聘检查已开始，请等待结束后再核实单条详情。");
      const latest = await chrome.storage.local.get(["jobs", "applications"]);
      const updated = { ...job, ...enriched, detailError: enriched.detailError || "", legacy: false, lastCheckedAt: new Date().toISOString() };
      const patch = { jobs: R.mergeJobs([updated], latest.jobs || []) };
      if (latest.applications?.[job.id]) patch.applications = { ...latest.applications, [job.id]: { ...latest.applications[job.id], job: updated } };
      await chrome.storage.local.set(patch);
      return { ok: true, assessment: R.assess(updated, R.profile(profile)) };
    });
  }
  if (message.type === "reportApplyAccess") return serialWrite(async () => {
    const state = await chrome.storage.local.get(["jobs", "applications", "accessReports"]);
    if (!state.jobs?.some((j) => j.id === message.jobId) && !state.applications?.[message.jobId]) throw Error("找不到对应岗位");
    if (!["school-login", "unavailable", "clear"].includes(message.status)) throw Error("不支持的入口反馈类型");
    const accessReports = { ...(state.accessReports || {}) };
    if (message.status === "clear") delete accessReports[message.jobId];
    else accessReports[message.jobId] = { status: message.status, at: new Date().toISOString() };
    await chrome.storage.local.set({ accessReports });
    return { ok: true };
  });
  if (message.type === "restoreBackup") return serialWrite(async () => {
    if (scanTask) throw Error("请等待当前招聘检查结束后恢复备份。");
    const backup = message.payload;
    if (backup?.schemaVersion !== 2 || !Array.isArray(backup.jobs) || !backup.applications || typeof backup.applications !== "object" || Array.isArray(backup.applications)) throw Error("请选择招聘雷达 2.x 导出的 JSON 备份。");
    if (JSON.stringify(backup).length > 10 * 1024 * 1024 || backup.jobs.length > 1200 || Object.keys(backup.applications).length > 2000) throw Error("备份超过恢复容量，请分开整理后重试。");
    function clean(raw) {
      if (!raw || typeof raw !== "object") return null;
      const fields = ["title", "company", "degree", "major", "location", "companyType", "companySize", "sourceLabel", "sourceType", "detailUrl", "publishedAt", "updatedAt", "deadline", "description", "detailCheckedAt", "firstSeenAt", "lastCheckedAt", "status", "kind", "salaryUnit", "salaryEvidence"];
      const value = Object.fromEntries(fields.filter((key) => typeof raw[key] === "string").map((key) => [key, raw[key].slice(0, key === "description" ? 18000 : 2000)]));
      for (const key of ["salaryLow", "salaryHigh"]) value[key] = Math.max(0, Number(raw[key]) || 0);
      value.intern = Boolean(raw.intern); value.detailVerified = Boolean(raw.detailVerified); value.companyUrl = R.safeUrl(raw.companyUrl);
      const job = R.normalizeJob(value, { id: R.text(raw.sourceId).slice(0, 100) || "backup", name: R.text(raw.sourceName).slice(0, 200) || "本机备份", url: R.safeUrl(raw.sourceUrl) }, raw.lastCheckedAt || null);
      if (job) job.legacy = Boolean(raw.legacy);
      return job;
    }
    const current = await chrome.storage.local.get(["jobs", "applications"]), applications = { ...(current.applications || {}) };
    const imported = backup.jobs.map(clean).filter(Boolean); let added = 0;
    for (const record of Object.values(backup.applications)) {
      const job = clean(record?.job); if (!job || !R.STAGES[record.stage] || applications[job.id]) continue;
      applications[job.id] = { job, stage: record.stage, notes: String(record.notes || "").slice(0, 6000), interviewAt: R.text(record.interviewAt).slice(0, 80),
        createdAt: R.iso(record.createdAt) || new Date().toISOString(), updatedAt: R.iso(record.updatedAt) || new Date().toISOString(),
        companyChecked: Boolean(record.companyChecked), companyCheckedAt: R.iso(record.companyCheckedAt), history: [] };
      added++;
    }
    const jobs = R.mergeJobs(current.jobs || [], imported);
    await chrome.storage.local.set({ jobs, applications });
    return { ok: true, addedApplications: added, addedJobs: Math.max(0, jobs.length - (current.jobs || []).length) };
  });
  throw Error("未知操作");
}

function startScan(mode, snapshot) {
  if (scanTask) return scanTask;
  scanTask = initialize().then(() => performScan(mode, snapshot)).finally(() => {
    scanTask = null;
    if (queuedProfileScan) { queuedProfileScan = false; startScan("all").catch(console.error); }
  });
  return scanTask;
}
function fingerprint(j) {
  return R.hash(JSON.stringify([j.title, j.company, j.degree, j.location, j.salaryLow, j.salaryHigh, j.salaryUnit,
    j.description, j.publishedAt, j.deadline, j.status, j.applyInfo?.status || "", (j.applyInfo?.routes || []).map((r) => [r.kind, r.url || r.value])]));
}
async function performScan(mode, snapshot) {
  const settings = await chrome.storage.local.get(null);
  const p = R.profile(settings.profile);
  if (mode !== "current" && !R.profileReady(p)) return { outcome: "needs-profile", running: false, message: "等待填写目标岗位后开始检查招聘。" };
  const sources = mode === "current" ? [{ id: R.hash(snapshot.url), name: snapshot.title || new URL(snapshot.url).hostname,
    url: snapshot.url, adapter: "page", enabled: true }] : (settings.sources || []).filter((s) => s.enabled && s.adapter !== "manual");
  const startedAt = new Date().toISOString(), runId = R.hash(startedAt + Math.random());
  let scan = { runId, mode, running: true, startedAt, completedAt: null, outcome: "running", completedSources: 0,
    totalSources: sources.length, successfulSources: 0, failedSources: 0, readCount: 0, newCount: 0, updatedCount: 0,
    unchangedCount: 0, matchedCount: 0, message: "开始连接公开招聘来源" };
  await chrome.storage.local.set({ scan });
  const allFound = [], statuses = { ...(settings.sourceStatus || {}) }, logs = [];
  try {
    await S.mapLimit(sources, 3, async (source) => {
      const progress = async (message) => {
        statuses[source.id] = { ...statuses[source.id], running: true, name: source.name, url: source.url, checkedAt: new Date().toISOString(), message };
        scan.message = `${source.name}：${message}`;
        await chrome.storage.local.set({ scan: { ...scan }, sourceStatus: { ...statuses } });
      };
      try {
        const result = snapshot ? S.parsePage(snapshot, source) : await S.fetchSource(source, p, progress);
        const detailErrors = mode === "current" ? [] : await S.enrich(result.items, p, settings.jobs || [], progress);
        const normalized = result.items.map((j) => R.normalizeJob(j, source, new Date().toISOString())).filter(Boolean);
        allFound.push(...normalized.filter((j) => R.matchesRoles(j, p)));
        const status = { name: source.name, url: source.url, running: false, ok: true, checkedAt: new Date().toISOString(),
          readCount: normalized.length, detailCount: normalized.filter((j) => j.detailVerified).length,
          method: result.method, errors: result.errors, detailErrors: detailErrors.slice(0, 10), truncated: result.truncated,
          coverage: result.coverage, queries: result.queries, queryReports: result.queryReports || [],
          message: `读取 ${normalized.length} 条${source.adapter === "tiangong" ? "公告" : "职位"}，其中 ${normalized.filter((j) => j.detailVerified).length} 条有可核实正文` };
        statuses[source.id] = status; logs.push({ ...status, sourceId: source.id, runId });
        scan.successfulSources++; scan.readCount += normalized.length;
      } catch (e) {
        const status = { name: source.name, url: source.url, running: false, ok: false, checkedAt: new Date().toISOString(),
          readCount: 0, message: e.message, errors: [e.message], queries: [] };
        statuses[source.id] = status; logs.push({ ...status, sourceId: source.id, runId }); scan.failedSources++;
      }
      scan.completedSources++;
      await chrome.storage.local.set({ scan: { ...scan }, sourceStatus: { ...statuses } });
    });
    const found = R.mergeJobs(allFound, []);
    const oldById = new Map((settings.jobs || []).map((j) => [j.id, j]));
    let jobs = R.mergeJobs(found, settings.jobs || []);
    const foundIds = new Set(found.map((j) => j.id));
    // A list window is incomplete: absence is not evidence that a job closed.
    jobs = jobs.map((j) => foundIds.has(j.id) ? j : { ...j, lastCheckedAt: j.lastCheckedAt || null });
    const mergedById = new Map(jobs.map((j) => [j.id, j]));
    scan.offCampusCount = 0; scan.schoolAccessCount = 0;
    for (const job of found) {
      const previous = oldById.get(job.id);
      const effective = mergedById.get(job.id) || job;
      if (!previous) scan.newCount++;
      else if (fingerprint(previous) !== fingerprint(effective)) scan.updatedCount++;
      else scan.unchangedCount++;
      const a = R.assess(job, p);
      if (a.eligibility !== "excluded" && a.fresh) scan.matchedCount++;
      if (R.matchesAccess(effective, "off-campus", settings.accessReports?.[job.id])) scan.offCampusCount++;
      if (R.matchesAccess(effective, "school", settings.accessReports?.[job.id])) scan.schoolAccessCount++;
    }
    scan.uniqueCount = found.length;
    scan.running = false; scan.completedAt = new Date().toISOString();
    scan.outcome = !sources.length ? "no-sources" : !scan.successfulSources ? "failed" : scan.failedSources || logs.some((l) => l.errors?.length) ? "partial" : scan.readCount ? "checked" : "empty";
    scan.message = scan.outcome === "failed" ? "所有自动来源读取失败；保留历史记录，本次没有更新成功。"
      : scan.outcome === "no-sources" ? "没有启用可自动读取的来源，请到来源管理启用公开数据源。"
      : !scan.readCount ? "本次来源返回 0 条记录，未获得新岗位。"
      : `本次读取 ${scan.readCount} 条列表记录，去重并匹配方向后 ${found.length} 条；新增 ${scan.newCount}、信息补全或变化 ${scan.updatedCount}、重复 ${scan.unchangedCount}。其中 ${scan.offCampusCount} 条有校外渠道线索，${scan.schoolAccessCount} 条校站投递待核实或受限；不代表已确认可提交。`;
    await chrome.storage.local.set({ jobs, scan, sourceStatus: statuses, scanLogs: [...logs, ...(settings.scanLogs || [])].slice(0, 120),
      ...(scan.readCount ? { lastSuccessAt: scan.completedAt } : {}) });
    const newSuitable = found.filter((j) => !oldById.has(j.id) && R.assess(j, p).fresh && R.assess(j, p).eligibility !== "excluded" && R.matchesAccess(mergedById.get(j.id) || j, "off-campus", settings.accessReports?.[j.id]));
    if (newSuitable.length) chrome.notifications.create(`radar-${runId}`, { type: "basic", iconUrl: "icon.png",
      title: `招聘雷达：新增 ${newSuitable.length} 条近期记录`, message: "方向匹配，部分报名条件仍待核实；打开看板查看证据与发布时间。" }).catch(console.warn);
    return scan;
  } catch (e) {
    scan = { ...scan, running: false, completedAt: new Date().toISOString(), outcome: "failed", error: e.message,
      message: `扫描中断：${e.message}。历史记录保持不变。` };
    await chrome.storage.local.set({ scan });
    throw e;
  }
}
