const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const extension = path.join(__dirname, '..', 'extension');

function environment(initial = {}) {
  const state = {
    schemaVersion: 2, sourceCatalogVersion: 3, applyAccessSchema: 1,
    jobs: [], applications: {}, sources: [],
    profile: { roles: ['软件测试'], degree: 'bachelor', route: 'regular', regions: ['江苏'] },
    ...structuredClone(initial)
  };
  const chrome = {
    runtime: { id: 'local-test', onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getURL: p => 'chrome-extension://local-test/' + p },
    storage: { local: { get: async () => structuredClone(state), set: async patch => Object.assign(state, structuredClone(patch)) } },
    alarms: { onAlarm: { addListener() {} }, clear: async () => {}, create: async () => {} },
    permissions: { contains: async () => true }, notifications: { create: async () => {} },
    tabs: { query: async () => [], create: async () => {} }
  };
  const ctx = vm.createContext({
    URL, URLSearchParams, TextDecoder, AbortController, setTimeout, clearTimeout, console, chrome,
    fetch: async () => { throw Error('No network permitted in offline tests'); },
    importScripts: (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(extension, file), 'utf8'), ctx))
  });
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), ctx);
  return {
    state, ctx, R: ctx.Radar, S: ctx.RadarSources,
    route: message => { ctx.message = message; return vm.runInContext('route(message)', ctx); },
    run: code => vm.runInContext(code, ctx)
  };
}
function job(extra = {}) {
  return {
    id: 'sample-job', title: '软件测试实习生', company: '示例科技有限公司', location: '江苏',
    degree: '本科及以上', description: '软件测试实习岗位',
    detailUrl: 'https://example.com/jobs/testing-role', publishedAt: new Date().toISOString(),
    sourceLabel: '智联招聘', kind: 'job', ...extra
  };
}
function info(routes = []) { return { version: 1, checkedAt: new Date().toISOString(), status: 'checked', routes }; }

test('fresh installations have no personal defaults', () => {
  const { R } = environment(), p = R.profile();
  assert.equal(p.major, ''); assert.equal(p.graduation, ''); assert.equal(p.roles.length, 0);
  assert.equal(p.regions.length, 0); assert.equal(p.degree, 'unknown'); assert.equal(R.profileReady(p), false);
});
test('blank role save rejects without altering the stored profile', async () => {
  const e = environment();
  await assert.rejects(e.route({ type: 'saveProfile', profile: { roles: [' ', '，'] } }), /目标岗位/);
  assert.equal(e.state.profile.roles[0], '软件测试');
});
test('a new profile can choose unrelated roles, education and region', async () => {
  const e = environment();
  await e.route({ type: 'saveProfile', profile: { roles: ['会计'], degree: 'college', regions: ['广东'], skills: ['Excel'], graduation: '2029-06' } });
  assert.equal(e.state.profile.roles[0], '会计'); assert.equal(e.state.profile.degree, 'college');
  assert.equal(e.state.profile.regions[0], '广东'); assert.equal(e.state.profile.major, '');
});
test('a known platform is conditional access, not confirmed public submission', () => {
  const { R } = environment(), j = job();
  assert.equal(R.applicationAccess(j).status, 'platform'); assert.equal(R.matchesAccess(j, 'public'), false);
});
test('a readable college listing is hidden from the default off-campus scope', () => {
  const { R } = environment(), j = job({ sourceLabel: '示例学院', sourceType: '12', detailVerified: true });
  assert.equal(R.applicationAccess(j).status, 'school-unknown');
  assert.equal(R.matchesAccess(j), false); assert.equal(R.matchesAccess(j, 'all'), true);
});
test('a college listing with a public resume email remains accessible', () => {
  const { R } = environment(), j = job({ sourceLabel: '示例学院', applyInfo: info([{ kind: 'email', value: 'hiring@example.com' }]) });
  assert.equal(R.applicationAccess(j).status, 'email'); assert.equal(R.matchesAccess(j, 'public'), true);
});
test('stale application evidence does not establish a current public route', () => {
  const { R } = environment(), j = job({ applyInfo: { ...info([{ kind: 'email', value: 'hiring@example.com' }]), checkedAt: '2000-01-01' } });
  assert.equal(R.matchesAccess(j, 'public'), false);
});
test('student login HTML is detected without claiming verified job details', () => {
  const { S } = environment(), html = '<h1>学生登录</h1>请输入学号<input type="password">';
  assert.equal(S.loginGate(html, 'https://college.example.edu.cn/login'), 'school-login');
  const enriched = S.enrichResponse(job(), html, 'https://college.example.edu.cn/login');
  assert.equal(enriched.applyInfo.status, 'school-login'); assert.notEqual(enriched.detailVerified, true);
});
test('resume email extraction excludes the site footer', () => {
  const { S } = environment(), j = job({ detailUrl: 'https://www.ncss.cn/student/jobs/example/detail.html' });
  const html = '<pre class="mainContent">简历投递：hiring@example.com</pre><footer>招聘咨询 admin@example.com</footer>';
  const routes = S.applicationInfo(j, html).routes;
  assert.equal(routes.length, 1); assert.equal(routes[0].value, 'hiring@example.com');
});
test('nested job sections are retained while footer text stays excluded', () => {
  const { S } = environment();
  const text = S.detailText('<div class="mainContent"><div>岗位职责：测试</div><div>接受专升本</div></div><footer>不接受专升本</footer>', 'https://www.ncss.cn/student/jobs/example/detail.html');
  assert.match(text, /岗位职责.*接受专升本/); assert.doesNotMatch(text, /不接受/);
});
test('application links exclude scripts, loopback and school account routes', () => {
  const { S } = environment(), j = job({ detailUrl: 'https://www.ncss.cn/student/jobs/example/detail.html' });
  const html = '<pre class="mainContent"><a href="javascript:alert(1)">投递</a><a href="http://127.0.0.1/apply">申请</a><a href="https://college.jysd.com/login">投递</a><a href="https://careers.example.com/jobs/test">网申</a></pre>';
  const routes = S.applicationInfo(j, html).routes;
  assert.equal(routes.length, 1); assert.equal(routes[0].url, 'https://careers.example.com/jobs/test');
});
test('unknown education is not a confirmed eligibility match', () => {
  const { R } = environment(), a = R.assess(job({ degree: '' }), R.profile({ roles: ['软件测试'], degree: 'unknown' }));
  assert.equal(a.eligibility, 'unknown'); assert.equal(a.excluded.length, 0);
});
test('explicit education and deadline failures are both preserved', () => {
  const { R } = environment(), a = R.assess(job({ deadline: '2000-01-01' }), R.profile({ roles: ['软件测试'], degree: 'college' }));
  assert.equal(a.eligibility, 'excluded'); assert.ok(a.excluded.length >= 2);
});
test('daily and monthly salary thresholds are compared independently', () => {
  const { R } = environment(), p = R.profile({ roles: ['软件测试'], minDaily: 180, minMonthly: 8000 });
  assert.equal(R.assess(job({ salaryUnit: 'day', salaryLow: 200 }), p).salaryMatch, true);
  assert.equal(R.assess(job({ salaryUnit: 'month', salaryLow: 5000 }), p).salaryMatch, false);
});
test('tracking parameters do not create new job identities', () => {
  const { R } = environment();
  assert.equal(R.canonical('https://example.com/job?id=1&utm_source=feed'), R.canonical('https://example.com/job?id=1'));
});
test('similarity grouping keeps different companies and salaries separate', () => {
  const { R } = environment();
  const groups = R.groupSimilar([job(), job({ id: 'duplicate' }), job({ id: 'other-company', company: '另一家示例公司' }), job({ id: 'other-pay', salaryLow: 5000 })]);
  assert.equal(groups.length, 3);
});
test('school-account feedback is reversible and preserves interview tracking', async () => {
  const e = environment({ jobs: [job()], applications: { 'sample-job': { stage: 'interview', job: job() } } });
  await e.route({ type: 'reportApplyAccess', jobId: 'sample-job', status: 'school-login' });
  assert.equal(e.state.accessReports['sample-job'].status, 'school-login');
  await e.route({ type: 'reportApplyAccess', jobId: 'sample-job', status: 'clear' });
  assert.equal(e.state.accessReports['sample-job'], undefined); assert.equal(e.state.applications['sample-job'].stage, 'interview');
});
test('a blank profile cannot start public source requests', async () => {
  const e = environment({ profile: {}, sources: [{ id: 'sample', enabled: true, url: 'https://example.com/jobs', adapter: 'html' }] });
  let requests = 0;
  e.ctx.fetch = async () => { requests++; throw Error('Unexpected request'); };
  await e.run('startScan("all")');
  assert.equal(requests, 0);
});
test('checking the same public listing twice does not invent new jobs', async () => {
  const e = environment({ sources: [{ id: 'sample', name: '示例公开来源', enabled: true, url: 'https://example.com/jobs', adapter: 'html' }] });
  e.ctx.sampleItems = [job()];
  e.run('RadarSources.fetchSource=async()=>({items:sampleItems,queries:["https://example.com/jobs"],errors:[],method:"合成列表",coverage:"第一页"}); RadarSources.enrich=async()=>[];');
  await e.run('startScan("all")'); assert.equal(e.state.scan.newCount, 1);
  await e.run('startScan("all")'); assert.equal(e.state.scan.newCount, 0); assert.equal(e.state.jobs.length, 1);
});
