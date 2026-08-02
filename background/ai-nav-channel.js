// background/ai-nav-channel.js
// AI 对话导航后台消息路由
// - 由 background.js 的 onMessage 分发器调用
// - 负责：设置读写、模板查询、跨标签页状态广播、跳转指令转发
//
// 消息协议（统一前缀 aiNav）：
//   aiNavGetSettings    UI → BG          读取设置
//   aiNavSetSettings    UI → BG          保存设置（patch）
//   aiNavGetTemplate    Injector → BG    按 domain 获取模板配置
//   aiNavState          Injector → BG    推送当前 tab 的解析状态（转发给独立窗口）
//   aiNavGetState       UI → BG          拉取指定 tab 的解析状态（转发到 content script）
//   aiNavScrollTo       UI → BG → Inj    跳转到指定 messageId
//   aiNavScrollContainer UI → BG → Inj   跳转顶部/底部
//   aiNavRefresh        UI → BG → Inj    强制重新解析
//   aiNavToggleBookmark UI → BG          切换收藏
//   aiNavGetBookmarks   UI → BG          读取收藏
//   aiNavOpenPanel      Injector → BG    请求在 MDI 中打开大视图

self.AiNavChannel = (function () {
  'use strict';

  // 缓存最近一次各 tab 的状态，供独立窗口主动拉取
  const _tabStates = new Map(); // tabId → { state, ts }

  function _getStateCache(tabId) {
    return _tabStates.get(tabId) || null;
  }

  function _setStateCache(tabId, state) {
    _tabStates.set(tabId, { state, ts: Date.now() });
    // 清理超过 5 分钟未更新的缓存
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, entry] of _tabStates) {
      if (entry.ts < cutoff) _tabStates.delete(id);
    }
  }

  async function handle(message, sender, sendResponse) {
    const action = message.action;
    const tabId = sender?.tab?.id ?? message.tabId ?? null;

    try {
      switch (action) {
        case 'aiNavGetSettings': {
          const settings = await self.AiNavStore.getSettings();
          return { ok: true, settings };
        }

        case 'aiNavSetSettings': {
          const settings = await self.AiNavStore.setSettings(message.patch || {});
          return { ok: true, settings };
        }

        case 'aiNavResetSettings': {
          const settings = await self.AiNavStore.resetSettings();
          return { ok: true, settings };
        }

        case 'aiNavGetTemplate': {
          const domain = message.domain;
          if (!domain) return { ok: false, error: 'missing_domain' };
          const template = self.AiPlatforms.getTemplateByDomain(domain);
          const templateKey = self.AiPlatforms.getTemplateKeyByDomain(domain);
          if (!template) return { ok: false, error: 'unsupported_domain' };
          const settings = await self.AiNavStore.getSettings();
          const platformEnabled = settings.platforms?.[templateKey] ?? false;
          if (!platformEnabled) return { ok: false, disabled: true };
          if (!settings.enabled) return { ok: false, disabled: true, reason: 'global_disabled' };
          return { ok: true, template, templateKey, settings };
        }

        case 'aiNavState': {
          // content script 推送状态
          if (tabId !== null) {
            _setStateCache(tabId, message.state);
          }
          // 广播给独立窗口（MDI 子窗口订阅）
          try {
            chrome.runtime.sendMessage({
              action: 'aiNavStateBroadcast',
              tabId,
              state: message.state
            }).catch(() => {});
          } catch {}
          return { ok: true };
        }

        case 'aiNavGetState': {
          // 独立窗口拉取指定 tab 的状态
          const targetTabId = message.tabId;
          if (!targetTabId) {
            // 无 tabId 时返回缓存
            const cached = tabId !== null ? _getStateCache(tabId) : null;
            return { ok: true, state: cached?.state || null, fromCache: true };
          }
          // 优先返回缓存
          const cached = _getStateCache(targetTabId);
          if (cached) {
            // 同时触发 content script 刷新（异步，不阻塞返回）
            try {
              chrome.tabs.sendMessage(targetTabId, { action: 'aiNavRefresh' }).catch(() => {});
            } catch {}
            return { ok: true, state: cached.state, fromCache: true };
          }
          // 无缓存，直接请求 content script
          try {
            const resp = await chrome.tabs.sendMessage(targetTabId, { action: 'aiNavGetState' });
            return resp || { ok: false, error: 'no_response' };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        }

        case 'aiNavScrollTo': {
          const targetTabId = message.tabId;
          const messageId = message.messageId;
          if (!targetTabId || !messageId) return { ok: false, error: 'missing_params' };
          try {
            await chrome.tabs.sendMessage(targetTabId, {
              action: 'aiNavScrollTo',
              messageId
            });
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        }

        case 'aiNavScrollContainer': {
          const targetTabId = message.tabId;
          const direction = message.direction; // 'top' | 'bottom'
          if (!targetTabId || !direction) return { ok: false, error: 'missing_params' };
          try {
            await chrome.tabs.sendMessage(targetTabId, {
              action: 'aiNavScrollContainer',
              direction
            });
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        }

        case 'aiNavRefresh': {
          const targetTabId = message.tabId || tabId;
          if (!targetTabId) return { ok: false, error: 'no_tab' };
          try {
            await chrome.tabs.sendMessage(targetTabId, { action: 'aiNavRefresh' });
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        }

        case 'aiNavToggleBookmark': {
          const { conversationKey, messageId } = message;
          if (!conversationKey || !messageId) return { ok: false, error: 'missing_params' };
          const bookmarked = await self.AiNavStore.toggleBookmark(conversationKey, messageId);
          return { ok: true, bookmarked };
        }

        case 'aiNavGetBookmarks': {
          const { conversationKey } = message;
          if (!conversationKey) {
            const all = await self.AiNavStore.getBookmarks();
            return { ok: true, bookmarks: all };
          }
          const scoped = await self.AiNavStore.getConversationBookmarks(conversationKey);
          return { ok: true, bookmarks: scoped };
        }

        case 'aiNavSetSidebarState': {
          // content script 报告侧边栏打开/关闭状态
          const open = !!message.data?.open;
          try {
            const settings = await self.AiNavStore.setSettings({
              sidebarOpen: open,
              sidebarFilter: message.data?.filter
            });
            return { ok: true, settings };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        }

        case 'aiNavOpenPanel': {
          // 请求打开独立窗口中的 AI 导航大视图
          // 由 standalone.js 监听并通过 MDI 创建子窗口
          try {
            chrome.runtime.sendMessage({
              action: 'aiNavOpenPanelRequest',
              tabId,
              state: message.state
            }).catch(() => {});
          } catch {}
          return { ok: true };
        }

        case 'aiNavGetAllPlatforms': {
          // 供设置页渲染平台列表
          const keys = self.AiPlatforms.getAllPlatformKeys();
          const catalog = self.AiPlatforms.templateCatalog;
          const list = keys.map((k) => ({
            key: k,
            name: catalog[k].name,
            icon: catalog[k].icon,
            domains: catalog[k].domains,
            label: catalog[k].label
          }));
          return { ok: true, platforms: list };
        }

        case 'aiNavGetMessageWidths': {
          const widths = await self.AiNavStore.getMessageWidths();
          return { ok: true, widths };
        }

        case 'aiNavSetMessageWidth': {
          const { templateKey, width } = message;
          if (!templateKey) return { ok: false, error: 'missing_params' };
          if (typeof width === 'number' && width > 0) {
            await self.AiNavStore.setMessageWidth(templateKey, width);
          } else {
            await self.AiNavStore.deleteMessageWidth(templateKey);
          }
          return { ok: true };
        }

        default:
          return { ok: false, error: 'unknown_action' };
      }
    } catch (err) {
      console.warn('[AiNavChannel] 处理失败', action, err);
      return { ok: false, error: err.message };
    }
  }

  return { handle };
})();
