const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp', 'flv', 'wmv']);
const PAGE_SIZE = 200;
const DB_NAME = 'wechat-cleaner';
const DB_VERSION = 1;
const STORE_NAME = 'settings';
const LAST_DIR_KEY = 'last-directory';
const THEME_KEY = 'wechat-cleaner-theme';
const PREFS_KEY = 'wechat-cleaner-preferences';
const DEFAULT_ROOT_PATH = '~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/<你的微信数据目录>/msg/video';

const state = {
  rootHandle: null,
  rootName: '',
  files: [],
  selected: new Set(),
  filtered: [],
  page: 1,
  renderUrls: [],
  previewUrl: null,
  previewItem: null,
  canDelete: false,
  pendingDeleteIds: [],
  pendingDeleteOptions: {},
  isDeleting: false,
  duplicateMode: false,
  duplicateGroups: [],
  duplicateIds: new Set(),
  isFindingDuplicates: false,
  stopRequested: false,
};

const $ = (id) => document.getElementById(id);

const els = {
  pickDirBtn: $('pickDirBtn'),
  restoreLastBtn: $('restoreLastBtn'),
  supportNotice: $('supportNotice'),
  typeFilter: $('typeFilter'),
  minSizeFilter: $('minSizeFilter'),
  sortSelect: $('sortSelect'),
  duplicateModeSelect: $('duplicateModeSelect'),
  selectedOnly: $('selectedOnly'),
  requireConfirm: $('requireConfirm'),
  themeSelect: $('themeSelect'),
  rescanBtn: $('rescanBtn'),
  findDuplicatesBtn: $('findDuplicatesBtn'),
  selectDuplicateExtrasBtn: $('selectDuplicateExtrasBtn'),
  exitDuplicateModeBtn: $('exitDuplicateModeBtn'),
  selectPageBtn: $('selectPageBtn'),
  clearSelectionBtn: $('clearSelectionBtn'),
  exportBtn: $('exportBtn'),
  deleteBtn: $('deleteBtn'),
  rootName: $('rootName'),
  totalCount: $('totalCount'),
  totalSize: $('totalSize'),
  selectedCount: $('selectedCount'),
  progressPanel: $('progressPanel'),
  progressText: $('progressText'),
  progressCount: $('progressCount'),
  stopProgressBtn: $('stopProgressBtn'),
  resultInfo: $('resultInfo'),
  prevPageBtn: $('prevPageBtn'),
  pageInfo: $('pageInfo'),
  nextPageBtn: $('nextPageBtn'),
  grid: $('grid'),
  previewDialog: $('previewDialog'),
  previewBody: $('previewBody'),
  previewMeta: $('previewMeta'),
  closePreviewBtn: $('closePreviewBtn'),
  copyDirBtn: $('copyDirBtn'),
  deleteDialog: $('deleteDialog'),
  deleteCountText: $('deleteCountText'),
  deleteSizeText: $('deleteSizeText'),
  cancelDeleteBtn: $('cancelDeleteBtn'),
  confirmDeleteBtn: $('confirmDeleteBtn'),
};

function getExt(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function getMediaType(name, mime = '') {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'file';
}

function typeLabel(type) {
  if (type === 'image') return '图片';
  if (type === 'video') return '视频';
  return '文件';
}

function fileIconLabel(item) {
  const ext = getExt(item.name);
  return ext ? ext.slice(0, 5).toUpperCase() : 'FILE';
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatDate(ts) {
  if (!ts) return '未知时间';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function formatDateOnly(ts) {
  if (!ts) return '未知日期';
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[ch]));
}

function selectedItems() {
  return state.files.filter((item) => state.selected.has(item.id));
}

function selectedSize() {
  return selectedItems().reduce((sum, item) => sum + item.size, 0);
}

function folderPath(item) {
  const index = item.path.lastIndexOf('/');
  if (index < 0) return '(根目录)';
  return item.path.slice(0, index) || '(根目录)';
}

function fullFilePath(item) {
  return `${DEFAULT_ROOT_PATH}/${item.path}`;
}

function requireConfirmEnabled() {
  return els.requireConfirm.checked;
}

function systemThemeQuery() {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

function normalizeTheme(theme) {
  return ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto';
}

function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  const resolved = normalized === 'auto'
    ? (systemThemeQuery().matches ? 'dark' : 'light')
    : normalized;

  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = normalized;
  els.themeSelect.value = normalized;
}

function saveTheme(theme) {
  const normalized = normalizeTheme(theme);
  localStorage.setItem(THEME_KEY, normalized);
  applyTheme(normalized);
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'auto');

  const query = systemThemeQuery();
  const onSystemThemeChange = () => {
    if (normalizeTheme(localStorage.getItem(THEME_KEY) || 'auto') === 'auto') {
      applyTheme('auto');
    }
  };

  if (query.addEventListener) query.addEventListener('change', onSystemThemeChange);
  else if (query.addListener) query.addListener(onSystemThemeChange);
}

function optionExists(select, value) {
  return Array.from(select.options).some((option) => option.value === value);
}

function loadControlPreferences() {
  let prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch (error) {
    console.warn('读取筛选设置失败：', error);
  }

  if (optionExists(els.typeFilter, prefs.typeFilter)) {
    els.typeFilter.value = prefs.typeFilter;
  }
  if (optionExists(els.minSizeFilter, prefs.minSizeFilter)) {
    els.minSizeFilter.value = prefs.minSizeFilter;
  }
  if (optionExists(els.sortSelect, prefs.sortSelect)) {
    els.sortSelect.value = prefs.sortSelect;
  }
  if (optionExists(els.duplicateModeSelect, prefs.duplicateModeSelect)) {
    els.duplicateModeSelect.value = prefs.duplicateModeSelect;
  }
  if (typeof prefs.selectedOnly === 'boolean') {
    els.selectedOnly.checked = prefs.selectedOnly;
  }
  if (typeof prefs.requireConfirm === 'boolean') {
    els.requireConfirm.checked = prefs.requireConfirm;
  }
}

function saveControlPreferences() {
  localStorage.setItem(PREFS_KEY, JSON.stringify({
    typeFilter: els.typeFilter.value,
    minSizeFilter: els.minSizeFilter.value,
    sortSelect: els.sortSelect.value,
    duplicateModeSelect: els.duplicateModeSelect.value,
    selectedOnly: els.selectedOnly.checked,
    requireConfirm: els.requireConfirm.checked,
  }));
}

function openSettingsDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSetting(key) {
  const db = await openSettingsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function writeSetting(value) {
  const db = await openSettingsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const request = tx.objectStore(STORE_NAME).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function saveRememberedDirectory(rootHandle) {
  try {
    await writeSetting({
      key: LAST_DIR_KEY,
      handle: rootHandle,
      name: rootHandle.name,
      savedAt: Date.now(),
    });
  } catch (error) {
    console.warn('保存上次选择的文件夹失败：', error);
  }
}

async function getRememberedDirectory() {
  try {
    return await readSetting(LAST_DIR_KEY);
  } catch (error) {
    console.warn('读取上次选择的文件夹失败：', error);
    return null;
  }
}

async function hasDirectoryPermission(rootHandle, requestPermission = false) {
  const options = { mode: 'readwrite' };
  if ((await rootHandle.queryPermission(options)) === 'granted') return true;
  if (!requestPermission) return false;
  return (await rootHandle.requestPermission(options)) === 'granted';
}

async function rememberedStartDirectoryHandle() {
  if (state.rootHandle) return state.rootHandle;
  const remembered = await getRememberedDirectory();
  return remembered?.handle || null;
}

async function showDirectoryPickerFromLastChoice() {
  const options = { mode: 'readwrite' };
  const startHandle = await rememberedStartDirectoryHandle();
  if (startHandle) options.startIn = startHandle;

  try {
    return await window.showDirectoryPicker(options);
  } catch (error) {
    if (options.startIn && error?.name === 'TypeError') {
      console.warn('浏览器不支持用上次文件夹作为选择起点，已退回普通选择。', error);
      return window.showDirectoryPicker({ mode: 'readwrite' });
    }
    throw error;
  }
}

function updateStats() {
  const totalSize = state.files.reduce((sum, item) => sum + item.size, 0);
  const selected = selectedItems();
  const selectedBytes = selected.reduce((sum, item) => sum + item.size, 0);

  els.rootName.textContent = state.rootName || '未选择';
  els.totalCount.textContent = String(state.files.length);
  els.totalSize.textContent = formatSize(totalSize);
  els.selectedCount.textContent = `${selected.length} / ${formatSize(selectedBytes)}`;

  const hasFiles = state.files.length > 0;
  const hasSelection = state.selected.size > 0;
  els.rescanBtn.disabled = !state.rootHandle;
  els.findDuplicatesBtn.disabled = !hasFiles || state.isFindingDuplicates;
  els.selectDuplicateExtrasBtn.disabled = !state.duplicateMode || state.duplicateGroups.length === 0 || state.isFindingDuplicates;
  els.exitDuplicateModeBtn.hidden = !state.duplicateMode;
  els.selectPageBtn.disabled = state.filtered.length === 0;
  els.clearSelectionBtn.disabled = !hasSelection;
  els.exportBtn.disabled = !hasSelection;
  els.deleteBtn.disabled = !hasSelection || !state.canDelete || state.isDeleting;

  if (!state.canDelete && hasFiles) {
    els.deleteBtn.title = '当前浏览器不支持直接删除；请用 Chrome / Edge 的“选择文件夹”。';
  } else {
    els.deleteBtn.title = '';
  }
}

function updateProgress(text, count = '') {
  els.progressText.textContent = text;
  els.progressCount.textContent = count;
}

function showProgress() {
  state.stopRequested = false;
  els.stopProgressBtn.disabled = false;
  els.progressPanel.hidden = false;
}

function hideProgress() {
  els.stopProgressBtn.disabled = true;
  els.progressPanel.hidden = true;
}

function requestStopCurrentTask() {
  state.stopRequested = true;
  els.stopProgressBtn.disabled = true;
  updateProgress('正在停止，请稍候...', els.progressCount.textContent);
}

function clearRenderUrls() {
  for (const url of state.renderUrls) URL.revokeObjectURL(url);
  state.renderUrls = [];
}

function clearPreviewUrl() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
}

function clearDuplicateState() {
  for (const item of state.files) {
    delete item.duplicateGroupIndex;
    delete item.duplicateGroupCount;
    delete item.duplicateSignatureLabel;
  }
  state.duplicateMode = false;
  state.duplicateGroups = [];
  state.duplicateIds = new Set();
}

function resetData() {
  clearRenderUrls();
  clearPreviewUrl();
  clearDuplicateState();
  state.files = [];
  state.selected = new Set();
  state.filtered = [];
  state.page = 1;
}

async function scanDirectoryHandle(rootHandle) {
  const found = [];
  let visitedDirs = 0;

  async function walk(dirHandle, relDir) {
    if (state.stopRequested) return;
    visitedDirs += 1;
    if (found.length % 25 === 0) {
      updateProgress(`正在扫描：${relDir || rootHandle.name}`, `${found.length} 个资源文件 / ${visitedDirs} 个目录`);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    for await (const [name, handle] of dirHandle.entries()) {
      if (state.stopRequested) break;
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (handle.kind === 'directory') {
        await walk(handle, relPath);
        if (state.stopRequested) break;
        continue;
      }

      if (handle.kind !== 'file') continue;

      try {
        const file = await handle.getFile();
        const type = getMediaType(file.name, file.type);
        found.push({
          id: relPath,
          name,
          path: relPath,
          type,
          mime: file.type,
          size: file.size,
          lastModified: file.lastModified,
          fileHandle: handle,
          parentHandle: dirHandle,
        });
      } catch (error) {
        console.warn('读取文件失败：', relPath, error);
      }
    }
  }

  await walk(rootHandle, '');
  return found;
}

async function loadFile(item) {
  if (item.file) return item.file;
  return item.fileHandle.getFile();
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '时长未知';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${String(remain).padStart(2, '0')}`;
}

function strictDurationKey(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return 'unknown';
  return String(Math.round(seconds * 100) / 100);
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function fileHash(item) {
  if (item.sha256) return item.sha256;
  const file = await loadFile(item);
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  item.sha256 = bytesToHex(digest);
  return item.sha256;
}

async function getVideoDuration(item) {
  if (Object.prototype.hasOwnProperty.call(item, 'videoDuration')) {
    return item.videoDuration;
  }

  let url = '';
  try {
    const file = await loadFile(item);
    url = URL.createObjectURL(file);
  } catch (error) {
    console.warn('读取视频失败：', item.path, error);
    item.videoDuration = null;
    return null;
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    let settled = false;

    const finish = (duration) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      item.videoDuration = duration;
      resolve(duration);
    };

    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      finish(duration);
    };
    video.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
    video.src = url;
  });
}

function annotateDuplicateGroups() {
  for (const item of state.files) {
    delete item.duplicateGroupIndex;
    delete item.duplicateGroupCount;
    delete item.duplicateSignatureLabel;
  }

  state.duplicateIds = new Set();
  state.duplicateGroups.forEach((group, index) => {
    const groupIndex = index + 1;
    for (const item of group.items) {
      item.duplicateGroupIndex = groupIndex;
      item.duplicateGroupCount = group.items.length;
      item.duplicateSignatureLabel = group.signatureLabel;
      state.duplicateIds.add(item.id);
    }
  });
}

function refreshDuplicateGroupsAfterFileChange() {
  if (!state.duplicateMode) return;

  const liveIds = new Set(state.files.map((item) => item.id));
  state.duplicateGroups = state.duplicateGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => liveIds.has(item.id)),
    }))
    .filter((group) => group.items.length > 1);

  if (!state.duplicateGroups.length) {
    clearDuplicateState();
    return;
  }

  annotateDuplicateGroups();
}

async function duplicateSignature(item) {
  const ext = getExt(item.name) || '无扩展名';

  if (item.type === 'video') {
    const duration = await getVideoDuration(item);
    const durationKey = strictDurationKey(duration);
    return {
      key: `video|${item.size}|${ext}|${durationKey}`,
      label: `视频 · ${ext.toUpperCase()} · ${item.size} 字节 · ${formatDuration(duration)}`,
    };
  }

  return {
    key: `${item.type}|${item.size}|${ext}`,
    label: `${typeLabel(item.type)} · ${ext.toUpperCase()}`,
  };
}

async function hashDuplicateSignature(item) {
  const hash = await fileHash(item);
  return {
    key: `hash|${hash}`,
    label: `SHA-256 · ${hash.slice(0, 12)}`,
  };
}

async function findSuspectedDuplicateFiles() {
  if (state.isFindingDuplicates) return;

  const files = state.files.slice();
  if (files.length < 2) {
    alert('当前目录里文件少于 2 个，无法查找疑似重复文件。');
    return;
  }

  state.isFindingDuplicates = true;
  updateStats();
  showProgress();

  try {
    updateProgress('正在按大小预分组...', `共 ${files.length} 个文件`);
    const bySize = new Map();
    for (const item of files) {
      if (state.stopRequested) break;
      if (!bySize.has(item.size)) bySize.set(item.size, []);
      bySize.get(item.size).push(item);
    }
    if (state.stopRequested) {
      hideProgress();
      els.resultInfo.textContent = '已停止查找疑似重复文件。';
      return;
    }

    const candidates = Array.from(bySize.values()).filter((group) => group.length > 1).flat();
    if (!candidates.length) {
      clearDuplicateState();
      state.page = 1;
      hideProgress();
      applyFilters();
      alert('没有发现大小相同的疑似重复文件。');
      return;
    }

    const useHash = els.duplicateModeSelect.value === 'hash';
    const bySignature = new Map();
    const signatureLabels = new Map();
    for (let index = 0; index < candidates.length; index += 1) {
      if (state.stopRequested) break;
      const item = candidates[index];
      updateProgress(useHash ? '正在计算文件 Hash...' : '正在生成重复特征...', `${index + 1}/${candidates.length}`);
      const signature = useHash ? await hashDuplicateSignature(item) : await duplicateSignature(item);
      const key = signature.key;
      if (!bySignature.has(key)) bySignature.set(key, []);
      signatureLabels.set(key, signature.label);
      bySignature.get(key).push(item);
    }
    if (state.stopRequested) {
      hideProgress();
      els.resultInfo.textContent = '已停止查找疑似重复文件。';
      return;
    }

    const groups = Array.from(bySignature.entries())
      .map(([key, items]) => ({ key, items, signatureLabel: signatureLabels.get(key) || '' }))
      .filter((group) => group.items.length > 1)
      .sort((a, b) => (b.items.length - a.items.length) || (b.items[0].size - a.items[0].size));

    clearDuplicateState();
    if (!groups.length) {
      state.page = 1;
      hideProgress();
      applyFilters();
      alert('没有发现疑似重复文件。');
      return;
    }

    state.duplicateMode = true;
    state.duplicateGroups = groups.map((group, index) => ({
      id: index + 1,
      items: group.items,
      size: group.items[0].size,
      signatureLabel: group.signatureLabel,
    }));
    annotateDuplicateGroups();
    state.page = 1;
    hideProgress();
    applyFilters();
  } catch (error) {
    hideProgress();
    console.error(error);
    alert(`查找疑似重复文件失败：${error.message || error}`);
  } finally {
    state.isFindingDuplicates = false;
    updateStats();
  }
}

function exitDuplicateMode() {
  clearDuplicateState();
  state.page = 1;
  applyFilters();
}

function selectDuplicateExtras() {
  if (!state.duplicateMode || !state.duplicateGroups.length) return;

  for (const group of state.duplicateGroups) {
    const sorted = group.items.slice().sort((a, b) => b.lastModified - a.lastModified);
    for (const item of sorted.slice(1)) {
      state.selected.add(item.id);
    }
  }

  render();
}

async function pickDirectory() {
  if (!window.showDirectoryPicker) {
    alert('当前浏览器不支持目录读写。请使用 Chrome / Edge。');
    return;
  }

  try {
    const rootHandle = await showDirectoryPickerFromLastChoice();
    await saveRememberedDirectory(rootHandle);
    await loadDirectory(rootHandle, { fromRemembered: false });
  } catch (error) {
    hideProgress();
    if (error?.name !== 'AbortError') {
      console.error(error);
      alert(`选择或扫描失败：${error.message || error}`);
    }
  }
}

async function loadDirectory(rootHandle, { fromRemembered = false } = {}) {
  resetData();
  state.rootHandle = rootHandle;
  state.rootName = rootHandle.name;
  state.canDelete = true;
  els.restoreLastBtn.hidden = true;
  showProgress();
  updateStats();
  const files = await scanDirectoryHandle(rootHandle);
  state.files = files;
  state.page = 1;
  hideProgress();
  applyFilters();
  if (state.stopRequested) {
    els.resultInfo.textContent = `已停止扫描，保留已扫描到的 ${state.files.length} 个资源文件。`;
  }

  if (fromRemembered) {
    els.supportNotice.innerHTML = `<strong>已自动恢复上次文件夹：</strong>${escapeHtml(rootHandle.name)}。如果要换目录，点击“选择文件夹”。`;
  } else {
    els.supportNotice.innerHTML = `<strong>已记住当前文件夹：</strong>${escapeHtml(rootHandle.name)}。下次打开会自动尝试恢复并扫描。`;
  }
}

async function restoreRememberedDirectory({ requestPermission = false } = {}) {
  if (!window.showDirectoryPicker) return false;

  const remembered = await getRememberedDirectory();
  if (!remembered?.handle) return false;

  const name = remembered.name || remembered.handle.name || '上次文件夹';
  els.restoreLastBtn.hidden = false;
  els.restoreLastBtn.textContent = `恢复上次文件夹：${name}`;

  let granted = false;
  try {
    granted = await hasDirectoryPermission(remembered.handle, requestPermission);
  } catch (error) {
    console.warn('检查上次文件夹权限失败：', error);
  }

  if (!granted) {
    els.supportNotice.innerHTML = `<strong>已记住上次文件夹：</strong>${escapeHtml(name)}。浏览器需要你重新授权，点击“恢复上次文件夹”即可继续。`;
    return false;
  }

  try {
    await loadDirectory(remembered.handle, { fromRemembered: true });
    return true;
  } catch (error) {
    hideProgress();
    console.error(error);
    els.supportNotice.innerHTML = `<strong>恢复上次文件夹失败：</strong>${escapeHtml(error.message || String(error))}。请重新点击“选择文件夹”。`;
    return false;
  }
}

async function rescanCurrent() {
  if (!state.rootHandle) return;
  try {
    const rootHandle = state.rootHandle;
    const rootName = state.rootName;
    resetData();
    state.rootHandle = rootHandle;
    state.rootName = rootName;
    state.canDelete = true;
    showProgress();
    updateStats();
    state.files = await scanDirectoryHandle(rootHandle);
    hideProgress();
    applyFilters();
    if (state.stopRequested) {
      els.resultInfo.textContent = `已停止扫描，保留已扫描到的 ${state.files.length} 个资源文件。`;
    }
  } catch (error) {
    hideProgress();
    console.error(error);
    alert(`重新扫描失败：${error.message || error}`);
  }
}

function applyFilters() {
  const type = els.typeFilter.value;
  const minSize = Number(els.minSizeFilter.value || 0);
  const selectedOnly = els.selectedOnly.checked;

  let list = state.files.filter((item) => {
    if (state.duplicateMode) {
      if (!state.duplicateIds.has(item.id)) return false;
    } else if (type !== 'all' && item.type !== type) {
      return false;
    }
    if (item.size < minSize) return false;
    if (selectedOnly && !state.selected.has(item.id)) return false;
    return true;
  });

  const sortValue = els.sortSelect.value;
  list = list.slice().sort((a, b) => {
    if (state.duplicateMode) {
      return (a.duplicateGroupIndex - b.duplicateGroupIndex) || (b.lastModified - a.lastModified);
    }

    switch (sortValue) {
      case 'size-asc': return a.size - b.size;
      case 'size-desc': return b.size - a.size;
      case 'mtime-asc': return a.lastModified - b.lastModified;
      case 'mtime-desc': return b.lastModified - a.lastModified;
      case 'name-desc': return b.name.localeCompare(a.name, 'zh-CN');
      case 'name-asc':
      default: return a.name.localeCompare(b.name, 'zh-CN');
    }
  });

  state.filtered = list;
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.page > pageCount) state.page = pageCount;
  if (state.page < 1) state.page = 1;
  render();
}

function currentPageItems() {
  const start = (state.page - 1) * PAGE_SIZE;
  return state.filtered.slice(start, start + PAGE_SIZE);
}

async function render() {
  clearRenderUrls();
  updateStats();

  const pageCount = state.filtered.length === 0 ? 0 : Math.ceil(state.filtered.length / PAGE_SIZE);
  const pageItems = currentPageItems();
  if (!state.files.length) {
    els.resultInfo.textContent = '还没有扫描结果。';
  } else if (state.duplicateMode) {
    els.resultInfo.textContent = `疑似重复文件 ${state.filtered.length} 个 / ${state.duplicateGroups.length} 组，当前页 ${pageItems.length} 个。`;
  } else {
    els.resultInfo.textContent = `筛选结果 ${state.filtered.length} 个，当前页 ${pageItems.length} 个。`;
  }
  els.pageInfo.textContent = `第 ${pageCount ? state.page : 0} / ${pageCount} 页`;
  els.prevPageBtn.disabled = state.page <= 1 || pageCount === 0;
  els.nextPageBtn.disabled = state.page >= pageCount || pageCount === 0;

  if (pageItems.length === 0) {
  els.grid.innerHTML = '<div class="empty">没有可展示的资源文件。请选择文件夹，或调整筛选条件。</div>';
    return;
  }

  els.grid.innerHTML = '';
  for (const item of pageItems) {
    const card = document.createElement('article');
    card.className = `card${state.selected.has(item.id) ? ' selected' : ''}`;
    card.dataset.id = item.id;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.title = '点击预览';
    thumb.addEventListener('click', () => openPreview(item));

      try {
        const file = await loadFile(item);
        const url = URL.createObjectURL(file);
      if (item.type === 'image') {
        card.dataset.objectUrl = url;
        state.renderUrls.push(url);
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = item.name;
        img.src = url;
        thumb.appendChild(img);
      } else if (item.type === 'video') {
        thumb.classList.add('thumb-video');
        card.dataset.objectUrl = url;
        state.renderUrls.push(url);
        const frame = document.createElement('div');
        frame.className = 'thumb-media-frame';
        const video = document.createElement('video');
        video.className = 'thumb-video-el';
        video.src = url;
        video.muted = true;
        video.preload = 'metadata';
        video.playsInline = true;
        video.loop = true;
        video.addEventListener('loadedmetadata', () => {
          if (video.videoHeight > video.videoWidth) {
            thumb.classList.add('thumb-portrait-video');
          }
        }, { once: true });
        thumb.addEventListener('mouseenter', () => {
          video.play().catch(() => {});
        });
        thumb.addEventListener('mouseleave', () => {
          video.pause();
          video.currentTime = 0;
        });
        frame.appendChild(video);
        thumb.appendChild(frame);
      } else {
        URL.revokeObjectURL(url);
        const icon = document.createElement('div');
        icon.className = 'file-thumb';
        icon.title = item.name;
        icon.innerHTML = `<span class="file-thumb-name">${escapeHtml(item.name)}</span>`;
        thumb.appendChild(icon);
      }
    } catch (error) {
      const placeholder = document.createElement('div');
      placeholder.className = 'placeholder';
      placeholder.textContent = '无法预览';
      thumb.appendChild(placeholder);
      console.warn('预览失败：', item.path, error);
    }

    const body = document.createElement('div');
    body.className = 'card-body';
    const fileDate = formatDateOnly(item.lastModified);
    const duplicateNote = state.duplicateMode && item.duplicateGroupIndex
      ? `<div class="duplicate-note">重复组 ${item.duplicateGroupIndex} · 共 ${item.duplicateGroupCount} 个${item.duplicateSignatureLabel ? ` · ${escapeHtml(item.duplicateSignatureLabel)}` : ''}</div>`
      : '';
    body.innerHTML = `
      <div class="card-summary">
        <span title="${escapeHtml(fileDate)}">${escapeHtml(fileDate)}</span>
        <span>${formatSize(item.size)}</span>
      </div>
      ${duplicateNote}
      <div class="card-actions">
        <label><input type="checkbox" ${state.selected.has(item.id) ? 'checked' : ''} /> 标记清理</label>
        <button type="button" class="danger direct-delete" ${state.canDelete ? '' : 'disabled'}>直接删除</button>
      </div>
    `;

    const checkbox = body.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', (event) => {
      if (event.target.checked) state.selected.add(item.id);
      else state.selected.delete(item.id);
      card.classList.toggle('selected', event.target.checked);
      updateStats();
    });
    const directDeleteBtn = body.querySelector('.direct-delete');
    directDeleteBtn.addEventListener('click', () => requestDeleteItems([item], {
      keepSlots: true,
      cards: [card],
    }));

    card.appendChild(thumb);
    card.appendChild(body);
    els.grid.appendChild(card);
  }
}

async function openPreview(item) {
  try {
    clearPreviewUrl();
    state.previewItem = item;
    els.copyDirBtn.disabled = false;
    const file = await loadFile(item);
    state.previewUrl = URL.createObjectURL(file);
    els.previewBody.innerHTML = '';
    if (item.type === 'image') {
      const img = document.createElement('img');
      img.alt = item.name;
      img.src = state.previewUrl;
      els.previewBody.appendChild(img);
    } else if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = state.previewUrl;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      els.previewBody.appendChild(video);
    } else {
      URL.revokeObjectURL(state.previewUrl);
      state.previewUrl = null;
      const icon = document.createElement('div');
      icon.className = 'file-preview';
      icon.innerHTML = `<span class="file-preview-icon">📄</span><span class="file-preview-ext">${escapeHtml(fileIconLabel(item))}</span>`;
      els.previewBody.appendChild(icon);
    }
    els.previewMeta.innerHTML = `
      <strong>${escapeHtml(item.name)}</strong><br>
      路径：${escapeHtml(item.path)}<br>
      类型：${typeLabel(item.type)} ｜ 大小：${formatSize(item.size)} ｜ 时间：${formatDate(item.lastModified)}
    `;
    els.previewDialog.showModal();
  } catch (error) {
    console.error(error);
    alert(`打开预览失败：${error.message || error}`);
  }
}

function closePreview() {
  els.previewDialog.close();
  els.previewBody.innerHTML = '';
  els.previewMeta.innerHTML = '';
  state.previewItem = null;
  els.copyDirBtn.disabled = true;
  clearPreviewUrl();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

async function copyPreviewDirectory() {
  const item = state.previewItem;
  if (!item) return;

  const fullPath = fullFilePath(item);
  els.copyDirBtn.disabled = true;
  els.copyDirBtn.textContent = '复制中...';

  try {
    await copyText(fullPath);
    els.resultInfo.textContent = `已复制完整路径：${fullPath}`;
  } catch (error) {
    console.error(error);
    alert(`复制失败，请手动复制：\n${fullPath}`);
  } finally {
    els.copyDirBtn.disabled = false;
    els.copyDirBtn.textContent = '复制完整路径';
  }
}

function selectCurrentPage() {
  for (const item of currentPageItems()) state.selected.add(item.id);
  render();
}

function clearSelection() {
  state.selected.clear();
  render();
}

function exportSelection() {
  const items = selectedItems();
  if (!items.length) return;
  const lines = [
    'name,path,type,size_bytes,size_human,last_modified',
    ...items.map((item) => [
      csvCell(item.name),
      csvCell(item.path),
      item.type,
      item.size,
      csvCell(formatSize(item.size)),
      csvCell(formatDate(item.lastModified)),
    ].join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wechat-clean-list-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function requestDeleteItems(items, options = {}) {
  if (!items.length || !state.canDelete) return;
  if (requireConfirmEnabled()) {
    openDeleteDialog(items, options);
  } else {
    deleteItems(items, options);
  }
}

function openDeleteDialog(items = selectedItems(), options = {}) {
  if (!items.length || !state.canDelete) return;
  state.pendingDeleteIds = items.map((item) => item.id);
  state.pendingDeleteOptions = options;
  const size = items.reduce((sum, item) => sum + item.size, 0);
  els.deleteCountText.textContent = String(items.length);
  els.deleteSizeText.textContent = formatSize(size);
  els.confirmDeleteBtn.disabled = false;
  els.deleteDialog.showModal();
}

async function deletePendingItems() {
  const pendingIds = new Set(state.pendingDeleteIds);
  const items = state.files.filter((item) => pendingIds.has(item.id));
  await deleteItems(items, { ...state.pendingDeleteOptions, closeDialog: true });
}

function keepDeletedSlotsBlank(deletedIds, cards = []) {
  const deletedSet = new Set(deletedIds);
  for (const card of cards) {
    if (!card || !deletedSet.has(card.dataset.id)) continue;
    if (card.dataset.objectUrl) {
      URL.revokeObjectURL(card.dataset.objectUrl);
      state.renderUrls = state.renderUrls.filter((url) => url !== card.dataset.objectUrl);
      delete card.dataset.objectUrl;
    }
    card.className = 'card deleted-slot';
    card.innerHTML = '';
    card.setAttribute('aria-label', '已删除，翻页后刷新');
  }
}

async function deleteItems(items, { closeDialog = false, keepSlots = false, cards = [] } = {}) {
  if (!items.length || state.isDeleting) return;
  state.isDeleting = true;
  updateStats();
  els.confirmDeleteBtn.disabled = true;
  els.confirmDeleteBtn.textContent = '删除中...';

  const deleted = [];
  const failed = [];

  for (const item of items) {
    try {
      await item.parentHandle.removeEntry(item.name);
      deleted.push(item.id);
    } catch (error) {
      failed.push({ item, error });
      console.error('删除失败：', item.path, error);
    }
  }

  const deletedSet = new Set(deleted);
  state.files = state.files.filter((item) => !deletedSet.has(item.id));
  state.filtered = state.filtered.filter((item) => !deletedSet.has(item.id));
  for (const id of deleted) state.selected.delete(id);
  refreshDuplicateGroupsAfterFileChange();
  if (closeDialog) els.deleteDialog.close();
  els.confirmDeleteBtn.textContent = '确认删除';
  state.pendingDeleteIds = [];
  state.pendingDeleteOptions = {};
  state.isDeleting = false;

  if (keepSlots) {
    keepDeletedSlotsBlank(deleted, cards);
    updateStats();
    const pageCount = state.filtered.length === 0 ? 0 : Math.ceil(state.filtered.length / PAGE_SIZE);
    els.pageInfo.textContent = `第 ${pageCount ? state.page : 0} / ${pageCount} 页`;
    els.resultInfo.textContent = `已删除 ${deleted.length} 个文件；当前位置已留空，翻页后重新渲染。`;
  } else {
    applyFilters();
  }

  if (failed.length) {
    alert(`已删除 ${deleted.length} 个，失败 ${failed.length} 个。失败详情请看浏览器控制台。`);
  } else if (!keepSlots) {
    els.resultInfo.textContent = `已删除 ${deleted.length} 个文件。`;
  }
}

function bindEvents() {
  els.pickDirBtn.addEventListener('click', pickDirectory);
  els.restoreLastBtn.addEventListener('click', () => restoreRememberedDirectory({ requestPermission: true }));
  els.stopProgressBtn.addEventListener('click', requestStopCurrentTask);
  els.rescanBtn.addEventListener('click', rescanCurrent);
  els.findDuplicatesBtn.addEventListener('click', findSuspectedDuplicateFiles);
  els.selectDuplicateExtrasBtn.addEventListener('click', selectDuplicateExtras);
  els.exitDuplicateModeBtn.addEventListener('click', exitDuplicateMode);
  els.selectPageBtn.addEventListener('click', selectCurrentPage);
  els.clearSelectionBtn.addEventListener('click', clearSelection);
  els.exportBtn.addEventListener('click', exportSelection);
  els.deleteBtn.addEventListener('click', () => requestDeleteItems(selectedItems()));

  for (const input of [els.typeFilter, els.minSizeFilter, els.sortSelect, els.duplicateModeSelect, els.selectedOnly, els.requireConfirm]) {
    input.addEventListener('input', () => {
      saveControlPreferences();
      state.page = 1;
      applyFilters();
    });
  }
  els.themeSelect.addEventListener('input', () => saveTheme(els.themeSelect.value));

  els.prevPageBtn.addEventListener('click', () => {
    state.page -= 1;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  els.nextPageBtn.addEventListener('click', () => {
    state.page += 1;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  els.closePreviewBtn.addEventListener('click', closePreview);
  els.copyDirBtn.addEventListener('click', copyPreviewDirectory);
  els.previewDialog.addEventListener('click', (event) => {
    if (event.target === els.previewDialog) {
      closePreview();
    }
  });
  els.previewDialog.addEventListener('close', () => {
    state.previewItem = null;
    els.copyDirBtn.disabled = true;
    clearPreviewUrl();
  });
  els.cancelDeleteBtn.addEventListener('click', () => els.deleteDialog.close());
  els.confirmDeleteBtn.addEventListener('click', deletePendingItems);
}

async function init() {
  initTheme();
  loadControlPreferences();
  bindEvents();
  if (!window.showDirectoryPicker) {
    els.supportNotice.innerHTML = '<strong>当前浏览器不支持目录读写。</strong> 请换用 Chrome / Edge。';
    els.pickDirBtn.disabled = true;
    els.restoreLastBtn.hidden = true;
  } else {
    restoreRememberedDirectory();
  }
  updateStats();
  applyFilters();
}

init();
