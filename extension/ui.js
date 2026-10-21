const R = Radar;
const $ = (selector) => document.querySelector(selector);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const formatDate = (s, time = false) => {
  if (!s) return "未提供";
  const d = new Date(s); if (Number.isNaN(d.valueOf())) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(d);
};
let data = { jobs: [], applications: {}, accessReports: {}, sources: [], sourceStatus: {}, scanLogs: [], profile: R.profile() };
let view = "jobs";
let busy = false;
let profileDirty = false;
let profileSaving = false;
let initialized = false;
let toastTimer;
let visibleJobs = 50;
let backupToRestore;
let automaticChecking = false;
let nextRouteExpiry = Infinity;
async function checkFreshness() {
  if (!initialized || document.hidden || automaticChecking || !R.profileReady(data.profile)) return;
  automaticChecking = true;
  try { const result = await send("ensureFresh"); if (result.started) notify(result.message); }
  catch (error) { notify(`自动检查未能启动：${error.message}`, "error"); }
  finally { automaticChecking = false; }
}
function notify(s, tone = "info") {
  $("#notice").textContent = s;
  const toast = $("#toast");
  if (toast) {
    clearTimeout(toastTimer); toast.textContent = s; toast.className = `toast visible ${tone}`;
    toastTimer = setTimeout(() => toast.classList.remove("visible"), tone === "error" ? 10000 : 7000);
  }
}
function feedback(id, message, tone = "info") {
  const target = $(id); if (!target) return;
  target.textContent = message; target.className = `form-status ${tone}`;
}
function pendingForm(form, pending, label = "保存中…") {
  form.setAttribute("aria-busy", String(pending));
  for (const control of form.querySelectorAll("input,select,textarea,button[type=submit]")) control.disabled = pending;
  const submit = form.querySelector("button[type=submit]");
  if (submit) { submit.dataset.restingText ||= submit.textContent; submit.textContent = pending ? label : submit.dataset.restingText; }
}
async function send(type, args = {}) {
  let timeout;
  try {
    const result = await Promise.race([chrome.runtime.sendMessage({ type, ...args }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("操作响应超时，请刷新工作台后重试；已填写的内容仍保留在当前表单。")), type === "refreshDetail" ? 20000 : 10000); })]);
    if (!result?.ok) throw Error(result?.error || "后台未返回有效响应，请刷新工作台后重试。");
    return result;
  } finally { clearTimeout(timeout); }
}
async function action(fn) { try { await fn(); } catch (e) { notify(e.message, "error"); } }
function link(url, label, classes = "button") {
  const safe = R.safeUrl(url);
  return safe ? `<a class="${esc(classes)}" href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : "";
}
function activate(next) {
  view = ["jobs", "applications", "profile", "sources"].includes(next) ? next : "jobs";
  document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === `${view}View`));
  document.querySelectorAll("[data-view]").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
  if (!document.body.classList.contains("popup")) history.replaceState(null, "", `#${view}`);
}
function goToView(next) {
  activate(next);
  $(`#${view}View`)?.focus?.({ preventScroll: true });
  globalThis.scrollTo?.({ top: 0, behavior: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
async function init() {
  document.body.classList.toggle("popup", location.pathname.endsWith("/popup.html"));
  pendingForm($("#profileForm"), true, "正在载入资料…");
  if (globalThis.RadarUpgrade && await RadarUpgrade.ensure()) return;
  await chrome.storage.local.get(null).then((value) => { data = { ...data, ...value, profile: R.profile(value.profile) }; });
  const runtime = await send("initialize");
  if (globalThis.RadarUpgrade && await RadarUpgrade.ensure(runtime)) return;
  const value = await chrome.storage.local.get(null);
  data = { ...data, ...value, profile: R.profile(value.profile) };
  renderAll(); renderProfile(); activate(location.hash.slice(1) || "jobs");
  if (!document.body.classList.contains("popup")) $("#openDashboard").hidden = true;
  $("#readPage").hidden = !document.body.classList.contains("popup");
  initialized = true; pendingForm($("#profileForm"), false);
  $("#roleTemplate").innerHTML = '<option value="">选择参考方向（可选）</option>' + R.ROLE_TEMPLATES.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("");
  if (!R.profileReady(data.profile)) {
    activate("profile");
    feedback("#profileSaveStatus", "先填写目标岗位，再保存并开始匹配。其他资料可按需补充。");
    $("#welcomeDialog").showModal?.();
  }
  document.querySelectorAll("[data-version]").forEach((el) => { el.textContent = R.VERSION; });
  if (data.lastUpgrade?.buildId === R.BUILD_ID && Date.now() - data.lastUpgrade.at < 120000) notify(`已升级至 ${R.VERSION}，原有资料和求职进度已保留。`, "success");
  await checkFreshness();
}
function renderAll() { renderScan(); renderSources(); renderJobs(); renderApplications(); renderPlatforms(); }
function renderPlatforms() {
  const keyword = $("#platformKeyword").value.trim() || data.profile.roles[0] || data.profile.major;
  $("#platformKeyword").placeholder = keyword || "输入岗位关键词";
  $("#platforms").innerHTML = R.platforms(keyword).map((p) => `<div>${link(p.url, p.name)}<span class="muted">${p.search ? "已带入岗位关键词" : "官网入口 · 进入后搜索"}</span></div>`).join("");
}
function renderScan() {
  const p = data.profile;
  $("#profileSummary").textContent = R.profileReady(p) ? [p.careerStage !== "unknown" ? R.CAREER_NAMES[p.careerStage] : "", p.graduation, p.major, R.DEGREE_NAMES[p.degree] + (p.route === "transfer" ? "（专升本）" : ""), p.regions.join("／") || "全国"].filter(Boolean).join(" · ") : "建立自己的求职档案，再按岗位、地区与条件筛选";
  $("#editProfile").textContent = R.profileReady(p) ? "完善求职档案" : "建立求职档案";
  const scan = data.scan;
  const title = !scan ? "尚未联网检查" : scan.running ? `正在检查 ${scan.completedSources}/${scan.totalSources} 个来源`
    : ({ failed: "本次读取失败", partial: "本次仅部分来源取得结果", checked: scan.newCount ? `发现 ${scan.newCount} 条新记录` : "检查完成 · 本次没有新增", empty: "本次没有取得岗位数据", interrupted: "上次检查被中断", "no-sources": "未启用自动来源" }[scan.outcome] || "检查已结束");
  $("#scanTitle").textContent = title;
  $("#scanMessage").textContent = scan?.message || scan?.error || "点击“检查最新招聘”，将实际连接已启用的公开来源。旧版记录移入历史，不会冒充近期新岗位。";
  $("#lastSuccess").textContent = `最近取得列表数据：${formatDate(data.lastSuccessAt, true)}${scan?.completedAt ? ` · 本次结束：${formatDate(scan.completedAt, true)}` : ""}`;
  $("#freshnessStatus").textContent = !R.profileReady(p) ? "保存目标岗位后，打开插件会自动检查公开来源。" : scan?.running ? "正在联网检查，先显示已取得的列表，正文与投递入口随后更新。" : "打开插件自动检查；停留时每 5 分钟检查一次，5 分钟内重复打开复用本次结果。可随时手动检查；来源没有新增时不会制造新岗位。";
  $(".scan-banner").className = `scan-banner ${["failed", "interrupted", "no-sources"].includes(scan?.outcome) ? "failed" : scan?.outcome === "partial" ? "partial" : ""}`;
  const progress = $("#scanProgress"); progress.hidden = !scan?.running;
  progress.max = scan?.totalSources || 1; progress.value = scan?.completedSources || 0;
  $("#scanNow").disabled = busy || Boolean(scan?.running); $("#readPage").disabled = busy || Boolean(scan?.running);
  $("#scanNow").textContent = scan?.running ? "检查中…" : R.profileReady(p) ? "检查最新招聘" : "填写档案后匹配";
  $("#newCount").textContent = String(scan?.newCount || 0);
  $("#sourceCount").textContent = `${scan?.successfulSources || 0}/${scan?.totalSources || data.sources.filter((s) => s.enabled && s.adapter !== "manual").length}`;
  $("#interviewCount").textContent = Object.values(data.applications).filter((a) => a.stage === "interview").length;
}
function salary(job) {
  if (!job.salaryLow && !job.salaryHigh) return "薪资未公开";
  const unit = job.salaryUnit === "day" ? "元／天" : "元／月";
  return `${job.salaryLow || "?"}${job.salaryHigh && job.salaryHigh !== job.salaryLow ? `–${job.salaryHigh}` : ""} ${unit}`;
}
function eligibilityLabel(a) {
  return a.eligibility === "excluded" ? "存在不符合条件"
    : a.eligibility === "education-explicit" ? "有专升本接受表述 · 其余条件待核实"
    : a.eligibility === "degree-match" ? "学历层次匹配 · 完整资格待核实" : "报名资格待核实";
}
function accessOf(job) { return R.applicationAccess(job, data.accessReports?.[job.id]); }
function primaryApplyAction(job) {
  const access = accessOf(job), route = access.routes.find((r) => r.kind === "link");
  if (route) return link(route.url, "打开原文报名入口", "button primary");
  if (access.status === "platform") return link(job.detailUrl, "打开职位原文（需账号确认）", "button primary");
  return `<button class="primary" data-action="routes">${access.status === "email" ? "查看简历邮箱" : "查找校外投递入口"}</button>`;
}
function jobCard(job, application, alternatives = []) {
  const a = R.assess(job, data.profile);
  const saved = application || data.applications[job.id];
  const issues = [...a.excluded, ...a.cautions];
  const access = accessOf(job);
  const lastSeenThisRun = data.scan?.startedAt && job.lastCheckedAt && new Date(job.lastCheckedAt) >= new Date(data.scan.startedAt);
  const isNew = lastSeenThisRun && new Date(job.firstSeenAt) >= new Date(data.scan.startedAt);
  return `<article class="job-card" data-job-id="${esc(job.id)}">
    <div class="card-top"><div><p class="company-name">${esc(job.company || "企业名称待确认")} ${job.companyType ? ` · ${esc(job.companyType)}` : ""}</p><h2 class="job-title">${esc(job.title)}</h2></div><span class="salary">${esc(salary(job))}</span></div>
    <div class="badges">${isNew ? '<span class="badge green">本次新发现</span>' : ""}<span class="badge">${job.kind === "announcement" ? "综合招聘公告" : "职位记录"}</span>${a.tags.map((t) => `<span class="badge">${R.TYPE_NAMES[t]}</span>`).join("")}<span class="badge ${a.eligibility === "excluded" ? "bad" : "warn"}">${eligibilityLabel(a)}</span>${job.legacy ? '<span class="badge warn">旧版历史 · 未重新核实</span>' : ""}${saved ? `<span class="badge green">${R.STAGES[saved.stage]}</span>` : ""}</div>
    <div class="job-meta"><span>地区：${esc(job.location || "未注明")}</span><span>学历：${esc(job.degree || "未注明")}</span>${job.major ? `<span>专业：${esc(job.major.slice(0, 150))}</span>` : ""}${job.companySize ? `<span>规模：${esc(job.companySize)}</span>` : ""}</div>
    <div class="job-meta"><span>原始发布：${formatDate(job.publishedAt, true)}</span><span>来源更新：${formatDate(job.updatedAt, true)}</span><span>列表读取：${formatDate(job.lastCheckedAt, true)}</span>${job.deadline ? `<span>截止：${formatDate(job.deadline)}</span>` : ""}</div>
    <p class="listing-freshness ${lastSeenThisRun ? "good" : "warn"}">${lastSeenThisRun ? "本次已从来源列表读取" : "本次尚未从来源列表重新读取 · 保留历史记录，不代表已下线"}${job.linkCheck ? ` · 正文链接${({ available: "可访问", login: "需要登录", unavailable: "无法访问", error: "检查失败" })[job.linkCheck.status] || "待核实"}（${formatDate(job.linkCheck.checkedAt, true)}）` : " · 正文链接尚待核实"}</p>
    <p class="access-summary"><span class="badge ${["link", "email"].includes(access.status) ? "green" : "warn"}">${esc(access.label)}</span><span>${esc(access.evidence)}${access.checkedAt ? ` · 核对于 ${formatDate(access.checkedAt, true)}` : ""}</span></p>
    ${saved?.interviewAt ? `<p class="interview-time">面试：${formatDate(saved.interviewAt, true)}${new Date(saved.interviewAt).valueOf() < Date.now() ? " · 时间已过，请更新进度" : ""}</p>` : ""}
    ${saved?.notes ? `<p class="app-notes">${esc(saved.notes)}</p>` : ""}
    ${issues.length ? `<p class="cautions">${issues.slice(0, 4).map(esc).join("；")}</p>` : ""}
    ${job.description ? `<details><summary class="muted">查看招聘正文与匹配依据</summary><div class="evidence">${esc(job.description.slice(0, 4500))}${job.description.length > 4500 ? "\n（正文较长，请打开原文查看全部）" : ""}</div><p class="muted">匹配依据：${esc(a.reasons.join("；") || "资料不足")}。学历证据：${esc(a.evidence.degree)}；专升本：${esc(a.evidence.transfer)}。</p></details>` : ""}
    <div class="card-actions">${primaryApplyAction(job)}${access.status !== "platform" ? link(job.detailUrl, "查看职位原文") : ""}${["link", "platform"].includes(access.status) ? '<button data-action="routes">投递渠道与替代入口</button>' : ""}<button data-action="application">${saved ? "更新求职进度" : "加入有意向"}</button><details class="more-actions"><summary>更多操作</summary><button data-action="company">核验企业</button><button data-action="verify">重新核实详情</button></details></div>
    ${alternatives.length ? `<details><summary>相似招聘记录 ${alternatives.length + 1} 条 · 展开其他原文</summary><p class="hint">企业、岗位名、地区、薪资、学历和发布日相同，暂归为一组；保留各条链接供你确认是否同一岗位。</p>${alternatives.map((j) => link(j.detailUrl, `${j.sourceLabel || j.sourceName || "招聘来源"} · ${accessOf(j).label}`)).join(" ")}</details>` : ""}
    <p class="source-line">来源：${esc(job.sourceName || "旧版记录")}${job.sourceLabel && job.sourceLabel !== job.sourceName ? ` · 原始标注：${esc(job.sourceLabel)}` : ""}。${job.detailVerified ? `正文核实于 ${formatDate(job.detailCheckedAt, true)}` : "尚未取得可核实的完整正文"}。${saved?.companyChecked ? `企业信息由你手动标记已核验（${formatDate(saved.companyCheckedAt)}）` : "企业信用尚未核验"} ${link(job.sourceUrl, "查看来源网站", "source-link")}</p>
  </article>`;
}
function renderJobs() {
  const now = Date.now();
  nextRouteExpiry = data.jobs.reduce((next, job) => { const expires = Number(new Date(job.applyInfo?.checkedAt)) + R.DETAIL_CACHE_MS; return expires > now ? Math.min(next, expires) : next; }, Infinity);
  const p = data.profile, scope = $("#scope").value, type = $("#type").value, query = $("#search").value.toLowerCase().trim();
  const scored = data.jobs.map((j) => ({ j, a: R.assess(j, p) }));
  $("#recentCount").textContent = R.groupSimilar(scored.filter(({ a, j }) => a.fresh && a.roleMatch && a.eligibility !== "excluded" && !j.legacy && R.matchesAccess(j, "off-campus", data.accessReports?.[j.id])).map(({ j }) => j)).length;
  const result = scored.filter(({ j, a }) => {
    if (scope !== "all" && j.legacy) return false;
    if (!a.roleMatch && scope !== "all") return false;
    if (scope === "recent" && !a.fresh) return false;
    if (scope === "unknown" && j.publishedAt) return false;
    if (scope === "new" && (!data.scan?.startedAt || new Date(j.firstSeenAt || 0) < new Date(data.scan.startedAt))) return false;
    if (scope === "run" && (!data.scan?.startedAt || !j.lastCheckedAt || new Date(j.lastCheckedAt) < new Date(data.scan.startedAt))) return false;
    if (!$("#showExcluded").checked && a.eligibility === "excluded") return false;
    if ($("#onlyRegion").checked && !a.regionMatch && !/全国|远程/.test(j.location)) return false;
    if (type && !a.tags.includes(type)) return false;
    if (!R.matchesAccess(j, $("#accessFilter").value, data.accessReports?.[j.id])) return false;
    if ($("#originFilter").value && (j.sourceLabel || j.sourceName) !== $("#originFilter").value) return false;
    if (query && !`${j.title} ${j.company} ${j.location} ${j.description}`.toLowerCase().includes(query)) return false;
    return true;
  });
  const groups = R.groupSimilar(R.sortJobs(result.map(({ j }) => j), p, $("#sortOrder").value));
  $("#resultCount").textContent = `${groups.length} 组／${result.length} 条记录 · 已展示 ${Math.min(visibleJobs, groups.length)} 组`;
  $("#loadMore").hidden = groups.length <= visibleJobs;
  $("#jobs").innerHTML = groups.length ? groups.slice(0, visibleJobs).map((group) => {
    const rank = (job) => ({ link: 4, email: 4, platform: 3, unknown: 1, "school-unknown": 0, "school-login": 0, unavailable: -1 }[accessOf(job).status] ?? 0);
    const ordered = [...group].sort((a, b) => rank(b) - rank(a) || Number(Boolean(data.applications[b.id])) - Number(Boolean(data.applications[a.id])) || Number(b.detailVerified) - Number(a.detailVerified));
    return jobCard(ordered[0], undefined, ordered.slice(1));
  }).join("") : '<div class="empty">当前条件下没有可展示的记录。<br>默认只展示已发现校外渠道线索的记录，平台账号及提交条件仍需确认。<br>可切换投递渠道到“全部（含校站待核实）”查看其他线索，或展开更多平台搜索。</div>';
}
function renderApplications() {
  const records = Object.values(data.applications), filter = $("#stageFilter").value, query = $("#applicationSearch").value.trim().toLowerCase();
  $("#stageStats").innerHTML = Object.entries(R.STAGES).map(([stage, label]) => `<button data-stage="${stage}" aria-pressed="${filter === stage}"><strong>${records.filter((a) => a.stage === stage).length}</strong><span>${label}</span></button>`).join("");
  const jobs = new Map(data.jobs.map((j) => [j.id, j]));
  const selected = records.filter((a) => (!filter || a.stage === filter) && (!query || `${a.job.company} ${a.job.title} ${a.notes}`.toLowerCase().includes(query))).sort((a, b) => {
    const upcoming = (r) => r.stage === "interview" && r.interviewAt && new Date(r.interviewAt) > new Date() ? new Date(r.interviewAt).valueOf() : Infinity;
    return upcoming(a) - upcoming(b) || new Date(b.updatedAt) - new Date(a.updatedAt);
  });
  $("#applications").innerHTML = selected.length ? selected.map((a) => jobCard(jobs.get(a.job.id) || a.job, a)).join("") : '<div class="empty">暂无求职记录。<br>在招聘卡片点击“加入有意向”，随后可记录投递和面试邀约。</div>';
}
function renderProfile() {
  const f = $("#profileForm"), p = data.profile;
  for (const key of ["major", "graduation", "degree", "route", "schoolTier", "schoolName", "careerStage", "experienceYears", "availableDays", "internMonths", "minMonthly", "minDaily", "maxAgeDays", "pageLimit"]) f.elements.namedItem(key).value = p[key] ?? "";
  f.elements.namedItem("skills").value = p.skills.join("，");
  f.elements.namedItem("roles").value = p.roles.join("，"); f.elements.namedItem("regions").value = p.regions.join("，");
  f.elements.namedItem("strictRegion").checked = p.strictRegion; f.elements.namedItem("strictSalary").checked = p.strictSalary;
  f.elements.namedItem("intervalMinutes").value = String(data.intervalMinutes || 30);
  f.querySelectorAll('[name="types"]').forEach((input) => { input.checked = p.types.includes(input.value); });
}
function renderSources() {
  const origin = $("#originFilter"), previous = origin.value;
  origin.innerHTML = '<option value="">全部原始来源</option>' + R.list(data.jobs.map((j) => j.sourceLabel || j.sourceName)).sort((a, b) => a.localeCompare(b, "zh-CN")).map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
  origin.value = previous; if (origin.selectedIndex < 0) origin.value = "";
  $("#sources").innerHTML = data.sources.filter((s) => s.adapter !== "manual").map((s) => {
    const status = data.sourceStatus[s.id], manual = s.adapter === "manual";
    return `<article class="source-card"><div class="source-head"><label><input type="checkbox" data-source-id="${esc(s.id)}" ${s.enabled ? "checked" : ""} ${manual ? "disabled" : ""}><strong>${esc(s.name)}</strong></label>${link(s.url, "打开来源")}</div><p class="${status?.ok === false ? "bad" : status?.running ? "warn" : "good"}">${esc(manual ? "浏览器读取模式：打开岗位列表后，在插件弹窗中点“读取当前网页”。未接入自动接口。" : status?.message || "等待联网检查")}</p>${status?.checkedAt ? `<p class="muted">检查：${formatDate(status.checkedAt, true)} · ${esc(status.method || "")}</p>` : ""}${status?.coverage ? `<p class="muted">${esc(status.coverage)}${status.truncated ? "。读取有数量上限。" : ""}</p>` : ""}${status?.errors?.length ? `<p class="warn">部分查询：${esc(status.errors.join("；"))}</p>` : ""}${status?.queries?.length ? `<details><summary>查看实际读取地址与详情失败记录</summary>${status.queries.slice(0, 20).map((url) => `<div>${link(url, url, "")}</div>`).join("")}${(status.detailErrors || []).map((e) => `<p>${esc(e.error)} · ${link(e.url, "打开原文", "")}</p>`).join("")}</details>` : ""}</article>`;
  }).join("");
  $("#logs").innerHTML = data.scanLogs.length ? data.scanLogs.slice(0, 18).map((log) => `<article class="source-card"><strong>${esc(log.name)}</strong><p class="${log.ok ? "good" : "bad"}">${esc(log.message)}</p><p class="muted">${formatDate(log.checkedAt, true)} · ${esc(log.method || "未取得数据")} · ${esc(log.coverage || "")}</p></article>`).join("") : '<div class="empty">尚无扫描日志。</div>';
}
function findJob(id) { return data.jobs.find((j) => j.id === id) || data.applications[id]?.job; }
function openApplication(job) {
  const saved = data.applications[job.id], f = $("#applicationForm");
  f.elements.namedItem("jobId").value = job.id;
  f.elements.namedItem("stage").value = saved?.stage || "interested";
  f.elements.namedItem("interviewAt").value = saved?.interviewAt || "";
  f.elements.namedItem("notes").value = saved?.notes || "";
  f.elements.namedItem("companyChecked").checked = Boolean(saved?.companyChecked);
  $("#applicationTitle").textContent = `${job.company || "企业待确认"} · ${job.title}`;
  feedback("#applicationSaveStatus", "选择阶段后保存，记录会出现在求职进度页。");
  $("#applicationDialog").showModal();
}
function openCompany(job) {
  const company = job.company || "", encoded = encodeURIComponent(company);
  $("#companyContent").innerHTML = `<h3>${esc(company || "该记录尚未取得企业全称")}</h3><p class="muted">企业名称来自招聘来源，尚未自动查询工商登记。以下入口需要你打开后确认同名企业、注册状态和招聘主体。</p><div class="company-links">${company ? `<button id="copyCompany">复制企业全称</button>${link(`https://www.qcc.com/web/search?key=${encoded}`, "企查查搜索")}${link(`https://www.tianyancha.com/search?key=${encoded}`, "天眼查搜索")}` : ""}${link("https://www.gsxt.gov.cn/", "国家企业信用信息公示系统")}${link(job.companyUrl, "招聘来源的企业页面")}${link(job.detailUrl, "招聘原文")}</div><ul class="research-list"><li>用企业全称查询统一社会信用代码、登记状态、经营异常和严重违法信息。</li><li>对照招聘主体、合同主体与联系邮箱，核对是否为该公司或有明确授权的招聘机构。</li><li>核实岗位要求、专升本条件、薪资口径与实习安排；收费、押金或转账要求应向官方渠道确认。</li><li>企业规模、国企／外企标签与平台收录，不能替代工商和招聘主体核验。</li></ul><p class="hint">企查查、天眼查等可能需要登录。插件提供查询入口，不会冒充已获得信用报告或“无风险”认证。</p>${data.applications[job.id]?.companyChecked ? `<p class="good">你曾于 ${formatDate(data.applications[job.id].companyCheckedAt, true)} 手动标记已核验。</p>` : ""}`;
  $("#companyDialog").showModal();
  if (company) $("#copyCompany").addEventListener("click", () => action(async () => { await navigator.clipboard.writeText(company); $("#copyCompany").textContent = "已复制"; }));
}
function openRoutes(job) {
  const access = accessOf(job), f = $("#accessReportForm");
  f.elements.namedItem("jobId").value = job.id;
  f.elements.namedItem("status").value = data.accessReports?.[job.id]?.status || "school-login";
  $("#routesTitle").textContent = `${job.company || "企业待确认"} · ${job.title}`;
  $("#routeAccessLabel").textContent = access.label;
  $("#routeAccessEvidence").textContent = access.evidence + (access.restrictedOriginal && access.routes.length ? "。原站仍有校内账号限制，下列公开方式需单独确认。" : "");
  $("#knownApplyRoutes").innerHTML = access.routes.length ? access.routes.map((route) => route.kind === "link" ? `<div class="route-item">${link(route.url, "打开原文提供的报名链接")}<p class="muted">${esc(route.evidence)}；登录、接收范围与招聘主体仍需核对。</p></div>` : `<div class="route-item"><strong>${esc(route.value)}</strong><button type="button" data-copy-email="${esc(route.value)}">复制简历邮箱</button><p class="muted">来自招聘正文：${esc(route.evidence)}。请自行核对招聘主体和简历接收要求。</p></div>`).join("") : '<p class="hint">尚未找到明确的校外报名链接或简历邮箱。该记录目前只提供求职线索，不能确认可投递。</p>';
  const candidates = data.jobs.filter((candidate) => candidate.id !== job.id && job.company && R.text(candidate.company) === R.text(job.company) && R.matchesAccess(candidate, "off-campus", data.accessReports?.[candidate.id]) && R.assess(candidate, data.profile).fresh && R.assess(candidate, data.profile).eligibility !== "excluded").slice(0, 6);
  $("#relatedApplyRoutes").innerHTML = candidates.length ? candidates.map((candidate) => `<div class="route-item">${link(candidate.detailUrl, `${candidate.title === job.title ? "同名岗位候选" : "同公司相关岗位"}：${candidate.title}`)}<p class="muted">${esc(candidate.sourceLabel || candidate.sourceName)} · ${esc(accessOf(candidate).label)}；需核对是否为同一岗位。</p></div>`).join("") : '<p class="muted">当前已保存数据中，未找到同一企业的其他近期校外渠道线索。</p>';
  const keyword = R.text(`${job.company} ${job.title}`).slice(0, 100);
  $("#applySearchLinks").innerHTML = R.platforms(keyword).filter((p) => p.search).map((p) => link(p.url, `${p.name}搜索`)).join("");
  $("#applySearchKeyword").textContent = keyword;
  $("#applyOriginalLink").innerHTML = link(job.detailUrl, "查看招聘原文");
  feedback("#accessReportStatus", "反馈仅保存在本机，校内受限或失效记录会从默认看板隐藏。");
  if (!$("#routesDialog").open) $("#routesDialog").showModal();
}
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => goToView(button.dataset.view)));
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
globalThis.addEventListener("hashchange", () => activate(location.hash.slice(1)));
for (const id of ["#search", "#scope", "#type", "#onlyRegion", "#showExcluded", "#originFilter", "#accessFilter", "#sortOrder"]) $(id).addEventListener(id === "#search" ? "input" : "change", () => { visibleJobs = 50; renderJobs(); });
$("#loadMore").addEventListener("click", () => { visibleJobs += 50; renderJobs(); });
$("#platformKeyword").addEventListener("input", renderPlatforms);
$("#copyKeyword").addEventListener("click", () => action(async () => { await navigator.clipboard.writeText($("#platformKeyword").value.trim() || data.profile.roles[0] || data.profile.major); notify("岗位关键词已复制，可以粘贴到平台官网搜索框。"); }));
$("#stageStats").addEventListener("click", (event) => { const button = event.target.closest("button[data-stage]"); if (button) { $("#stageFilter").value = $("#stageFilter").value === button.dataset.stage ? "" : button.dataset.stage; renderApplications(); } });
document.querySelectorAll("[data-metric]").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.metric === "sources") goToView("sources");
  else if (button.dataset.metric === "interview") { $("#stageFilter").value = "interview"; $("#applicationSearch").value = ""; renderApplications(); goToView("applications"); }
  else {
    $("#scope").value = button.dataset.metric === "new" ? "new" : "recent";
    $("#accessFilter").value = "off-campus";
    $("#search").value = ""; $("#type").value = ""; $("#originFilter").value = ""; $("#onlyRegion").checked = false; $("#showExcluded").checked = false;
    visibleJobs = 50; renderJobs();
  }
}));
$("#stageFilter").addEventListener("change", renderApplications); $("#applicationSearch").addEventListener("input", renderApplications);
$("#scanNow").addEventListener("click", () => action(async () => { if (!R.profileReady(data.profile)) { goToView("profile"); $("#profileForm [name=roles]").focus(); notify("请先填写目标岗位，再保存并开始匹配。"); return; } busy = true; renderScan(); try { notify((await send("scanNow")).message); } finally { busy = false; renderScan(); } }));
$("#editProfile").addEventListener("click", () => goToView("profile"));
$("#welcomeStart").addEventListener("click", () => { $("#welcomeDialog").close(); goToView("profile"); $("#profileForm [name=careerStage]").focus(); });
$("#welcomeBrowse").addEventListener("click", () => { $("#welcomeDialog").close(); goToView("jobs"); $(".platform-hub").open = true; notify("可以先浏览平台入口；保存自己的目标岗位后，再启动自动匹配。"); });
$("#applyRoleTemplate").addEventListener("click", () => {
  const item = R.ROLE_TEMPLATES.find((entry) => entry.id === $("#roleTemplate").value);
  if (!item) { notify("请先选择参考方向，也可以直接填写自定义岗位。"); return; }
  $("#profileForm [name=roles]").value = item.roles.join("，"); profileDirty = true;
  feedback("#profileSaveStatus", "参考岗位已填入，可以继续修改；保存后才会生效。");
});
$("#readPage").addEventListener("click", () => action(async () => { busy = true; renderScan(); try { const result = await send("readCurrentPage"); $("#scope").value = "run"; $("#accessFilter").value = "all"; visibleJobs = 50; goToView("jobs"); renderJobs(); notify(result.message); } finally { busy = false; renderScan(); } }));
$("#openDashboard").addEventListener("click", () => action(() => send("openDashboard", { view })));
for (const id of ["#jobs", "#applications"]) $(id).addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return;
  const job = findJob(button.closest("[data-job-id]").dataset.jobId); if (!job) return;
  if (button.dataset.action === "company") openCompany(job);
  if (button.dataset.action === "routes") openRoutes(job);
  if (button.dataset.action === "application") openApplication(job);
  if (button.dataset.action === "verify") action(async () => {
    button.disabled = true; button.textContent = "核实中…";
    try { await send("refreshDetail", { jobId: job.id }); notify("已检查公开正文与投递线索，请查看卡片；尚未确认账号资格或提交结果。"); }
    finally { button.disabled = false; button.textContent = "重新核实详情"; }
  });
});
$("#knownApplyRoutes").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-copy-email]");
  if (button) action(async () => { await navigator.clipboard.writeText(button.dataset.copyEmail); button.textContent = "邮箱已复制"; });
});
$("#copyApplyKeyword").addEventListener("click", () => action(async () => { await navigator.clipboard.writeText($("#applySearchKeyword").textContent); notify("企业与岗位关键词已复制。搜索结果需要核对，不代表已找到同一岗位。"); }));
$("#checkApplyRoutes").addEventListener("click", () => action(async () => {
  const button = $("#checkApplyRoutes"), id = $("#accessReportForm [name=jobId]").value;
  button.disabled = true;
  try { await send("refreshDetail", { jobId: id }); const stored = await chrome.storage.local.get(["jobs", "applications"]); data = { ...data, ...stored }; openRoutes(findJob(id)); notify("已重新检查公开内容；未触发原网站的投递提交。"); }
  finally { button.disabled = false; }
}));
$("#accessReportForm").addEventListener("submit", (event) => {
  event.preventDefault(); const f = event.currentTarget;
  action(async () => { try { const values = Object.fromEntries(new FormData(f)); pendingForm(f, true); await send("reportApplyAccess", values); feedback("#accessReportStatus", values.status === "clear" ? "已撤销手动标记，将按公开来源重新判断。" : "已记录，将按渠道与替代方式更新默认看板；求职进度仍保留。", "success"); }
  catch (e) { feedback("#accessReportStatus", e.message, "error"); throw e; } finally { pendingForm(f, false); } });
});
$("#profileForm").addEventListener("submit", (event) => {
  event.preventDefault(); saveProfileForm(event.currentTarget);
});
async function saveProfileForm(f) {
  if (profileSaving) return;
  if (!initialized) { feedback("#profileSaveStatus", "求职资料尚未载入，请刷新工作台后重试。", "error"); return; }
  profileSaving = true;
  try {
    const values = Object.fromEntries(new FormData(f));
    values.roles = R.list(values.roles); values.regions = R.list(values.regions);
    values.types = [...f.querySelectorAll('[name="types"]:checked')].map((input) => input.value);
    values.strictRegion = f.elements.namedItem("strictRegion").checked;
    values.strictSalary = f.elements.namedItem("strictSalary").checked;
    const intervalMinutes = values.intervalMinutes; delete values.intervalMinutes;
    pendingForm(f, true); feedback("#profileSaveStatus", "正在保存你的求职资料…");
    const result = await send("saveProfile", { profile: values, intervalMinutes });
    const stored = await chrome.storage.local.get("profile");
    if (JSON.stringify(R.profile(stored.profile)) !== JSON.stringify(R.profile(result.profile))) throw Error("保存后的资料与当前表单不一致，请重试。");
    data.profile = R.profile(stored.profile); profileDirty = false;
    feedback("#profileSaveStatus", "资料已保存，已返回招聘看板。", "success");
    renderAll(); goToView("jobs");
    notify(result.warning || "资料已保存，正在按新条件检查岗位。", result.warning ? "warning" : "success");
    try {
      const scan = await send("scanNow", { restartAfterCurrent: true });
      if (scan.queued) notify(scan.message, "success");
    } catch (e) { notify(`资料已保存；自动检查暂未启动：${e.message}`, "warning"); }
  } catch (e) { feedback("#profileSaveStatus", `保存失败：${e.message}`, "error"); notify(`保存失败：${e.message}`, "error"); }
  finally { profileSaving = false; pendingForm(f, false); }
}
$("#profileForm").addEventListener("input", () => { profileDirty = true; feedback("#profileSaveStatus", "有未保存的更改，点击“保存并查看岗位”生效。"); });
$("#profileForm").addEventListener("change", () => { profileDirty = true; });
$("#profileForm").addEventListener("invalid", (event) => {
  const details = event.target.closest("details"); if (details) details.open = true;
  feedback("#profileSaveStatus", `请检查输入：${event.target.validationMessage || "数值或格式不符合要求"}`, "error");
}, true);
$("#applicationForm").addEventListener("submit", (event) => {
  event.preventDefault(); const f = event.currentTarget;
  action(async () => {
    try {
      const values = Object.fromEntries(new FormData(f)); values.companyChecked = f.elements.namedItem("companyChecked").checked;
      pendingForm(f, true); feedback("#applicationSaveStatus", "正在保存记录…");
      await send("saveApplication", values); $("#applicationDialog").close(); goToView("applications");
      notify("求职进度已保存。", "success");
    } catch (e) { feedback("#applicationSaveStatus", `保存失败：${e.message}`, "error"); throw e; }
    finally { pendingForm(f, false); }
  });
});
$("#sources").addEventListener("change", (event) => {
  const input = event.target;
  if (input.dataset.sourceId) action(async () => {
    const enabled = input.checked; input.disabled = true;
    try { await send("saveSources", { id: input.dataset.sourceId, patch: { enabled } }); notify(enabled ? "自动来源已启用，下次检查生效。" : "自动来源已停用，下次检查生效。"); }
    catch (e) { input.checked = !enabled; throw e; } finally { input.disabled = false; }
  });
});
$("#sourceForm").addEventListener("submit", (event) => {
  event.preventDefault(); const f = event.currentTarget;
  action(async () => {
    try {
      const values = Object.fromEntries(new FormData(f)); pendingForm(f, true, "添加中…"); feedback("#sourceSaveStatus", "正在添加来源…");
      await send("saveSources", { patch: values }); f.reset(); feedback("#sourceSaveStatus", "来源已添加。", "success");
      notify("公开来源已添加。", "success");
    } catch (e) { feedback("#sourceSaveStatus", `添加失败：${e.message}`, "error"); throw e; }
    finally { pendingForm(f, false); }
  });
});
$("#exportData").addEventListener("click", () => action(async () => {
  const snapshot = await chrome.storage.local.get(null), blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = `招聘雷达备份-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  notify("已生成本机数据备份，请在浏览器下载列表中查看。", "success");
}));
$("#importData").addEventListener("click", () => $("#backupFile").click());
$("#backupFile").addEventListener("change", (event) => action(async () => {
  const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
  if (file.size > 10 * 1024 * 1024) throw Error("备份文件超过 10 MB，无法恢复。");
  const value = JSON.parse(await file.text());
  if (value.schemaVersion !== 2 || !Array.isArray(value.jobs) || !value.applications || typeof value.applications !== "object" || Array.isArray(value.applications)) throw Error("请选择招聘雷达 2.x 导出的 JSON 备份。");
  backupToRestore = value;
  $("#restoreSummary").textContent = `文件：${file.name}。包含 ${value.jobs.length} 条岗位记录、${Object.keys(value.applications).length} 条求职进度。将补入本机尚无的记录；已有岗位和求职进度优先保留，当前个人资料、来源设置保持不变。不会发送任何投递。`;
  feedback("#restoreStatus", "确认后才会写入本机数据。"); $("#restoreDialog").showModal();
}));
$("#restoreForm").addEventListener("submit", (event) => {
  event.preventDefault(); const f = event.currentTarget;
  action(async () => {
    try {
      pendingForm(f, true, "正在恢复…");
      const result = await send("restoreBackup", { payload: backupToRestore });
      backupToRestore = null; $("#restoreDialog").close(); goToView("applications");
      notify(`备份已合并：补入 ${result.addedJobs} 条岗位、${result.addedApplications} 条求职进度，已有记录已保留。`, "success");
    } catch (e) { feedback("#restoreStatus", e.message, "error"); throw e; }
    finally { pendingForm(f, false); }
  });
});
let renderTimer;
const pendingChanges = new Set();
function flushChanges() {
  renderTimer = null;
  const changed = new Set(pendingChanges); pendingChanges.clear();
  if (["sources", "sourceStatus", "scanLogs", "jobs"].some((key) => changed.has(key))) renderSources();
  if (["scan", "profile", "sources", "lastSuccessAt", "applications"].some((key) => changed.has(key))) renderScan();
  if (["jobs", "profile", "applications", "accessReports"].some((key) => changed.has(key)) || changed.has("scan") && !data.scan?.running) renderJobs();
  if (changed.has("applications") || changed.has("jobs") || changed.has("profile") || changed.has("accessReports")) renderApplications();
  if (changed.has("profile") && !profileDirty && !profileSaving) renderProfile();
  if (changed.has("profile")) renderPlatforms();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.scan?.oldValue?.running && changes.scan.newValue && !changes.scan.newValue.running) notify(changes.scan.newValue.message || "检查已结束，请查看本次结果。", changes.scan.newValue.outcome === "failed" ? "error" : "success");
  for (const [key, value] of Object.entries(changes)) data[key] = value.newValue;
  data.profile = R.profile(data.profile);
  if (changes.scan?.newValue && !changes.scan.newValue.running) renderScan();
  for (const key of Object.keys(changes)) pendingChanges.add(key);
  if (!renderTimer) renderTimer = setTimeout(flushChanges, 80);
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkFreshness(); });
globalThis.addEventListener("focus", () => checkFreshness());
setInterval(() => { if (!document.hidden && initialized) { renderScan(); if (Date.now() >= nextRouteExpiry) { renderJobs(); renderApplications(); } checkFreshness(); } }, 60000);
init().catch((e) => {
  pendingForm($("#profileForm"), false);
  feedback("#profileSaveStatus", `资料加载失败：${e.message}，请刷新工作台重试。`, "error");
  notify(`加载失败：${e.message}`, "error");
});
