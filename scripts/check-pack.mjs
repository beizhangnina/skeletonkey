import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'skeletonkey-pack-'));
try {
  const home = path.join(temp, 'home');
  const prefix = path.join(temp, 'prefix');
  const fakeBin = path.join(temp, 'fake-bin');
  mkdirSync(home);
  mkdirSync(fakeBin);
  for (const name of ['bw', 'op', 'security', 'secret-tool']) {
    writeFileSync(path.join(fakeBin, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  }
  // Do not inherit credentials, application overrides, or user npm configuration.
  const env = {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    SKELETONKEY_HOME: path.join(home, '.skeletonkey'),
    BITWARDENCLI_APPDATA_DIR: path.join(home, '.bitwarden'),
    npm_config_cache: path.join(temp, 'cache'),
    npm_config_userconfig: path.join(temp, 'npmrc'),
    npm_config_globalconfig: path.join(temp, 'global-npmrc'),
    npm_config_audit: 'false', npm_config_fund: 'false',
  };
  const run = (bin, args, cwd = temp) => {
    try {
      return execFileSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // Never echo subprocess output or inherited configuration on failure.
      throw new Error(`Package check failed: ${path.basename(bin)} ${args[0]}`);
    }
  };
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  // Publish readiness: the scoped name is claimed, `private` is gone, and the
  // scope is published publicly rather than restricted-by-default.
  assert.equal(manifest.name, '@beizhang/skeletonkey');
  assert.equal(manifest.private, undefined, '"private" must be absent so the package can be published');
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.equal(manifest.scripts?.prepublishOnly, 'npm run build && npm test');
  assert.equal(manifest.homepage, 'https://skeletonkey.run');
  const dry = JSON.parse(run('npm', ['pack', '--dry-run', '--json'], root))[0];
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], root))[0];
  const paths = packed.files.map(file => file.path).sort();
  // A zero-byte file in the tarball is always a mistake: an unfinished doc, a
  // stray placeholder, a build that half-ran.
  for (const file of packed.files) {
    assert.ok(file.size > 0, `Empty file in the package: ${file.path}`);
  }
  assert.deepEqual(paths, dry.files.map(file => file.path).sort());
  const allowed = /^(?:package\.json|README\.md|LICENSE|apis\.yaml|dist\/(?:[\w-]+\/)*[\w-]+\.(?:js|d\.ts)|data\/apis\/[\w-]+\.yaml|data\/apis\/README\.md|data\/discovered\.example\.yaml|skills\/[\w-]+\/SKILL\.md|docs\/[\w.-]+\.md)$/;
  for (const file of paths) assert.ok(allowed.test(file), `Unexpected package file: ${file}`);
  // Refused whatever the allow-list says, so a later loosening cannot ship
  // these by accident: raw catalog downloads, the catalog build scripts, the
  // sources and tests, and anything secret-shaped.
  const forbidden = [
    /^data\/apis\/raw\//, /^data\/apis\/scripts\//, /\.py$/, /(^|\/)\.ignore$/,
    /^test\//, /^src\//, /^scripts\//, /\.map$/,
    /(^|\/)\.env/, /(^|\/)\.npmrc$/, /vault(\.enc)?\.json$/, /dev-vault\.json$/,
    /(^|\/)discovered\.yaml$/, /\.(?:db|sqlite3?|pem|key|p12)$/,
  ];
  for (const file of paths) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(file), `File must never be published: ${file} (matched ${pattern})`);
    }
  }
  for (const file of ['dist/index.js', 'README.md', 'LICENSE', 'apis.yaml', 'data/discovered.example.yaml', 'skills/skeletonkey/SKILL.md', ...Object.values(manifest.bin).map(file => file.replace(/^\.\//, ''))]) {
    assert.ok(paths.includes(file), `Missing package file: ${file}`);
  }
  for (const file of readdirSync(path.join(root, 'data/apis')).filter(file => file.endsWith('.yaml'))) {
    assert.ok(paths.includes(`data/apis/${file}`));
  }
  run('npm', ['install', '-g', '--prefix', prefix, '--ignore-scripts', path.join(temp, packed.filename)]);
  const installed = path.join(prefix, 'lib/node_modules', manifest.name);
  const installedManifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(installedManifest.name, manifest.name);
  assert.equal(installedManifest.private, undefined);
  for (const name of Object.keys(manifest.bin)) {
    const help = run(path.join(prefix, 'bin', name), ['--help']);
    assert.match(help, /Usage:/);
    assert.match(help, /Options:/);
    if (name === 'skeletonkey-runner') assert.match(help, /--port/);
    else assert.match(help, /init/);
  }
  assert.deepEqual(readdirSync(home), [], 'Help must not create user state');
  console.log(`Package check passed: ${paths.length} files; all ${Object.keys(manifest.bin).length} installed bins show help.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
