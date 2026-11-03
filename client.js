window.__ModuleLoader__.load({
  id: '@local/dsh-conversation-export',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'local.conversation-export';
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    const OVERLAY_SLOT = 'shell.overlay';
    const URL_LIFETIME_MS = 60000;

    const dictionaries = {
      zh: {
        menu: '导出对话',
        title: '导出对话',
        untitled: '未命名对话',
        close: '关闭导出窗口',
        format: '导出格式',
        markdown: 'Markdown',
        markdownHint: '便于阅读与分享 · .md',
        json: 'JSON',
        jsonHint: '保留结构化数据 · .json',
        includeTools: '包含工具调用与结果',
        toolsHint: '工具内容可能包含文件路径、命令或敏感信息。',
        attachmentsHint: '仅导出附件引用，不包含附件文件。',
        cancel: '取消',
        done: '关闭',
        export: '导出',
        exportAgain: '再次导出',
        exporting: '正在导出…',
        started: '已开始下载',
        messageCount: '{count} 条消息',
        warning: '导出包含警告，请查看文件中的说明。',
        networkError: '连接失败，请检查网络后重试。',
        unauthorizedError: '登录状态已失效，请重新登录后重试。',
        forbiddenError: '你无权导出此对话。',
        missingError: '此对话不存在或已被删除。',
        tooLargeError: '导出内容超过服务器配置的大小限制。请尝试不包含工具内容。',
        invalidError: '导出请求无效，请关闭窗口后重试。',
        unavailableError: '导出服务暂时不可用，请稍后重试。',
        historyError: '无法读取此对话的历史记录，请稍后重试。',
        unsupportedHistoryError: '此对话包含当前导出器不支持的记录，暂时无法导出。',
        invalidObservationError: '对话记录格式无效，无法生成导出文件。',
        abortedError: '导出已取消，请重试。',
        exportError: '无法导出此对话，请稍后重试。',
        downloadError: '无法开始下载，请重试。',
      },
      en: {
        menu: 'Export conversation',
        title: 'Export conversation',
        untitled: 'Untitled conversation',
        close: 'Close export dialog',
        format: 'Export format',
        markdown: 'Markdown',
        markdownHint: 'For reading and sharing · .md',
        json: 'JSON',
        jsonHint: 'Keep structured data · .json',
        includeTools: 'Include tool calls and results',
        toolsHint: 'Tool content may contain file paths, commands, or sensitive information.',
        attachmentsHint: 'Only attachment references are exported, not the attachment files.',
        cancel: 'Cancel',
        done: 'Close',
        export: 'Export',
        exportAgain: 'Export again',
        exporting: 'Exporting…',
        started: 'Download started',
        messageCount: '{count} messages',
        warning: 'This export includes warnings. See the notes in the file.',
        networkError: 'Connection failed. Check your connection and try again.',
        unauthorizedError: 'Your sign-in has expired. Sign in again to retry.',
        forbiddenError: 'You do not have permission to export this conversation.',
        missingError: 'This conversation does not exist or has been deleted.',
        tooLargeError: 'The export exceeds the server’s configured size limit. Try excluding tool content.',
        invalidError: 'The export request is invalid. Close this dialog and try again.',
        unavailableError: 'The export service is temporarily unavailable. Try again later.',
        historyError: 'This conversation’s history could not be read. Try again later.',
        unsupportedHistoryError: 'This conversation contains records that the current exporter does not support.',
        invalidObservationError: 'The conversation records are invalid, so an export could not be created.',
        abortedError: 'The export was canceled. Try again.',
        exportError: 'This conversation could not be exported. Try again later.',
        downloadError: 'The download could not be started. Try again.',
      },
    };

    const menuCss = `
      .lce-menu-item {
        box-sizing: border-box; display: flex; align-items: center; gap: 8px;
        width: 100%; min-height: 32px; padding: 6px 10px; border: 0;
        border-radius: 6px; background: transparent; text-align: start;
        font: inherit; font-size: 14px; line-height: 20px;
        color: var(--dsw-alias-label-primary); cursor: pointer;
      }
      .lce-menu-item:hover { background: var(--dsw-alias-bg-layer-2); }
      .lce-menu-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
      .lce-menu-item svg { flex: none; color: var(--dsw-alias-label-secondary); }
    `;
    const overlayCss = `
      .lce-backdrop, .lce-backdrop * { box-sizing: border-box; }
      .lce-backdrop {
        position: fixed; inset: 0; z-index: 1000; display: flex; pointer-events: auto;
        align-items: center; justify-content: center; padding: 24px 16px;
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); font: inherit;
        color: var(--dsw-alias-label-primary); overscroll-behavior: contain;
      }
      .lce-dialog {
        width: 440px; max-width: 100%; max-height: 100%; overflow: auto;
        padding: 24px; border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 12px; background: var(--dsw-alias-bg-layer-1);
        font-size: 14px; line-height: 1.5; outline: none;
      }
      .lce-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .lce-heading h2 { margin: 0; font-size: 17px; line-height: 28px; font-weight: 600; }
      .lce-session {
        margin: 4px 0 24px; color: var(--dsw-alias-label-secondary);
        font-size: 13px; overflow-wrap: anywhere; display: -webkit-box;
        -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
      }
      .lce-close {
        display: flex; align-items: center; justify-content: center; flex: none;
        width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
        color: var(--dsw-alias-label-secondary); background: transparent; cursor: pointer;
      }
      .lce-close:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .lce-formats { min-width: 0; margin: 0 0 20px; padding: 0; border: 0; }
      .lce-formats legend { margin-bottom: 8px; padding: 0; font-size: 13px; font-weight: 500; }
      .lce-format-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .lce-format {
        display: flex; align-items: flex-start; gap: 8px; min-width: 0;
        padding: 12px; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 8px; background: var(--dsw-alias-bg-base); cursor: pointer;
      }
      .lce-format[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
      .lce-format-title { display: block; font-weight: 500; line-height: 20px; }
      .lce-format-hint { display: block; margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .lce-dialog input { flex: none; width: 15px; height: 15px; margin: 3px 0 0; accent-color: var(--dsw-alias-brand-primary); }
      .lce-tools { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
      .lce-tools-hint { margin: 5px 0 0 23px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .lce-note { margin: 20px 0 0; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .lce-status { margin-top: 16px; font-size: 13px; overflow-wrap: anywhere; }
      .lce-status:empty { margin-top: 0; }
      .lce-status-line { display: flex; align-items: center; gap: 7px; }
      .lce-status-line svg { color: var(--dsw-alias-brand-primary); flex: none; }
      .lce-count { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .lce-warning { margin: 6px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .lce-error { margin-top: 16px; color: var(--dsw-alias-state-error-primary); font-size: 13px; }
      .lce-error:empty { margin-top: 0; }
      .lce-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
      .lce-button {
        display: inline-flex; align-items: center; justify-content: center; gap: 7px;
        min-height: 32px; padding: 5px 13px; border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 6px; background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer;
      }
      .lce-button:hover { background: var(--dsw-alias-bg-layer-2); }
      .lce-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 500; }
      .lce-dialog button:focus-visible, .lce-dialog input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }
      .lce-dialog button:disabled, .lce-dialog fieldset:disabled, .lce-tools[data-disabled="true"] { opacity: .6; cursor: default; }
      .lce-dialog fieldset:disabled .lce-format { cursor: default; }
      .lce-spinner { width: 13px; height: 13px; border: 1.5px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); border-radius: 50%; animation: lce-spin .8s linear infinite; }
      @keyframes lce-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .lce-spinner { animation: none; } }
      @media (max-width: 400px) { .lce-dialog { padding: 20px; } .lce-format-grid { grid-template-columns: 1fr; } }
    `;

    function Icon({ kind = 'download', size = 16 }) {
      const paths = kind === 'close' ? ['M6 6l12 12', 'M18 6L6 18']
        : kind === 'check' ? ['M5 12l4 4L19 6']
          : ['M12 3v12', 'M7 10l5 5 5-5', 'M5 16v4h14v-4'];
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    function safeFocus(element) {
      if (!element || !element.isConnected || typeof element.focus !== 'function') return;
      try { element.focus({ preventScroll: true }); } catch (_) { /* The host may have removed the trigger. */ }
    }

    function focusCandidate(element, excluded) {
      return element && element !== excluded && element.isConnected
        && !['BODY', 'HTML'].includes(element.tagName) && typeof element.focus === 'function'
        ? element : null;
    }

    function exportFilename(disposition, format, title) {
      let filename = '';
      // RFC 5987 takes precedence over the ASCII fallback. Never interpret it as a path.
      const extended = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition || '');
      if (extended) {
        const encoded = /^UTF-8'[^']*'(.*)$/i.exec((extended[1] || extended[2] || '').trim());
        if (encoded) {
          try { filename = decodeURIComponent(encoded[1]); } catch (_) { /* Use filename instead. */ }
        }
      }
      if (!filename) {
        const ascii = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/i.exec(disposition || '');
        if (ascii) filename = (ascii[1] || ascii[2] || '').replace(/\\(["\\])/g, '$1').trim();
      }
      const extension = format === 'json' ? '.json' : '.md';
      filename = (filename || title || 'conversation')
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, '_')
        .replace(/^[.\s]+|[.\s]+$/g, '');
      if (!filename) filename = 'conversation';
      if (filename.toLowerCase().endsWith(extension)) filename = filename.slice(0, -extension.length);
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) filename = '_' + filename;
      return Array.from(filename).slice(0, 180).join('') + extension;
    }

    function countHeader(value) {
      if (value === null || !/^\d+$/.test(value.trim())) return null;
      const number = Number(value);
      return Number.isSafeInteger(number) ? number : null;
    }

    function errorKey(status, code) {
      const normalized = typeof code === 'string' ? code.toUpperCase() : '';
      if (status === 401) return 'unauthorizedError';
      if (status === 403) return 'forbiddenError';
      const codes = {
        INVALID_PARAMS: 'invalidError',
        EXPORT_TOO_LARGE: 'tooLargeError',
        INVALID_OBSERVATION: 'invalidObservationError',
        SESSION_NOT_FOUND: 'missingError',
        UNAUTHORIZED: 'unauthorizedError',
        HISTORY_UNAVAILABLE: 'historyError',
        UNSUPPORTED_HISTORY: 'unsupportedHistoryError',
        EXPORT_FAILED: 'exportError',
        ABORTED: 'abortedError',
      };
      if (Object.prototype.hasOwnProperty.call(codes, normalized)) return codes[normalized];
      if (status === 404) return 'missingError';
      if (status === 413) return 'tooLargeError';
      if (status === 400) return 'invalidError';
      if ([429, 502, 503, 504].includes(status)) return 'unavailableError';
      return 'exportError';
    }

    function createController() {
      let snapshot = null;
      let disposed = false;
      let epoch = 0;
      let requestSequence = 0;
      let activeRequest = null;
      let closingFocus = null;
      const listeners = new Set();
      const frames = new Set();
      const urls = new Map();
      const publish = (next) => {
        snapshot = next;
        for (const listener of Array.from(listeners)) listener();
      };
      const frame = (callback) => {
        if (disposed) return;
        const id = window.requestAnimationFrame(() => {
          frames.delete(id);
          if (!disposed) callback();
        });
        frames.add(id);
      };
      const cancelFrames = () => {
        for (const id of frames) window.cancelAnimationFrame(id);
        frames.clear();
      };
      const abort = () => {
        if (activeRequest) activeRequest.abort();
        activeRequest = null;
      };
      const revoke = (url) => {
        const record = urls.get(url);
        if (!record) return;
        if (record.timer !== null) window.clearTimeout(record.timer);
        URL.revokeObjectURL(url);
        urls.delete(url);
      };
      const releaseUnusedUrls = () => {
        for (const [url, record] of urls) if (!record.started) revoke(url);
      };
      const controller = {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          if (disposed) return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        open(owner, origin) {
          if (disposed || !owner || typeof owner.sessionId !== 'string' || !owner.sessionId) return;
          const sessionId = owner.sessionId;
          const displayTitle = typeof owner.displayTitle === 'string' ? owner.displayTitle : '';
          const document = origin.ownerDocument;
          const previousFocus = focusCandidate(document.activeElement, origin);
          const ticket = ++epoch;
          cancelFrames();
          closingFocus = null;
          abort();
          releaseUnusedUrls();
          publish(null);
          // The host menu restores its trigger asynchronously. Let that finish BEFORE
          // capturing return focus and mounting a dialog that takes focus itself.
          frame(() => frame(() => {
            if (epoch !== ticket) return;
            const returnFocus = focusCandidate(document.activeElement, origin) || previousFocus;
            publish({
              openId: ticket, sessionId, displayTitle, returnFocus,
              format: 'markdown', includeTools: false, phase: 'idle', error: null,
              download: null, messageCount: null, warnings: false,
            });
          }));
        },
        close() {
          const returnFocus = snapshot ? snapshot.returnFocus : closingFocus;
          ++epoch;
          cancelFrames();
          abort();
          releaseUnusedUrls();
          if (snapshot) publish(null);
          closingFocus = returnFocus;
          if (returnFocus && !disposed) {
            const ticket = epoch;
            frame(() => {
              if (!snapshot && ticket === epoch) {
                safeFocus(returnFocus);
                closingFocus = null;
              }
            });
          }
        },
        setOptions(patch) {
          if (!snapshot || ['loading', 'ready'].includes(snapshot.phase)) return;
          publish({ ...snapshot, ...patch, phase: 'idle', error: null, download: null, messageCount: null, warnings: false });
        },
        async start() {
          if (disposed || !snapshot || ['loading', 'ready'].includes(snapshot.phase)) return;
          const selection = snapshot;
          const requestId = ++requestSequence;
          const ticket = epoch;
          const request = new AbortController();
          abort();
          activeRequest = request;
          releaseUnusedUrls();
          publish({ ...selection, phase: 'loading', error: null, download: null, messageCount: null, warnings: false });
          const current = () => !disposed && !request.signal.aborted && epoch === ticket && activeRequest === request;
          try {
            const query = new URLSearchParams({
              sessionId: selection.sessionId,
              format: selection.format,
              includeTools: String(selection.includeTools),
            });
            const response = await fetch('api/conversation-export?' + query.toString(), {
              method: 'GET', credentials: 'same-origin', mode: 'same-origin',
              redirect: 'error', cache: 'no-store', signal: request.signal,
            });
            if (!current()) return;
            if (!response.ok) {
              let code;
              try {
                const payload = await response.json();
                code = payload && payload.error && payload.error.code;
              } catch (_) { /* A proxy may return a non-JSON error body. */ }
              // Keep errors localized; never render arbitrary server messages or stacks.
              if (current()) publish({ ...snapshot, phase: 'error', error: errorKey(response.status, code) });
              return;
            }
            // The Host owns its configurable size limit. Content-Length can be absent;
            // do not impose a second, hard-coded limit or fold conversation data here.
            const blob = await response.blob();
            if (!current()) return;
            const url = URL.createObjectURL(blob);
            urls.set(url, { started: false, timer: null });
            const warningHeader = response.headers.get('X-DSH-Export-Warnings');
            const warningCount = countHeader(warningHeader);
            publish({
              ...snapshot, phase: 'ready',
              download: {
                requestId, url,
                filename: exportFilename(response.headers.get('Content-Disposition'), selection.format, selection.displayTitle),
              },
              messageCount: countHeader(response.headers.get('X-DSH-Export-Messages')),
              warnings: warningCount !== null ? warningCount > 0 : Boolean(warningHeader && warningHeader.trim()),
            });
          } catch (_) {
            if (current()) publish({ ...snapshot, phase: 'error', error: 'networkError' });
          } finally {
            if (activeRequest === request) activeRequest = null;
          }
        },
        download(requestId, anchor) {
          if (disposed || !snapshot || snapshot.phase !== 'ready' || !snapshot.download
            || snapshot.download.requestId !== requestId || !anchor) return;
          const record = urls.get(snapshot.download.url);
          if (!record || record.started) return;
          const url = snapshot.download.url;
          record.started = true; // Claim synchronously, including React StrictMode effect replays.
          try {
            anchor.click();
            // Retain the URL after the click and after closing the dialog. Immediate
            // revocation can interrupt a browser that has not consumed the Blob yet.
            record.timer = window.setTimeout(() => revoke(url), URL_LIFETIME_MS);
            publish({ ...snapshot, phase: 'success', download: null });
          } catch (_) {
            revoke(url);
            publish({ ...snapshot, phase: 'error', error: 'downloadError', download: null });
          }
        },
        dispose() {
          if (disposed) return;
          const returnFocus = snapshot ? snapshot.returnFocus : closingFocus;
          controller.close();
          disposed = true;
          cancelFrames();
          for (const url of Array.from(urls.keys())) revoke(url);
          listeners.clear();
          closingFocus = null;
          safeFocus(returnFocus);
        },
      };
      return controller;
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const controller = createController();
        ctx.effect(() => () => controller.dispose());
        ctx.effect(() => ctx.locale.register(NS, 'zh', dictionaries.zh));
        ctx.effect(() => ctx.locale.register(NS, 'en', dictionaries.en));

        function MenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
          const [, setOpen] = useMenuOpenState();
          return h(React.Fragment, null,
            h('style', null, menuCss),
            h('button', {
              type: 'button', role: 'menuitem', className: 'lce-menu-item',
              onClick(event) {
                event.stopPropagation();
                const origin = event.currentTarget;
                // Copy the row owner, never a mutable/currently selected session.
                const selected = { sessionId, displayTitle };
                setOpen(false);
                controller.open(selected, origin);
              },
            }, h(Icon), h('span', null, t('menu'))),
          );
        }

        function Dialog({ state, t }) {
          const dialogRef = React.useRef(null);
          const initialFocusRef = React.useRef(null);
          const downloadRef = React.useRef(null);
          const id = React.useId();
          const busy = state.phase === 'loading' || state.phase === 'ready';
          const titleId = id + '-title';
          const sessionId = id + '-session';
          const toolsHintId = id + '-tools-hint';
          const noteId = id + '-note';

          React.useLayoutEffect(() => {
            const dialog = dialogRef.current;
            if (!dialog) return undefined;
            const document = dialog.ownerDocument;
            const focusInside = () => safeFocus(initialFocusRef.current && !initialFocusRef.current.matches(':disabled')
              ? initialFocusRef.current : dialog);
            const onFocus = (event) => {
              const current = controller.getSnapshot();
              if (current && current.openId === state.openId && !dialog.contains(event.target)) focusInside();
            };
            document.addEventListener('focusin', onFocus, true);
            focusInside();
            return () => document.removeEventListener('focusin', onFocus, true);
          }, [state.openId]);

          React.useEffect(() => {
            if (state.phase === 'ready' && state.download) {
              controller.download(state.download.requestId, downloadRef.current);
            }
          }, [state.phase, state.download]);

          function onKeyDown(event) {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              controller.close();
              return;
            }
            if (event.key !== 'Tab') return;
            // Query only the plugin-owned dialog, never the host DOM.
            const dialog = dialogRef.current;
            const targets = Array.from(dialog.querySelectorAll(
              'button:not(:disabled), input:not(:disabled), a[href]:not([tabindex="-1"]), [tabindex="0"]',
            )).filter((element) => !element.hidden && element.getClientRects().length > 0);
            const first = targets[0];
            const last = targets[targets.length - 1];
            const active = dialog.ownerDocument.activeElement;
            if (!first) {
              event.preventDefault();
              safeFocus(dialog);
            } else if (event.shiftKey && (active === first || active === dialog)) {
              event.preventDefault();
              safeFocus(last);
            } else if (!event.shiftKey && (active === last || active === dialog)) {
              event.preventDefault();
              safeFocus(first);
            }
          }

          function formatChoice(format, label, hint) {
            return h('label', {
              className: 'lce-format', 'data-selected': state.format === format,
            },
            h('input', {
              ref: format === 'markdown' ? initialFocusRef : undefined,
              type: 'radio', name: id + '-format', value: format,
              checked: state.format === format,
              onChange: () => controller.setOptions({ format }),
            }),
            h('span', null,
              h('span', { className: 'lce-format-title' }, t(label)),
              h('span', { className: 'lce-format-hint' }, t(hint)),
            ));
          }

          return h('div', {
            className: 'lce-backdrop',
            onPointerDown(event) {
              if (event.target === event.currentTarget) {
                event.preventDefault();
                controller.close();
              }
            },
          }, h('section', {
            ref: dialogRef, className: 'lce-dialog', role: 'dialog',
            'aria-modal': true, 'aria-labelledby': titleId,
            'aria-describedby': sessionId + ' ' + noteId,
            tabIndex: -1, onKeyDown,
          },
          h('div', { className: 'lce-heading' },
            h('h2', { id: titleId }, t('title')),
            h('button', {
              type: 'button', className: 'lce-close', 'aria-label': t('close'),
              onClick: () => controller.close(),
            }, h(Icon, { kind: 'close', size: 18 })),
          ),
          h('p', {
            id: sessionId, className: 'lce-session', title: state.displayTitle || t('untitled'),
          }, state.displayTitle || t('untitled')),
          h('form', {
            onSubmit(event) { event.preventDefault(); void controller.start(); },
          },
          h('fieldset', { className: 'lce-formats', disabled: busy },
            h('legend', null, t('format')),
            h('div', { className: 'lce-format-grid' },
              formatChoice('markdown', 'markdown', 'markdownHint'),
              formatChoice('json', 'json', 'jsonHint'),
            ),
          ),
          h('label', { className: 'lce-tools', 'data-disabled': busy },
            h('input', {
              type: 'checkbox', checked: state.includeTools, disabled: busy,
              'aria-describedby': toolsHintId,
              onChange: (event) => controller.setOptions({ includeTools: event.target.checked }),
            }),
            h('span', null, t('includeTools')),
          ),
          h('p', { id: toolsHintId, className: 'lce-tools-hint' }, t('toolsHint')),
          h('p', { id: noteId, className: 'lce-note' }, t('attachmentsHint')),
          h('div', { className: 'lce-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
            busy ? h('span', { className: 'lce-status-line' }, t('exporting')) : null,
            state.phase === 'success' ? h(React.Fragment, null,
              h('div', { className: 'lce-status-line' },
                h(Icon, { kind: 'check' }), h('span', null, t('started')),
                state.messageCount !== null ? h('span', { className: 'lce-count' }, t('messageCount', { count: state.messageCount })) : null,
              ),
              state.warnings ? h('p', { className: 'lce-warning' }, t('warning')) : null,
            ) : null,
          ),
          h('div', { className: 'lce-error', role: 'alert', 'aria-atomic': true }, state.error ? t(state.error) : null),
          h('div', { className: 'lce-actions' },
            h('button', {
              type: 'button', className: 'lce-button', onClick: () => controller.close(),
            }, t(state.phase === 'success' ? 'done' : 'cancel')),
            h('button', { type: 'submit', className: 'lce-button lce-primary', disabled: busy, 'aria-busy': busy },
              busy ? h('span', { className: 'lce-spinner', 'aria-hidden': true }) : h(Icon),
              t(busy ? 'exporting' : state.phase === 'success' ? 'exportAgain' : 'export'),
            ),
          )),
          // This is a React-owned element inside the overlay, not a body append.
          h('a', {
            ref: downloadRef, hidden: true, tabIndex: -1, 'aria-hidden': true,
            href: state.download ? state.download.url : undefined,
            download: state.download ? state.download.filename : undefined,
          }),
          ));
        }

        function Overlay({ t }) {
          const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
          React.useEffect(() => () => controller.close(), []);
          return h(React.Fragment, null,
            h('style', null, overlayCss),
            state ? h(Dialog, { key: state.openId, state, t }) : null,
          );
        }

        ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
          name: MENU_SLOT, id: 'local.conversation-export.menu', order: 500, locale: NS,
        }, MenuItem));
        ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
          name: OVERLAY_SLOT, id: 'local.conversation-export.overlay', order: 500, locale: NS,
        }, Overlay));
      },
    };
  },
});
