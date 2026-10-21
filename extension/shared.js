/* Shared model: all suitability labels retain the original recruitment evidence. */
globalThis.Radar = (() => {
  const DEFAULT_PROFILE = {
    major: "", degree: "unknown", route: "other", schoolTier: "unknown", graduation: "", schoolName: "", careerStage: "unknown",
    roles: [], regions: [], skills: [], experienceYears: null, availableDays: null, internMonths: null,
    types: ["intern", "campus", "autumn", "social"], minMonthly: 0, minDaily: 0,
    strictRegion: false, strictSalary: false, maxAgeDays: 30, pageLimit: 2
  };
  const SOURCES = [
    { id: "ncss-intern", name: "国家大学生就业服务平台 · 实习", url: "https://www.ncss.cn/student/jobs/internindex.html", adapter: "ncss", jobType: "03", enabled: true },
    { id: "ncss-jobs", name: "国家大学生就业服务平台 · 职位", url: "https://www.ncss.cn/student/jobs/index.html", adapter: "ncss", jobType: "", enabled: true },
    { id: "ncss-zhaopin", name: "智联招聘 · 国家平台公开聚合", url: "https://www.ncss.cn/student/jobs/index.html", adapter: "ncss", feed: "fawzqa3wo3hy2x4uqe1b1bwy4met2wpb", enabled: true },
    { id: "ncss-51job", name: "前程无忧 · 国家平台公开聚合", url: "https://www.ncss.cn/student/jobs/index.html", adapter: "ncss", feed: "19etdf5giehhg58vzrf5m0en8hldvkvw", enabled: true },
    { id: "ncss-liepin", name: "猎聘 · 国家平台公开聚合", url: "https://www.ncss.cn/student/jobs/index.html", adapter: "ncss", feed: "2000846397", enabled: true },
    { id: "ncss-shixiseng", name: "实习僧 · 国家平台公开聚合", url: "https://www.ncss.cn/student/jobs/internindex.html", adapter: "ncss", feed: "2xy7zytm7pt75iz09glwxs5554t621uf", enabled: true },
    { id: "ncss-iguopin", name: "国聘 · 国家平台公开聚合", url: "https://www.ncss.cn/student/jobs/index.html", adapter: "ncss", feed: "gn5yn9s9wjydmrlh5kre1rzkma8mmjbu", enabled: true },
    { id: "tiangong", name: "天津工业大学就业网 · 招聘公告", url: "https://jobs.tiangong.edu.cn/correcruit/index", adapter: "tiangong", enabled: true },
    { id: "iguopin", name: "国聘 · 浏览器读取", url: "https://www.iguopin.com/", adapter: "manual", enabled: false },
    { id: "boss-design-soe", name: "BOSS · 浏览器读取", url: "https://www.zhipin.com/web/geek/job", adapter: "manual", enabled: false },
    { id: "zhaopin-design-soe", name: "智联 · 浏览器读取", url: "https://sou.zhaopin.com/", adapter: "manual", enabled: false }
  ];
  const STAGES = { interested: "有意向", applied: "已投递", interview: "面试邀约", offer: "收到 Offer", closed: "已结束" };
  const TYPE_NAMES = { intern: "实习", campus: "校招", autumn: "秋招", social: "社招", unknown: "类型待核实" };
  const DEGREE_NAMES = { unknown: "学历未填", secondary: "高中／中职及以下", college: "专科", bachelor: "本科", master: "硕士", doctor: "博士" };
  const CAREER_NAMES = { unknown: "求职阶段未填", student: "在校生", graduate: "应届毕业生", experienced: "已有工作经验", returning: "转行／重返职场" };
  const ROLE_TEMPLATES = [
    { id: "design", name: "设计与创意", roles: ["平面设计", "视觉设计", "UI设计"] },
    { id: "tech", name: "研发与技术", roles: ["前端开发", "Java", "软件测试"] },
    { id: "operation", name: "市场与运营", roles: ["新媒体运营", "用户运营", "市场专员"] },
    { id: "finance", name: "财务与审计", roles: ["会计", "财务助理", "审计助理"] },
    { id: "business", name: "行政与人力", roles: ["行政助理", "人力资源", "招聘专员"] },
    { id: "manufacture", name: "制造与工程", roles: ["机械工程师", "电气工程师", "质量工程师"] }
  ];
  function platforms(keyword = "") {
    const q = encodeURIComponent(text(keyword).slice(0, 100));
    return [
      ["BOSS 直聘", `https://www.zhipin.com/web/geek/job?query=${q}`, true],
      ["智联招聘", `https://sou.zhaopin.com/?kw=${q}`, true],
      ["前程无忧", "https://www.51job.com/"],
      ["猎聘", `https://www.liepin.com/zhaopin/?key=${q}`, true],
      ["实习僧", `https://www.shixiseng.com/interns?k=${q}`, true],
      ["牛客实习", `https://www.nowcoder.com/jobs/intern/center?query=${q}`, true],
      ["国聘", "https://www.iguopin.com/"], ["应届生求职网", "https://m.yingjiesheng.com/"],
      ["拉勾", "https://www.lagou.com/"], ["腾讯招聘", "https://careers.tencent.com/zh-cn/search.html"],
      ["阿里巴巴招聘", "https://talent.alibaba.com/"], ["字节跳动校招", "https://jobs.bytedance.com/campus/"],
      ["京东校招", "https://campus.jd.com/"], ["百度招聘", "https://talent.baidu.com/jobs/"]
    ].map(([name, url, search]) => ({ name, url, search: Boolean(search) }));
  }
  const text = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const list = (s) => [...new Set((Array.isArray(s) ? s : String(s || "").split(/[\n,，、;；]+/)).map(text).filter(Boolean))];
  function hash(s) { let n = 2166136261; for (const c of s) { n ^= c.charCodeAt(0); n = Math.imul(n, 16777619); } return `r-${(n >>> 0).toString(16)}`; }
  function safeUrl(s, base) { try { const u = new URL(s, base); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : ""; } catch { return ""; } }
  function canonical(s) {
    const url = safeUrl(s); if (!url) return "";
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|spm$|from$|ref$|pageCode$)/i.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    if (!u.hash.startsWith("#/")) u.hash = "";
    if (/^(?:www|job|fs)\.ncss\.cn$/.test(u.hostname)) { u.hostname = "www.ncss.cn"; u.protocol = "https:"; }
    return u.href;
  }
  function publicUrl(value, base) {
    const safe = safeUrl(value, base); if (!safe) return "";
    const host = new URL(safe).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || /\.(?:localhost|local)$/.test(host) || /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host) || /^(?:::|::1|f[cd][\da-f]{2}:|fe80:)/i.test(host)) return "";
    return safe;
  }
  function schoolUrl(value) {
    try { const host = new URL(value).hostname; return /(?:^|\.)edu\.cn$/i.test(host) || /^(?!www\.|m\.)[^.]+\.(?:goworkla\.cn|bysjy\.cn|bysjy\.com\.cn|jysd\.com)$/i.test(host); } catch { return false; }
  }
  function applicationAccess(job, report) {
    const source = text(job.sourceLabel || job.sourceName);
    const saved = job.applyInfo;
    const fresh = saved?.version === 1 && saved.checkedAt && Date.now() - new Date(saved.checkedAt).valueOf() < 24 * 3600000;
    const routes = fresh ? (Array.isArray(saved.routes) ? saved.routes : []).filter((r) => r && (r.kind === "email" ? /^[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d.-]+\.[a-z]{2,}$/i.test(r.value) : r.kind === "link" && publicUrl(r.url) && !schoolUrl(r.url))).slice(0, 5) : [];
    const base = { routes, checkedAt: fresh ? saved.checkedAt : null, evidence: fresh ? text(saved.evidence) : "", restrictedOriginal: report?.status === "school-login" || fresh && saved.status === "school-login" };
    if (report?.status === "unavailable") return { ...base, routes: [], status: "unavailable", label: "你标记原站入口失效", evidence: "本机手动记录，可在投递渠道窗口撤销" };
    if (routes.length) return { ...base, status: routes.some((r) => r.kind === "link") ? "link" : "email", label: routes.some((r) => r.kind === "link") ? "原文提供校外报名链接" : "原文提供简历邮箱" };
    if (base.restrictedOriginal) return { ...base, status: "school-login", label: "原站需要院校账号", evidence: report?.status ? "用户手动标记：原站需要院校账号" : saved.evidence };
    if (fresh && saved.status === "school-unknown") return { ...base, status: "school-unknown", label: "校站登录要求待核实" };
    if (fresh && saved.status === "login") return { ...base, status: "platform", label: "原平台需要账号登录" };
    if (job.sourceType === "12" || (/(?:大学|学院|高校)/.test(source) && !/国家大学生就业服务平台/.test(source)) || schoolUrl(job.detailUrl)) return { ...base, status: "school-unknown", label: "校站投递入口待核实", evidence: base.evidence || "来自高校渠道，尚未找到校外报名链接或简历邮箱" };
    if (/国家大学生就业服务平台|智联|前程无忧|实习僧|国聘|猎聘|BOSS|牛客|中华英才|全联人才|一览英才|北森|中智招聘/.test(source)) return { ...base, status: "platform", label: "原平台账号与投递条件待确认", evidence: base.evidence || "根据来源识别为平台渠道；未验证账号注册及最终提交条件" };
    return { ...base, status: "unknown", label: "投递方式尚未核实", evidence: base.evidence || "读取到岗位信息，尚未找到明确的投递方式" };
  }
  function matchesAccess(job, scope = "off-campus", report) {
    const access = applicationAccess(job, report);
    if (scope === "all") return true;
    if (scope === "public") return ["link", "email"].includes(access.status);
    if (scope === "school") return ["school-login", "school-unknown"].includes(access.status);
    if (scope === "unknown") return ["unknown", "unavailable"].includes(access.status);
    return ["link", "email", "platform"].includes(access.status);
  }
  function iso(s) {
    if (!s) return null;
    const n = typeof s === "number" ? s : String(s).trim();
    const d = new Date(typeof n === "string" && /^\d{10,13}$/.test(n) ? Number(n) * (n.length === 10 ? 1000 : 1) : n);
    return Number.isNaN(d.valueOf()) ? null : d.toISOString();
  }
  function profile(value = {}) {
    const p = { ...DEFAULT_PROFILE, ...value };
    p.roles = list(p.roles).filter((s) => /[^\s，,、;；]/.test(s)).map((s) => s.slice(0, 100)).slice(0, 6); p.regions = list(p.regions).slice(0, 20);
    p.skills = list(p.skills).map((s) => s.slice(0, 60)).slice(0, 20);
    p.major = text(p.major).slice(0, 100); p.schoolName = text(p.schoolName).slice(0, 100);
    if (!Object.hasOwn(CAREER_NAMES, p.careerStage)) p.careerStage = "unknown";
    for (const [key, max] of [["experienceYears", 60], ["availableDays", 7], ["internMonths", 36]]) p[key] = p[key] === "" || p[key] == null || !Number.isFinite(Number(p[key])) ? null : Math.min(max, Math.max(0, Number(p[key])));
    p.types = list(p.types).filter((s) => Object.hasOwn(TYPE_NAMES, s));
    p.minMonthly = Math.max(0, Number(p.minMonthly) || 0); p.minDaily = Math.max(0, Number(p.minDaily) || 0);
    p.maxAgeDays = [7, 30, 90, 365].includes(Number(p.maxAgeDays)) ? Number(p.maxAgeDays) : 30;
    p.pageLimit = Math.min(3, Math.max(1, Number(p.pageLimit) || 2));
    p.strictRegion = Boolean(p.strictRegion); p.strictSalary = Boolean(p.strictSalary);
    if (!Object.hasOwn(DEGREE_NAMES, p.degree)) p.degree = "unknown";
    if (!["transfer", "regular", "other"].includes(p.route)) p.route = "other";
    if (!["ordinary", "211", "985", "double-first", "unknown"].includes(p.schoolTier)) p.schoolTier = "unknown";
    if (!/^(?:19|20)\d{2}-(0[1-9]|1[0-2])$/.test(p.graduation)) p.graduation = "";
    return p;
  }
  function profileReady(p) { return Boolean(p.roles?.some((role) => text(role))); }
  function roleTerms(p) {
    const aliases = { "视觉设计": "视觉", "平面设计": "平面", "新媒体设计": "新媒体", "AIGC": "AIGC" };
    return list(p.roles.map((r) => aliases[r] || r)).slice(0, 6);
  }
  function matchesRoles(job, p) {
    if (!p.roles.length) return true;
    const title = text(job.title).toLowerCase(), major = text(job.major).toLowerCase();
    const haystack = `${title} ${job.description || ""}`.toLowerCase();
    return p.roles.some((r) => {
      const term = r.toLowerCase();
      if (/视觉设计|平面设计/.test(r) && /机器视觉|机械视觉|视觉算法|视觉工程师/.test(title) && !/传达|平面|艺术|美术|数字媒体/.test(major)) return false;
      if (r === "视觉设计") return /视觉.{0,5}(设计|创意|策划|实习)|视觉创作/.test(haystack);
      if (r === "新媒体设计") return /新媒体/.test(haystack);
      if (r === "AIGC" && /设计|艺术|美术/.test(p.major) && /算法|自动驾驶|研发工程师|软件工程|模型训练/.test(title) && !/视觉设计|美术|创意|内容创作/.test(title)) return false;
      return haystack.includes(term);
    });
  }
  function normalizeJob(raw, source, checkedAt) {
    const detailUrl = canonical(raw.detailUrl); if (!detailUrl || !text(raw.title)) return null;
    return { ...raw, id: hash(detailUrl), detailUrl, title: text(raw.title), company: text(raw.company),
      companyKnown: Boolean(text(raw.company)), sourceId: source.id, sourceName: source.name,
      sourceUrl: source.url, sourceIds: [source.id], publishedAt: iso(raw.publishedAt), updatedAt: iso(raw.updatedAt),
      deadline: iso(raw.deadline), lastCheckedAt: checkedAt, firstSeenAt: raw.firstSeenAt || checkedAt,
      description: text(raw.description).slice(0, 18000), major: text(raw.major), location: text(raw.location),
      degree: text(raw.degree), kind: raw.kind === "announcement" ? "announcement" : "job",
      detailVerified: Boolean(raw.detailVerified), status: raw.status || "listed", legacy: false };
  }
  function assess(job, p, now = Date.now()) {
    const evidence = `${job.title} ${job.description || ""}`;
    const reasons = [], cautions = [], excluded = [];
    const tags = [];
    if (job.intern || /实习|intern\b/i.test(job.title) || /实习生招聘|实习岗位|岗位性质.{0,5}实习|internship/i.test(evidence)) tags.push("intern");
    if (/校园招聘|校招|应届|毕业生|20\d{2}届/.test(evidence)) tags.push("campus");
    if (/秋招|秋季.{0,6}招聘/.test(evidence)) tags.push("autumn");
    if (/社会招聘|社招/.test(evidence)) tags.push("social");
    if (!tags.length) tags.push("unknown");
    if (job.kind === "announcement") cautions.push("综合招聘公告，岗位与条件请逐项确认");
    const level = /博士/.test(job.degree) ? 4 : /硕士|研究生/.test(job.degree) ? 3 : /本科/.test(job.degree) ? 2 : /专科|大专/.test(job.degree) ? 1 : /高中|中专|中职|技校/.test(job.degree) ? 0 : -1;
    const own = { secondary: 0, college: 1, bachelor: 2, master: 3, doctor: 4 }[p.degree];
    if (own !== undefined && level > own && job.kind !== "announcement") excluded.push(`学历要求：${job.degree}`);
    if (own === undefined) cautions.push("尚未填写学历，学历条件待核对");
    const transferNo = /(?:不接受|不含|不包括|不招收|排除).{0,8}专升本|专升本.{0,6}(?:除外|不接受|不符合)/.exec(evidence);
    const transferYes = /(?:接受|包含|包括|含|可报考|可报名).{0,8}专升本|专升本.{0,8}(?:可报名|可报考|可以报|均可|可投递)/.exec(evidence);
    if (p.route === "transfer" && transferNo) (job.kind === "announcement" ? cautions : excluded).push(transferNo[0]);
    const elite = /(?:仅限|限于|须为|必须为).{0,15}(?:985|211|双一流)|(?:985|211|双一流).{0,8}(?:院校毕业生|高校毕业生).{0,5}(?:方可|限定)/.exec(evidence);
    if (elite) cautions.push(`院校限制：${elite[0]}`);
    if (elite && p.schoolTier === "ordinary" && job.kind !== "announcement") excluded.push("存在指定院校限制，当前普通院校资料不符合");
    const years = [...evidence.matchAll(/(20\d{2})届/g)].map((m) => m[1]);
    if (p.graduation && years.length && !years.includes(p.graduation.slice(0, 4))) (job.kind === "announcement" ? cautions : excluded).push(`届别不符：公告面向 ${list(years).join("、")} 届`);
    if (/([2-9]|十)[年－-]?[年]?以上.{0,8}(工作|从业|相关).*经验|(?:工作|相关)经验.{0,5}[2-9]年|[2-9]年以上.{0,5}(?:工作|相关)经验/.test(evidence)) cautions.push(`有工作经验要求，请核对${p.experienceYears == null ? "自己的工作年限" : `已填写的 ${p.experienceYears} 年经历`}`);
    if (job.deadline && new Date(job.deadline).valueOf() < now) excluded.push("已过公告报名截止时间");
    if (job.status === "closed") excluded.push("详情页显示已结束或下线");
    const ageBase = job.publishedAt;
    const age = ageBase ? Math.floor((now - new Date(ageBase).valueOf()) / 86400000) : null;
    const fresh = !job.legacy && age !== null && age >= 0 && age <= p.maxAgeDays;
    if (!job.detailVerified) cautions.push("详情尚未完整核实");
    if (!ageBase) cautions.push("来源未提供原始发布日期");
    if (p.route === "transfer" && !transferNo && !transferYes) cautions.push("专升本是否可报：公告未明确，需向招聘方确认");
    if (/第一学历|起点本科/.test(evidence)) cautions.push("存在第一学历表述，请核对完整要求");
    const regionMatch = !p.regions.length || p.regions.some((r) => job.location.includes(r));
    const remote = /全国|远程/.test(job.location);
    if (p.strictRegion && !regionMatch && !remote) excluded.push("工作地不在设定范围或未注明");
    let salaryMatch = true;
    if (job.salaryUnit === "day" && p.minDaily) salaryMatch = Number(job.salaryLow) >= p.minDaily;
    else if (job.salaryUnit === "month" && p.minMonthly) salaryMatch = Number(job.salaryLow) >= p.minMonthly;
    else if ((p.minMonthly || p.minDaily) && !job.salaryLow) { salaryMatch = false; cautions.push("薪资未公开或面议"); }
    if (p.strictSalary && !salaryMatch) excluded.push("公开薪资下限未达到设定值，或薪资待确认");
    else if (!salaryMatch && job.salaryLow) cautions.push("公开薪资下限低于你的期望");
    let score = 0;
    const roleMatch = matchesRoles(job, p);
    if (roleMatch) { score += 35; reasons.push("岗位方向匹配"); }
    if (regionMatch || remote) { score += 25; reasons.push(regionMatch ? "意向地区匹配" : "全国／远程岗位"); }
    if (tags.some((t) => p.types.includes(t))) { score += 20; reasons.push("招聘类型匹配"); }
    const skillHits = (p.skills || []).filter((skill) => evidence.toLowerCase().includes(skill.toLowerCase()));
    if (skillHits.length) { score += Math.min(10, skillHits.length * 2); reasons.push(`正文提及技能：${skillHits.slice(0, 5).join("、")}`); }
    if (fresh) score += 10;
    if (salaryMatch && job.salaryLow) score += Math.min(10, Math.floor(job.salaryLow / (job.salaryUnit === "day" ? 30 : 1000)));
    if (transferYes && p.route === "transfer") { score += 5; reasons.push(`专升本表述：${transferYes[0]}`); }
    let eligibility = "unknown";
    if (excluded.length) eligibility = "excluded";
    else if (transferYes && p.route === "transfer" && job.detailVerified && job.kind !== "announcement") eligibility = "education-explicit";
    else if (level >= 0 && level <= own && job.kind !== "announcement") eligibility = "degree-match";
    return { score, roleMatch, regionMatch, salaryMatch, tags, fresh, age, eligibility, excluded, cautions, reasons,
      evidence: { degree: job.degree || "未注明", transfer: transferNo?.[0] || transferYes?.[0] || "未明确", graduation: list(years).join("、") || "未明确" } };
  }
  function mergeJobs(found, previous) {
    const byId = new Map(previous.map((j) => [j.id, j]));
    for (const job of found) {
      const old = byId.get(job.id);
      const verified = old?.detailVerified && !job.detailVerified;
      byId.set(job.id, { ...old, ...job, intern: Boolean(old?.intern || job.intern), description: verified ? old.description : job.description,
        applyInfo: job.applyInfo || old?.applyInfo || null,
        detailVerified: verified || job.detailVerified, firstSeenAt: old?.firstSeenAt || job.firstSeenAt,
        sourceIds: list([...(old?.sourceIds || []), ...(job.sourceIds || [])]) });
    }
    return [...byId.values()].sort((a, b) => new Date(b.publishedAt || b.updatedAt || 0) - new Date(a.publishedAt || a.updatedAt || 0)).slice(0, 1200);
  }
  function groupSimilar(jobs) {
    const groups = new Map();
    for (const job of jobs) {
      const key = job.company && job.kind !== "announcement" ? JSON.stringify([text(job.company), text(job.title), text(job.location), text(job.degree), job.salaryLow || 0, job.salaryHigh || 0, job.salaryUnit, job.publishedAt?.slice(0, 10) || "", Boolean(job.legacy)]) : job.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    return [...groups.values()];
  }
  return { VERSION: "2.4.0", BUILD_ID: "20261021-apply-access-1", SOURCE_CATALOG: 3, DEFAULT_PROFILE, SOURCES, STAGES, TYPE_NAMES, DEGREE_NAMES, CAREER_NAMES, ROLE_TEMPLATES, platforms, text, list, hash, safeUrl, publicUrl, schoolUrl, applicationAccess, matchesAccess, canonical, iso, profile, profileReady, roleTerms, matchesRoles, normalizeJob, assess, mergeJobs, groupSimilar };
})();

