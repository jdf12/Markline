// ===== DOM 引用 =====
const backBtn = document.getElementById('backBtn');
const themeSelect = document.getElementById('themeSelect');
const languageSelect = document.getElementById('languageSelect');
const checkerFrequencySelect = document.getElementById('checkerFrequencySelect');
const checkerDayOfWeekRow = document.getElementById('checkerDayOfWeekRow');
const checkerDayOfWeekSelect = document.getElementById('checkerDayOfWeekSelect');
const checkerDayOfMonthRow = document.getElementById('checkerDayOfMonthRow');
const checkerDayOfMonthSelect = document.getElementById('checkerDayOfMonthSelect');
const checkerTimeRow = document.getElementById('checkerTimeRow');
const checkerTimeInput = document.getElementById('checkerTimeInput');
const checkerAutoDeleteRow = document.getElementById('checkerAutoDeleteRow');
const checkerAutoDeleteToggle = document.getElementById('checkerAutoDeleteToggle');
const checkerTimeoutSelect = document.getElementById('checkerTimeoutSelect');
const checkerConcurrencySelect = document.getElementById('checkerConcurrencySelect');
const checkerRetriesSelect = document.getElementById('checkerRetriesSelect');
const checkerBackoffBaseSelect = document.getElementById('checkerBackoffBaseSelect');
const checkerBackoffMaxSelect = document.getElementById('checkerBackoffMaxSelect');
const openCheckerBtn = document.getElementById('openCheckerBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportHtmlBtn = document.getElementById('exportHtmlBtn');
const importFileBtn = document.getElementById('importFileBtn');
const importFileInput = document.getElementById('importFileInput');
const retentionDaysSelect = document.getElementById('retentionDaysSelect');
const previewEnabledToggle = document.getElementById('previewEnabledToggle');
const previewCacheTTLSelect = document.getElementById('previewCacheTTLSelect');
const previewMaxEntriesSelect = document.getElementById('previewMaxEntriesSelect');
const previewCacheStatsDesc = document.getElementById('previewCacheStatsDesc');
const clearPreviewCacheBtn = document.getElementById('clearPreviewCacheBtn');
const mdiWindowEnabledToggle = document.getElementById('mdiWindowEnabledToggle');
const toastContainer = document.getElementById('toastContainer');
const shortcutQuickBookmark = document.getElementById('shortcutQuickBookmark');
const shortcutOpenPalette = document.getElementById('shortcutOpenPalette');
const shortcutOpenPopup = document.getElementById('shortcutOpenPopup');
const shortcutConflicts = document.getElementById('shortcutConflicts');
const conflictDetails = document.getElementById('conflictDetails');
const openShortcutsPageLink = document.getElementById('openShortcutsPageLink');

// ===== RSS 订阅设置 DOM 引用 =====
const rssPollIntervalSelect = document.getElementById('rssPollIntervalSelect');
const rssMaxItemsSelect = document.getElementById('rssMaxItemsSelect');
const rssDefaultFolderSelect = document.getElementById('rssDefaultFolderSelect');
const rssAutoDiscoverToggle = document.getElementById('rssAutoDiscoverToggle');
const rssNotifyNewToggle = document.getElementById('rssNotifyNewToggle');
const rssProxyFallbackToggle = document.getElementById('rssProxyFallbackToggle');
const rssProxyUrlRow = document.getElementById('rssProxyUrlRow');
const rssProxyUrlInput = document.getElementById('rssProxyUrlInput');
const rssProxyTestBtn = document.getElementById('rssProxyTestBtn');
const rssProxySaveBtn = document.getElementById('rssProxySaveBtn');
const rssProxyTestResult = document.getElementById('rssProxyTestResult');
const rssRefreshAllBtn = document.getElementById('rssRefreshAllBtn');
const rssLastUpdatedDesc = document.getElementById('rssLastUpdatedDesc');
const rssUnreadBadge = document.getElementById('rssUnreadBadge');

// ===== 推送通知设置 DOM 引用 =====
const pushEnabledToggle = document.getElementById('pushEnabledToggle');
const pushStrategySelect = document.getElementById('pushStrategySelect');
const pushDailySendAtInput = document.getElementById('pushDailySendAtInput');
const pushDigestStyleSelect = document.getElementById('pushDigestStyleSelect');
const pushDigestMaxInput = document.getElementById('pushDigestMaxInput');
const pushDigestAiWarnRow = document.getElementById('pushDigestAiWarnRow');
const pushDigestAiConfigLink = document.getElementById('pushDigestAiConfigLink');
const pushQuietStartInput = document.getElementById('pushQuietStartInput');
const pushQuietEndInput = document.getElementById('pushQuietEndInput');
const pushKeywordsIncludeInput = document.getElementById('pushKeywordsIncludeInput');
const pushKeywordsExcludeInput = document.getElementById('pushKeywordsExcludeInput');
const pushEmailToInput = document.getElementById('pushEmailToInput');
const pushFromInput = document.getElementById('pushFromInput');
const pushProviderSelect = document.getElementById('pushProviderSelect');
const pushSmtpUsernameInput = document.getElementById('pushSmtpUsernameInput');
const pushSmtpPassInput = document.getElementById('pushSmtpPassInput');
const pushSmtpPassStatus = document.getElementById('pushSmtpPassStatus');
const pushSaveSmtpPassBtn = document.getElementById('pushSaveSmtpPassBtn');
const pushClearSmtpPassBtn = document.getElementById('pushClearSmtpPassBtn');
const pushSmtpHostInput = document.getElementById('pushSmtpHostInput');
const pushSmtpPortInput = document.getElementById('pushSmtpPortInput');
const pushSmtpTlsSelect = document.getElementById('pushSmtpTlsSelect');
const pushApiKeyInput = document.getElementById('pushApiKeyInput');
const pushApiKeyStatus = document.getElementById('pushApiKeyStatus');
const pushSaveApiKeyBtn = document.getElementById('pushSaveApiKeyBtn');
const pushClearApiKeyBtn = document.getElementById('pushClearApiKeyBtn');
const pushHttpEndpointInput = document.getElementById('pushHttpEndpointInput');
const pushHttpAuthTypeSelect = document.getElementById('pushHttpAuthTypeSelect');
const pushTestBtn = document.getElementById('pushTestBtn');
const pushFlushNowBtn = document.getElementById('pushFlushNowBtn');
const pushDiagBtn = document.getElementById('pushDiagBtn');
const pushClearHistoryBtn = document.getElementById('pushClearHistoryBtn');
const pushHistoryList = document.getElementById('pushHistoryList');
const pushProviderTypeRadios = document.querySelectorAll('input[name="pushProviderType"]');
const pushBridgeStatusText = document.getElementById('pushBridgeStatusText');
const pushBridgeCheckBtn = document.getElementById('pushBridgeCheckBtn');

// 预置 SMTP/HTTP Provider 表（从 background 获取后缓存）
let _smtpProviders = {};
let _httpProviders = {};

// 区分 HTTP/SMTP provider 值集合
const _HTTP_PROVIDER_VALUES = new Set(['resend', 'sendgrid', 'mailgun', 'custom']);
const _SMTP_PROVIDER_VALUES = new Set(['gmail', 'qq', '163', '126', 'outlook', 'aliyun', 'sina', 'sohu', '189', 'feishu', 'custom-smtp']);

// 预置 HTTP provider 的固定鉴权方式（custom 才允许用户自定义）
const _HTTP_PRESET_AUTH_TYPE = {
  resend: 'bearer',
  sendgrid: 'bearer',
  mailgun: 'bearer'
};

// Provider → 发件人邮箱域名映射（用于 placeholder 动态回显）
const _PROVIDER_DOMAIN = {
  // HTTP API
  resend:   'onboarding@resend.dev',
  sendgrid: 'noreply@yourdomain.com',
  mailgun:  'noreply@yourdomain.com',
  custom:   'noreply@yourdomain.com',
  // SMTP
  gmail:        'your-email@gmail.com',
  qq:           'your-email@qq.com',
  '163':        'your-email@163.com',
  '126':        'your-email@126.com',
  outlook:      'your-email@outlook.com',
  aliyun:       'your-email@qiye.aliyun.com',
  sina:         'your-email@sina.com',
  sohu:         'your-email@sohu.com',
  '189':        'your-email@189.cn',
  feishu:       'your-email@feishu.cn',
  'custom-smtp': 'your-email@example.com'
};

// ===== 智能标签规则 DOM 引用 =====
const domainRuleDomains = document.getElementById('domainRuleDomains');
const domainRuleTag = document.getElementById('domainRuleTag');
const addDomainRuleBtn = document.getElementById('addDomainRuleBtn');
const domainRulesList = document.getElementById('domainRulesList');
const keywordRuleTag = document.getElementById('keywordRuleTag');
const keywordRuleKeyword = document.getElementById('keywordRuleKeyword');
const addKeywordRuleBtn = document.getElementById('addKeywordRuleBtn');
const keywordRulesList = document.getElementById('keywordRulesList');
const stopWordInput = document.getElementById('stopWordInput');
const addStopWordBtn = document.getElementById('addStopWordBtn');
const stopWordsList = document.getElementById('stopWordsList');
const clearLearnedTagsBtn = document.getElementById('clearLearnedTagsBtn');
const learnedTagsList = document.getElementById('learnedTagsList');

// ===== 主动学习 DOM 引用 =====
const activeLearningBadge = document.getElementById('activeLearningBadge');
const learningStatsDesc = document.getElementById('learningStatsDesc');
const clearReviewQueueBtn = document.getElementById('clearReviewQueueBtn');
const pendingReviewsList = document.getElementById('pendingReviewsList');

// ===== 通知设置 DOM 引用 =====
const notificationEnabledToggle = document.getElementById('notificationEnabledToggle');

// ===== AI 辅助分类 DOM 引用 =====
const aiEnabledToggle = document.getElementById('aiEnabledToggle');
const aiProviderSelect = document.getElementById('aiProviderSelect');
const aiApiKeyInput = document.getElementById('aiApiKeyInput');
const aiModelInput = document.getElementById('aiModelInput');
const aiTimeoutInput = document.getElementById('aiTimeoutInput');
const aiTestBtn = document.getElementById('aiTestBtn');
const aiClearCacheBtn = document.getElementById('aiClearCacheBtn');
const aiStatusDesc = document.getElementById('aiStatusDesc');
const aiCustomFields = document.getElementById('aiCustomFields');
const aiCustomFormatSelect = document.getElementById('aiCustomFormatSelect');
const aiCustomEndpointInput = document.getElementById('aiCustomEndpointInput');
const aiFullUrlToggle = document.getElementById('aiFullUrlToggle');
const aiEndpointHintText = document.getElementById('aiEndpointHintText');
const aiEndpointHintFullUrl = document.getElementById('aiEndpointHintFullUrl');
const aiLogsHeader = document.getElementById('aiLogsHeader');
const aiLogsBody = document.getElementById('aiLogsBody');
const aiLogsToggleIcon = document.getElementById('aiLogsToggleIcon');
const aiLogsStats = document.getElementById('aiLogsStats');
const aiLogsList = document.getElementById('aiLogsList');
const aiRefreshLogsBtn = document.getElementById('aiRefreshLogsBtn');
const aiClearLogsBtn = document.getElementById('aiClearLogsBtn');

// ===== 统计 DOM 引用 =====
const statsStartDate = document.getElementById('statsStartDate');
const statsEndDate = document.getElementById('statsEndDate');
const statsApplyRangeBtn = document.getElementById('statsApplyRangeBtn');
const statsResetRangeBtn = document.getElementById('statsResetRangeBtn');
const statTotal = document.getElementById('statTotal');
const statTags = document.getElementById('statTags');
const statDomains = document.getElementById('statDomains');
const statFolders = document.getElementById('statFolders');
const healthScoreValue = document.getElementById('healthScoreValue');
const healthScoreDetails = document.getElementById('healthScoreDetails');
const healthScoreDesc = document.getElementById('healthScoreDesc');
const favoriteHealthScoreBtn = document.getElementById('favoriteHealthScoreBtn');
const trendTabs = document.getElementById('trendTabs');
const trendChart = document.getElementById('trendChart');
const tagsChart = document.getElementById('tagsChart');
const domainsChart = document.getElementById('domainsChart');
const hoursChart = document.getElementById('hoursChart');
const foldersChart = document.getElementById('foldersChart');
const accuracyTrendChart = document.getElementById('accuracyTrendChart');
const accuracyTrendEmpty = document.getElementById('accuracyTrendEmpty');
const exportStatsCsvBtn = document.getElementById('exportStatsCsvBtn');
const exportStatsPdfBtn = document.getElementById('exportStatsPdfBtn');
const healthFavoritesSection = document.getElementById('healthFavoritesSection');
const healthFavoritesList = document.getElementById('healthFavoritesList');

// ===== 导航切换 =====
const navItems = document.querySelectorAll('.nav-item');
const panelSections = document.querySelectorAll('.panel-section');

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const panelId = item.dataset.panel;

    // 更新导航高亮
    navItems.forEach(nav => nav.classList.remove('active'));
    item.classList.add('active');

    // 切换面板
    panelSections.forEach(panel => {
      panel.classList.remove('active');
      if (panel.id === `panel-${panelId}`) {
        panel.classList.add('active');
      }
    });

    // 首次打开统计面板时加载数据
    if (panelId === 'stats') {
      loadStatsPanel();
    }
    // 首次打开语音面板时加载设置并检测桥接
    if (panelId === 'voice') {
      loadVoiceSettings();
    }
  });
});

// ===== Toast 提示 =====
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 2500);
}

// ===== 主题管理 =====
function applyTheme(theme) {
  document.body.classList.remove('theme-light', 'theme-dark');
  
  if (theme === 'light') {
    document.body.classList.add('theme-light');
  } else if (theme === 'dark') {
    document.body.classList.add('theme-dark');
  }
}

async function loadTheme() {
  const result = await chrome.storage.local.get('theme');
  const theme = result.theme || 'system';
  themeSelect.value = theme;
  applyTheme(theme);
}

async function saveTheme(theme) {
  await chrome.storage.local.set({ theme });
  applyTheme(theme);
}

// ===== 语言管理 =====
async function loadLanguage() {
  const result = await chrome.storage.local.get('language');
  const language = result.language || 'system';
  languageSelect.value = language;
  setCurrentLang(language);
  applyI18n();
}

async function saveLanguage(language) {
  await chrome.storage.local.set({ language });
  setCurrentLang(language);
  applyI18n();
}

// ===== 失效检测设置管理 =====
async function loadCheckerSettings() {
  const result = await chrome.storage.local.get([
    'checkerFrequency', 'checkerTime', 'checkerDayOfWeek', 'checkerDayOfMonth',
    'checkerAutoDelete', 'checkerTimeout', 'checkerConcurrency',
    'checkerRetries', 'checkerBackoffBase', 'checkerBackoffMax'
  ]);
  checkerFrequencySelect.value = result.checkerFrequency || 'never';
  checkerDayOfWeekSelect.value = String(result.checkerDayOfWeek ?? 1);
  populateCheckerDayOfMonthOptions(result.checkerDayOfMonth ?? 1);
  checkerTimeInput.value = result.checkerTime || '03:00';
  checkerAutoDeleteToggle.checked = !!result.checkerAutoDelete;
  checkerTimeoutSelect.value = result.checkerTimeout || '10000';
  checkerConcurrencySelect.value = result.checkerConcurrency || '5';
  // 新增 3 项：未保存时显示默认值（与 HTML selected 保持一致）
  checkerRetriesSelect.value = String(result.checkerRetries ?? 2);
  checkerBackoffBaseSelect.value = String(result.checkerBackoffBase ?? 800);
  checkerBackoffMaxSelect.value = String(result.checkerBackoffMax ?? 3000);
  // 根据频率显示/隐藏时间设置和自动删除
  toggleCheckerScheduleRows(result.checkerFrequency || 'never');
}

function populateCheckerDayOfMonthOptions(selectedDay = 1) {
  if (!checkerDayOfMonthSelect) return;
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const safeDay = Math.min(Math.max(1, selectedDay), daysInMonth);
  checkerDayOfMonthSelect.innerHTML = '';
  for (let d = 1; d <= daysInMonth; d++) {
    const option = document.createElement('option');
    option.value = String(d);
    option.textContent = `${d} 日`;
    if (d === safeDay) option.selected = true;
    checkerDayOfMonthSelect.appendChild(option);
  }
}

function toggleCheckerScheduleRows(frequency) {
  const show = frequency !== 'never';
  const showWeekly = frequency === 'weekly';
  const showMonthly = frequency === 'monthly';
  if (checkerDayOfWeekRow) {
    checkerDayOfWeekRow.classList.toggle('hidden-row', !showWeekly);
  }
  if (checkerDayOfMonthRow) {
    checkerDayOfMonthRow.classList.toggle('hidden-row', !showMonthly);
  }
  if (checkerTimeRow) {
    checkerTimeRow.classList.toggle('hidden-row', !show);
  }
  if (checkerAutoDeleteRow) {
    checkerAutoDeleteRow.classList.toggle('hidden-row', !show);
  }
}

async function saveCheckerSetting(key, value) {
  await chrome.storage.local.set({ [key]: value });
  // 如果修改了检测频率或日期/时间，需要重新调度闹钟
  if (['checkerFrequency', 'checkerTime', 'checkerDayOfWeek', 'checkerDayOfMonth'].includes(key)) {
    try {
      await chrome.runtime.sendMessage({ action: 'scheduleChecker' });
    } catch (e) {
      // background 可能未就绪
    }
  }
}

// ===== 最近删除设置 =====
async function loadRetentionDays() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getAppSettings' });
    const days = (res && res.settings && res.settings.tombstoneRetentionDays) || 7;
    retentionDaysSelect.value = String(days);
  } catch (e) {
    retentionDaysSelect.value = '7';
  }
}

async function saveRetentionDays(days) {
  await chrome.runtime.sendMessage({
    action: 'updateAppSettings',
    patch: { tombstoneRetentionDays: Number(days) }
  });
}

// ===== 网页预览设置 (Mozilla Readability) =====
async function loadPreviewSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getPreviewSettings' });
    const s = (res && res.settings) || {};
    previewEnabledToggle.checked = s.previewEnabled !== false;
    previewCacheTTLSelect.value = String(s.previewCacheTTL ?? 30);
    previewMaxEntriesSelect.value = String(s.previewMaxCacheEntries ?? 500);
    mdiWindowEnabledToggle.checked = s.mdiWindowEnabled === true;
  } catch (e) {
    previewEnabledToggle.checked = true;
    previewCacheTTLSelect.value = '30';
    previewMaxEntriesSelect.value = '500';
    mdiWindowEnabledToggle.checked = false;
  }
  await refreshPreviewCacheStats();
}

async function refreshPreviewCacheStats() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getPreviewCacheStats' });
    const stats = (res && res.stats) || { count: 0, totalChars: 0 };
    if (stats.count === 0) {
      previewCacheStatsDesc.textContent = i18n('previewCacheEmpty') || 'Empty';
    } else {
      const text = (i18n('previewCacheStatsText') || '$1 entries · $2 chars')
        .replace('$1', stats.count)
        .replace('$2', stats.totalChars);
      previewCacheStatsDesc.textContent = text;
    }
  } catch (e) {
    previewCacheStatsDesc.textContent = '—';
  }
}

async function savePreviewSetting(patch) {
  await chrome.runtime.sendMessage({ action: 'updatePreviewSettings', patch });
}

// ===== RSS 订阅设置 =====
// 扁平化书签文件夹树，返回 [{ id, title, depth }]（仅文件夹节点）
function flattenBookmarkFolders(nodes, depth = 0, out = []) {
  for (const n of nodes || []) {
    if (n.children !== undefined) {
      out.push({ id: n.id, title: n.title || '', depth });
      if (n.children && n.children.length) {
        flattenBookmarkFolders(n.children, depth + 1, out);
      }
    }
  }
  return out;
}

// 填充默认书签文件夹下拉
async function populateRssFolderSelect(selectedId = null) {
  if (!rssDefaultFolderSelect) return;
  try {
    const tree = await chrome.bookmarks.getTree();
    const folders = flattenBookmarkFolders(tree);
    // 保留首项 "— None —"
    rssDefaultFolderSelect.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.setAttribute('data-i18n', 'rssDefaultFolderNone');
    noneOpt.textContent = i18n('rssDefaultFolderNone') || '— None —';
    rssDefaultFolderSelect.appendChild(noneOpt);
    for (const f of folders) {
      // 跳过根节点（id 为 '0'），其本身无意义
      if (f.id === '0') continue;
      const opt = document.createElement('option');
      opt.value = f.id;
      const indent = '\u00A0\u00A0'.repeat(f.depth);
      opt.textContent = indent + (f.title || '(unnamed)');
      rssDefaultFolderSelect.appendChild(opt);
    }
    rssDefaultFolderSelect.value = selectedId || '';
  } catch (e) {
    console.warn('populateRssFolderSelect failed:', e);
  }
}

async function loadRssSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'rssGetSettings' });
    const s = (res && res.settings) || {};
    rssPollIntervalSelect.value = String(s.pollIntervalMin ?? 30);
    rssMaxItemsSelect.value = String(s.maxItemsPerFeed ?? 100);
    rssAutoDiscoverToggle.checked = s.autoDiscover !== false;
    rssNotifyNewToggle.checked = s.notifyNew !== false;
    rssProxyFallbackToggle.checked = s.proxyFallback !== false;
    rssProxyUrlInput.value = s.proxyUrl || '';
    updateProxyRowState();
    await populateRssFolderSelect(s.defaultFolderId || null);
    await refreshRssLastUpdated();
    await refreshRssUnreadBadge();
  } catch (e) {
    rssPollIntervalSelect.value = '30';
    rssMaxItemsSelect.value = '100';
    rssAutoDiscoverToggle.checked = true;
    rssNotifyNewToggle.checked = true;
    rssProxyFallbackToggle.checked = true;
    rssProxyUrlInput.value = '';
    updateProxyRowState();
    await populateRssFolderSelect(null);
  }
}

// 根据代理回退开关启用/禁用代理 URL 配置行
function updateProxyRowState() {
  rssProxyUrlRow.classList.toggle('is-disabled', !rssProxyFallbackToggle.checked);
}

async function saveRssSetting(patch) {
  await chrome.runtime.sendMessage({ action: 'rssSetSettings', patch });
}

// 刷新"最后更新"文本
async function refreshRssLastUpdated() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'rssGetFeeds' });
    const feeds = (res && res.feeds) || [];
    if (feeds.length === 0) {
      rssLastUpdatedDesc.textContent = i18n('rssNoFeeds') || 'No subscriptions';
      return;
    }
    let latest = 0;
    for (const f of feeds) {
      if (f.lastFetched && f.lastFetched > latest) latest = f.lastFetched;
    }
    if (latest === 0) {
      rssLastUpdatedDesc.textContent = i18n('rssNever') || 'Never';
    } else {
      const d = new Date(latest);
      const ts = d.toLocaleString();
      rssLastUpdatedDesc.textContent = (i18n('rssLastUpdated') || 'Last updated: $1').replace('$1', ts);
    }
  } catch {
    rssLastUpdatedDesc.textContent = '—';
  }
}

// 刷新导航未读徽标
async function refreshRssUnreadBadge() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'rssGetFeeds' });
    const feeds = (res && res.feeds) || [];
    if (feeds.length === 0) {
      rssUnreadBadge.style.display = 'none';
      return;
    }
    const itemsRes = await chrome.runtime.sendMessage({ action: 'rssGetItems', all: true });
    const items = (itemsRes && itemsRes.items) || [];
    const unread = items.filter(i => !i.read).length;
    if (unread > 0) {
      rssUnreadBadge.textContent = unread > 99 ? '99+' : String(unread);
      rssUnreadBadge.style.display = '';
    } else {
      rssUnreadBadge.style.display = 'none';
    }
  } catch {
    rssUnreadBadge.style.display = 'none';
  }
}

// 用于在自定义和内置 provider 之间切换时临时保留字段值
let _aiProviderInputCache = {};

// ===== AI 辅助分类设置 =====
async function loadAISettings() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getAIConfig' });
    const c = (res && res.config) || {};
    aiEnabledToggle.checked = !!c.enabled;
    aiProviderSelect.value = c.provider || 'zhipu';
    aiApiKeyInput.value = c.apiKey || '';
    aiModelInput.value = c.model || '';
    aiTimeoutInput.value = String(c.timeout ?? 8);
    if (aiCustomFormatSelect) aiCustomFormatSelect.value = c.customFormat || 'openai';
    if (aiCustomEndpointInput) aiCustomEndpointInput.value = c.customEndpoint || '';
    if (aiFullUrlToggle) aiFullUrlToggle.checked = !!c.customFullUrl;
    const provider = c.provider || 'zhipu';
    _aiProviderInputCache = {
      [provider]: {
        apiKey: c.apiKey || '',
        model: c.model || '',
        endpoint: c.customEndpoint || ''
      }
    };
    aiProviderSelect.dataset.previousProvider = provider;
  } catch (e) {
    aiEnabledToggle.checked = false;
  }
  toggleCustomFields();
  updateAIEndpointHint();
  clearAIValidationErrors();
  await refreshAIStatus();
}

function switchAIProvider(newProvider) {
  const previousProvider = aiProviderSelect.dataset.previousProvider || aiProviderSelect.value;

  // 保存当前 provider 的值到对应缓存
  _aiProviderInputCache[previousProvider] = {
    apiKey: aiApiKeyInput.value,
    model: aiModelInput.value,
    endpoint: aiCustomEndpointInput ? aiCustomEndpointInput.value : ''
  };

  // 恢复目标 provider 的缓存值，没有缓存则清空
  const cached = _aiProviderInputCache[newProvider] || {};
  aiApiKeyInput.value = cached.apiKey || '';
  aiModelInput.value = cached.model || '';
  if (aiCustomEndpointInput) aiCustomEndpointInput.value = cached.endpoint || '';

  aiProviderSelect.dataset.previousProvider = newProvider;
}

function toggleCustomFields() {
  const isCustom = aiProviderSelect.value === 'custom';
  if (aiCustomFields) {
    aiCustomFields.style.display = isCustom ? '' : 'none';
  }
}

function updateAIEndpointHint() {
  if (!aiEndpointHintText || !aiEndpointHintFullUrl) return;
  const isFullUrl = aiFullUrlToggle && aiFullUrlToggle.checked;
  aiEndpointHintText.style.display = isFullUrl ? 'none' : '';
  aiEndpointHintFullUrl.style.display = isFullUrl ? '' : 'none';

  if (!isFullUrl) {
    const format = aiCustomFormatSelect ? aiCustomFormatSelect.value : 'openai';
    const key = format === 'anthropic' ? 'aiEndpointHintAnthropic' : 'aiEndpointHintOpenAI';
    aiEndpointHintText.textContent = i18n(key);
  }
}

function buildAIConfigFromUI() {
  return {
    enabled: aiEnabledToggle.checked,
    provider: aiProviderSelect.value,
    apiKey: aiApiKeyInput.value.trim(),
    model: aiModelInput.value.trim(),
    timeout: Math.max(3, Math.min(30, parseInt(aiTimeoutInput.value, 10) || 8)),
    customFormat: aiCustomFormatSelect ? aiCustomFormatSelect.value : 'openai',
    customEndpoint: aiCustomEndpointInput ? aiCustomEndpointInput.value.trim() : '',
    customFullUrl: !!(aiFullUrlToggle && aiFullUrlToggle.checked)
  };
}

function validateAIConfig(config) {
  const errors = [];
  if (!config.enabled) return { valid: true, errors };

  const isCustom = config.provider === 'custom';

  if (!config.apiKey) {
    errors.push({ field: 'apiKey', message: i18n('aiApiKeyRequired') || 'Please enter API Key' });
  }
  if (!config.model) {
    errors.push({ field: 'model', message: i18n('aiModelRequired') || 'Please enter Model' });
  }
  if (isCustom && !config.customEndpoint) {
    errors.push({ field: 'customEndpoint', message: i18n('aiCustomEndpointRequired') || 'Please enter API Base URL' });
  }

  return { valid: errors.length === 0, errors };
}

function markAIFieldError(field, hasError) {
  const map = {
    apiKey: aiApiKeyInput,
    model: aiModelInput,
    customEndpoint: aiCustomEndpointInput
  };
  const el = map[field];
  if (!el) return;
  if (hasError) {
    el.classList.add('tagrule-input--error');
  } else {
    el.classList.remove('tagrule-input--error');
  }
}

function clearAIValidationErrors() {
  ['apiKey', 'model', 'customEndpoint'].forEach(field => markAIFieldError(field, false));
}

function applyAIValidationErrors(errors) {
  clearAIValidationErrors();
  errors.forEach(err => markAIFieldError(err.field, true));
}

async function saveAIConfig() {
  const config = buildAIConfigFromUI();
  const validation = validateAIConfig(config);
  if (!validation.valid) {
    applyAIValidationErrors(validation.errors);
    showToast(validation.errors[0].message, 'error');
    return;
  }
  clearAIValidationErrors();
  try {
    await chrome.runtime.sendMessage({ action: 'setAIConfig', config });
    await refreshAIStatus();
    showToast(i18n('settingsSaved'), 'success');
  } catch (e) {
    showToast(i18n('saveFailed') || 'Save failed', 'error');
  }
}

async function onAIEnabledToggle(e) {
  const config = buildAIConfigFromUI();
  config.enabled = e.target.checked;
  const validation = validateAIConfig(config);
  if (!validation.valid) {
    e.target.checked = false;
    applyAIValidationErrors(validation.errors);
    showToast(validation.errors[0].message, 'error');
    return;
  }
  clearAIValidationErrors();
  await saveAIConfig();
}

async function refreshAIStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getAIStats' });
    const stats = (res && res.stats) || {};
    const enabled = aiEnabledToggle.checked;
    const hasKey = !!(aiApiKeyInput.value || '').trim();

    if (!enabled) {
      aiStatusDesc.textContent = i18n('aiStatusDisabled') || 'AI disabled';
      return;
    }
    if (!hasKey) {
      aiStatusDesc.textContent = i18n('aiStatusNoKey') || 'API Key not set';
      return;
    }

    const triggered = stats.totalTriggered || 0;
    const success = stats.successCount || 0;
    const fail = stats.failCount || 0;
    const avg = stats.avgLatencyMs || 0;
    const template = i18n('aiStatusFormat') || 'Triggered: $1 · Success: $2 · Fail: $3 · Avg: $4ms';
    aiStatusDesc.textContent = template
      .replace('$1', triggered)
      .replace('$2', success)
      .replace('$3', fail)
      .replace('$4', avg);
  } catch (e) {
    aiStatusDesc.textContent = '—';
  }
}

async function testAIConnection() {
  const config = buildAIConfigFromUI();
  if (!config.apiKey) {
    showToast(i18n('aiStatusNoKey') || 'Please enter API Key', 'error');
    return;
  }

  aiTestBtn.disabled = true;
  aiTestBtn.textContent = i18n('aiTesting') || 'Testing...';
  try {
    const res = await chrome.runtime.sendMessage({ action: 'testAIConnection', config });
    if (res && res.ok) {
      // 回显服务端返回的实际模型名称
      if (res.model && aiModelInput) {
        aiModelInput.value = res.model;
        // 自动保存，使模型名称持久化
        saveAIConfig();
      }
      showToast((i18n('aiTestSuccess') || 'Connected. Sample tag: $1').replace('$1', res.sampleTag || '—'), 'success');
    } else {
      showToast((i18n('aiTestFailed') || 'Connection failed: $1').replace('$1', res?.error || 'Unknown'), 'error');
    }
  } catch (e) {
    showToast(i18n('aiTestFailed') || 'Connection failed', 'error');
  } finally {
    aiTestBtn.disabled = false;
    aiTestBtn.textContent = i18n('aiTest') || 'Test';
  }
}

async function clearAICache() {
  try {
    await chrome.runtime.sendMessage({ action: 'clearAICache' });
    showToast(i18n('aiCacheCleared') || 'AI cache cleared', 'success');
    await refreshAIStatus();
  } catch (e) {
    showToast(i18n('clearFailed') || 'Clear failed', 'error');
  }
}

function formatAILogType(type) {
  const map = {
    trigger: i18n('aiLogTrigger') || 'Triggered',
    trigger_skip: i18n('aiLogTriggerSkip') || 'Skipped',
    cache_hit: i18n('aiLogCacheHit') || 'Cache Hit',
    classify_success: i18n('aiLogClassifySuccess') || 'Success',
    classify_fail: i18n('aiLogClassifyFail') || 'Failed',
    backfill_success: i18n('aiLogBackfillSuccess') || 'Backfilled',
    backfill_fail: i18n('aiLogBackfillFail') || 'Backfill Failed',
    backfill_skip: i18n('aiLogBackfillSkip') || 'Backfill Skipped'
  };
  return map[type] || type;
}

function formatDuration(ms) {
  if (typeof ms !== 'number') return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatFullTime(ts) {
  return new Date(ts).toLocaleString();
}

function formatAIReason(reason) {
  const map = {
    low_confidence: i18n('reasonLowConfidence') || '置信度低',
    ambiguous_top2: i18n('reasonAmbiguous') || '标签相近',
    strong_conflict: i18n('reasonSignalConflict') || '信号冲突',
    top1_strong: '置信度高',
    confidence_ok: '置信度正常',
    no_ai_result: 'AI 无结果',
    no_change: '标签无变化'
  };
  return map[reason] || reason;
}

function buildAILogDetailLines(log) {
  const lines = [];

  lines.push({
    label: i18n('aiLogTime') || '时间',
    value: formatFullTime(log.timestamp)
  });

  if (log.provider) {
    lines.push({ label: i18n('aiProvider') || '服务商', value: log.provider });
  }
  if (log.model) {
    lines.push({ label: i18n('aiModel') || '模型', value: log.model });
  }
  if (log.domain) {
    lines.push({ label: i18n('aiLogDomain') || '域名', value: log.domain });
  }
  if (typeof log.duration === 'number') {
    lines.push({ label: i18n('aiLogDuration') || '耗时', value: formatDuration(log.duration) });
  }
  if (log.details?.reason) {
    lines.push({ label: i18n('aiLogReason') || '原因', value: formatAIReason(log.details.reason) });
  }

  const tags = log.details?.tags || log.details?.afterTags || log.details?.aiTags;
  if (tags && tags.length > 0) {
    lines.push({ label: i18n('aiLogTags') || '标签', value: tags.join(', ') });
  }

  if (log.error) {
    lines.push({ label: i18n('aiLogError') || '错误', value: log.error, isError: true });
  }

  return lines;
}

function getAILogBadgeClass(type) {
  switch (type) {
    case 'backfill_success':
    case 'classify_success':
      return 'ai-log-badge--success';
    case 'backfill_fail':
    case 'classify_fail':
      return 'ai-log-badge--fail';
    case 'trigger':
    case 'cache_hit':
      return 'ai-log-badge--info';
    default:
      return 'ai-log-badge--neutral';
  }
}

function shouldShowAILog(log) {
  // 隐藏内部调试日志
  return log && !['backfill_start', 'trigger_skip'].includes(log.type);
}

async function renderAILogs() {
  if (!aiLogsList || !aiLogsStats) return;
  try {
    let logs, stats;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'getAILogs', limit: 50 });
      if (res && res.success) {
        logs = res.logs || [];
        stats = res.stats || {};
      } else {
        throw new Error(res?.error || 'getAILogs failed');
      }
    } catch (e) {
      // fallback to direct function if message fails (e.g. settings page has ai-logger.js loaded)
      logs = await getAILogs(50);
      stats = await getAILogStats();
    }

    const statsTemplate = i18n('aiLogsStatsFormat') || 'Total: $TOTAL$ · Success: $SUCCESS$ · Fail: $FAIL$ · Cache: $CACHE$ ($RATE$) · Avg: $AVG$';
    const cacheHitRate = typeof stats.cacheHitRate === 'number' && !isNaN(stats.cacheHitRate)
      ? stats.cacheHitRate
      : 0;
    const cacheHitRateText = cacheHitRate > 0
      ? (cacheHitRate * 100).toFixed(1) + '%'
      : '0.0%';
    aiLogsStats.textContent = statsTemplate
      .replace('$TOTAL$', stats.total)
      .replace('$SUCCESS$', stats.success)
      .replace('$FAIL$', stats.fail)
      .replace('$CACHE$', stats.cacheHit)
      .replace('$AVG$', formatDuration(stats.avgDuration))
      .replace('$RATE$', cacheHitRateText);

    const visibleLogs = logs.filter(shouldShowAILog);

    if (visibleLogs.length === 0) {
      aiLogsList.innerHTML = `<div class="ai-log-empty">${i18n('aiLogsEmpty') || 'No logs yet'}</div>`;
      return;
    }

    aiLogsList.innerHTML = visibleLogs.map(log => {
      const badgeClass = getAILogBadgeClass(log.type);
      const detailLines = buildAILogDetailLines(log);
      const detailsHtml = detailLines.length > 0
        ? `<div class="ai-log-details">${detailLines.map(line => `
            <div class="ai-log-detail-line ${line.isError ? 'ai-log-detail-line--error' : ''}">
              <span class="ai-log-detail-label">${escapeHtml(line.label)}</span>
              <span class="ai-log-detail-value">${escapeHtml(line.value)}</span>
            </div>
          `).join('')}</div>`
        : '';

      return `
        <div class="ai-log-item">
          <div class="ai-log-main">
            <span class="ai-log-badge ${badgeClass}">${escapeHtml(formatAILogType(log.type))}</span>
            ${detailsHtml}
          </div>
          <div class="ai-log-time" title="${escapeHtml(formatFullTime(log.timestamp))}">${formatTime(log.timestamp)}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    aiLogsStats.textContent = '—';
    aiLogsList.innerHTML = `<div class="ai-log-empty" style="color: var(--danger);">${i18n('aiLogsLoadFailed') || 'Failed to load logs'}</div>`;
  }
}

function toggleAILogs() {
  if (!aiLogsBody || !aiLogsToggleIcon) return;
  const isHidden = aiLogsBody.style.display === 'none';
  aiLogsBody.style.display = isHidden ? 'block' : 'none';
  aiLogsToggleIcon.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
  if (isHidden) renderAILogs();
}

async function clearAILogsUI() {
  if (!confirm(i18n('aiClearLogsConfirm') || 'Clear all AI classification logs?')) return;
  try {
    const res = await chrome.runtime.sendMessage({ action: 'clearAILogs' });
    const ok = res && res.success;
    if (ok) {
      showToast(i18n('aiLogsCleared') || 'Logs cleared', 'success');
      await renderAILogs();
    } else {
      showToast(i18n('clearFailed') || 'Clear failed', 'error');
    }
  } catch (e) {
    try {
      const ok = await clearAILogs();
      if (ok) {
        showToast(i18n('aiLogsCleared') || 'Logs cleared', 'success');
        await renderAILogs();
      } else {
        showToast(i18n('clearFailed') || 'Clear failed', 'error');
      }
    } catch (e2) {
      showToast(i18n('clearFailed') || 'Clear failed', 'error');
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===== 事件绑定 =====
backBtn.addEventListener('click', () => {
  window.close();
});

retentionDaysSelect.addEventListener('change', async (e) => {
  await saveRetentionDays(e.target.value);
  showToast(i18n('settingsSaved'), 'success');
});

themeSelect.addEventListener('change', async (e) => {
  const theme = e.target.value;
  await saveTheme(theme);
  showToast(i18n('settingsSaved'), 'success');
});

languageSelect.addEventListener('change', async (e) => {
  const language = e.target.value;
  await saveLanguage(language);
  showToast(i18n('settingsSaved'), 'success');
});

checkerFrequencySelect.addEventListener('change', async (e) => {
  const value = e.target.value;
  toggleCheckerScheduleRows(value);
  await saveCheckerSetting('checkerFrequency', value);
  showToast(i18n('settingsSaved'), 'success');
});

checkerTimeInput.addEventListener('change', async (e) => {
  await saveCheckerSetting('checkerTime', e.target.value);
  showToast(i18n('settingsSaved'), 'success');
});

checkerDayOfWeekSelect.addEventListener('change', async (e) => {
  await saveCheckerSetting('checkerDayOfWeek', parseInt(e.target.value, 10));
  showToast(i18n('settingsSaved'), 'success');
});

checkerDayOfMonthSelect.addEventListener('change', async (e) => {
  const v = parseInt(e.target.value, 10);
  await saveCheckerSetting('checkerDayOfMonth', v);
  showToast(i18n('settingsSaved'), 'success');
});

checkerAutoDeleteToggle.addEventListener('change', async (e) => {
  await saveCheckerSetting('checkerAutoDelete', e.target.checked);
  showToast(i18n('settingsSaved'), 'success');
});

checkerTimeoutSelect.addEventListener('change', async (e) => {
  await saveCheckerSetting('checkerTimeout', e.target.value);
  showToast(i18n('settingsSaved'), 'success');
});

checkerConcurrencySelect.addEventListener('change', async (e) => {
  await saveCheckerSetting('checkerConcurrency', e.target.value);
  showToast(i18n('settingsSaved'), 'success');
});

checkerRetriesSelect.addEventListener('change', async (e) => {
  const v = parseInt(e.target.value, 10);
  await saveCheckerSetting('checkerRetries', v);
  showToast(i18n('settingsSaved'), 'success');
});

checkerBackoffBaseSelect.addEventListener('change', async (e) => {
  const v = parseInt(e.target.value, 10);
  await saveCheckerSetting('checkerBackoffBase', v);
  showToast(i18n('settingsSaved'), 'success');
});

checkerBackoffMaxSelect.addEventListener('change', async (e) => {
  const v = parseInt(e.target.value, 10);
  await saveCheckerSetting('checkerBackoffMax', v);
  showToast(i18n('settingsSaved'), 'success');
});

openCheckerBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/checker/checker.html') });
});

previewEnabledToggle.addEventListener('change', async (e) => {
  await savePreviewSetting({ previewEnabled: e.target.checked });
  showToast(i18n('settingsSaved'), 'success');
});

previewCacheTTLSelect.addEventListener('change', async (e) => {
  const v = parseInt(e.target.value, 10);
  await savePreviewSetting({ previewCacheTTL: v });
  showToast(i18n('settingsSaved'), 'success');
});

previewMaxEntriesSelect.addEventListener('change', async (e) => {
  const v = parseInt(e.target.value, 10);
  await savePreviewSetting({ previewMaxCacheEntries: v });
  await refreshPreviewCacheStats();
  showToast(i18n('settingsSaved'), 'success');
});

clearPreviewCacheBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'clearPreviewCache' });
  await refreshPreviewCacheStats();
  showToast(i18n('previewCacheCleared') || 'Cleared', 'success');
});

mdiWindowEnabledToggle.addEventListener('change', async (e) => {
  await savePreviewSetting({ mdiWindowEnabled: e.target.checked });
  showToast(i18n('settingsSaved'), 'success');
});

// ===== RSS 订阅设置事件绑定 =====
rssPollIntervalSelect.addEventListener('change', async (e) => {
  const v = parseInt(e.target.value, 10);
  await saveRssSetting({ pollIntervalMin: v });
  showToast(i18n('settingsSaved'), 'success');
});

rssMaxItemsSelect.addEventListener('change', async (e) => {
  const v = parseInt(e.target.value, 10);
  await saveRssSetting({ maxItemsPerFeed: v });
  showToast(i18n('settingsSaved'), 'success');
});

rssDefaultFolderSelect.addEventListener('change', async (e) => {
  const v = e.target.value || null;
  await saveRssSetting({ defaultFolderId: v });
  showToast(i18n('settingsSaved'), 'success');
});

rssAutoDiscoverToggle.addEventListener('change', async (e) => {
  await saveRssSetting({ autoDiscover: e.target.checked });
  showToast(i18n('settingsSaved'), 'success');
});

rssNotifyNewToggle.addEventListener('change', async (e) => {
  await saveRssSetting({ notifyNew: e.target.checked });
  showToast(i18n('settingsSaved'), 'success');
});

rssProxyFallbackToggle.addEventListener('change', async (e) => {
  await saveRssSetting({ proxyFallback: e.target.checked });
  updateProxyRowState();
  showToast(i18n('settingsSaved'), 'success');
});

// 保存代理 URL
rssProxySaveBtn.addEventListener('click', async () => {
  const v = (rssProxyUrlInput.value || '').trim();
  if (!v) {
    showToast(i18n('rssProxyUrlRequired') || 'Proxy URL is required', 'error');
    return;
  }
  if (!v.includes('{url}')) {
    showToast(i18n('rssProxyUrlPlaceholderMissing') || 'Proxy URL must contain {url} placeholder', 'error');
    return;
  }
  await saveRssSetting({ proxyUrl: v });
  showToast(i18n('settingsSaved'), 'success');
});

// 测试代理连通性（用阮一峰博客作测试源）
rssProxyTestBtn.addEventListener('click', async () => {
  const v = (rssProxyUrlInput.value || '').trim();
  if (!v || !v.includes('{url}')) {
    rssProxyTestResult.textContent = i18n('rssProxyUrlPlaceholderMissing') || 'Proxy URL must contain {url} placeholder';
    rssProxyTestResult.className = 'proxy-test-result proxy-test-result--fail';
    return;
  }
  const original = rssProxyTestBtn.innerHTML;
  rssProxyTestBtn.innerHTML = '<span>' + (i18n('rssProxyTesting') || 'Testing...') + '</span>';
  rssProxyTestBtn.disabled = true;
  rssProxyTestResult.textContent = '';
  rssProxyTestResult.className = 'proxy-test-result';
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'rssTestProxy',
      proxyUrl: v
    });
    if (res && res.success) {
      const okText = (i18n('rssProxyTestOk') || 'OK: $1 articles').replace('$1', res.itemCount || 0);
      rssProxyTestResult.textContent = okText + ' — ' + (res.feedTitle || '');
      rssProxyTestResult.className = 'proxy-test-result proxy-test-result--ok';
    } else {
      rssProxyTestResult.textContent = (i18n('rssProxyTestFail') || 'Failed: ') + (res?.error || 'unknown');
      rssProxyTestResult.className = 'proxy-test-result proxy-test-result--fail';
    }
  } catch (e) {
    rssProxyTestResult.textContent = (i18n('rssProxyTestFail') || 'Failed: ') + e.message;
    rssProxyTestResult.className = 'proxy-test-result proxy-test-result--fail';
  } finally {
    rssProxyTestBtn.disabled = false;
    rssProxyTestBtn.innerHTML = original;
  }
});

rssRefreshAllBtn.addEventListener('click', async () => {
  rssRefreshAllBtn.disabled = true;
  const original = rssRefreshAllBtn.innerHTML;
  try {
    rssRefreshAllBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spinning"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/></svg><span>' + (i18n('rssRefreshing') || 'Refreshing...') + '</span>';
    await chrome.runtime.sendMessage({ action: 'rssRefreshAll' });
    showToast(i18n('rssRefreshAllDone') || 'Refreshed', 'success');
    await refreshRssLastUpdated();
    await refreshRssUnreadBadge();
  } catch (e) {
    showToast(i18n('rssRefreshFailed') || 'Refresh failed', 'error');
  } finally {
    rssRefreshAllBtn.disabled = false;
    rssRefreshAllBtn.innerHTML = original;
  }
});

// 监听 RSS 数据变化（跨窗口同步）
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'rssDataChanged' || message.action === 'rssUnreadChanged') {
    refreshRssLastUpdated();
    refreshRssUnreadBadge();
  }
});

// ===== AI 辅助分类事件绑定 =====
if (aiEnabledToggle) {
  aiEnabledToggle.addEventListener('change', onAIEnabledToggle);
}
if (aiProviderSelect) {
  aiProviderSelect.addEventListener('change', () => {
    switchAIProvider(aiProviderSelect.value);
    toggleCustomFields();
    updateAIEndpointHint();
    saveAIConfig();
  });
}
if (aiApiKeyInput) {
  aiApiKeyInput.addEventListener('change', saveAIConfig);
}
if (aiModelInput) {
  aiModelInput.addEventListener('change', saveAIConfig);
}
if (aiTimeoutInput) {
  aiTimeoutInput.addEventListener('change', saveAIConfig);
}

// ===== 通知设置事件绑定 =====
if (notificationEnabledToggle) {
  notificationEnabledToggle.addEventListener('change', () => {
    saveNotificationSetting('notificationEnabled', notificationEnabledToggle.checked);
  });
}
if (aiCustomFormatSelect) {
  aiCustomFormatSelect.addEventListener('change', () => {
    updateAIEndpointHint();
    saveAIConfig();
  });
}
if (aiCustomEndpointInput) {
  aiCustomEndpointInput.addEventListener('change', saveAIConfig);
}
if (aiFullUrlToggle) {
  aiFullUrlToggle.addEventListener('change', () => {
    updateAIEndpointHint();
    saveAIConfig();
  });
}
if (aiTestBtn) {
  aiTestBtn.addEventListener('click', testAIConnection);
}
if (aiClearCacheBtn) {
  aiClearCacheBtn.addEventListener('click', clearAICache);
}
if (aiLogsHeader) {
  aiLogsHeader.addEventListener('click', toggleAILogs);
}
if (aiRefreshLogsBtn) {
  aiRefreshLogsBtn.addEventListener('click', renderAILogs);
}
if (aiClearLogsBtn) {
  aiClearLogsBtn.addEventListener('click', clearAILogsUI);
}

// ===== 导入 / 导出 =====
function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

async function handleExportJson() {
  try {
    const result = await chrome.runtime.sendMessage({ action: 'exportData' });
    if (!result?.success) { showToast(i18n('importFailed'), 'error'); return; }
    const data = JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      bookmarks: (result.bookmarks || []).map(b => ({
        title: b.title, url: b.url, dateAdded: b.dateAdded,
        folderPath: b.folderPath, tags: b.tags, pinned: b.pinned
      }))
    }, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`markline-bookmarks-${stamp}.json`, data, 'application/json');
    showToast(i18n('settingsSaved'), 'success');
  } catch (e) {
    console.error(e);
    showToast(i18n('importFailed'), 'error');
  }
}

// ===== 导出 HTML 页面（可阅读的极简视图） =====
function escapeHtml(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatTime(ts) {
  const t = new Date(ts);
  return pad2(t.getHours()) + ':' + pad2(t.getMinutes());
}

function formatDateHeader(timestamp, latestTs, lang, now = Date.now()) {
  const d = new Date(timestamp);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const dDay = new Date(timestamp); dDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - dDay) / 86400000);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const isCN = lang === 'zh-CN';
  if (diffDays === 0) return isCN ? '今天' : 'Today';
  if (diffDays === 1) return isCN ? '昨天' : 'Yesterday';
  if (diffDays < 7) {
    const time = latestTs ? ' ' + formatTime(latestTs) : '';
    return (isCN
      ? pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + time
      : M[d.getMonth()] + ' ' + d.getDate() + time);
  }
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return (isCN
      ? (d.getMonth() + 1) + '月' + d.getDate() + '日'
      : M[d.getMonth()] + ' ' + d.getDate());
  }
  return (isCN
    ? d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
    : d.getFullYear() + ' · ' + M[d.getMonth()] + ' ' + d.getDate());
}

function buildBookmarksPage(bookmarks) {
  // 按日期分组
  const groups = new Map();
  for (const b of bookmarks) {
    const ts = b.dateAdded || Date.now();
    const day = new Date(ts); day.setHours(0, 0, 0, 0);
    const key = day.getTime();
    if (!groups.has(key)) groups.set(key, { ts: day.getTime(), items: [] });
    groups.get(key).items.push(b);
  }
  const sortedDays = [...groups.values()].sort((a, b) => b.ts - a.ts);
  const total = bookmarks.length;
  const stamp = new Date().toISOString().slice(0, 10);
  const lang = (typeof _currentLang !== 'undefined' && _currentLang === 'zh_CN') ? 'zh-CN' : 'en';
  const labels = {
    en: { title: 'Bookmarks', count: (n) => `${n} item${n === 1 ? '' : 's'} · exported ${stamp}` },
    'zh-CN': { title: '书签', count: (n) => `共 ${n} 条 · 导出于 ${stamp}` }
  };
  const L = labels[lang] || labels.en;

  const sections = sortedDays.map(group => {
    // 组内按时间倒序，第一条即为该组最新时间
    group.items.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
    const header = formatDateHeader(group.ts, group.items[0].dateAdded, lang);
    const items = group.items.map(b => {
        const title = escapeHtml(b.title || b.url || '(untitled)');
        const url = escapeHtml(b.url || '#');
        const domain = b.domain ? `<span class="domain">${escapeHtml(b.domain)}</span>` : '';
        const tags = (b.tags && b.tags.length)
          ? `<span class="tags">${b.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</span>`
          : '';
        const pin = b.pinned ? `<span class="pin" title="pinned">·</span>` : '';
        return `      <li><a href="${url}">${title}</a>${pin}${domain}${tags}</li>`;
      }).join('\n');
    return `  <section>\n    <h2>${escapeHtml(header)}</h2>\n    <ul>\n${items}\n    </ul>\n  </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(L.title)} · ${stamp}</title>
<style>
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #8a8a8a;
  --line: #ececec;
  --hover: #f6f6f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0e0e;
    --fg: #ececec;
    --muted: #777777;
    --line: #1f1f1f;
    --hover: #181818;
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: var(--bg); color: var(--fg); }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui,
               "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  max-width: 680px;
  margin: 0 auto;
  padding: 64px 24px 96px;
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
header {
  margin-bottom: 48px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
}
h1 {
  font-size: 17px;
  font-weight: 500;
  letter-spacing: -0.005em;
}
.meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
section { margin-bottom: 36px; }
h2 {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--muted);
  margin-bottom: 10px;
  font-variant-numeric: tabular-nums;
}
ul { list-style: none; }
li {
  padding: 5px 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
li:hover { background: var(--hover); }
a {
  color: var(--fg);
  text-decoration: none;
  word-break: break-word;
}
a:hover { text-decoration: underline; text-underline-offset: 2px; }
.domain {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.tags { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.tag {
  color: var(--muted);
  font-size: 12px;
}
.pin {
  color: var(--muted);
  font-size: 12px;
  width: 4px;
  height: 4px;
  background: currentColor;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
  align-self: center;
}
@media print {
  body { padding: 24px 0; }
  li:hover { background: transparent; }
}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(L.title)}</h1>
  <p class="meta">${escapeHtml(L.count(total))}</p>
</header>
${sections}
</body>
</html>`;
}

async function handleExportHtml() {
  try {
    const result = await chrome.runtime.sendMessage({ action: 'exportData' });
    if (!result?.success) { showToast(i18n('importFailed'), 'error'); return; }
    const page = buildBookmarksPage(result.bookmarks || []);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadFile(`markline-bookmarks-${stamp}.html`, page, 'text/html;charset=utf-8');
    showToast(i18n('settingsSaved'), 'success');
  } catch (e) {
    console.error(e);
    showToast(i18n('importFailed'), 'error');
  }
}

function parseImportedJSON(text) {
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data.bookmarks || []);
    return list.filter(b => b && b.url).map(b => ({
      id: 'imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: b.title || b.url,
      url: b.url,
      domain: extractDomain(b.url),
      dateAdded: b.dateAdded || Date.now(),
      tags: Array.isArray(b.tags) ? b.tags : [],
      pinned: !!b.pinned
    }));
  } catch (e) { return null; }
}

function parseImportedHTML(text) {
  const results = [];
  const re = /<a[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const url = m[1];
    const title = m[2] || url;
    if (!url || url.startsWith('javascript:') || url.startsWith('data:')) continue;
    results.push({
      id: 'imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title, url,
      domain: extractDomain(url),
      dateAdded: Date.now(),
      tags: [], pinned: false
    });
  }
  return results;
}

async function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    const text = e.target.result;
    let items = null;
    if (file.name.endsWith('.json')) items = parseImportedJSON(text);
    else items = parseImportedHTML(text);
    if (!items || items.length === 0) { showToast(i18n('importEmpty'), 'error'); return; }
    try {
      const result = await chrome.runtime.sendMessage({ action: 'importData', bookmarks: items, mode: 'merge' });
      if (result?.success) {
        showToast(i18n('importedCount', [String(result.added)]), 'success');
      } else {
        showToast(i18n('importFailed'), 'error');
      }
    } catch (err) {
      console.error(err);
      showToast(i18n('importFailed'), 'error');
    }
  };
  reader.readAsText(file);
}

if (exportJsonBtn) exportJsonBtn.addEventListener('click', handleExportJson);
if (exportHtmlBtn) exportHtmlBtn.addEventListener('click', handleExportHtml);
if (importFileBtn) importFileBtn.addEventListener('click', () => importFileInput.click());
if (importFileInput) {
  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
    importFileInput.value = '';
  });
}

// ===== 监听存储变化 =====
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.theme) {
      const newTheme = changes.theme.newValue || 'system';
      themeSelect.value = newTheme;
      applyTheme(newTheme);
    }
    if (changes.language) {
      const newLanguage = changes.language.newValue || 'system';
      languageSelect.value = newLanguage;
      setCurrentLang(newLanguage);
      applyI18n();
    }
    if (changes.checkerFrequency) {
      checkerFrequencySelect.value = changes.checkerFrequency.newValue || 'never';
      toggleCheckerScheduleRows(changes.checkerFrequency.newValue || 'never');
    }
    if (changes.checkerTime) {
      checkerTimeInput.value = changes.checkerTime.newValue || '03:00';
    }
    if (changes.checkerAutoDelete) {
      checkerAutoDeleteToggle.checked = !!changes.checkerAutoDelete.newValue;
    }
    if (changes.checkerTimeout) {
      checkerTimeoutSelect.value = changes.checkerTimeout.newValue || '10000';
    }
    if (changes.checkerConcurrency) {
      checkerConcurrencySelect.value = changes.checkerConcurrency.newValue || '5';
    }
    if (changes.checkerRetries) {
      checkerRetriesSelect.value = String(changes.checkerRetries.newValue ?? 2);
    }
    if (changes.checkerBackoffBase) {
      checkerBackoffBaseSelect.value = String(changes.checkerBackoffBase.newValue ?? 800);
    }
    if (changes.checkerBackoffMax) {
      checkerBackoffMaxSelect.value = String(changes.checkerBackoffMax.newValue ?? 3000);
    }
    if (changes.ai_classifier_logs) {
      renderAILogs();
    }
    // RSS 订阅数据变化：刷新最后更新时间与未读徽标
    if (changes.rss_feeds || changes.rss_settings) {
      refreshRssLastUpdated();
      refreshRssUnreadBadge();
    }
    if (changes.rss_settings) {
      // 设置可能在其他窗口被改动，重新加载本地 UI 状态
      loadRssSettings();
    }
    // items 分片键变化（rss_items_<feedId>）触发未读刷新
    for (const key of Object.keys(changes)) {
      if (key.startsWith('rss_items_')) {
        refreshRssUnreadBadge();
        break;
      }
    }
    // 推送设置变化：重新加载 UI
    if (changes.push_settings) {
      loadPushSettings();
    }
  }
});

// ===== 推送通知设置 =====

// 根据当前 providerType 更新服务商下拉的可选项
function updateProviderOptionsVisibility(providerType) {
  const httpGroup = document.getElementById('pushProviderHttpGroup');
  const smtpGroup = document.getElementById('pushProviderSmtpGroup');
  if (!httpGroup || !smtpGroup) return;
  // 仅显示当前类型的 optgroup，隐藏另一组
  httpGroup.style.display = providerType === 'http' ? '' : 'none';
  smtpGroup.style.display = providerType === 'smtp' ? '' : 'none';
}

// 测试按钮状态：未启用推送时置灰
function updatePushTestButtonState() {
  pushTestBtn.disabled = !pushEnabledToggle.checked;
}

// 根据当前 providerType 和 provider 更新字段显隐
function updatePushFieldsVisibility() {
  const providerType = document.querySelector('input[name="pushProviderType"]:checked')?.value || 'http';
  const provider = pushProviderSelect.value;

  const isHttp = providerType === 'http';
  const isSmtp = providerType === 'smtp';
  const isHttpCustom = isHttp && provider === 'custom';
  const isSmtpCustom = isSmtp && provider === 'custom-smtp';

  // 同步服务商下拉仅显示当前类型的选项
  updateProviderOptionsVisibility(providerType);

  // HTTP 模式字段
  document.querySelectorAll('.push-http-only').forEach(el => {
    el.classList.toggle('is-visible', isHttp);
  });
  document.querySelectorAll('.push-http-custom-only').forEach(el => {
    el.classList.toggle('is-visible', isHttpCustom);
  });

  // SMTP 模式字段
  document.querySelectorAll('.push-smtp-only').forEach(el => {
    el.classList.toggle('is-visible', isSmtp);
  });
  document.querySelectorAll('.push-smtp-custom-only').forEach(el => {
    el.classList.toggle('is-visible', isSmtpCustom);
  });

  // SMTP 模式下自动检测桥接程序状态
  if (isSmtp) {
    checkBridgeStatus();
  }
}

// 切换 providerType 时，自动选对应组的第一个 provider
function syncProviderByType(type) {
  const currentValue = pushProviderSelect.value;
  const currentIsHttp = _HTTP_PROVIDER_VALUES.has(currentValue);
  if (type === 'http' && !currentIsHttp) {
    pushProviderSelect.value = 'resend';
  } else if (type === 'smtp' && currentIsHttp) {
    pushProviderSelect.value = 'gmail';
  }
}

// 根据当前 provider 更新发件人输入框 placeholder
function updateFromPlaceholder() {
  const providerType = document.querySelector('input[name="pushProviderType"]:checked')?.value || 'http';
  const provider = pushProviderSelect.value;
  const domain = _PROVIDER_DOMAIN[provider] || 'sender@example.com';

  let placeholder;
  if (providerType === 'http') {
    // HTTP API 模式：显示带发件人名称的默认地址
    placeholder = `Markline <${domain}>`;
  } else {
    // SMTP 模式：发件人通常是用户自己的邮箱
    placeholder = domain;
  }

  pushFromInput.placeholder = placeholder;
}

// 判断 from 值是否是某个服务商的预设地址（非用户自定义）
function isPresetFrom(value) {
  if (!value) return false;
  const v = value.trim();
  for (const domain of Object.values(_PROVIDER_DOMAIN)) {
    if (v === domain || v === `Markline <${domain}>`) return true;
  }
  return false;
}

// 检测本地 SMTP 桥接程序状态
async function checkBridgeStatus() {
  if (!pushBridgeStatusText) return;
  pushBridgeStatusText.textContent = '检测中…';
  pushBridgeStatusText.className = 'push-bridge-status push-bridge-status--checking';
  try {
    const res = await chrome.runtime.sendMessage({ action: 'pushBridgeHealth' });
    if (res && res.running) {
      pushBridgeStatusText.textContent = `运行中 v${res.version}`;
      pushBridgeStatusText.className = 'push-bridge-status push-bridge-status--ok';
    } else {
      pushBridgeStatusText.textContent = '未运行';
      pushBridgeStatusText.className = 'push-bridge-status push-bridge-status--error';
    }
  } catch {
    pushBridgeStatusText.textContent = '检测失败';
    pushBridgeStatusText.className = 'push-bridge-status push-bridge-status--error';
  }
}

// 桥接检测按钮
if (pushBridgeCheckBtn) {
  pushBridgeCheckBtn.addEventListener('click', checkBridgeStatus);
}

// 切换服务商时，若 from 输入框当前值是某个服务商的默认地址（自动填入的），清空它以让新 placeholder 显示
function clearFromIfPreset() {
  if (isPresetFrom(pushFromInput.value)) {
    pushFromInput.value = '';
  }
}

// 刷新当前 provider 对应的 API Key / SMTP 授权码状态显示（不重载全部设置）
async function refreshPushCredStatus() {
  const provider = pushProviderSelect.value;
  if (!provider) return;
  try {
    const res = await chrome.runtime.sendMessage({ action: 'pushGetCredStatus', provider });
    if (!res || !res.success) return;
    // API Key 状态
    pushApiKeyInput.value = '';
    if (res.hasApiKey) {
      pushApiKeyStatus.textContent = i18n('pushApiKeySet') || '已配置';
      pushApiKeyStatus.classList.add('is-set');
    } else {
      pushApiKeyStatus.textContent = i18n('pushApiKeyNotSet') || '未配置';
      pushApiKeyStatus.classList.remove('is-set');
    }
    // SMTP 授权码状态
    pushSmtpPassInput.value = '';
    if (res.hasSmtpPass) {
      pushSmtpPassStatus.textContent = i18n('pushApiKeySet') || '已配置';
      pushSmtpPassStatus.classList.add('is-set');
    } else {
      pushSmtpPassStatus.textContent = i18n('pushApiKeyNotSet') || '未配置';
      pushSmtpPassStatus.classList.remove('is-set');
    }
  } catch {}
}

async function loadPushSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'pushGetSettings' });
    const s = (res && res.settings) || {};
    pushEnabledToggle.checked = !!s.enabled;
    pushStrategySelect.value = s.strategy === 'instant' ? 'instant' : 'daily';
    pushDailySendAtInput.value = s.dailySendAt || '08:00';
    // 摘要样式（仅 daily 生效）
    pushDigestStyleSelect.value = (s.digest && s.digest.style === 'list') ? 'list' : 'briefing';
    pushDigestMaxInput.value = s.digest?.maxItems || 30;
    pushQuietStartInput.value = s.quietHours?.start || '';
    pushQuietEndInput.value = s.quietHours?.end || '';
    pushKeywordsIncludeInput.value = (s.keywords?.include || []).join(', ');
    pushKeywordsExcludeInput.value = (s.keywords?.exclude || []).join(', ');
    pushEmailToInput.value = s.email?.to || '';
    // 过滤掉预设地址：若是服务商默认地址则不恢复到输入框，让 placeholder 正常显示
    const savedFrom = s.email?.from || '';
    pushFromInput.value = isPresetFrom(savedFrom) ? '' : savedFrom;

    // providerType 单选
    const pt = s.email?.providerType || 'http';
    document.querySelector(`input[name="pushProviderType"][value="${pt}"]`).checked = true;

    // provider 下拉
    const provider = s.email?.provider || (pt === 'smtp' ? 'gmail' : 'resend');
    pushProviderSelect.value = provider;

    // SMTP 字段
    pushSmtpUsernameInput.value = s.email?.username || '';
    pushSmtpHostInput.value = s.email?.smtpHost || '';
    pushSmtpPortInput.value = s.email?.smtpPort || 465;
    pushSmtpTlsSelect.value = s.email?.smtpTls || 'ssl';

    // HTTP 字段
    pushHttpEndpointInput.value = s.email?.endpoint || '';
    // 预置 provider 强制使用固定 authType，custom 才用存储的 authType
    const httpProvider = s.email?.provider || (pt === 'smtp' ? '' : 'resend');
    const effectiveAuthType = (pt === 'http' && httpProvider !== 'custom')
      ? (_HTTP_PRESET_AUTH_TYPE[httpProvider] || 'bearer')
      : (s.email?.authType || 'bearer');
    pushHttpAuthTypeSelect.value = effectiveAuthType;

    // 凭证状态（API Key / SMTP 授权码）按当前 provider 刷新
    await refreshPushCredStatus();

    updatePushFieldsVisibility();
    updateStrategyVisibility();
    updateDigestVisibility();
    updatePushTestButtonState();
    updateFromPlaceholder();
    // 加载发送历史
    loadPushHistory();
  } catch {
    pushEnabledToggle.checked = false;
    pushStrategySelect.value = 'daily';
    pushDigestStyleSelect.value = 'briefing';
    pushDigestMaxInput.value = 30;
    document.querySelector('input[name="pushProviderType"][value="http"]').checked = true;
    pushProviderSelect.value = 'resend';
    updatePushFieldsVisibility();
    updateStrategyVisibility();
    updateDigestVisibility();
    updatePushTestButtonState();
    updateFromPlaceholder();
  }
}

// 根据当前 strategy 显隐 dailySendAt / quietHours 字段
function updateStrategyVisibility() {
  const strategy = pushStrategySelect.value;
  const isDaily = strategy === 'daily';
  const isInstant = strategy === 'instant';
  document.querySelectorAll('.push-daily-only').forEach(el => {
    el.classList.toggle('is-visible', isDaily);
  });
  document.querySelectorAll('.push-instant-only').forEach(el => {
    el.classList.toggle('is-visible', isInstant);
  });
  // daily/instant 切换时同步刷新摘要区域显隐
  updateDigestVisibility();
}

// 根据摘要样式显隐 maxItems + AI 未配置警告
// briefing 模式下显示 maxItems；若 AI 未配置则显示警告条
// list 模式下隐藏 maxItems 和警告条
async function updateDigestVisibility() {
  const strategy = pushStrategySelect.value;
  const style = pushDigestStyleSelect.value;
  const isBriefing = strategy === 'daily' && style === 'briefing';
  // maxItems 行仅在 briefing 模式显示
  const maxRow = document.getElementById('pushDigestMaxRow');
  if (maxRow) maxRow.style.display = isBriefing ? '' : 'none';
  // AI 未配置警告：仅 briefing 模式下检查
  if (isBriefing) {
    const aiConfigured = await checkAIConfigured();
    if (pushDigestAiWarnRow) pushDigestAiWarnRow.style.display = aiConfigured ? 'none' : '';
  } else {
    if (pushDigestAiWarnRow) pushDigestAiWarnRow.style.display = 'none';
  }
}

// 检测 AI 分类服务是否已配置（读 chrome.storage.local）
async function checkAIConfigured() {
  try {
    const r = await chrome.storage.local.get('ai_classifier_config');
    const cfg = r.ai_classifier_config || {};
    return !!(cfg.enabled && cfg.apiKey);
  } catch {
    return false;
  }
}

// 保存非密钥字段
async function savePushSettings(patch) {
  await chrome.runtime.sendMessage({ action: 'pushSetSettings', patch });
}

pushEnabledToggle.addEventListener('change', () => {
  savePushSettings({ enabled: pushEnabledToggle.checked });
  updatePushTestButtonState();
});
pushStrategySelect.addEventListener('change', () => {
  savePushSettings({ strategy: pushStrategySelect.value });
  updateStrategyVisibility();
});
pushDailySendAtInput.addEventListener('change', () => {
  savePushSettings({ dailySendAt: pushDailySendAtInput.value || '08:00' });
});
pushDigestStyleSelect.addEventListener('change', () => {
  savePushSettings({ digest: { style: pushDigestStyleSelect.value, aiEnabled: pushDigestStyleSelect.value === 'briefing' } });
  updateDigestVisibility();
});
pushDigestMaxInput.addEventListener('change', () => {
  let v = parseInt(pushDigestMaxInput.value, 10);
  if (isNaN(v)) v = 30;
  v = Math.min(Math.max(v, 10), 50);
  pushDigestMaxInput.value = v;
  savePushSettings({ digest: { maxItems: v } });
});
// 警告条"去配置"链接：切换到 AI 分类设置面板
if (pushDigestAiConfigLink) {
  pushDigestAiConfigLink.addEventListener('click', (e) => {
    e.preventDefault();
    const aiNav = document.querySelector('.nav-item[data-panel="ai"]');
    if (aiNav) aiNav.click();
  });
}
pushQuietStartInput.addEventListener('change', () => {
  savePushSettings({ quietHours: { start: pushQuietStartInput.value, end: pushQuietEndInput.value } });
});
pushQuietEndInput.addEventListener('change', () => {
  savePushSettings({ quietHours: { start: pushQuietStartInput.value, end: pushQuietEndInput.value } });
});
// 关键词过滤：逗号分隔转数组
function _parseKeywords(str) {
  return str.split(',').map(s => s.trim()).filter(Boolean);
}
pushKeywordsIncludeInput.addEventListener('change', () => {
  savePushSettings({ keywords: { include: _parseKeywords(pushKeywordsIncludeInput.value), exclude: _parseKeywords(pushKeywordsExcludeInput.value) } });
});
pushKeywordsExcludeInput.addEventListener('change', () => {
  savePushSettings({ keywords: { include: _parseKeywords(pushKeywordsIncludeInput.value), exclude: _parseKeywords(pushKeywordsExcludeInput.value) } });
});
pushEmailToInput.addEventListener('change', () => {
  savePushSettings({ email: { to: pushEmailToInput.value.trim() } });
});
pushFromInput.addEventListener('change', () => {
  savePushSettings({ email: { from: pushFromInput.value.trim() } });
});

// 服务类型切换
pushProviderTypeRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    const type = radio.value;
    syncProviderByType(type);
    clearFromIfPreset();
    updatePushFieldsVisibility();
    updateFromPlaceholder();
    savePushSettings({ email: { providerType: type, provider: pushProviderSelect.value } });
    // 切换后刷新凭证状态显示
    refreshPushCredStatus();
  });
});

// 服务商切换
pushProviderSelect.addEventListener('change', () => {
  const provider = pushProviderSelect.value;
  // 若 provider 不属于当前 type，自动切换 type
  const isHttpProvider = _HTTP_PROVIDER_VALUES.has(provider);
  const currentType = document.querySelector('input[name="pushProviderType"]:checked')?.value;
  if (isHttpProvider && currentType !== 'http') {
    document.querySelector('input[name="pushProviderType"][value="http"]').checked = true;
  } else if (!isHttpProvider && currentType !== 'smtp') {
    document.querySelector('input[name="pushProviderType"][value="smtp"]').checked = true;
  }
  clearFromIfPreset();
  updatePushFieldsVisibility();
  updateFromPlaceholder();
  // 预置 provider 强制使用其固定 authType，避免残留的 custom authType 干扰
  const patch = { email: { provider } };
  if (isHttpProvider && provider !== 'custom') {
    const presetAuthType = _HTTP_PRESET_AUTH_TYPE[provider];
    if (presetAuthType) {
      pushHttpAuthTypeSelect.value = presetAuthType;
      patch.email.authType = presetAuthType;
    }
  }
  savePushSettings(patch);
  // 切换服务商后刷新凭证状态显示
  refreshPushCredStatus();
});

// SMTP 账号/主机/端口/加密
pushSmtpUsernameInput.addEventListener('change', () => {
  savePushSettings({ email: { username: pushSmtpUsernameInput.value.trim() } });
});
pushSmtpHostInput.addEventListener('change', () => {
  savePushSettings({ email: { smtpHost: pushSmtpHostInput.value.trim() } });
});
pushSmtpPortInput.addEventListener('change', () => {
  const v = Math.max(1, Math.min(65535, parseInt(pushSmtpPortInput.value) || 465));
  pushSmtpPortInput.value = v;
  savePushSettings({ email: { smtpPort: v } });
});
pushSmtpTlsSelect.addEventListener('change', () => {
  savePushSettings({ email: { smtpTls: pushSmtpTlsSelect.value } });
});

// SMTP 授权码保存/清除
pushSaveSmtpPassBtn.addEventListener('click', async () => {
  const pass = pushSmtpPassInput.value.trim();
  if (!pass) {
    showToast(i18n('pushSmtpPassEmpty') || '请输入授权码', 'error');
    return;
  }
  const provider = pushProviderSelect.value;
  pushSaveSmtpPassBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ action: 'pushSetSmtpPass', password: pass, provider });
    if (res && res.success) {
      showToast(i18n('pushSmtpPassSaved') || 'SMTP 授权码已加密保存', 'success');
      pushSmtpPassInput.value = '';
      await refreshPushCredStatus();
    } else {
      showToast(i18n('pushApiKeySaveFailed') || '保存失败', 'error');
    }
  } catch {
    showToast(i18n('pushApiKeySaveFailed') || '保存失败', 'error');
  } finally {
    pushSaveSmtpPassBtn.disabled = false;
  }
});

pushClearSmtpPassBtn.addEventListener('click', async () => {
  const provider = pushProviderSelect.value;
  pushClearSmtpPassBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action: 'pushClearSmtpPass', provider });
    showToast(i18n('pushSmtpPassCleared') || 'SMTP 授权码已清除', 'success');
    await refreshPushCredStatus();
  } finally {
    pushClearSmtpPassBtn.disabled = false;
  }
});

// HTTP API Key 保存/清除
pushSaveApiKeyBtn.addEventListener('click', async () => {
  const key = pushApiKeyInput.value.trim();
  if (!key) {
    showToast(i18n('pushApiKeyEmpty') || '请输入 API Key', 'error');
    return;
  }
  const provider = pushProviderSelect.value;
  pushSaveApiKeyBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ action: 'pushSetApiKey', apiKey: key, provider });
    if (res && res.success) {
      showToast(i18n('pushApiKeySaved') || 'API Key 已加密保存', 'success');
      pushApiKeyInput.value = '';
      await refreshPushCredStatus();
    } else {
      showToast(i18n('pushApiKeySaveFailed') || '保存失败', 'error');
    }
  } catch {
    showToast(i18n('pushApiKeySaveFailed') || '保存失败', 'error');
  } finally {
    pushSaveApiKeyBtn.disabled = false;
  }
});

pushClearApiKeyBtn.addEventListener('click', async () => {
  const provider = pushProviderSelect.value;
  pushClearApiKeyBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ action: 'pushClearApiKey', provider });
    showToast(i18n('pushApiKeyCleared') || 'API Key 已清除', 'success');
    await refreshPushCredStatus();
  } finally {
    pushClearApiKeyBtn.disabled = false;
  }
});

// HTTP Custom 端点/鉴权
pushHttpEndpointInput.addEventListener('change', () => {
  savePushSettings({ email: { endpoint: pushHttpEndpointInput.value.trim() } });
});
pushHttpAuthTypeSelect.addEventListener('change', () => {
  savePushSettings({ email: { authType: pushHttpAuthTypeSelect.value } });
});

pushTestBtn.addEventListener('click', async () => {
  pushTestBtn.disabled = true;
  const original = pushTestBtn.innerHTML;
  pushTestBtn.innerHTML = '<span>' + (i18n('pushTesting') || 'Sending...') + '</span>';
  try {
    const res = await chrome.runtime.sendMessage({ action: 'pushSendTest' });
    if (res && res.ok) {
      showToast(i18n('pushTestSuccess') || '测试邮件已发送', 'success');
    } else {
      const err = (res && res.error) || 'unknown';
      showToast((i18n('pushTestFailed') || '测试失败: $1').replace('$1', err), 'error');
    }
  } catch (e) {
    showToast((i18n('pushTestFailed') || '测试失败: $1').replace('$1', e.message), 'error');
  } finally {
    pushTestBtn.disabled = false;
    pushTestBtn.innerHTML = original;
  }
});

// ===== 立即发送队列 =====
pushFlushNowBtn.addEventListener('click', async () => {
  pushFlushNowBtn.disabled = true;
  const original = pushFlushNowBtn.innerHTML;
  pushFlushNowBtn.innerHTML = '<span>' + (i18n('pushFlushing') || '发送中...') + '</span>';
  try {
    const res = await chrome.runtime.sendMessage({ action: 'pushFlushNow' });
    if (res && res.ok) {
      showToast((i18n('pushFlushSuccess') || '已发送 $1 篇').replace('$1', String(res.sent || 0)), 'success');
    } else if (res && res.skipped) {
      const reason = res.reason === 'empty_queue' ? '队列为空' : (res.reason === 'filtered_out' ? '全部被关键词过滤' : res.reason);
      showToast(i18n('pushFlushSkipped') || '跳过: ' + reason, 'info');
    } else if (res && res.retrying) {
      showToast(i18n('pushFlushRetry') || '发送失败，将自动重试', 'error');
    } else {
      const err = (res && res.error) || 'unknown';
      showToast((i18n('pushFlushFailed') || '发送失败: $1').replace('$1', err), 'error');
    }
    // 刷新历史
    loadPushHistory();
  } catch (e) {
    showToast((i18n('pushFlushFailed') || '发送失败: $1').replace('$1', e.message), 'error');
  } finally {
    pushFlushNowBtn.disabled = false;
    pushFlushNowBtn.innerHTML = original;
  }
});

// ===== 诊断：查看 alarm 状态 =====
pushDiagBtn.addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'pushGetAlarmStatus' });
    if (!res || !res.success) {
      showToast('诊断失败: ' + (res?.error || 'unknown'), 'error');
      return;
    }
    const lines = [];
    lines.push('每日摘要 Alarm: ' + (res.dailyAlarm ? res.dailyAlarm.scheduledTime : '❌ 未创建'));
    if (res.dailyAlarm) lines.push('  周期: ' + res.dailyAlarm.periodInMinutes + ' 分钟');
    lines.push('重试 Alarm: ' + (res.retryAlarm ? res.retryAlarm.scheduledTime : '无'));
    lines.push('静默结束 Alarm: ' + (res.quietEndAlarm ? res.quietEndAlarm.scheduledTime : '无'));
    lines.push('队列长度: ' + res.queueLength + ' 篇');
    lines.push('历史记录: ' + res.historyLength + ' 条');
    if (res.lastHistory) {
      lines.push('最近一次: ' + (res.lastHistory.status === 'success' ? '✓' : '✗') + ' ' + new Date(res.lastHistory.time).toLocaleString());
    }
    // 如果 daily 模式但 alarm 不存在，提示重建
    const needRebuild = !res.dailyAlarm;
    if (needRebuild) {
      lines.push('\n⚠️ 每日摘要 Alarm 缺失！点击"确定"后自动重建。');
    }
    alert(lines.join('\n'));
    // 自动重建
    if (needRebuild) {
      await chrome.runtime.sendMessage({ action: 'pushRebuildAlarms' });
      showToast('已重建定时器', 'success');
    }
  } catch (e) {
    showToast('诊断失败: ' + e.message, 'error');
  }
});

// ===== 发送历史 =====
async function loadPushHistory() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'pushGetHistory' });
    if (!res || !res.success) return;
    renderPushHistory(res.history || []);
  } catch {}
}

function renderPushHistory(history) {
  if (!pushHistoryList) return;
  if (!history || history.length === 0) {
    pushHistoryList.innerHTML = `<div class="push-empty-hint">${i18n('pushHistoryEmpty') || '暂无发送记录'}</div>`;
    return;
  }
  pushHistoryList.innerHTML = history.map(h => {
    const time = new Date(h.time).toLocaleString();
    const isSuccess = h.status === 'success';
    const statusClass = isSuccess ? 'push-history-status--success' : 'push-history-status--failed';
    const statusText = isSuccess ? '✓' : '✗';
    const countText = h.count ? `${h.count} 篇` : '';
    const errText = (!isSuccess && h.error) ? `<span class="push-history-error">${_escHtml(h.error)}</span>` : '';
    return `
      <div class="push-history-item">
        <span class="push-history-status ${statusClass}">${statusText}</span>
        <span class="push-history-time">${time}</span>
        <span class="push-history-count">${countText}</span>
        ${errText}
      </div>`;
  }).join('');
}

function _escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

pushClearHistoryBtn.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ action: 'pushClearHistory' });
    showToast(i18n('pushHistoryCleared') || '历史已清空', 'success');
    loadPushHistory();
  } catch {}
});

// 监听 push_history 存储变化，实时刷新历史列表
chrome.storage.onChanged.addListener((changes) => {
  if (changes.push_history) {
    loadPushHistory();
  }
});

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  loadLanguage();
  loadCheckerSettings();
  loadRetentionDays();
  loadPreviewSettings();
  loadShortcutSettings();
  loadTagRules();
  loadAISettings();
  loadActiveLearning();
  loadNotificationSettings();
  loadRssSettings();
  // 等待推送设置加载完成，确保 placeholder 按存储值一次性正确显示
  await loadPushSettings();
  renderAILogs();

  // 处理 URL hash，自动打开指定面板
  const hash = window.location.hash.replace('#', '');
  if (hash) {
    const targetNav = document.querySelector(`.nav-item[data-panel="${hash}"]`);
    if (targetNav) {
      targetNav.click();
    }
  }
});

// ===== 通知设置 =====
async function loadNotificationSettings() {
  const result = await chrome.storage.local.get(['notificationEnabled']);
  notificationEnabledToggle.checked = !!result.notificationEnabled;
}

async function saveNotificationSetting(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// ===== 快捷键设置 =====
const COMMAND_LABELS = {
  'quick-bookmark': { el: shortcutQuickBookmark, name: 'Quick Bookmark' },
  'open-command-palette': { el: shortcutOpenPalette, name: 'Command Palette' },
  'open-popup': { el: shortcutOpenPopup, name: 'Open Markline' }
};

async function loadShortcutSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getCommands' });
    if (!res || !res.success) return;
    const commands = res.commands || [];

    for (const cmd of commands) {
      const info = COMMAND_LABELS[cmd.name];
      if (!info || !info.el) continue;

      const shortcut = cmd.shortcut || '';
      if (shortcut) {
        info.el.textContent = formatShortcut(shortcut);
        info.el.classList.remove('unset');
      } else {
        info.el.textContent = i18n('shortcutNotSet') || 'Not set';
        info.el.classList.add('unset');
      }
    }

    // 冲突检测
    detectShortcutConflicts(commands);
  } catch (e) {
    // 静默处理
  }
}

function formatShortcut(shortcut) {
  return shortcut
    .replace(/Command/i, '⌘')
    .replace(/Ctrl/i, 'Ctrl')
    .replace(/Shift/i, '⇧')
    .replace(/Alt/i, 'Alt')
    .replace(/\+/g, ' + ');
}

function detectShortcutConflicts(commands) {
  const conflicts = [];
  const keyMap = new Map(); // normalizedKey -> [commandName, ...]

  // 收集所有已设置的快捷键
  for (const cmd of commands) {
    if (!cmd.shortcut) continue;
    const key = cmd.shortcut.toLowerCase().replace(/\s+/g, '');
    if (!keyMap.has(key)) keyMap.set(key, []);
    keyMap.get(key).push(cmd.name);
  }

  // 检查内部冲突（同一扩展内重复）
  for (const [key, names] of keyMap) {
    if (names.length > 1) {
      const labels = names.map(n => COMMAND_LABELS[n]?.name || n);
      conflicts.push({
        key: formatShortcut(key),
        commands: labels,
        type: 'internal'
      });
    }
  }

  // 检查常见系统快捷键冲突
  const SYSTEM_CONFLICTS = [
    { key: 'Ctrl+D', system: 'Chrome 添加书签' },
    { key: 'Ctrl+Shift+D', system: 'Chrome 为所有标签页添加书签' },
    { key: 'Ctrl+Shift+B', system: 'Chrome 书签栏显示/隐藏' },
    { key: 'Ctrl+L', system: '聚焦地址栏' },
    { key: 'Ctrl+K', system: 'Chrome 搜索框' },
    { key: 'Ctrl+E', system: 'Chrome 搜索框' },
    { key: 'Ctrl+Shift+A', system: 'Chrome 搜索标签页' },
    { key: 'Ctrl+W', system: '关闭当前标签页' },
    { key: 'Ctrl+T', system: '新建标签页' },
    { key: 'Ctrl+N', system: '新建窗口' },
  ];

  for (const cmd of commands) {
    if (!cmd.shortcut) continue;
    const normalizedKey = cmd.shortcut.replace(/\s+/g, '');
    const systemConflict = SYSTEM_CONFLICTS.find(sc =>
      sc.key.toLowerCase() === normalizedKey.toLowerCase()
    );
    if (systemConflict) {
      conflicts.push({
        key: formatShortcut(normalizedKey),
        commands: [COMMAND_LABELS[cmd.name]?.name || cmd.name],
        system: systemConflict.system,
        type: 'system'
      });
    }
  }

  // 渲染冲突
  if (conflicts.length > 0) {
    shortcutConflicts.style.display = 'flex';
    conflictDetails.innerHTML = conflicts.map(c => {
      if (c.type === 'system') {
        return `<div class="conflict-item"><kbd>${escapeHtml(c.key)}</kbd> ${escapeHtml(c.commands[0])} → ${escapeHtml(c.system)}</div>`;
      }
      return `<div class="conflict-item"><kbd>${escapeHtml(c.key)}</kbd> ${escapeHtml(c.commands.join(' & '))} ${i18n('shortcutConflictInternal') || 'duplicate binding'}</div>`;
    }).join('');
  } else {
    shortcutConflicts.style.display = 'none';
  }
}

function escapeHtml(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 打开 Chrome 快捷键设置页
if (openShortcutsPageLink) {
  openShortcutsPageLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
}

// ===== 智能标签规则管理 =====
async function loadTagRules() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getDynamicRules' });
    if (!res || !res.success) return;
    const rules = res.rules || {};
    renderDomainRules(rules.domainRules || []);
    renderKeywordRules(rules.keywordRules || {});
    renderStopWords(rules.stopWords || []);
    renderLearnedTags(rules.learnedDomainTag || {});
  } catch (e) {
    // 静默处理
  }
}

function renderDomainRules(domainRules) {
  if (!domainRules || domainRules.length === 0) {
    domainRulesList.innerHTML = `<div class="tagrule-empty">${i18n('noDomainRules') || '暂无自定义域名规则'}</div>`;
    return;
  }
  domainRulesList.innerHTML = domainRules.map((r, idx) => `
    <div class="tagrule-item">
      <span class="tagrule-item-text">${escapeHtml((r.domains || []).join(', '))}</span>
      <span class="tagrule-item-tag">${escapeHtml(r.tag)}</span>
      <button class="tagrule-item-delete" data-idx="${idx}" data-tag="${escapeHtml(r.tag)}" title="${i18n('delete') || '删除'}">×</button>
    </div>
  `).join('');
  domainRulesList.querySelectorAll('.tagrule-item-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tag = btn.dataset.tag;
      await chrome.runtime.sendMessage({ action: 'removeDynamicDomainRule', tag });
      await loadTagRules();
      showToast(i18n('settingsSaved'), 'success');
    });
  });
}

function renderKeywordRules(keywordRules) {
  const entries = Object.entries(keywordRules || {});
  if (entries.length === 0) {
    keywordRulesList.innerHTML = `<div class="tagrule-empty">${i18n('noKeywordRules') || '暂无自定义关键词规则'}</div>`;
    return;
  }
  keywordRulesList.innerHTML = entries.map(([tag, kws]) => `
    <div class="tagrule-item">
      <span class="tagrule-item-text">${escapeHtml((kws || []).join(', '))}</span>
      <span class="tagrule-item-tag">${escapeHtml(tag)}</span>
    </div>
  `).join('');
}

function renderStopWords(stopWords) {
  if (!stopWords || stopWords.length === 0) {
    stopWordsList.innerHTML = `<div class="tagrule-empty">${i18n('noStopWords') || '暂无自定义停用词'}</div>`;
    return;
  }
  stopWordsList.innerHTML = stopWords.map(w => `
    <div class="tagrule-item">
      <span class="tagrule-item-text">${escapeHtml(w)}</span>
      <button class="tagrule-item-delete" data-word="${escapeHtml(w)}" title="${i18n('delete') || '删除'}">×</button>
    </div>
  `).join('');
  stopWordsList.querySelectorAll('.tagrule-item-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      // 停用词删除：重新获取规则，移除该项后保存
      const res = await chrome.runtime.sendMessage({ action: 'getDynamicRules' });
      if (res && res.success && res.rules) {
        const word = btn.dataset.word;
        res.rules.stopWords = (res.rules.stopWords || []).filter(w => w !== word);
        // 直接保存（复用 saveDynamicRules via background）
        await chrome.runtime.sendMessage({ action: 'saveDynamicRules', rules: res.rules });
        await loadTagRules();
        showToast(i18n('settingsSaved'), 'success');
      }
    });
  });
}

function renderLearnedTags(learnedDomainTag) {
  const entries = Object.entries(learnedDomainTag || {});
  if (entries.length === 0) {
    learnedTagsList.innerHTML = `<div class="tagrule-empty">${i18n('noLearnedTags') || '暂无自动学习记录'}</div>`;
    return;
  }
  learnedTagsList.innerHTML = entries.map(([domain, tag]) => `
    <div class="tagrule-item">
      <span class="tagrule-item-text">${escapeHtml(domain)}</span>
      <span class="tagrule-item-tag">${escapeHtml(tag)}</span>
    </div>
  `).join('');
}

// 添加域名规则
addDomainRuleBtn.addEventListener('click', async () => {
  const domainsStr = domainRuleDomains.value.trim();
  const tag = domainRuleTag.value.trim();
  if (!domainsStr || !tag) {
    showToast(i18n('fillAllFields') || '请填写完整', 'error');
    return;
  }
  const domains = domainsStr.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  await chrome.runtime.sendMessage({ action: 'addDynamicDomainRule', domains, tag });
  domainRuleDomains.value = '';
  domainRuleTag.value = '';
  await loadTagRules();
  showToast(i18n('settingsSaved'), 'success');
});

// 添加关键词规则
addKeywordRuleBtn.addEventListener('click', async () => {
  const tag = keywordRuleTag.value.trim();
  const keyword = keywordRuleKeyword.value.trim();
  if (!tag || !keyword) {
    showToast(i18n('fillAllFields') || '请填写完整', 'error');
    return;
  }
  await chrome.runtime.sendMessage({ action: 'addDynamicKeyword', tag, keyword });
  keywordRuleTag.value = '';
  keywordRuleKeyword.value = '';
  await loadTagRules();
  showToast(i18n('settingsSaved'), 'success');
});

// 添加停用词
addStopWordBtn.addEventListener('click', async () => {
  const word = stopWordInput.value.trim();
  if (!word) {
    showToast(i18n('fillAllFields') || '请填写完整', 'error');
    return;
  }
  await chrome.runtime.sendMessage({ action: 'addDynamicStopWord', word });
  stopWordInput.value = '';
  await loadTagRules();
  showToast(i18n('settingsSaved'), 'success');
});

// 清空学习记录
clearLearnedTagsBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'clearLearnedDomainTags' });
  await loadTagRules();
  showToast(i18n('settingsSaved'), 'success');
});

// ===== 主动学习管理 =====
async function loadActiveLearning() {
  try {
    const [queueRes, statsRes] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getReviewQueue' }),
      chrome.runtime.sendMessage({ action: 'getLearningStats' })
    ]);

    const queue = (queueRes && queueRes.success) ? queueRes.queue || [] : [];
    const stats = (statsRes && statsRes.success) ? statsRes.stats : null;

    updateActiveLearningBadge(queue.length);
    renderLearningStats(stats);
    renderPendingReviews(queue);
  } catch (e) {
    // 静默处理
  }
}

function updateActiveLearningBadge(count) {
  if (!activeLearningBadge) return;
  if (count > 0) {
    activeLearningBadge.textContent = count > 99 ? '99+' : String(count);
    activeLearningBadge.style.display = 'inline-flex';
  } else {
    activeLearningBadge.style.display = 'none';
  }
}

function renderLearningStats(stats) {
  if (!stats) {
    learningStatsDesc.textContent = i18n('learningStatsDesc') || '—';
    return;
  }
  const accepted = stats.totalAccepted || 0;
  const modified = stats.totalModified || 0;
  const ignored = stats.totalIgnored || 0;
  const total = stats.totalReviewed || 0;
  learningStatsDesc.textContent = i18n('learningStatsFormat')
    ? i18n('learningStatsFormat', [total, accepted, modified, ignored])
    : `已确认 ${total} 条：接受 ${accepted} / 修改 ${modified} / 忽略 ${ignored}`;
}

function renderPendingReviews(queue) {
  if (!queue || queue.length === 0) {
    pendingReviewsList.innerHTML = `<div class="tagrule-empty">${i18n('noPendingReviews') || '暂无待确认的书签'}</div>`;
    return;
  }

  pendingReviewsList.innerHTML = queue.map(item => {
    const isAI = item.source === 'ai';
    const aiBadge = isAI
      ? `<span class="review-source review-source--ai">${i18n('aiAssistedTag') || 'AI 辅助分类'}</span>`
      : '';
    const reasonHtml = !isAI
      ? `<span class="review-reason">${escapeHtml(getReasonText(item.reason))}</span>`
      : '';
    return `
    <div class="review-item ${isAI ? 'review-item--ai' : ''}" data-id="${escapeHtml(item.id)}">
      <div class="review-info">
        <div class="review-title" title="${escapeHtml(item.url)}">${escapeHtml(item.title || item.url)}</div>
        <div class="review-meta">
          ${reasonHtml}
          ${aiBadge}
          <span class="review-confidence">置信度 ${(item.confidence * 100).toFixed(0)}%</span>
          <span class="review-score">权重分 ${(item.score ?? ((item.confidence || 0) * 100)).toFixed(2)}</span>
        </div>
        ${item.excerpt ? `<div class="review-excerpt">${escapeHtml(item.excerpt.slice(0, 120))}</div>` : ''}
      </div>
      <div class="review-suggested">
        <span class="tagrule-item-tag">${escapeHtml((item.suggestedTags || []).join(', ') || i18n('noTag') || '无标签')}</span>
      </div>
      <div class="review-actions">
        <input type="text" class="review-tag-input" placeholder="${i18n('tagPlaceholder') || '标签'}" value="${escapeHtml((item.suggestedTags || [])[0] || '')}">
        <button class="btn btn-primary btn-sm review-confirm" data-id="${escapeHtml(item.id)}">
          <span data-i18n="confirm">确认</span>
        </button>
        <button class="btn btn-secondary btn-sm review-modify" data-id="${escapeHtml(item.id)}">
          <span data-i18n="modify">修改</span>
        </button>
        <button class="btn btn-danger btn-sm review-ignore" data-id="${escapeHtml(item.id)}">
          <span data-i18n="ignore">忽略</span>
        </button>
      </div>
    </div>
  `}).join('');

  pendingReviewsList.querySelectorAll('.review-confirm').forEach(btn => {
    btn.addEventListener('click', () => onConfirmReview(btn.dataset.id, false));
  });
  pendingReviewsList.querySelectorAll('.review-modify').forEach(btn => {
    btn.addEventListener('click', () => onConfirmReview(btn.dataset.id, true));
  });
  pendingReviewsList.querySelectorAll('.review-ignore').forEach(btn => {
    btn.addEventListener('click', () => onIgnoreReview(btn.dataset.id));
  });
}

function getReasonText(reason) {
  const map = {
    empty: i18n('reasonEmpty') || '无标签',
    low_confidence: i18n('reasonLowConfidence') || '置信度低',
    ambiguous: i18n('reasonAmbiguous') || '标签相近',
    weak_signal: i18n('reasonWeakSignal') || '依据不足',
    new_domain: i18n('reasonNewDomain') || '新域名',
    title_noise: i18n('reasonTitleNoise') || '标题过短',
    signal_conflict: i18n('reasonSignalConflict') || '信号冲突',
    content_disagree: i18n('reasonContentDisagree') || '正文判断不一致',
    ai_assisted: i18n('reasonAIAssisted') || 'AI 辅助分类'
  };
  return map[reason] || reason;
}

async function onConfirmReview(id, isModify) {
  try {
    const queueRes = await chrome.runtime.sendMessage({ action: 'getReviewQueue' });
    if (!queueRes || !queueRes.success) return;
    const item = queueRes.queue.find(q => q.id === id);
    if (!item) return;

    const input = pendingReviewsList.querySelector(`.review-item[data-id="${CSS.escape(id)}"] .review-tag-input`);
    const tag = input ? input.value.trim() : ((item.suggestedTags || [])[0] || '');
    if (!tag) {
      showToast(i18n('fillAllFields') || '请填写标签', 'error');
      return;
    }

    await chrome.runtime.sendMessage({
      action: 'confirmTagReview',
      queueItem: item,
      confirmedTags: [tag],
      reviewAction: isModify ? 'modified' : 'accepted'
    });

    await loadActiveLearning();
    showToast(i18n('settingsSaved'), 'success');
  } catch (e) {
    // 静默处理
  }
}

async function onIgnoreReview(id) {
  try {
    const queueRes = await chrome.runtime.sendMessage({ action: 'getReviewQueue' });
    if (!queueRes || !queueRes.success) return;
    const item = queueRes.queue.find(q => q.id === id);
    if (!item) return;

    await chrome.runtime.sendMessage({ action: 'ignoreTagReview', queueItem: item });
    await loadActiveLearning();
    showToast(i18n('settingsSaved'), 'success');
  } catch (e) {
    // 静默处理
  }
}

// 清空待确认队列
clearReviewQueueBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'clearReviewQueue' });
  await loadActiveLearning();
  showToast(i18n('settingsSaved'), 'success');
});

// ===== 统计面板 =====
let _cachedBookmarks = null;
let _cachedStats = null;
let _currentTrendMode = 'daily';
let _currentHealthScore = null;
let _currentDateRange = { startTs: null, endTs: null };

async function loadStatsPanel() {
  try {
    if (!_cachedBookmarks) {
      const res = await chrome.runtime.sendMessage({ action: 'exportData' });
      _cachedBookmarks = (res && res.bookmarks) || [];
    }
    const bookmarks = _cachedBookmarks;
    const stats = BookmarkStats.computeBookmarkStats(bookmarks, _currentDateRange);
    _cachedStats = stats;
    _currentHealthScore = stats.health;

    renderStats(stats);
    renderCharts(stats);
    await loadAccuracyTrend();
    await loadHealthFavorites();
  } catch (err) {
    console.error('loadStatsPanel error:', err);
    showToast(i18n('loadFailed') || '加载失败', 'error');
  }
}

function renderStats(stats) {
  const ov = stats.overview;
  statTotal.textContent = ov.total;
  statTags.textContent = ov.totalTags;
  statDomains.textContent = ov.uniqueDomains;
  statFolders.textContent = ov.folders;

  renderHealthScore(stats.health);
}

function renderHealthScore(health) {
  if (!healthScoreValue || !healthScoreDetails) return;

  if (health.level === 'empty') {
    healthScoreValue.textContent = '—';
    healthScoreValue.className = 'stats-health-score';
    healthScoreDetails.innerHTML = '';
    healthScoreDesc.textContent = i18n('statsHealthScoreEmpty') || 'Add some bookmarks to see your health score';
    return;
  }

  healthScoreValue.textContent = health.score;
  healthScoreValue.className = `stats-health-score level-${health.level}`;

  healthScoreDetails.innerHTML = health.details.map(d => `
    <div class="stats-health-item">
      <div class="stats-health-item-label">${d.label}</div>
      <div class="stats-health-item-bar">
        <div class="stats-health-item-fill" style="width: ${d.score}%"></div>
      </div>
      <div class="stats-health-item-value">${d.score}%</div>
    </div>
  `).join('');

  healthScoreDesc.textContent = i18n('statsHealthScoreDesc') || 'Overall quality of your bookmark collection';
}

function renderCharts(stats) {
  if (typeof SimpleCharts === 'undefined') return;

  // 时间趋势
  const trendData = stats.trend[_currentTrendMode].map(d => ({ label: d.date, value: d.count }));
  SimpleCharts.lineChart(SimpleCharts.init(trendChart), trendData);

  // Top 标签
  SimpleCharts.barChart(SimpleCharts.init(tagsChart), stats.tagDistribution.map(d => ({
    label: d.tag, value: d.count
  })));

  // Top 域名
  SimpleCharts.pieChart(SimpleCharts.init(domainsChart), stats.domainDistribution.map(d => ({
    label: d.domain, value: d.count
  })), { donut: true });

  // 时段分布
  SimpleCharts.barChart(SimpleCharts.init(hoursChart), stats.hourlyDistribution.map(d => ({
    label: `${d.hour}:00`, value: d.count
  })));

  // 文件夹分布（横向）
  SimpleCharts.barChart(SimpleCharts.init(foldersChart), stats.folderDistribution.map(d => ({
    label: d.folder, value: d.count
  })), { horizontal: true });
}

async function loadAccuracyTrend() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getLearningTrend', days: 30 });
    const trend = (res && res.success) ? res.trend || [] : [];

    if (trend.length === 0) {
      accuracyTrendChart.innerHTML = '';
      accuracyTrendEmpty.style.display = 'block';
      return;
    }
    accuracyTrendEmpty.style.display = 'none';

    const data = trend.map(d => ({
      label: d.date.slice(5),
      value: d.accuracy
    }));
    SimpleCharts.lineChart(SimpleCharts.init(accuracyTrendChart), data, {
      yLabelFormatter: v => v + '%'
    });
  } catch (err) {
    console.error('loadAccuracyTrend error:', err);
    accuracyTrendChart.innerHTML = '';
    accuracyTrendEmpty.style.display = 'block';
  }
}

async function loadHealthFavorites() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getHealthScoreFavorites' });
    const favorites = (res && res.success) ? res.favorites || [] : [];
    renderHealthFavorites(favorites);
  } catch (err) {
    console.error('loadHealthFavorites error:', err);
  }
}

function renderHealthFavorites(favorites) {
  if (!healthFavoritesSection || !healthFavoritesList) return;
  if (!favorites || favorites.length === 0) {
    healthFavoritesSection.style.display = 'none';
    return;
  }
  healthFavoritesSection.style.display = 'block';

  healthFavoritesList.innerHTML = favorites.map(f => {
    const date = new Date(f.createdAt).toLocaleString();
    const rangeText = f.range && (f.range.start || f.range.end)
      ? `${f.range.start || '...'} ~ ${f.range.end || '...'}`
      : i18n('statsAllTime') || 'All time';
    return `
      <div class="stats-favorite-item" data-id="${f.id}">
        <div class="stats-favorite-info">
          <div class="stats-favorite-score">${f.score} <span style="font-size:12px;font-weight:400;color:var(--text-secondary)">${rangeText}</span></div>
          <div class="stats-favorite-meta">${date}${f.note ? ' · ' + escapeHtml(f.note) : ''}</div>
        </div>
        <div class="stats-favorite-actions">
          <button class="btn btn-danger btn-sm delete-favorite-btn" data-id="${f.id}">${i18n('delete') || 'Delete'}</button>
        </div>
      </div>
    `;
  }).join('');

  healthFavoritesList.querySelectorAll('.delete-favorite-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await chrome.runtime.sendMessage({ action: 'deleteHealthScoreFavorite', id });
      await loadHealthFavorites();
      showToast(i18n('deleted') || 'Deleted', 'success');
    });
  });
}

async function handleFavoriteHealthScore() {
  if (!_currentHealthScore || _currentHealthScore.level === 'empty') {
    showToast(i18n('statsNoScoreToFavorite') || 'No score to favorite', 'error');
    return;
  }

  const record = {
    score: _currentHealthScore.score,
    level: _currentHealthScore.level,
    details: _currentHealthScore.details,
    range: {
      start: statsStartDate.value || null,
      end: statsEndDate.value || null
    }
  };

  const res = await chrome.runtime.sendMessage({ action: 'saveHealthScoreFavorite', record });
  if (res && res.success) {
    await loadHealthFavorites();
    showToast(i18n('settingsSaved') || 'Saved', 'success');
  } else if (res && res.error === 'already_exists') {
    showToast(i18n('statsFavoriteExists') || 'Already favorited today', 'info');
  } else {
    showToast(i18n('saveFailed') || 'Save failed', 'error');
  }
}

function handleExportCsv() {
  if (!_cachedStats) {
    showToast(i18n('statsNoData') || 'No data to export', 'error');
    return;
  }
  const csv = BookmarkStats.statsToCsv(_cachedStats);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`markline-stats-${stamp}.csv`, '\uFEFF' + csv, 'text/csv;charset=utf-8;');
  showToast(i18n('settingsSaved') || 'Exported', 'success');
}

function handleExportPdf() {
  if (!_cachedStats) {
    showToast(i18n('statsNoData') || 'No data to export', 'error');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const isCN = (typeof _currentLang !== 'undefined' && _currentLang === 'zh_CN');
  const s = _cachedStats;

  const rows = [
    ['Total Bookmarks', s.overview.total],
    ['Total Tags', s.overview.totalTags],
    ['Unique Domains', s.overview.uniqueDomains],
    ['Folders', s.overview.folders],
    ['Health Score', s.health.score]
  ];

  const title = isCN ? 'Markline 书签统计报告' : 'Markline Bookmark Statistics';
  const html = `<!DOCTYPE html>
<html lang="${isCN ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; color: #202124; }
h1 { font-size: 22px; margin-bottom: 8px; }
.meta { color: #5f6368; font-size: 12px; margin-bottom: 24px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e8eaed; }
th { background: #f8f9fa; font-weight: 500; }
.section-title { font-size: 14px; font-weight: 600; margin: 24px 0 12px; }
</style>
</head>
<body>
  <h1>${title}</h1>
  <div class="meta">${stamp}</div>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    ${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}
  </table>
  <div class="section-title">Top Tags</div>
  <table>
    <tr><th>Tag</th><th>Count</th></tr>
    ${s.tagDistribution.map(d => `<tr><td>${escapeHtml(d.tag)}</td><td>${d.count}</td></tr>`).join('')}
  </table>
  <div class="section-title">Top Domains</div>
  <table>
    <tr><th>Domain</th><th>Count</th></tr>
    ${s.domainDistribution.map(d => `<tr><td>${escapeHtml(d.domain)}</td><td>${d.count}</td></tr>`).join('')}
  </table>
  <div class="section-title">Daily Trend</div>
  <table>
    <tr><th>Date</th><th>Count</th></tr>
    ${s.trend.daily.map(d => `<tr><td>${d.date}</td><td>${d.count}</td></tr>`).join('')}
  </table>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    showToast(i18n('statsPopupBlocked') || 'Popup blocked', 'error');
    return;
  }
  win.document.write(html);
  win.document.close();
  setTimeout(() => win.print(), 300);
}

function applyDateRange() {
  const start = statsStartDate.value ? new Date(statsStartDate.value).getTime() : null;
  let end = statsEndDate.value ? new Date(statsEndDate.value).getTime() : null;
  if (end) end = end + 24 * 60 * 60 * 1000 - 1;
  _currentDateRange = { startTs: start, endTs: end };
  _cachedStats = null;
  loadStatsPanel();
}

function resetDateRange() {
  statsStartDate.value = '';
  statsEndDate.value = '';
  _currentDateRange = { startTs: null, endTs: null };
  _cachedStats = null;
  loadStatsPanel();
}

// 统计面板事件绑定
if (statsApplyRangeBtn) statsApplyRangeBtn.addEventListener('click', applyDateRange);
if (statsResetRangeBtn) statsResetRangeBtn.addEventListener('click', resetDateRange);
if (favoriteHealthScoreBtn) favoriteHealthScoreBtn.addEventListener('click', handleFavoriteHealthScore);
if (exportStatsCsvBtn) exportStatsCsvBtn.addEventListener('click', handleExportCsv);
if (exportStatsPdfBtn) exportStatsPdfBtn.addEventListener('click', handleExportPdf);

if (trendTabs) {
  trendTabs.addEventListener('click', (e) => {
    if (!e.target.classList.contains('tab-btn')) return;
    trendTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    _currentTrendMode = e.target.dataset.trend;
    if (_cachedStats) renderCharts(_cachedStats);
  });
}

// 监听存储变化，清除统计缓存
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.bookmark_timeline_data || changes.tag_learning_stats || changes.health_score_favorites) {
      _cachedBookmarks = null;
      _cachedStats = null;
      const panel = document.getElementById('panel-stats');
      if (panel && panel.classList.contains('active')) {
        loadStatsPanel();
      }
    }
  }
});

// 监听队列变化广播，刷新徽章和列表
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'reviewQueueChanged') {
    updateActiveLearningBadge(message.count || 0);
    // 如果当前在主动学习面板，刷新列表
    const panel = document.getElementById('panel-activelearning');
    if (panel && panel.classList.contains('active')) {
      loadActiveLearning();
    }
  }
});

// ===== 语音朗读设置 =====

let _voiceSettingsLoaded = false;
let _voicePreviewAudio = null;
let _voicePreviewObjectUrl = null;
let _voicePreviewMediaSource = null;

async function loadVoiceSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'voiceGetSettings' });
    const s = (res && res.settings) || {};

    const portInput = document.getElementById('voiceBridgePort');
    const voiceSelect = document.getElementById('voiceDefaultVoiceSelect');
    const localeFilter = document.getElementById('voiceLocaleFilter');
    const rateSel = document.getElementById('voiceRateSelect');
    const pitchSel = document.getElementById('voicePitchSelect');
    const volumeSel = document.getElementById('voiceVolumeSelect');
    const maxCharsInput = document.getElementById('voiceMaxChars');
    const asyncThresholdInput = document.getElementById('voiceAsyncThreshold');
    const autoExtractToggle = document.getElementById('voiceAutoExtractToggle');

    if (portInput) portInput.value = s.bridgePort || 7822;
    if (voiceSelect) voiceSelect.value = s.defaultVoice || 'zh-CN-XiaoxiaoNeural';
    if (localeFilter) localeFilter.value = '';
    if (rateSel) rateSel.value = s.rate || '+0%';
    if (pitchSel) pitchSel.value = s.pitch || '+0Hz';
    if (volumeSel) volumeSel.value = s.volume || '+0%';
    if (maxCharsInput) maxCharsInput.value = s.maxChars || 30000;
    if (asyncThresholdInput) asyncThresholdInput.value = s.asyncThreshold || 3000;
    if (autoExtractToggle) autoExtractToggle.checked = (s.autoExtract !== false);

    // 绑定事件（仅绑定一次）
    if (!_voiceSettingsLoaded) {
      _bindVoiceSettingsEvents();
      _voiceSettingsLoaded = true;
    }

    // 检测桥接状态
    _checkVoiceBridge();
  } catch (e) {
    console.error('loadVoiceSettings error:', e);
  }
}

function _bindVoiceSettingsEvents() {
  const refreshBtn = document.getElementById('voiceBridgeRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', _checkVoiceBridge);

  const refreshVoicesBtn = document.getElementById('voiceRefreshVoices');
  if (refreshVoicesBtn) refreshVoicesBtn.addEventListener('click', _refreshVoiceList);

  const portInput = document.getElementById('voiceBridgePort');
  if (portInput) {
    portInput.addEventListener('change', async () => {
      const port = parseInt(portInput.value, 10);
      if (!port || port < 1024 || port > 65535) {
        showToast(i18n('voicePortInvalid') || '端口范围 1024-65535', 'error');
        portInput.value = 7822;
        return;
      }
      await chrome.runtime.sendMessage({ action: 'voiceSetSettings', patch: { bridgePort: port } });
      showToast(i18n('settingsSaved') || 'Saved', 'success');
      _checkVoiceBridge();
    });
  }

  const voiceSelect = document.getElementById('voiceDefaultVoiceSelect');
  if (voiceSelect) {
    voiceSelect.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({ action: 'voiceSetSettings', patch: { defaultVoice: voiceSelect.value } });
      showToast(i18n('settingsSaved') || 'Saved', 'success');
    });
  }

  const rateSel = document.getElementById('voiceRateSelect');
  if (rateSel) {
    rateSel.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({ action: 'voiceSetSettings', patch: { rate: rateSel.value } });
    });
  }

  const pitchSel = document.getElementById('voicePitchSelect');
  if (pitchSel) {
    pitchSel.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({ action: 'voiceSetSettings', patch: { pitch: pitchSel.value } });
    });
  }

  const volumeSel = document.getElementById('voiceVolumeSelect');
  if (volumeSel) {
    volumeSel.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({ action: 'voiceSetSettings', patch: { volume: volumeSel.value } });
    });
  }

  const maxCharsInput = document.getElementById('voiceMaxChars');
  if (maxCharsInput) {
    maxCharsInput.addEventListener('change', async () => {
      const v = parseInt(maxCharsInput.value, 10);
      if (!v || v < 1000) {
        maxCharsInput.value = 30000;
        return;
      }
      await chrome.runtime.sendMessage({ action: 'voiceSetSettings', patch: { maxChars: v } });
    });
  }

  const asyncThresholdInput = document.getElementById('voiceAsyncThreshold');
  if (asyncThresholdInput) {
    asyncThresholdInput.addEventListener('change', async () => {
      const v = parseInt(asyncThresholdInput.value, 10);
      if (!v || v < 500) {
        asyncThresholdInput.value = 3000;
        return;
      }
      await chrome.runtime.sendMessage({ action: 'voiceSetSettings', patch: { asyncThreshold: v } });
    });
  }

  const autoExtractToggle = document.getElementById('voiceAutoExtractToggle');
  if (autoExtractToggle) {
    autoExtractToggle.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({ action: 'voiceSetSettings', patch: { autoExtract: autoExtractToggle.checked } });
    });
  }

  const previewBtn = document.getElementById('voicePreviewBtn');
  if (previewBtn) {
    previewBtn.addEventListener('click', _previewVoice);
  }

  const localeFilter = document.getElementById('voiceLocaleFilter');
  if (localeFilter) {
    localeFilter.addEventListener('change', _refreshVoiceList);
  }
}

async function _checkVoiceBridge() {
  const text = document.getElementById('voiceBridgeStatusText');
  const versionEl = document.getElementById('voiceBridgeVersion');
  if (!text) return;

  // 复用推送面板的 push-bridge-status 状态徽标样式
  text.className = 'push-bridge-status push-bridge-status--checking';
  text.textContent = i18n('voiceBridgeChecking') || '检测中…';
  if (versionEl) versionEl.textContent = '';

  try {
    const res = await chrome.runtime.sendMessage({ action: 'voiceBridgeHealth' });
    if (res && res.ok && res.running) {
      text.className = 'push-bridge-status push-bridge-status--ok';
      text.textContent = i18n('voiceBridgeOnline') || '运行中';
      if (versionEl) versionEl.textContent = `v${res.version || ''}`;
    } else {
      text.className = 'push-bridge-status push-bridge-status--error';
      text.textContent = i18n('voiceBridgeOffline') || '未运行';
    }
  } catch {
    text.className = 'push-bridge-status push-bridge-status--error';
    text.textContent = i18n('voiceBridgeOffline') || '未运行';
  }
}

async function _refreshVoiceList() {
  const voiceSelect = document.getElementById('voiceDefaultVoiceSelect');
  const localeFilter = document.getElementById('voiceLocaleFilter');
  if (!voiceSelect) return;
  const locale = localeFilter ? localeFilter.value : '';

  showToast(i18n('voiceLoadingVoices') || '正在加载音色列表...', 'info');
  try {
    const res = await chrome.runtime.sendMessage({ action: 'voiceListVoices', locale });
    if (!res || !res.ok) {
      showToast(i18n('voiceLoadFailed') || '加载失败', 'error');
      return;
    }
    const voices = res.voices || [];
    if (voices.length === 0) {
      showToast(i18n('voiceNoVoices') || '无可用音色', 'warning');
      return;
    }
    // 保留当前选中值
    const cur = voiceSelect.value;
    voiceSelect.innerHTML = '';
    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.ShortName;
      const gender = v.Gender === 'Female' ? '女' : (v.Gender === 'Male' ? '男' : v.Gender);
      opt.textContent = `${v.ShortName} (${v.FriendlyName || ''} · ${gender})`;
      voiceSelect.appendChild(opt);
    }
    // 尝试恢复选中
    if ([...voiceSelect.options].some(o => o.value === cur)) {
      voiceSelect.value = cur;
    }
    showToast(i18n('voiceVoicesLoaded') || `已加载 ${voices.length} 个音色`, 'success');
  } catch (e) {
    showToast((i18n('voiceLoadFailed') || '加载失败') + ': ' + e.message, 'error');
  }
}

async function _previewVoice() {
  const voiceSelect = document.getElementById('voiceDefaultVoiceSelect');
  const previewBtn = document.getElementById('voicePreviewBtn');
  if (!voiceSelect) return;
  const voice = voiceSelect.value;

  if (previewBtn) {
    previewBtn.disabled = true;
    previewBtn.textContent = i18n('voicePreviewing') || '合成中...';
  }

  // 清理上一次的预览
  if (_voicePreviewAudio) {
    _voicePreviewAudio.pause();
    _voicePreviewAudio = null;
  }
  if (_voicePreviewObjectUrl) {
    try { URL.revokeObjectURL(_voicePreviewObjectUrl); } catch {}
    _voicePreviewObjectUrl = null;
  }
  if (_voicePreviewMediaSource) {
    try {
      if (_voicePreviewMediaSource.readyState === 'open') {
        _voicePreviewMediaSource.endOfStream();
      }
    } catch {}
    _voicePreviewMediaSource = null;
  }

  try {
    const settings = await chrome.runtime.sendMessage({ action: 'voiceGetSettings' });
    const port = (settings && settings.settings && settings.settings.bridgePort) || 7822;
    const base = `http://127.0.0.1:${port}`;

    const sampleText = '欢迎使用 Markline 语音朗读功能。这是一段示例文本，用于试听当前音色效果。';
    const resp = await fetch(`${base}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sampleText, voice })
    });

    if (!resp.ok) {
      let err = `http_${resp.status}`;
      try { const j = await resp.json(); if (j && j.error) err = j.error; } catch {}
      showToast((i18n('voiceSynthFailed') || '合成失败') + ': ' + err, 'error');
      return;
    }

    // 检查是否返回了 JSON 错误
    const ctype = resp.headers.get('Content-Type') || '';
    if (ctype.includes('application/json')) {
      const j = await resp.json();
      showToast((i18n('voiceSynthFailed') || '合成失败') + ': ' + (j.error || 'unknown'), 'error');
      return;
    }

    // 流式播放：用 MediaSource 边接收边播放
    const canUseMSE = window.MediaSource && MediaSource.isTypeSupported('audio/mpeg');
    if (canUseMSE) {
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      _voicePreviewMediaSource = mediaSource;
      _voicePreviewObjectUrl = objectUrl;
      _voicePreviewAudio = new Audio(objectUrl);

      mediaSource.addEventListener('sourceopen', () => {
        const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
        const reader = resp.body.getReader();

        const pump = async () => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              if (mediaSource.readyState === 'open') mediaSource.endOfStream();
              return;
            }
            const append = () => {
              try { sourceBuffer.appendBuffer(value); }
              catch (e) {
                if (mediaSource.readyState === 'open') {
                  try { mediaSource.endOfStream('decode'); } catch {}
                }
              }
            };
            if (sourceBuffer.updating) {
              sourceBuffer.addEventListener('updateend', append, { once: true });
            } else {
              append();
            }
          } catch (e) {
            if (mediaSource.readyState === 'open') {
              try { mediaSource.endOfStream('decode'); } catch {}
            }
          }
        };

        sourceBuffer.addEventListener('updateend', () => {
          if (mediaSource.readyState === 'open') pump();
        });
        pump();
      }, { once: true });

      _voicePreviewAudio.play().catch(() => {});
      _voicePreviewAudio.addEventListener('ended', () => {
        try { URL.revokeObjectURL(objectUrl); } catch {}
        _voicePreviewObjectUrl = null;
        _voicePreviewMediaSource = null;
      });
    } else {
      // 回退：完整下载后播放
      const blob = await resp.blob();
      if (!blob || blob.size === 0) {
        showToast(i18n('voiceSynthFailed') || '合成失败: empty audio', 'error');
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      _voicePreviewObjectUrl = objectUrl;
      _voicePreviewAudio = new Audio(objectUrl);
      _voicePreviewAudio.play().catch(() => {});
      _voicePreviewAudio.addEventListener('ended', () => {
        try { URL.revokeObjectURL(objectUrl); } catch {}
        _voicePreviewObjectUrl = null;
      });
    }
  } catch (e) {
    showToast((i18n('voiceSynthFailed') || '合成失败') + ': ' + e.message, 'error');
  } finally {
    if (previewBtn) {
      previewBtn.disabled = false;
      previewBtn.textContent = i18n('voicePreviewBtn') || '试听样本';
    }
  }
}

// 监听语音设置变化（其他窗口修改时同步）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.voice_settings) {
    const panel = document.getElementById('panel-voice');
    if (panel && panel.classList.contains('active')) {
      loadVoiceSettings();
    }
  }
});
