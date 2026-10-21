/* Public read-only sources. No login automation, CAPTCHA workarounds or private APIs. */
globalThis.RadarSources = (() => {
  const R = Radar;
  const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
    const point = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
  });
  function plain(html) { return R.text(decode(String(html || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ").replace(/<[^>]+>/g, " "))); }
  function networkError(e) {
    if (e.name === "AbortError" || e.name === "TimeoutError") return "请求超过 15 秒未完成";
    if (/fetch|network/i.test(e.message)) return "网络请求失败，请检查网站访问权限、网络、代理或网站限制";
    return e.message || "未知读取错误";
  }
  let active = 0;
  const waiting = [];
  async function request(url) {
    if (active >= 3) await new Promise((resolve) => waiting.push(resolve)); else active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const target = R.safeUrl(url); if (!target) throw Error("仅支持 HTTP/HTTPS 来源链接");
      const allowed = await chrome.permissions.contains({ origins: [`${new URL(target).origin}/*`] });
      if (!allowed) throw Error("缺少网站访问权限，请在扩展详情中允许访问该网站");
      const response = await fetch(target, { cache: "no-store", credentials: "omit", signal: controller.signal,
        headers: { Accept: "application/json,text/html,application/xml;q=0.9,*/*;q=0.8" } });
      if (!response.ok) throw Error(`HTTP ${response.status}：${[401, 403, 412, 429].includes(response.status) ? "网站限制访问，需手动打开确认" : "来源未返回正常响应"}`);
      const bytes = await response.arrayBuffer();
      const head = new TextDecoder().decode(bytes.slice(0, 2048));
      const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || "utf-8";
      let content;
      try { content = new TextDecoder(charset).decode(bytes); } catch { content = new TextDecoder().decode(bytes); }
      const probe = plain(content);
      if (!/^\s*[\[{]/.test(content) && probe.length < 2500 && /请完成.{0,12}验证|安全验证|访问过于频繁|verify you are human|access denied|just a moment/i.test(probe)) throw Error("网站要求验证，不能在后台自动读取");
      if (/aliyun_waf|acw_sc__v2|id=["']renderData["']/.test(content) && !/<a[^>]+(?:job|recruit|detail)/i.test(content)) throw Error("网站返回访问验证页面，未获取到招聘列表");
      return { content, url: response.url || target, checkedAt: new Date().toISOString() };
    } catch (e) { throw Error(networkError(e)); }
    finally { clearTimeout(timer); const next = waiting.shift(); if (next) next(); else active--; }
  }
  async function json(url) {
    const response = await request(url);
    let value;
    try { value = JSON.parse(response.content); } catch { throw Error("来源没有返回职位 JSON，可能是登录、验证页或接口已变化"); }
    if (value.flag === false) throw Error(value.global?.[0]?.des || "来源拒绝了职位查询");
    return value;
  }
  async function mapLimit(values, limit, fn) {
    let next = 0; const output = new Array(values.length);
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) { const index = next++; output[index] = await fn(values[index], index); }
    }));
    return output;
  }
  function ncssJob(raw, source) {
    return { jobId: raw.jobId, title: raw.jobName, company: raw.recName, degree: raw.degreeName,
      major: raw.major, location: raw.areaCodeName, companyType: raw.recProperty, companySize: raw.recScale,
      benefits: raw.recTags, sourceLabel: raw.sourcesNameCh || "国家大学生就业服务平台", sourceType: String(raw.sourcesType ?? ""),
      detailUrl: `https://www.ncss.cn/student/jobs/${encodeURIComponent(raw.jobId)}/detail.html`,
      companyUrl: raw.recId && !/^(?:-|null|undefined|0)$/i.test(String(raw.recId)) ? `https://www.ncss.cn/student/company/${encodeURIComponent(raw.recId)}/index.html` : "",
      publishedAt: raw.publishDate, updatedAt: raw.updateDate, intern: source.jobType === "03",
      salaryLow: Number(raw.lowMonthPay) * 1000 || 0, salaryHigh: Number(raw.highMonthPay) * 1000 || 0,
      salaryUnit: "month", salaryEvidence: "平台月薪字段", description: "", detailVerified: false, kind: "job" };
  }
  async function ncss(source, p, progress) {
    const terms = R.roleTerms(p); if (!terms.length) terms.push("");
    const queries = [];
    const queryReports = [];
    const items = [];
    const errors = [];
    await mapLimit(terms, 2, async (term) => {
      for (let page = 1; page <= p.pageLimit; page++) {
        const params = new URLSearchParams({ offset: String(page), limit: "20", jobType: source.jobType || "", jobName: term });
        if (source.feed) params.set("sourcesName", source.feed);
        const endpoint = `https://www.ncss.cn/student/jobs/jobslist/ajax/?${params}`;
        try {
          const data = await json(endpoint);
          if (!Array.isArray(data.data?.list)) throw Error("职位接口字段已变化，未获得 list 数组");
          const rows = data.data.list.filter((r) => r.jobId && r.jobName);
          queries.push(endpoint);
          items.push(...rows.map((row) => ncssJob(row, source)));
          queryReports.push({ term, page, returned: rows.length, available: Number(data.data.pagenation?.count) || 0 });
          await progress(`${term || "全部方向"} · 第 ${page} 页，读取 ${rows.length} 条`);
          if (!rows.length || rows.length < 20 || page * 20 >= Number(data.data.pagenation?.count || Infinity)) break;
        } catch (e) { errors.push(`${term || "全部方向"} 第 ${page} 页：${e.message}`); break; }
      }
    });
    if (!queries.length) throw Error(errors.join("；") || "未取得职位列表");
    return { items: [...new Map(items.map((j) => [j.detailUrl, j])).values()], queries, queryReports, errors,
      method: source.feed ? "国家平台公开聚合 JSON（非原平台全量接口）" : "国家平台公开职位及外部聚合 JSON", truncated: queryReports.some((r) => r.available > p.pageLimit * 20),
      coverage: `按 ${terms.length} 个方向检索，每方向最多 ${p.pageLimit} 页 × 20 条；并非平台全部岗位` };
  }
  function parseTiangong(html, source) {
    const items = [];
    for (const block of html.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || []) {
      const link = block.match(/<a\b[^>]*href=["']([^"']*\/correcruit\/content\/id\/\d+\.html)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const title = plain(link[2]);
      const company = plain(block.match(/<a\b[^>]*href=["'][^"']*\/company\/index[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]).replace(/^[【\[]|[】\]]$/g, "");
      const day = plain(block.match(/class=["']day["'][^>]*>([\s\S]*?)<\//i)?.[1]);
      const year = plain(block.match(/class=["']year["'][^>]*>([\s\S]*?)<\//i)?.[1]);
      const summary = plain(block.match(/<div\b[^>]*class=["']company["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
      const location = summary.replace(company, "").replace(/[【】]/g, "").split("/")[0].trim();
      items.push({ title, company, location, degree: /本科/.test(summary) ? "本科在学" : /硕士/.test(summary) ? "硕士" : "",
        detailUrl: R.safeUrl(link[1], source.url), publishedAt: /^\d{4}\.\d{2}$/.test(year) && /^\d{1,2}$/.test(day) ? `${year.replace(".", "-")}-${day.padStart(2, "0")}T00:00:00+08:00` : null,
        description: summary, kind: "announcement", detailVerified: false });
    }
    return items;
  }
  async function tiangong(source, p, progress) {
    const { content } = await request(source.url);
    const items = parseTiangong(content, source);
    if (!items.length) throw Error("高校招聘页结构变化，未读取到招聘公告");
    await progress(`读取最新列表 ${items.length} 条招聘公告`);
    return { items, queries: [source.url], errors: [], method: "高校公开招聘列表", truncated: true,
      coverage: "只读取当前最新列表页；公告内包含的多个岗位不拆分成虚假的岗位数量" };
  }
  function detailBody(html, url) {
    if (/\.ncss\.cn$/.test(new URL(url).hostname)) {
      const body = html.match(/<(pre|div)\b[^>]*class=["'][^"']*mainContent[^"']*["'][^>]*>/i);
      if (!body) throw Error("详情页未返回职位正文，无法核实要求");
      const start = body.index + body[0].length, tag = body[1];
      const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"); tokens.lastIndex = start;
      let depth = 1, token;
      while ((token = tokens.exec(html))) { depth += token[0].startsWith("</") ? -1 : 1; if (!depth) return html.slice(start, token.index); }
      throw Error("详情正文结构不完整，保留列表记录");
    }
    if (new URL(url).hostname === "jobs.tiangong.edu.cn") {
      const start = html.search(/<div\b[^>]*class=["']zpnr["']/i);
      if (start < 0) throw Error("高校公告正文结构已变化");
      const after = html.slice(start), end = after.search(/<div\b[^>]*class=["']bottom["']/i);
      return end > 0 ? after.slice(0, end) : after;
    }
    const body = html.match(/<div\b[^>]*(?:class|id)=["'][^"']*(?:content-info|content_info|v_news_content|article-content|article_content|job-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (body) return body;
    // Use the article region when a site does not expose a stable content class.
    const start = html.search(/(?:岗位职责|招聘对象|招聘简章|招聘专业|招聘岗位|工作职责|任职要求|职位描述|202[0-9].{0,20}校园招聘)/);
    if (start < 0) throw Error("无法定位招聘正文，保留列表记录并标记待核实");
    const after = html.slice(Math.max(0, start - 300));
    const end = after.search(/<div[^>]+class=["'][^"']*(?:footer|foot|copyright)/i);
    return end > 0 ? after.slice(0, end) : after;
  }
  function detailText(html, url) { return plain(detailBody(html, url)).slice(0, 18000); }
  function loginGate(html, url) {
    const body = plain(html);
    const password = /<input\b[^>]*type\s*=\s*["']?password\b/i.test(html);
    const ncBody = /<(?:pre|div)\b[^>]*class=["'][^"']*mainContent/.test(html);
    if (!ncBody && password && /学号|学生登录|统一身份认证|校园统一认证/.test(body)) return "school-login";
    if (!ncBody && R.schoolUrl(url) && /\/(?:login|signin|auth|cas)(?:\/|[.?]|$)/i.test(new URL(url).pathname) && /登录|认证|sign\s*in/i.test(body)) return "school-unknown";
    if (!ncBody && password && /登录|sign\s*in|log\s*in/i.test(body) && /login|signin|passport|auth/i.test(url)) return "login";
    return "";
  }
  function applicationInfo(job, html, finalUrl = job.detailUrl, region) {
    const checkedAt = new Date().toISOString(), gate = loginGate(html, finalUrl);
    if (gate) return { version: 1, checkedAt, status: gate, finalUrl: R.safeUrl(finalUrl), routes: [], evidence: gate === "school-login" ? "公开请求返回学号／学生身份认证登录页" : "公开请求返回账号登录页" };
    const content = region ?? detailBody(html, job.detailUrl);
    const description = plain(content), routes = [];
    const addEmail = (value, evidence) => {
      const email = value.replace(/^mailto:/i, "").split("?")[0].trim();
      if (!/^[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d.-]+\.[a-z]{2,}$/i.test(email)) return;
      if (!routes.some((r) => r.kind === "email" && r.value.toLowerCase() === email.toLowerCase())) routes.push({ kind: "email", value: email, evidence: R.text(evidence).slice(0, 180) });
    };
    const addLink = (value, evidence) => {
      const url = R.publicUrl(decode(value), job.detailUrl);
      if (!url || R.schoolUrl(url) || R.canonical(url) === R.canonical(job.detailUrl) || !/投递|网申|申请|报名|招聘入口|招聘官网|应聘/i.test(evidence)) return;
      const parsed = new URL(url);
      if (/\.(?:pdf|docx?|xlsx?|zip|png|jpe?g)(?:$|\?)/i.test(parsed.pathname) || /(?:logout|delete|unsubscribe|submit|sendresume)/i.test(parsed.pathname) || /(?:action|method)=(?:delete|send|submit)/i.test(parsed.search)) return;
      if (!routes.some((r) => r.url === url)) routes.push({ kind: "link", url, evidence: R.text(evidence).slice(0, 180) });
    };
    for (const match of content.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const context = plain(content.slice(Math.max(0, match.index - 100), match.index + match[0].length)).split(/[。；;]/).pop();
      if (/^mailto:/i.test(match[1])) { if (/简历|投递|应聘|招聘邮箱|报名邮箱/.test(context)) addEmail(decode(match[1]), context); }
      else addLink(match[1], `${plain(match[2])} ${context}`);
    }
    for (const match of description.matchAll(/[A-Z\d.!#$%&'*+/=?^_`{|}~-]+@[A-Z\d.-]+\.[A-Z]{2,}/gi)) {
      const before = description.slice(Math.max(0, match.index - 65), match.index).split(/[。；;]/).pop();
      const after = description.slice(match.index + match[0].length, match.index + match[0].length + 25).split(/[。；;]/)[0];
      const context = `${before}${match[0]}${after}`;
      if (/简历|投递|应聘|招聘邮箱|报名邮箱/.test(context)) addEmail(match[0], context);
    }
    for (const match of description.matchAll(/https?:\/\/[^\s<>"'，。；）)]+/gi)) {
      const context = description.slice(Math.max(0, match.index - 70), match.index + match[0].length).split(/[。；;]/).pop();
      addLink(match[0], context);
    }
    return { version: 1, checkedAt, status: "checked", finalUrl: R.safeUrl(finalUrl), routes: routes.slice(0, 5), evidence: routes.length ? "在公开招聘正文中找到报名链接或简历邮箱，提交条件仍需自行确认" : "已读取公开正文，尚未找到明确的校外报名链接或简历邮箱" };
  }
  function enrichText(job, description) {
    const deadline = description.match(/(?:报名截止(?:日期|时间)?|投递截止(?:日期|时间)?|申请截止(?:日期|时间)?)\s*[:：为至]?\s*(20\d{2})[年.\/-](\d{1,2})[月.\/-](\d{1,2})/);
    const daily = description.match(/(?:薪资|薪酬|实习补贴|日薪|工资)[^。；]{0,15}?(\d{2,4})\s*(?:[-~—至]\s*(\d{2,4}))?\s*元?\s*(?:\/|每)\s*(?:天|日)/);
    return { ...job, description, detailVerified: true, detailCheckedAt: new Date().toISOString(),
      ...(deadline ? { deadline: `${deadline[1]}-${deadline[2].padStart(2, "0")}-${deadline[3].padStart(2, "0")}T23:59:59+08:00` } : {}),
      ...(daily ? { salaryLow: Number(daily[1]), salaryHigh: Number(daily[2] || daily[1]), salaryUnit: "day", salaryEvidence: daily[0] } : {}),
      ...(/职位已下线|该岗位已停止招聘|该职位已结束|招聘已结束/.test(description) ? { status: "closed" } : {}) };
  }
  function enrichResponse(job, html, finalUrl = job.detailUrl) {
    const gate = loginGate(html, finalUrl);
    if (gate) return { ...job, applyInfo: applicationInfo(job, html, finalUrl), detailError: gate === "school-login" ? "原站需要院校账号，未获取公开正文" : "原站需要登录，正文未核实" };
    const region = detailBody(html, job.detailUrl);
    const result = { ...enrichText(job, plain(region).slice(0, 18000)), applyInfo: applicationInfo(job, html, finalUrl, region) };
    if (/\.ncss\.cn$/.test(new URL(job.detailUrl).hostname)) {
      const origin = html.match(/<span\b[^>]*class=["']source-sp["'][^>]*>([\s\S]*?)<\/span>/i);
      if (origin) { result.sourceLabel = plain(origin[1]); result.sourceType = origin[0].match(/data-sourcesType=["']([^"']*)/i)?.[1] || job.sourceType || ""; }
      const city = plain(html.match(/<div\b[^>]*class=["']site-tag["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
      if (city) { result.detailLocation = city; result.location = city; }
    }
    return result;
  }
  async function enrich(items, p, previous, progress) {
    const byId = new Map(previous.map((j) => [R.canonical(j.detailUrl), j]));
    const sorted = [...items].sort((a, b) => {
      const rank = (j) => (R.matchesRoles(j, p) ? 50 : 0) + (p.regions.some((r) => j.location?.includes(r)) ? 30 : 0);
      return rank(b) - rank(a);
    });
    const targets = sorted.filter((j) => {
      const cached = byId.get(R.canonical(j.detailUrl));
      if (cached?.detailVerified && cached.applyInfo?.version === 1 && Date.now() - new Date(cached.detailCheckedAt).valueOf() < 24 * 3600000 && Date.now() - new Date(cached.applyInfo.checkedAt).valueOf() < 24 * 3600000) {
        Object.assign(j, { description: cached.description, detailVerified: true, detailCheckedAt: cached.detailCheckedAt, deadline: cached.deadline,
          applyInfo: cached.applyInfo,
          ...(cached.detailLocation ? { detailLocation: cached.detailLocation, location: cached.detailLocation } : {}),
          ...(cached.salaryUnit === "day" ? { salaryUnit: "day", salaryLow: cached.salaryLow, salaryHigh: cached.salaryHigh, salaryEvidence: cached.salaryEvidence } : {}) });
        return false;
      }
      return R.matchesRoles(j, p) || j.kind === "announcement";
    }).slice(0, items[0]?.kind === "announcement" ? 8 : 10);
    const errors = [];
    await mapLimit(targets, 2, async (job, index) => {
      try { const { content, url } = await request(job.detailUrl); Object.assign(job, enrichResponse(job, content, url)); }
      catch (e) { errors.push({ url: job.detailUrl, error: e.message }); job.detailError = e.message; }
      await progress(`核实详情 ${index + 1}/${targets.length}：${job.title.slice(0, 35)}`);
    });
    return errors;
  }
  function collectPage() {
    const links = [];
    for (const a of document.querySelectorAll("a[href]")) {
      if (!a.getClientRects().length || getComputedStyle(a).visibility === "hidden") continue;
      const title = (a.innerText || a.getAttribute("aria-label") || a.title || "").replace(/\s+/g, " ").trim();
      if (title.length < 2 || title.length > 160) continue;
      const card = a.closest(".joblist-box,.joblist-item,.job-card,.job-item,.job-primary,.jobList,li,article");
      const company = card?.querySelector(".company-name,.company-text h3,.company-title,.company-ul h5,.company,.job-company")?.innerText || "";
      links.push({ href: a.href, title, company: company.slice(0, 160), context: (card?.innerText || "").slice(0, 1800) });
      if (links.length === 1500) break;
    }
    return { url: location.href, title: document.title, body: (document.body?.innerText || "").slice(0, 18000), links };
  }
  function isDetail(url) {
    const safe = R.safeUrl(url); if (!safe) return false;
    const u = new URL(safe), path = `${u.pathname}${u.hash}`;
    if (/shixiseng\.com$/.test(u.hostname) && /^\/intern\/inn_[\w-]+/.test(path)) return true;
    if (/jobs\.51job\.com$/.test(u.hostname) && /\/\d+\.html$/.test(u.pathname)) return true;
    if (/\/(?:job|jobs|position|detail)\/(?:list|search|index)(?:\/|$)/i.test(path)) return false;
    return /\/job_detail\/|\/student\/jobs\/[^/]+\/detail\.html|\/correcruit\/content\/id\/\d+|\/detail\/(?:online|job)|\/(?:job|jobs|position|detail)\/(?:detail|[\w-]{3,})(?:[/.?#]|$)/i.test(path)
      || /(?:jobid|positionid|job_id)=/i.test(u.search) || /\/jobs?\/detail/i.test(path);
  }
  function parsePage(page, source) {
    const links = [...(page.links || [])];
    if (isDetail(page.url) && !links.some((l) => R.canonical(l.href) === R.canonical(page.url))) links.unshift({ href: page.url, title: page.title, context: page.body || "", company: "" });
    const items = links.filter((l) => isDetail(l.href) && /招聘|校招|实习|职位|设计|视觉|新媒体|AIGC|岗位|工程|助理/i.test(`${l.title} ${l.context}`)).map((l) => ({
      title: l.title, detailUrl: l.href, company: l.company || "", description: l.context,
      kind: "job", detailVerified: false, publishedAt: null, location: "", degree: "" }));
    return { items: [...new Map(items.map((j) => [j.detailUrl, j])).values()], queries: [page.url], errors: [],
      method: "用户已打开的网页", truncated: true, coverage: "只读取当前已渲染的主页面链接；发布时间、学历与企业名称缺失时保持待核实" };
  }
  async function fetchSource(source, p, progress) {
    if (source.adapter === "ncss") return ncss(source, p, progress);
    if (source.adapter === "tiangong") return tiangong(source, p, progress);
    if (source.adapter === "manual") throw Error("此来源仅支持打开官网后使用“读取当前网页”，未接入自动接口");
    const { content } = await request(source.url);
    const links = [...content.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: R.safeUrl(decode(m[1]), source.url), title: plain(m[2]), context: "" }));
    return parsePage({ url: source.url, links }, source);
  }
  return { request, plain, decode, mapLimit, ncssJob, parseTiangong, detailBody, detailText, loginGate, applicationInfo, enrichText, enrichResponse, enrich, collectPage, parsePage, isDetail, fetchSource };
})();
