/* 迷你播放器小窗：只负责显示状态 + 把操作转发给主窗口 */
const desktop = window.orangeDesktop;
const $ = selector => document.querySelector(selector);

const coverEl = $('#miniCover');
const titleEl = $('#miniTitle');
const artistEl = $('#miniArtist');
const lyricEl = $('#miniLyric');
const seekEl = $('#miniSeek');
const timeEl = $('#miniTime');
const playBtn = $('#miniPlay');
const playIcon = $('#miniPlayIcon');

const ICON_PLAY = 'M8 5.2v13.6L19.2 12z';
const ICON_PAUSE = 'M7.5 5h3.2v14H7.5zM13.3 5h3.2v14h-3.2z';
const DEFAULT_COVER = 'assets/cover-default.png';

let dragging = false;
let state = { playing: false, progress: 0, time: 0 };

const formatTime = seconds => {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

function applyState(next) {
  if (!next) return;
  state = { ...state, ...next };

  titleEl.textContent = state.title || '未播放';
  artistEl.textContent = state.artist || '';
  // 没有歌词时退回艺人名之外的一句提示，避免文字块空一半
  lyricEl.textContent = state.lyric || (state.title ? '纯音乐 / 暂无歌词' : '导入歌曲后开始播放');

  const cover = state.cover || DEFAULT_COVER;
  if (coverEl.getAttribute('src') !== cover) coverEl.src = cover;

  // progress 与主界面 seekSlider 同一套刻度：0–1000
  const raw = Math.max(0, Math.min(1000, Math.round(Number(state.progress) || 0)));
  if (!dragging) {
    seekEl.value = String(raw);
    seekEl.style.setProperty('--p', `${raw / 10}%`);
  }
  timeEl.textContent = formatTime(state.time);

  const playing = Boolean(state.playing);
  playIcon.setAttribute('d', playing ? ICON_PAUSE : ICON_PLAY);
  playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
  playBtn.title = playing ? '暂停' : '播放';
  document.body.classList.toggle('is-playing', playing);
}

coverEl.addEventListener('error', () => {
  if (!coverEl.src.endsWith('cover-default.png')) coverEl.src = DEFAULT_COVER;
});

playBtn.addEventListener('click', () => desktop?.sendMiniCommand?.('toggle'));

$('#miniPrev').addEventListener('click', () => desktop?.sendMiniCommand?.('prev'));

$('#miniNext').addEventListener('click', () => desktop?.sendMiniCommand?.('next'));

seekEl.addEventListener('pointerdown', () => { dragging = true; });
seekEl.addEventListener('input', () => {
  const pct = Number(seekEl.value) / 10;
  seekEl.style.setProperty('--p', `${pct}%`);
  timeEl.textContent = formatTime((Number(seekEl.value) / 1000) * (Number(state.duration) || 0));
});
const commitSeek = () => {
  if (!dragging) return;
  dragging = false;
  desktop?.sendMiniCommand?.({ type: 'seek', value: Number(seekEl.value) / 1000 });
};
seekEl.addEventListener('change', commitSeek);
seekEl.addEventListener('pointerup', commitSeek);

$('#miniClose').addEventListener('click', () => desktop?.closeMiniPlayer?.());
$('#miniExpand').addEventListener('click', () => desktop?.showMainWindow?.());

// 双击卡片（按钮之外的地方）回主窗口，和大多数迷你播放器一致
$('#mini').addEventListener('dblclick', event => {
  if (event.target.closest('button, input')) return;
  desktop?.showMainWindow?.();
});

desktop?.onMiniState?.(applyState);
