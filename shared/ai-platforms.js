// shared/ai-platforms.js
// AI 对话平台选择器配置（移植自 ChatTOC templateCatalog v3.6.0）
// - 27 个平台适配：ChatGPT/Claude/Gemini/DeepSeek/Kimi/Qwen/豆包/...
// - 每个平台 schema: { name, icon, domains, label, selectors, messageOrder? }
// - selectors.messageContainer 支持 '--xxx' 开头表示 CSS 变量名
//
// 选择器字段说明：
//   container         - 对话滚动容器（MutationObserver 的 target）
//   userItem          - 用户消息节点选择器
//   assistantItem     - AI 消息节点选择器
//   textUser          - 用户消息正文选择器
//   textAssistant     - AI 消息正文选择器
//   image             - 图片选择器（可选）
//   exclude           - 排除的噪音节点（可选）
//   composer          - 输入框选择器（用于 prompt 回填，可选）
//   messageContainer  - 消息宽度容器；'--xxx' 开头时直接改 :root CSS 变量（可选）

(function (global) {
  'use strict';

  const templateCatalog = {
    chatgpt: {
      name: { zh: 'ChatGPT', en: 'ChatGPT' },
      icon: '🤖',
      domains: ['chat.openai.com', 'chatgpt.com'],
      label: { zh: 'ChatGPT / 通用', en: 'ChatGPT / Generic' },
      selectors: {
        container: '#main',
        userItem: "[data-turn='user']",
        assistantItem: "[data-turn='assistant']",
        textUser: '.user-message-bubble-color',
        // 写作块（Canvas / writing-block）正文真正的容器是内部的 .ProseMirror，
        // 外层的 .markdown 会把 "写入/复制" 等 chrome 文本混进来，所以优先取内层；
        // 普通文本回复仍然走 .markdown，但要排除掉包含写作块的那个外层壳子。
        textAssistant: '[data-writing-block] .ProseMirror, .markdown:not(:has([data-writing-block]))',
        image: "img.absolute[alt][src*='/backend-api/estuary/content']",
        exclude: "[data-testid*='error']",
        composer: '#prompt-textarea',
        messageContainer: 'section[data-turn] > div > div'
      }
    },
    claude: {
      name: { zh: 'Claude', en: 'Claude' },
      icon: '🤖',
      domains: ['claude.ai'],
      label: { zh: 'Claude', en: 'Claude' },
      selectors: {
        container: 'main, [role="main"], #root, div.overflow-y-scroll.overflow-x-hidden.pt-6.flex-1',
        userItem: '[data-user-message-bubble="true"]',
        assistantItem: '.font-claude-response',
        textUser: '[data-user-message-bubble="true"]',
        textAssistant: '.font-claude-response',
        exclude: '[data-testid="message-warning"], [class*="Error"]',
        composer: '[data-testid="chat-input"]',
        messageContainer: '[data-autoscroll-container="true"] div.max-w-3xl'
      }
    },
    gemini: {
      name: { zh: 'Gemini', en: 'Gemini' },
      icon: '🤖',
      domains: ['gemini.google.com'],
      label: { zh: 'Gemini', en: 'Gemini' },
      selectors: {
        container: 'chat-window-content',
        userItem: 'user-query',
        assistantItem: 'model-response',
        textUser: '.query-text',
        // 在 .query-text 内部剔除给屏幕阅读器用的隐藏前缀（"You said:" / "你说:"）。
        textUserExtract: '.screen-reader-user-query-label',
        textAssistant: '.markdown-main-panel, .markdown, .model-response-text',
        image: 'generated-image .image-container img.image',
        exclude: '.error',
        composer: '.ql-editor.textarea.new-input-ui',
        messageContainer: '.conversation-container,user-query'
      }
    },
    aistudio: {
      name: { zh: 'AI Studio', en: 'AI Studio' },
      icon: '🤖',
      domains: ['aistudio.google.com'],
      label: { zh: 'AI Studio', en: 'AI Studio' },
      selectors: {
        container: 'ms-chat-session, ms-autoscroll-container, main',
        userItem: 'ms-chat-turn  .user-prompt-container[data-turn-role="User"]',
        assistantItem: 'ms-chat-turn  .model-prompt-container[data-turn-role="Model"] ms-prompt-chunk:not(:has(ms-thought-chunk))',
        textUser: 'ms-chat-turn  .user-prompt-container[data-turn-role="User"] ms-text-chunk',
        textAssistant: 'ms-chat-turn   .model-prompt-container[data-turn-role="Model"] ms-text-chunk',
        image: 'ms-image-chunk .image-container img',
        exclude: '.error, [class*="error"], [class*="Error"], button, svg, .actions-container, .turn-footer, ms-thought-chunk, .author-label',
        composer: 'textarea[formcontrolname="promptText"]'
      }
    },
    deepseek: {
      name: { zh: 'DeepSeek', en: 'DeepSeek' },
      icon: '🐋',
      domains: ['chat.deepseek.com'],
      label: { zh: 'DeepSeek', en: 'DeepSeek' },
      selectors: {
        container: "main, [role='main'], #root, .app-container",
        // 优先用 :has(.ds-markdown) 区分 AI/用户消息（更稳健，不依赖奇偶性）
        // :has() 不支持时 fallback 到 nth-child
        userItem: '.ds-message:not(:has(.ds-markdown)); .ds-scroll-area > div > div:nth-child(odd) .ds-message',
        assistantItem: '.ds-message:has(.ds-markdown); .ds-scroll-area > div > div:nth-child(even) .ds-message',
        textUser: ':scope > div:not(.ds-markdown)',
        textAssistant: '.ds-markdown',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'textarea[name="search"]',
        // 以 `--` 开头表示 CSS 变量名：直接修改 :root 上的变量
        messageContainer: '--message-list-max-width'
      }
    },
    zai: {
      name: { zh: 'Z.ai', en: 'Z.ai' },
      icon: '🤖',
      domains: ['chat.z.ai'],
      label: { zh: 'Z.ai', en: 'Z.ai' },
      selectors: {
        container: '#messages-container, main, [role="main"], #root',
        userItem: '.user-message',
        assistantItem: '.chat-assistant',
        textUser: '.rounded-xl, .chat-user',
        textAssistant: 'p, .markdown-prose',
        exclude: "[class*='error'], [class*='Error']",
        composer: '#chat-input',
        messageContainer: '.max-w-\\[1000px\\]'
      }
    },
    qwen: {
      name: { zh: 'Qwen', en: 'Qwen' },
      icon: '🤖',
      domains: ['chat.qwen.ai'],
      label: { zh: 'Qwen', en: 'Qwen' },
      selectors: {
        container: '#chat-message-container, #chat-messages-scroll-container, .chat-messages',
        userItem: '.chat-user-message-container',
        assistantItem: '.qwen-chat-message-assistant',
        textUser: '.chat-user-message',
        textAssistant: '.response-message-content .custom-qwen-markdown .qwen-markdown',
        image: '.qwen-markdown-image .qwen-markdown-image-content img.ant-image-img',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'textarea.message-input-textarea',
        messageContainer: '.qwen-chat-message'
      }
    },
    qianwen: {
      name: { zh: '千问', en: 'Qianwen' },
      icon: '🤖',
      // tongyi.aliyun.com 现为通义实验室首页，tongyi.com 会重定向到 www.qianwen.com
      // 实际对话页域名为 www.qianwen.com/chat/...
      domains: ['www.qianwen.com', 'qianwen.com', 'tongyi.com'],
      label: { zh: '千问', en: 'Qianwen' },
      selectors: {
        container: '#message-list-scroller, .message-list-scroll-container',
        // 用户消息：.message-card-wrap.question 内含 .question-text-card 文本节点
        userItem: '.message-card-wrap.question',
        assistantItem: '.answer-common-card',
        textUser: '.question-text-card',
        // AI 回答：.answer-common-card 内 .qk-markdown 为 markdown 渲染容器
        textAssistant: '.qk-markdown',
        exclude: '[class*="vote-btn"], [class*="vote-secondary"], [aria-hidden="true"]',
        // 输入框：contenteditable 的 div[role="textbox"]（千问自有 UI）
        composer: 'div[role="textbox"][contenteditable="true"]',
        // 消息宽度容器：千问用 .chat-round 作为一轮对话的宽度壳
        messageContainer: '.chat-round'
      }
    },
    kimi: {
      name: { zh: 'Kimi', en: 'Kimi' },
      icon: '🤖',
      domains: ['www.kimi.com'],
      label: { zh: 'Kimi', en: 'Kimi' },
      selectors: {
        container: '.chat-detail-main',
        userItem: '.chat-content-item.chat-content-item-user',
        assistantItem: '.chat-content-item.chat-content-item-assistant',
        textUser: '.segment.segment-user .user-content',
        textAssistant: '.segment.segment-assistant .markdown-container .markdown',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'div.chat-input-editor[contenteditable="true"][data-lexical-editor="true"]',
        messageContainer: '--max-width-qa'
      }
    },
    doubao: {
      name: { zh: '豆包', en: 'Doubao' },
      icon: '🤖',
      domains: ['www.doubao.com'],
      label: { zh: '豆包', en: 'Doubao' },
      selectors: {
        container: "[class^='message-list-']",
        userItem: "[data-message-id].justify-end",
        assistantItem: "[data-message-id]:not(.justify-end)",
        textUser: ".whitespace-pre-wrap",
        textAssistant: ".flow-markdown-body",
        image: "picture img[class^='image-']",
        exclude: "[class*='error'], [class*='Error']",
        composer: 'textarea.semi-input-textarea-autosize;textarea.semi-input-textarea',
        messageContainer: '--content-max-width'
      }
    },
    grok: {
      name: { zh: 'Grok', en: 'Grok' },
      icon: '🤖',
      domains: ['grok.com', 'grok.x.ai', 'x.ai'],
      label: { zh: 'Grok', en: 'Grok' },
      selectors: {
        container: 'main, [role="main"], #root, body',
        userItem: '.items-end',
        assistantItem: '.items-start',
        textUser: '.message-bubble, .response-content-markdown',
        textAssistant: '.response-content-markdown, .message-bubble',
        image: ".message-bubble .not-prose img",
        exclude: '',
        composer: 'div.tiptap.ProseMirror.min-h-14[contenteditable="true"];div.tiptap.ProseMirror[contenteditable="true"]',
        messageContainer: '--content-max-width'
      }
    },
    minimax: {
      name: { zh: 'Minimax', en: 'Minimax' },
      icon: '🤖',
      domains: ['agent.minimaxi.com'],
      label: { zh: 'Minimax', en: 'Minimax' },
      selectors: {
        container: 'main .chat-page',
        userItem: '#message-container .message.sent',
        assistantItem: '#message-container .message.received',
        textUser: '#message-container .message.sent .message-content .text-pretty',
        textAssistant: '#message-container .message.received .message-content .matrix-markdown',
        exclude: '.think-container, .tool-name, .messages-container [data-msg-id] .text-text_default_tertiary.hidden',
        composer: 'div.tiptap.ProseMirror.tiptap-editor[contenteditable="true"];div.tiptap.ProseMirror[contenteditable="true"]',
        messageContainer: '#message-container > div'
      }
    },
    mistral: {
      name: { zh: 'Mistral', en: 'Mistral' },
      icon: '🤖',
      domains: ['chat.mistral.ai'],
      label: { zh: 'Mistral', en: 'Mistral' },
      selectors: {
        container: 'main main [data-radix-scroll-area-viewport]',
        userItem: "[data-message-author-role='user']",
        assistantItem: "[data-message-author-role='assistant']",
        textUser: '.select-text .whitespace-pre-wrap',
        textAssistant: "[data-message-part-type='answer']",
        exclude: "[data-testid*='error']",
        composer: 'div.ProseMirror[contenteditable="true"][data-placeholder];div.ProseMirror[contenteditable="true"]',
        messageContainer: '--breakpoint-md'
      }
    },
    perplexity: {
      name: { zh: 'Perplexity AI', en: 'Perplexity AI' },
      icon: '🤖',
      domains: ['www.perplexity.ai', 'perplexity.ai'],
      label: { zh: 'Perplexity AI', en: 'Perplexity AI' },
      selectors: {
        container: '.scrollable-container',
        userItem: '.max-w-threadContentWidth span.select-text',
        assistantItem: '[id^="markdown-content-"] div.prose',
        textUser: '.max-w-threadContentWidth span.select-text',
        textAssistant: '[id^="markdown-content-"] div.prose',
        exclude: "[class*='error'], [class*='Error']",
        composer: '#ask-input',
        messageContainer: '--thread-content-width'
      }
    },
    poe: {
      name: { zh: 'Poe', en: 'Poe' },
      icon: '🤖',
      domains: ['poe.com', 'www.poe.com'],
      label: { zh: 'Poe', en: 'Poe' },
      selectors: {
        container: '[class^="ChatMessagesScrollWrapper_scrollableContainerWrapper__"], [class^="ChatMessagesView_tupleGroupContainer__"]',
        userItem: '[class*="ChatMessage_chatMessage__"]:has([class*="Message_rightSideMessageBubble__"])',
        assistantItem: '[class*="ChatMessage_chatMessage__"]:has([class*="Message_leftSideMessageBubble__"])',
        textUser: '[class*="Message_rightSideMessageBubble__"] [class*="Prose_prose__"]',
        textAssistant: '[class*="Message_leftSideMessageBubble__"] [class*="Prose_prose__"]',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'textarea[class*="GrowingTextArea_textArea__"]',
        messageContainer: '[class^="ChatMessagesView_messageTuple__"]'
      }
    },
    ernie: {
      name: { zh: '文心一言', en: 'ERNIE Bot' },
      icon: '🤖',
      domains: ['ernie.baidu.com', 'yiyan.baidu.com'],
      label: { zh: '文心一言', en: 'ERNIE Bot' },
      messageOrder: 'reverse',
      selectors: {
        container: 'main, [role="main"], #root, body',
        userItem: '#question_text_id',
        assistantItem: '[class*="roleSystem__"] .dialog-card-wrapper',
        textUser: '#question_text_id',
        textAssistant: '#answer_text_id .custom-html.md-stream-desktop, #answer_text_id .custom-html',
        image: '[class*="ebImage__"] img',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'div[role="textbox"][data-slate-editor="true"][data-slate-node="value"][contenteditable="true"]',
        messageContainer: '[id^="chat-id-"] > div'
      }
    },
    hunyuan: {
      name: { zh: '混元', en: 'Hunyuan' },
      icon: '🤖',
      domains: ['ai.tencent.com', 'yuanbao.tencent.com', 'hunyuan.tencent.com'],
      label: { zh: '混元', en: 'Hunyuan' },
      selectors: {
        container: '.agent-chat__list__content-wrapper',
        userItem: '.agent-chat__list__item--human .agent-chat__bubble--human',
        assistantItem: '.agent-chat__list__item--ai .agent-chat__bubble--ai',
        textUser: '.agent-chat__list__item--human .agent-chat__bubble--human .hyc-component-text',
        textAssistant: '.agent-chat__list__item--ai .agent-chat__bubble--ai .agent-chat__bubble__content',
        image: ".agent-chat__list__item--ai .hyc-card-box-card--image .hyc-content-img img",
        exclude: "[class*='error'], [class*='Error']",
        composer: '[contenteditable="true"][enterkeyhint="send"];[contenteditable="true"][role="textbox"];.agent-chat textarea',
        messageContainer: '--hunyuan-chat-list-max-width'
      }
    },
    copilot: {
      name: { zh: 'Copilot', en: 'Copilot' },
      icon: '🤖',
      domains: ['github.com'],
      label: { zh: 'Copilot', en: 'Copilot' },
      selectors: {
        container: '[class*="ChatScrollContainer-module__container__"]',
        userItem: '[class*="ChatMessage-module__user__"]',
        assistantItem: '[class*="ChatMessage-module__ai__"]',
        textUser: '[class*="ChatMessage-module__user__"] div[class*="ChatMessage-module__userMessage__"]',
        textAssistant: '[class*="ChatMessage-module__ai__"] .markdown-body',
        exclude: "[class*='error'], [class*='Error']",
        composer: '#copilot-chat-textarea;textarea[class*="ChatInput-module__input__"]',
        messageContainer: '--breakpoint-medium'
      }
    },
    chatglm: {
      name: { zh: '智谱清言', en: 'ChatGLM' },
      icon: '🤖',
      domains: ['chatglm.cn', 'www.chatglm.cn'],
      label: { zh: '智谱清言', en: 'ChatGLM' },
      selectors: {
        container: '.detail.chatScrollContainer.conversation-list',
        userItem: '.conversation-item .question .question-txt span',
        assistantItem: '.answer-content',
        textUser: '.conversation-item .question .question-txt',
        textAssistant: '.answer-content .answer-content-wrap .markdown-body',
        image: '.cog-img-wrap.img-content-wrap img.limitSize',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'div.input-box-inner textarea;textarea.scroll-display-none',
        messageContainer: '.dialogue .conversation-list.detail .item'
      }
    },
    iflow: {
      name: { zh: '心流', en: 'iflow' },
      icon: '🤖',
      domains: ['iflow.cn'],
      label: { zh: '心流', en: 'iflow' },
      selectors: {
        container: '#list-container',
        userItem: '[class^="QAV2Question--"]',
        assistantItem: '[class^="QAV2Answer--"]',
        textUser: '[class^="promptV2--]',
        textAssistant: '[class^="QAItemBox--"] [class^="QAItem--"]',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'textarea[placeholder="基于指定材料生成相关回答"]'
      }
    },
    coze: {
      name: { zh: '扣子', en: 'Coze' },
      icon: '🤖',
      domains: ['coze.cn'],
      label: { zh: '扣子', en: 'Coze' },
      selectors: {
        container: '[class^="message-container-"]',
        userItem: '[data-group-type="query"].message-group',
        assistantItem: '[data-group-type="reply"].message-group',
        textUser: 'div.max-w-full.break-words',
        textAssistant: 'div.reply-container .prose',
        image: '.reply-container [class*="img-container-"] > div img',
        exclude: "[class*='error'], [class*='Error']"
      }
    },
    ima: {
      name: { zh: 'ima', en: 'ima' },
      icon: '🤖',
      domains: ['ima.qq.com'],
      label: { zh: 'ima', en: 'ima' },
      selectors: {
        container: '#scrollContainer',
        userItem: '[class^="_userBubbleContainer_"]',
        assistantItem: '[class^="_aiContainer_"]',
        textUser: '[class^="_userBubble_"] p[class^="_content_"]',
        textAssistant: '[class^="_bubble_"]',
        exclude: "[class*='error'], [class*='Error']",
        composer: '#tagTextarea div.tiptap.ProseMirror[contenteditable="true"];#tagTextarea [contenteditable="true"]',
        messageContainer: '--max-width-qa'
      }
    },
    MicrosoftCopilot: {
      name: { zh: 'Microsoft Copilot', en: 'Microsoft Copilot' },
      icon: '🤖',
      domains: ['copilot.microsoft.com'],
      label: { zh: 'Microsoft Copilot', en: 'Microsoft Copilot' },
      selectors: {
        container: '[class^="@container/chat"][data-testid="chat-page"]',
        userItem: '[class*="user-message"]',
        assistantItem: '[data-content="ai-message"][data-testid="ai-message"]',
        textUser: '[data-content="user-message"]',
        textAssistant: '[class*="ai-message-item"]',
        image: '[data-content="ai-message"] picture img',
        exclude: "[class*='error'], [class*='Error']",
        composer: '[data-testid="composer-input"];#userInput',
        messageContainer: '.max-w-chat'
      }
    },
    zread: {
      name: { zh: 'ZreadAI', en: 'ZreadAI' },
      icon: '🤖',
      domains: ['zread.ai'],
      label: { zh: 'ZreadAI', en: 'ZreadAI' },
      selectors: {
        container: '.mt-2.flex.w-full.grow.flex-col.overflow-auto.px-4.pb-4',
        userItem: '.mt-2.flex.w-full.grow.flex-col.overflow-auto.px-4.pb-4 > div:nth-child(odd) .mt-2.flex.flex-col.items-end',
        assistantItem: '.mt-2.flex.w-full.grow.flex-col.overflow-auto.px-4.pb-4 > div:nth-child(even)',
        textUser: '.prose',
        textAssistant: '.prose',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'textarea[class*="ring-offset-background"];div[class*="border-input"] textarea;textarea[class*="resize-none"][class*="grow"]'
      }
    },
    longcat: {
      name: { zh: '龙猫', en: 'LongCat' },
      icon: '🤖',
      domains: ['longcat.chat'],
      label: { zh: '龙猫', en: 'LongCat' },
      selectors: {
        container: '#pageContentScroll',
        userItem: '.v-chat-messge-view > .user-message > .user-wrapper',
        assistantItem: '.v-chat-messge-view > .assistant-message .assistant-main',
        textUser: '.user-text',
        textAssistant: '.md-show-container .mt-markdown-body',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'div[class*="editor-wapper"] .tiptap.ProseMirror[contenteditable="true"];div.editor-wapper .tiptap.ProseMirror[contenteditable="true"]',
        messageContainer: '.message-list'
      }
    },
    notebooklm: {
      name: { zh: 'NotebookLM', en: 'NotebookLM' },
      icon: '🤖',
      domains: ['notebooklm.google.com'],
      label: { zh: 'NotebookLM', en: 'NotebookLM' },
      selectors: {
        container: '.chat-panel-content',
        userItem: '.from-user-container',
        assistantItem: '.to-user-container',
        textUser: '.from-user-message-card-content .message-text-content',
        textAssistant: '.to-user-message-card-content .message-text-content',
        exclude: "[class*='error'], [class*='Error']",
        composer: 'textarea.query-box-input;textarea[matinput];textarea.cdk-textarea-autosize'
      }
    }
  };

  // 索引：domain → templateKey
  const domainTemplateMap = {};
  Object.keys(templateCatalog).forEach((key) => {
    (templateCatalog[key].domains || []).forEach((d) => {
      domainTemplateMap[d] = key;
    });
  });

  function getTemplateByDomain(domain) {
    const key = domainTemplateMap[domain];
    return key ? templateCatalog[key] : null;
  }

  function getTemplateKeyByDomain(domain) {
    return domainTemplateMap[domain] || null;
  }

  function getAllPlatformKeys() {
    return Object.keys(templateCatalog);
  }

  function getDomainLabel(domain) {
    const t = getTemplateByDomain(domain);
    if (!t) return null;
    return { name: t.name, icon: t.icon, label: t.label };
  }

  global.AiPlatforms = {
    templateCatalog,
    domainTemplateMap,
    getTemplateByDomain,
    getTemplateKeyByDomain,
    getAllPlatformKeys,
    getDomainLabel
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
