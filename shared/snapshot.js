// ===== 书签数据快照管理 =====
// 在关键操作（导入/同步/删除/恢复）前后自动创建快照，
// 支持一键恢复到任意快照点，防止数据丢失。
//
// 设计要点：
// - 快照存储在 chrome.storage.local，借助 unlimitedStorage 权限避免配额问题
// - 淘汰策略：auto 类型优先淘汰，同类型按时间最旧优先，上限 20 个
// - auto 类型保留最近 7 天
// - 恢复前自动创建当前状态备份，避免误操作不可逆

const SNAPSHOT_KEY = 'bookmark_snapshots';
const SNAPSHOT_BOOKMARKS_KEY = 'bookmark_timeline_data';
// 默认值（可被 app_settings 中的策略覆盖）
const DEFAULT_MAX_SNAPSHOTS = 20;
const DEFAULT_AUTO_RETENTION_DAYS = 7;
const DEFAULT_PROTECT_MANUAL = true;

// 读取快照策略设置（从 app_settings 读取，未配置则用默认值）
async function getSnapshotSettings() {
  const result = await chrome.storage.local.get('app_settings');
  const s = (result.app_settings) || {};
  return {
    maxCount: Number(s.snapshotMaxCount) || DEFAULT_MAX_SNAPSHOTS,
    autoRetentionDays: Number(s.snapshotAutoRetentionDays) || DEFAULT_AUTO_RETENTION_DAYS,
    protectManual: s.snapshotProtectManual !== false  // 默认 true
  };
}

// 淘汰优先级（数字越大越先被淘汰）
const REASON_PRIORITY = {
  'auto': 5,
  'pre_sync': 4,
  'pre_restore': 3,
  'pre_delete': 2,
  'pre_import': 2,
  'manual': 1
};

// 读取存储中的书签数据（避免与 background.js 的 getStoredBookmarks 强耦合）
async function _snapshotGetBookmarks() {
  const result = await chrome.storage.local.get(SNAPSHOT_BOOKMARKS_KEY);
  return result[SNAPSHOT_BOOKMARKS_KEY] || [];
}

async function _snapshotSetBookmarks(bookmarks) {
  await chrome.storage.local.set({ [SNAPSHOT_BOOKMARKS_KEY]: bookmarks });
}

async function _loadSnapshots() {
  const result = await chrome.storage.local.get(SNAPSHOT_KEY);
  return result[SNAPSHOT_KEY] || [];
}

async function _saveSnapshots(snapshots) {
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshots });
}

// 创建快照
// reason: 'manual' | 'pre_import' | 'pre_sync' | 'pre_delete' | 'pre_restore' | 'auto'
// label: 可选的用户备注
async function createSnapshot(reason, label) {
  const bookmarks = await _snapshotGetBookmarks();
  const snapshot = {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    reason: reason || 'manual',
    label: label || '',
    stats: {
      bookmarkCount: bookmarks.length,
      taggedCount: bookmarks.filter(b => b && b.tags && b.tags.length > 0).length,
      pinnedCount: bookmarks.filter(b => b && b.pinned).length
    },
    bookmarks
  };
  const snapshots = await _loadSnapshots();
  snapshots.unshift(snapshot);
  // 读取策略设置进行淘汰
  const settings = await getSnapshotSettings();
  const pruned = pruneSnapshots(snapshots, settings.maxCount, settings.autoRetentionDays, settings.protectManual);
  await _saveSnapshots(pruned);
  return snapshot;
}

// 淘汰超限快照（参数化，由 createSnapshot 传入策略值）
function pruneSnapshots(snapshots, maxCount, autoRetentionDays, protectManual) {
  if (snapshots.length <= maxCount) return snapshots;

  // 先淘汰超过保留期的 auto 快照
  const now = Date.now();
  const autoCutoff = now - autoRetentionDays * 24 * 60 * 60 * 1000;
  let filtered = snapshots.filter(s => !(s.reason === 'auto' && s.createdAt < autoCutoff));

  // 仍超限则按优先级 + 时间淘汰
  if (filtered.length > maxCount) {
    // protectManual=true 时，manual 类型不参与淘汰
    const candidates = protectManual
      ? filtered.filter(s => s.reason !== 'manual')
      : filtered.slice();
    // 若候选数已不足需要淘汰的数量，则放宽限制（允许淘汰 manual）以遵守 maxCount 硬上限
    const toRemove = filtered.length - maxCount;
    let removalPool = candidates;
    if (removalPool.length < toRemove) {
      removalPool = filtered.slice();
    }
    removalPool.sort((a, b) => {
      const pa = REASON_PRIORITY[a.reason] || 3;
      const pb = REASON_PRIORITY[b.reason] || 3;
      if (pa !== pb) return pb - pa;          // 优先级高的先被淘汰
      return a.createdAt - b.createdAt;         // 同优先级旧的先淘汰
    });
    const removeSet = new Set();
    for (let i = 0; i < toRemove && i < removalPool.length; i++) {
      removeSet.add(removalPool[i].id);
    }
    filtered = filtered.filter(s => !removeSet.has(s.id));
  }

  return filtered;
}

// 恢复快照（恢复前自动创建当前状态备份）
async function restoreSnapshot(snapshotId) {
  const snapshots = await _loadSnapshots();
  const target = snapshots.find(s => s.id === snapshotId);
  if (!target) {
    return { success: false, error: 'Snapshot not found' };
  }

  // 恢复前备份当前状态
  await createSnapshot('pre_restore', '恢复前自动备份');

  // 用快照数据覆盖当前书签
  await _snapshotSetBookmarks(target.bookmarks || []);

  return { success: true, restoredCount: (target.bookmarks || []).length };
}

// 返回快照摘要列表（不含全量 bookmarks 数据，避免传输开销）
async function listSnapshots() {
  const snapshots = await _loadSnapshots();
  return snapshots.map(s => ({
    id: s.id,
    createdAt: s.createdAt,
    reason: s.reason,
    label: s.label,
    stats: s.stats
  }));
}

// 删除单个快照
async function deleteSnapshot(snapshotId) {
  const snapshots = await _loadSnapshots();
  const filtered = snapshots.filter(s => s.id !== snapshotId);
  await _saveSnapshots(filtered);
  return { success: true, removed: snapshots.length - filtered.length };
}

// 清除所有 auto 类型快照（供 UI 手动清理）
async function clearAutoSnapshots() {
  const snapshots = await _loadSnapshots();
  const filtered = snapshots.filter(s => s.reason !== 'auto');
  await _saveSnapshots(filtered);
  return { success: true, removed: snapshots.length - filtered.length };
}

// 估算快照总存储占用（字节）
async function getSnapshotStorageBytes() {
  const snapshots = await _loadSnapshots();
  let total = 0;
  for (const s of snapshots) {
    total += new Blob([JSON.stringify(s)]).size;
  }
  return total;
}
