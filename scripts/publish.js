#!/usr/bin/env node
'use strict';
/*
 * 一处打包，三处落地：
 *   1. release/            本项目安装包（并顺手装上本机）
 *   2. 安装包目录          给用户/自己留的 exe
 *   3. GitHub 源码镜像     可直接拖上 GitHub 的纯源码
 *
 * 用法：
 *   node scripts/publish.js              打包 + 同步 + 安装本机
 *   node scripts/publish.js --skip-build 复用现有 release-pub 产物
 *   node scripts/publish.js --no-install 不装本机
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
// 本次使用的打包输出目录，由 build() 选定（--skip-build 时留空，自动找上一次的产物）
let BUILD_DIR = '';

// 临时输出目录：release/ 里的 app.asar 常常被 Windows 僵尸句柄锁住，绕开它。
// 锁住的目录连删都删不掉，所以这里挨个试，挑第一个能删干净的用。
function pickBuildDir() {
  for (let i = 0; i < 20; i += 1) {
    const dir = path.join(root, i ? `release-pub-${i}` : 'release-pub');
    try {
      rmrf(dir);
      return dir;
    } catch (error) {
      // 被占用：换下一个
    }
  }
  throw new Error('找不到可用的打包输出目录（都还被系统占用）');
}
/*
 * 交付路径。
 * 公开仓库里不能写死作者本机的目录（既不体面，别人 clone 下来也跑不通），
 * 所以默认落在项目内的 publish-out/。想指到别处有两种办法：
 *   1) 在项目根放一个 publish.local.json（已被 .gitignore 忽略）：
 *        { "mirrorDir": "...", "installerDir": "..." }
 *   2) 环境变量 ORANGE_MIRROR_DIR / ORANGE_INSTALLER_DIR
 * 路径里的 ${version} 会替换成当前版本号。
 */
function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'publish.local.json'), 'utf8'));
  } catch (error) {
    return {};
  }
}
const localConfig = readLocalConfig();
const expand = value => String(value).replace(/\$\{version\}/g, version);
const resolvePath = value => (path.isAbsolute(value) ? value : path.join(root, value));
const OUT_DIR = resolvePath(expand(
  process.env.ORANGE_OUT_DIR || localConfig.outDir || 'publish-out',
));
const MIRROR_DIR = resolvePath(expand(
  process.env.ORANGE_MIRROR_DIR
  || localConfig.mirrorDir
  || path.join(OUT_DIR, `Orange-Music-${version}-源码`, `Orange-Music-${version}-源码`),
));
const INSTALLER_DIR = resolvePath(expand(
  process.env.ORANGE_INSTALLER_DIR || localConfig.installerDir || path.join(OUT_DIR, '安装包'),
));

// 只同步这些，node_modules / release / tmp 之类留在本机
const MIRROR_ITEMS = [
  'main.js', 'preload.js', 'package.json', 'README.md', 'LICENSE', '.gitignore',
  'renderer', 'online', 'assets', 'docs', 'scripts',
];

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const noInstall = args.includes('--no-install');

function log(msg) { console.log(`[publish] ${msg}`); }

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}

function build() {
  log(`打包 v${version} …`);
  BUILD_DIR = pickBuildDir();
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dist', '--', `-c.directories.output=${path.basename(BUILD_DIR)}`],
    // Node 22 起 .cmd 不能直接 spawn（CVE-2024-27980），Windows 上必须走 shell
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }
  );
}

/** --skip-build 时也要能找到上一次的产物：在 release-pub* 里挑最新的那个 exe */
function findBuiltExe() {
  return fs.readdirSync(root)
    .filter(name => /^release-pub/.test(name))
    .map(name => path.join(root, name, `Orange Music Setup ${version}.exe`))
    .filter(file => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
}

function distExe() {
  const exe = BUILD_DIR ? path.join(BUILD_DIR, `Orange Music Setup ${version}.exe`) : findBuiltExe();
  if (!exe || !fs.existsSync(exe)) throw new Error('没找到打包产物，先跑一次完整打包（去掉 --skip-build）');
  return exe;
}

function copyInstaller(exe) {
  const releaseDir = path.join(root, 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  // 旧版本的安装包不留着，避免 release 目录越攒越大
  for (const name of fs.readdirSync(releaseDir)) {
    if (/^Orange Music Setup .*\.exe$/.test(name) && name !== path.basename(exe)) {
      rmrf(path.join(releaseDir, name));
    }
  }
  const local = path.join(releaseDir, path.basename(exe));
  fs.copyFileSync(exe, local);
  log(`安装包 → ${local}`);

  fs.mkdirSync(INSTALLER_DIR, { recursive: true });
  const remote = path.join(INSTALLER_DIR, path.basename(exe));
  fs.copyFileSync(exe, remote);
  log(`安装包 → ${remote}`);
  return local;
}

// fs.cpSync 在这台机器的桌面中文路径上会静默不复制（不报错也不建目录），
// 所以自己走 mkdirSync + copyFileSync 递归，别用 cpSync。
function copyTree(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyTree(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function mirrorSource() {
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  for (const item of MIRROR_ITEMS) {
    const src = path.join(root, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(MIRROR_DIR, item);
    // 整目录替换，避免已删除的文件残留在镜像里
    if (fs.statSync(src).isDirectory()) rmrf(dst);
    copyTree(src, dst);
  }
  const count = countFiles(MIRROR_DIR);
  log(`源码 → ${MIRROR_DIR}（${count} 个文件）`);
}

function countFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

/*
 * 打 GitHub 源码 zip。
 * 以前用 Compress-Archive，它有两个硬伤：条目名按系统代码页（GBK）写并且不带 UTF-8 标志，
 * 路径分隔符还是反斜杠。结果在 macOS / Linux 上解压出一堆乱码文件名，甚至把
 * 「目录\文件」当成一个畸形文件名。所以改成 archiver：正斜杠 + UTF-8 标志。
 */
async function zipMirror() {
  // 压缩包跟源码目录同级同名：Orange-Music-x.y.z-源码.zip
  const zipPath = `${MIRROR_DIR}.zip`;
  const top = path.basename(MIRROR_DIR); // zip 内的顶层目录
  const parent = path.dirname(MIRROR_DIR);
  try {
    fs.mkdirSync(parent, { recursive: true });
    rmrf(zipPath);
    const archiver = require('archiver');
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });
      archive.pipe(output);
      archive.directory(MIRROR_DIR, top);
      archive.finalize();
    });
    log(`压缩包 → ${zipPath}`);
  } catch (err) {
    log(`压缩包生成失败（不影响源码）：${err.message}`);
  }
}

function installLocal() {
  log('安装到本机 …');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'install-local.js')], {
    cwd: root, stdio: 'inherit',
  });
}

(async function main() {
  try {
    if (!skipBuild) build();
    const exe = distExe();
    copyInstaller(exe);
    mirrorSource();
    await zipMirror();
    if (!noInstall) installLocal();
    log(`完成：v${version}`);
  } catch (err) {
    log(`失败：${err.message}`);
    process.exit(1);
  }
})();
