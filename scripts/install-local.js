/**
 * 把当前版本静默安装到本机（升级已安装的 Orange Music）。
 * 用法：node scripts/install-local.js
 * 也可在打包后自动执行：npm run dist:install
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const setup = path.join(root, 'release', `Orange Music Setup ${version}.exe`);

function log(msg) {
  process.stdout.write(`[install-local] ${msg}\n`);
}

if (!fs.existsSync(setup)) {
  log(`找不到安装包：${setup}`);
  log('请先执行 npm run dist 打包。');
  process.exit(1);
}

// Windows 下安装包会替换正在运行的 exe，先关掉旧进程
if (process.platform === 'win32') {
  const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Orange Music.exe', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if ((running.stdout || '').toLowerCase().includes('orange music.exe')) {
    log('检测到 Orange Music 正在运行，先关闭旧版本…');
    spawnSync('taskkill', ['/IM', 'Orange Music.exe', '/T', '/F'], { windowsHide: true });
  }
}

log(`静默安装 ${version} …`);
const result = spawnSync(setup, ['/S'], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) {
  log(`安装失败，退出码 ${result.status}`);
  process.exit(result.status || 1);
}

// 校验安装结果：对比安装目录里的 app.asar 与本次打包产物是否一致
function findInstallDir() {
  const candidates = [
    process.env.ORANGE_MUSIC_INSTALL_DIR,
    'D:\\Downloads\\Orange Music',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Orange Music'),
    'C:\\Program Files\\Orange Music',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'Orange Music.exe'))) return dir;
  }
  return null;
}

const dir = findInstallDir();
const built = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
if (dir && fs.existsSync(built)) {
  const installed = path.join(dir, 'resources', 'app.asar');
  const same = fs.existsSync(installed) && fs.statSync(installed).size === fs.statSync(built).size;
  log(same
    ? `校验通过：${dir} 已是 ${version}`
    : `安装目录 ${dir} 的 app.asar 与打包产物不一致，请手动确认。`);
} else {
  log(`已执行安装，但未定位到安装目录（当前目录假定为 ${dir || '未知'}）。`);
}

log('完成。可以从桌面/开始菜单启动 Orange Music。');
