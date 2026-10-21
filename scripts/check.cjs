const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
for (const file of ['shared.js', 'sources.js', 'background.js', 'ui.js', 'upgrade.js']) {
  cp.execFileSync(process.execPath, ['--check', path.join(extension, file)], { stdio: 'pipe', windowsHide: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
const release = JSON.parse(fs.readFileSync(path.join(extension, 'release.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ctx = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(extension, 'shared.js'), 'utf8'), ctx);
if (manifest.version !== release.version || release.version !== ctx.Radar.VERSION || pkg.version !== release.version || release.buildId !== ctx.Radar.BUILD_ID) {
  throw Error('Version/build mismatch');
}
for (const file of ['dashboard.html', 'popup.html']) {
  const html = fs.readFileSync(path.join(extension, file), 'utf8');
  for (const match of html.matchAll(/<script[^>]*src="([^"]+)"/g)) {
    if (!fs.existsSync(path.join(extension, match[1]))) throw Error('Missing script ' + match[1]);
  }
  if (/<script[^>]+src="https?:/i.test(html)) throw Error('Unexpected remote executable script');
}
const profile = ctx.Radar.profile();
if (profile.roles.length || profile.major || profile.graduation || profile.regions.length) throw Error('Personal defaults must remain blank');
console.log('Source syntax, bundled scripts, blank defaults and release ' + release.version + ' verified.');
