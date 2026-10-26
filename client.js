/**
 * Session Admin — Client (browser) half.
 *
 * Adds one row to the Session "..." menu (`sidebar.workspaces.session.menu.item`)
 * and one frame-wide confirmation dialog (`shell.overlay`). The dialog talks to
 * the Host `sessionAdmin` Remote namespace mounted at startup.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-admin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NAME = '@local/dsh-session-admin'
    const NS = 'sessionAdmin'
    const LOCALE_NS = 'session-admin'
    const STYLE_MARK = 'data-plugin="dsh-session-admin"'

    /* ------------------------------------------------------------- locale */

    const en = {
      menuDelete: 'Delete session…',
      dialogTitle: 'Delete session',
      dialogSubtitle: 'This permanently removes the session and the files it stored. It cannot be undone.',
      untitled: 'Untitled',
      loading: 'Reading session data…',
      workspaceLabel: 'Workspace',
      ungrouped: 'Ungrouped',
      createdLabel: 'Created',
      sizeLabel: 'Stored size',
      artifactsLabel: 'Will be removed',
      artifactsEmpty: 'No stored files were found for this session.',
      childrenLabel: 'Child subagent sessions removed with it',
      remindersLabel: 'Scheduled reminders cancelled with it',
      writtenFilesLabel: 'Files this session wrote in its working directory',
      writtenFilesHint: 'Optional: delete these workspace files as well. Review the list before confirming.',
      noWrittenFiles: 'No workspace files were found for this session.',
      blockersLabel: 'Cannot delete right now',
      liveWarningLabel: 'This session is still loaded in the app',
      liveWarningBody:
        'The running application still holds this session (it may be open in another window). Its files can be deleted now, but any message sent afterwards from that window will fail. Close that window or reload the page after deleting.',
      liveConfirm: 'I understand it is still loaded and want to delete it anyway',
      runningLabel: 'Running',
      idleLoadedLabel: 'Loaded, idle',
      cancel: 'Cancel',
      delete: 'Delete permanently',
      deleting: 'Deleting…',
      close: 'Close',
      doneTitle: 'Session deleted',
      doneSummary: 'Freed {size}. Removed {sessions} session(s), {files} file(s).',
      failedTitle: 'Delete failed',
      previewFailedTitle: 'Could not read session',
      retryHint: 'Try again, or check the plugin audit log in <DSH_HOME>/session-admin/audit.jsonl.',
      warningLabel: 'Warnings',
      pathLabel: 'Path',
      sessionsCount: '{count} session(s)',
      childCount: '{count} child session(s)',
    }

    const zh = {
      menuDelete: '删除会话…',
      dialogTitle: '删除会话',
      dialogSubtitle: '将永久删除该会话及其占用的文件，无法撤销。',
      untitled: '未命名',
      loading: '正在读取会话信息…',
      workspaceLabel: '工作区',
      ungrouped: '未分组',
      createdLabel: '创建时间',
      sizeLabel: '占用空间',
      artifactsLabel: '将被移除',
      artifactsEmpty: '该会话没有找到可移除的存储文件。',
      childrenLabel: '一并移除的子会话',
      remindersLabel: '一并取消的定时任务',
      writtenFilesLabel: '该会话在工作区中写入的文件',
      writtenFilesHint: '可选：同时删除这些工作区文件。确认前请先核对列表。',
      noWrittenFiles: '没有找到该会话写入的工作区文件。',
      blockersLabel: '当前无法删除',
      liveWarningLabel: '该会话仍被应用加载',
      liveWarningBody:
        '应用内存中仍保留该会话（可能正在另一个窗口打开）。可以现在删除它的文件，但之后从那个窗口再发送消息会失败。删除后请关闭该窗口或刷新页面。',
      liveConfirm: '我了解该会话仍被加载，仍然删除',
      runningLabel: '运行中',
      idleLoadedLabel: '已加载（空闲）',
      cancel: '取消',
      delete: '永久删除',
      deleting: '正在删除…',
      close: '关闭',
      doneTitle: '会话已删除',
      doneSummary: '已释放 {size}，移除 {sessions} 个会话、{files} 个文件。',
      failedTitle: '删除失败',
      previewFailedTitle: '读取会话失败',
      retryHint: '可以再试一次；若仍失败，请查看 <DSH_HOME>/session-admin/audit.jsonl 里的记录。',
      warningLabel: '警告',
      pathLabel: '路径',
      sessionsCount: '{count} 个会话',
      childCount: '{count} 个子会话',
    }

    /* --------------------------------------------------------------- store */

    let dialogRequest = null
    const dialogListeners = new Set()

    function publish() {
      for (const listener of [...dialogListeners]) listener()
    }

    function subscribeDialog(listener) {
      dialogListeners.add(listener)
      return () => {
        dialogListeners.delete(listener)
      }
    }

    function getDialog() {
      return dialogRequest
    }

    function openDeleteDialog(request) {
      dialogRequest = request
      publish()
    }

    function closeDeleteDialog() {
      dialogRequest = null
      publish()
    }

    /* ----------------------------------------------------------- utilities */

    function errorMessage(error) {
      if (!error) return 'Unknown error'
      if (typeof error === 'string') return error
      return error.message || error.code || String(error)
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
    }

    function formatDate(timestamp) {
      if (!timestamp) return '—'
      try {
        return new Date(timestamp).toLocaleString()
      } catch {
        return String(timestamp)
      }
    }

    function baselineName(basename) {
      if (!basename) return ''
      const segments = basename.split(/[\\/]/).filter(Boolean)
      return segments[segments.length - 1] || basename
    }

    /* -------------------------------------------------------------- visuals */

    const CSS = `
.sa-menu-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4;text-align:left;white-space:nowrap;cursor:pointer}
.sa-menu-item:hover,.sa-menu-item:focus-visible{background:var(--dsw-alias-bg-layer-2);outline:none}
.sa-menu-icon{display:inline-flex;flex:0 0 auto;width:14px;height:14px;align-items:center;justify-content:center;opacity:.8}
.sa-backdrop{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:color-mix(in srgb,var(--dsw-alias-label-primary) 32%,transparent);pointer-events:auto}
.sa-dialog{width:min(600px,calc(100vw - 48px));max-height:min(720px,calc(100vh - 64px));overflow:auto;box-sizing:border-box;padding:20px 22px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 24px 64px color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);font-size:13px;line-height:1.55}
.sa-title{margin:0 0 4px;font-size:15px;font-weight:600}
.sa-subtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.sa-section{margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.sa-section-title{margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.sa-kv{display:flex;gap:8px;justify-content:space-between;padding:2px 0}
.sa-kv-key{color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.sa-kv-value{overflow-wrap:anywhere;text-align:right}
.sa-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sa-list{margin:4px 0 0;padding-left:18px}
.sa-list li{margin:2px 0;overflow-wrap:anywhere}
.sa-empty{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.sa-check{display:flex;gap:9px;align-items:flex-start;margin-top:10px;cursor:pointer;user-select:none}
.sa-check input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.sa-hint{margin:4px 0 0 22px;color:var(--dsw-alias-label-secondary);font-size:12px}
.sa-warning{margin:10px 0 0;padding:9px 11px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-label-primary);font-size:12px}
.sa-error{color:var(--dsw-alias-state-error-primary)}
.sa-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.sa-btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4;cursor:pointer}
.sa-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.sa-btn:disabled{opacity:.5;cursor:not-allowed}
.sa-btn-danger{padding:6px 14px;border:1px solid transparent;border-radius:8px;background:var(--dsw-alias-state-error-primary);color:#fff;font:inherit;font-size:13px;line-height:1.4;cursor:pointer}
.sa-btn-danger:hover:not(:disabled){filter:brightness(1.06)}
.sa-btn-danger:disabled{opacity:.5;cursor:not-allowed}
.sa-spinner{display:inline-block;width:12px;height:12px;margin-right:8px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:sa-spin .8s linear infinite;vertical-align:-2px}
@keyframes sa-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.sa-spinner{animation:none}}
`

    function TrashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M2.5 4h11' }),
        h('path', { d: 'M6 4V2.8c0-.4.3-.8.8-.8h2.4c.5 0 .8.4.8.8V4' }),
        h('path', { d: 'M4 4l.6 9.1c.1.5.5.9 1 .9h4.8c.5 0 .9-.4 1-.9L12 4' }),
      )
    }

    /* -------------------------------------------------------- menu item */

    function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
      const setMenuOpen = useMenuOpenState()[1]
      const onSelect = (event) => {
        event.preventDefault()
        event.stopPropagation()
        setMenuOpen(false)
        openDeleteDialog({ sessionId, displayTitle })
      }
      return h(
        'button',
        { type: 'button', role: 'menuitem', className: 'sa-menu-item', onClick: onSelect, title: t('menuDelete') },
        h('span', { className: 'sa-menu-icon' }, h(TrashIcon)),
        h('span', null, t('menuDelete')),
      )
    }

    /* ----------------------------------------------------------- dialog */

    function DeleteDialog({ t, api }) {
      const request = React.useSyncExternalStore(subscribeDialog, getDialog, getDialog)
      const requestId = request ? request.sessionId : null
      const [stage, setStage] = React.useState({ phase: 'idle' })
      const [deleteFiles, setDeleteFiles] = React.useState(false)
      const [allowLive, setAllowLive] = React.useState(false)

      React.useEffect(() => {
        if (!request) {
          setStage({ phase: 'idle' })
          return undefined
        }
        let cancelled = false
        setDeleteFiles(false)
        setAllowLive(false)
        setStage({ phase: 'loading' })
        api
          .preview(request.sessionId)
          .then((preview) => {
            if (!cancelled) setStage({ phase: 'ready', preview })
          })
          .catch((error) => {
            if (!cancelled) setStage({ phase: 'failed', scope: 'preview', message: errorMessage(error) })
          })
        return () => {
          cancelled = true
        }
      }, [requestId])

      React.useEffect(() => {
        if (!request) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            closeDeleteDialog()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [requestId])

      if (!request) return null

      const preview = stage.preview
      const session = preview ? preview.session : null
      const title = (session && session.title) || request.displayTitle || t('untitled')
      const blockers = preview ? preview.blockers || [] : []
      const liveSessions = preview ? preview.liveSessions || [] : []
      const needsLive = Boolean(preview && preview.needsLiveConfirmation)
      const busy = stage.phase === 'loading' || stage.phase === 'deleting'
      const workspaceLabel = session && session.workspace ? session.workspace.title || baselineName(session.workspace.path) : t('ungrouped')

      const runDelete = () => {
        setStage({ phase: 'deleting', preview })
        api
          .delete({ sessionId: request.sessionId, deleteWorkspaceFiles: deleteFiles === true, allowLive: needsLive && allowLive })
          .then((result) => setStage({ phase: 'done', result }))
          .catch((error) => setStage({ phase: 'failed', scope: 'delete', message: errorMessage(error) }))
      }

      const header = h(
        'div',
        null,
        h('h2', { className: 'sa-title' }, t('dialogTitle')),
        h('p', { className: 'sa-subtitle', id: 'sa-dialog-subtitle' }, t('dialogSubtitle')),
      )

      const body = []

      if (!preview) {
        body.push(h('div', { className: 'sa-section' }, h('p', { className: 'sa-empty' }, stage.phase === 'loading' ? h(React.Fragment, null, h('span', { className: 'sa-spinner' }), t('loading')) : '')))
      } else {
        body.push(
          h(
            'div',
            { className: 'sa-section' },
            h('p', { className: 'sa-title', style: { fontSize: '14px', marginBottom: '2px' } }, title),
            h(
              'div',
              { className: 'sa-kv' },
              h('span', { className: 'sa-kv-key' }, t('workspaceLabel')),
              h('span', { className: 'sa-kv-value' }, workspaceLabel),
            ),
            session && session.cwd
              ? h(
                  'div',
                  { className: 'sa-kv' },
                  h('span', { className: 'sa-kv-key' }, t('pathLabel')),
                  h('span', { className: 'sa-kv-value sa-code' }, session.cwd),
                )
              : null,
            h(
              'div',
              { className: 'sa-kv' },
              h('span', { className: 'sa-kv-key' }, t('createdLabel')),
              h('span', { className: 'sa-kv-value' }, formatDate(session.createdAt)),
            ),
            h(
              'div',
              { className: 'sa-kv' },
              h('span', { className: 'sa-kv-key' }, t('sizeLabel')),
              h('span', { className: 'sa-kv-value' }, formatBytes(preview.totalBytes)),
            ),
          ),
        )

        if (needsLive) {
          body.push(
            h(
              'div',
              { className: 'sa-warning' },
              h('strong', null, t('liveWarningLabel')),
              liveSessions.length > 0
                ? h(
                    'div',
                    { className: 'sa-code', style: { marginTop: '4px' } },
                    liveSessions.map((entry) => entry.sessionId).join(', '),
                  )
                : null,
              h('p', { style: { margin: '6px 0 0' } }, t('liveWarningBody')),
              h(
                'label',
                { className: 'sa-check' },
                h('input', {
                  type: 'checkbox',
                  checked: allowLive,
                  disabled: busy,
                  onChange: (event) => setAllowLive(event.target.checked),
                }),
                h('span', null, t('liveConfirm')),
              ),
            ),
          )
        }

        const artifacts = preview.artifacts || []
        body.push(
          h(
            'div',
            { className: 'sa-section' },
            h('p', { className: 'sa-section-title' }, t('artifactsLabel')),
            artifacts.length === 0
              ? h('p', { className: 'sa-empty' }, t('artifactsEmpty'))
              : h(
                  'ul',
                  { className: 'sa-list' },
                  artifacts.map((artifact) =>
                    h(
                      'li',
                      { key: artifact.path },
                      h('span', { className: 'sa-code' }, artifact.path),
                      ' — ',
                      h('span', { className: 'sa-code' }, formatBytes(artifact.bytes)),
                    ),
                  ),
                ),
          ),
        )

        if (preview.children && preview.children.length > 0) {
          body.push(
            h(
              'div',
              { className: 'sa-section' },
              h('p', { className: 'sa-section-title' }, t('childrenLabel')),
              h(
                'ul',
                { className: 'sa-list' },
                preview.children.map((child) =>
                  h(
                    'li',
                    { key: child.sessionId },
                    (child.title || t('untitled')) + ' — ',
                    h('span', { className: 'sa-code' }, formatBytes(child.sizeBytes)),
                  ),
                ),
              ),
            ),
          )
        }

        if (preview.reminders && preview.reminders.length > 0) {
          body.push(
            h(
              'div',
              { className: 'sa-section' },
              h('p', { className: 'sa-section-title' }, t('remindersLabel')),
              h(
                'ul',
                { className: 'sa-list' },
                preview.reminders.map((reminder) =>
                  h('li', { key: reminder.id }, h('span', { className: 'sa-code' }, reminder.id)),
                ),
              ),
            ),
          )
        }

        const written = preview.writtenFiles || []
        body.push(
          h(
            'div',
            { className: 'sa-section' },
            h('p', { className: 'sa-section-title' }, t('writtenFilesLabel')),
            written.length === 0
              ? h('p', { className: 'sa-empty' }, t('noWrittenFiles'))
              : h(
                  'label',
                  { className: 'sa-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: deleteFiles,
                    disabled: busy,
                    onChange: (event) => setDeleteFiles(event.target.checked),
                  }),
                  h('span', null, t('writtenFilesHint')),
                ),
            written.length === 0
              ? null
              : h(
                  'ul',
                  { className: 'sa-list' },
                  written.map((file) =>
                    h(
                      'li',
                      { key: file.path },
                      h('span', { className: 'sa-code' }, file.path),
                      ' — ',
                      h('span', { className: 'sa-code' }, formatBytes(file.bytes)),
                    ),
                  ),
                ),
          ),
        )

        if (blockers.length > 0) {
          body.push(
            h(
              'div',
              { className: 'sa-warning' },
              h('strong', null, t('blockersLabel')),
              h(
                'ul',
                { className: 'sa-list' },
                blockers.map((blocker, index) => h('li', { key: String(index) }, blocker)),
              ),
            ),
          )
        }
      }

      if (stage.phase === 'done') {
        const result = stage.result || {}
        body.push(
          h(
            'div',
            { className: 'sa-section' },
            h('p', { className: 'sa-title', style: { fontSize: '14px' } }, t('doneTitle')),
            h(
              'p',
              { className: 'sa-subtitle' },
              t('doneSummary', {
                size: formatBytes(result.bytesFreed || 0),
                sessions: (result.deletedSessions || []).length,
                files: (result.filesDeleted || []).length,
              }),
            ),
            result.warnings && result.warnings.length > 0
              ? h(
                  'div',
                  { className: 'sa-warning' },
                  h('strong', null, t('warningLabel')),
                  h('ul', { className: 'sa-list' }, result.warnings.map((warning, index) => h('li', { key: String(index) }, warning))),
                )
              : null,
          ),
        )
      }

      if (stage.phase === 'failed') {
        body.push(
          h(
            'div',
            { className: 'sa-section' },
            h(
              'p',
              { className: 'sa-title sa-error', style: { fontSize: '14px' } },
              t(stage.scope === 'preview' ? 'previewFailedTitle' : 'failedTitle'),
            ),
            h('p', { className: 'sa-empty sa-error' }, stage.message || ''),
            h('p', { className: 'sa-empty' }, t('retryHint')),
          ),
        )
      }

      const actions = []
      if (stage.phase === 'done' || stage.phase === 'failed') {
        actions.push(h('button', { key: 'close', type: 'button', className: 'sa-btn', onClick: closeDeleteDialog }, t('close')))
      } else {
        actions.push(h('button', { key: 'cancel', type: 'button', className: 'sa-btn', disabled: stage.phase === 'deleting', onClick: closeDeleteDialog }, t('cancel')))
        actions.push(
          h(
            'button',
            {
              key: 'delete',
              type: 'button',
              className: 'sa-btn-danger',
              disabled: busy || !preview || blockers.length > 0 || (needsLive && !allowLive),
              onClick: runDelete,
            },
            stage.phase === 'deleting' ? h(React.Fragment, null, h('span', { className: 'sa-spinner' }), t('deleting')) : t('delete'),
          ),
        )
      }

      return h(
        'div',
        {
          className: 'sa-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) closeDeleteDialog()
          },
        },
        h(
          'div',
          {
            className: 'sa-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'sa-dialog-title',
            onMouseDown: (event) => event.stopPropagation(),
          },
          h('span', { id: 'sa-dialog-title', style: { display: 'none' } }, t('dialogTitle')),
          header,
          body,
          h('div', { className: 'sa-actions' }, actions),
        ),
      )
    }

    /* ------------------------------------------------------- remote wiring */

    const strictCodec = (symbol, parse) => ({
      mode: 'strict',
      typeSymbol: `${NAME}#${symbol}`,
      schema: { parse },
      create: () => ({ parse }),
    })

    const parseSessionId = (value) => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('Invalid session id')
      return value
    }

    const parseDeleteRequest = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid delete request')
      parseSessionId(value.sessionId)
      return value
    }

    const passThrough = (value) => value
    const sessionIdCodec = strictCodec('SessionId', parseSessionId)
    const deleteRequestCodec = strictCodec('DeleteRequest', parseDeleteRequest)
    const listCodec = strictCodec('SessionList', passThrough)
    const previewCodec = strictCodec('SessionPreview', passThrough)
    const deleteResultCodec = strictCodec('DeleteResult', passThrough)

    const remote = {
      package: NAME,
      descriptors: [
        { id: `${NAME}#${NS}/list`, service: NS, namespace: NS, method: 'list', invocation: { kind: 'direct' }, parameters: [], result: listCodec },
        {
          id: `${NAME}#${NS}/preview`,
          service: NS,
          namespace: NS,
          method: 'preview',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec }],
          result: previewCodec,
        },
        {
          id: `${NAME}#${NS}/delete`,
          service: NS,
          namespace: NS,
          method: 'delete',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: deleteRequestCodec }],
          result: deleteResultCodec,
        },
      ],
    }

    /* -------------------------------------------------------------- diag */

    // Browser-side diagnostics: the Host can read these from the app's Local
    // Storage on disk, so a page that cannot reach the Host still leaves a trace.
    const DIAG_KEY = 'session-admin:diagnostics.v1'

    function recordDiag(entry) {
      try {
        let previous = {}
        try {
          previous = JSON.parse(localStorage.getItem(DIAG_KEY) || '{}') || {}
        } catch {
          previous = {}
        }
        const events = Array.isArray(previous.events) ? previous.events.slice(-9) : []
        events.push({ at: new Date().toISOString(), ...entry })
        localStorage.setItem(DIAG_KEY, JSON.stringify({ boot: entry.kind === 'boot' ? entry : previous.boot, events }))
      } catch {
        // diagnostics must never break the UI
      }
    }

    /* --------------------------------------------------------------- apply */

    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'session-admin: copy dictionaries')

        recordDiag({ kind: 'boot', plugin: NAME, location: String(window && window.location && window.location.href) })

        const mounted = ctx.remote.$mount(remote)
        ctx.effect(async () => {
          await mounted
        })
        Promise.resolve(mounted).then(
          () => recordDiag({ kind: 'mount-ok' }),
          (error) => recordDiag({ kind: 'mount-failed', message: errorMessage(error), stack: error && error.stack }),
        )

        // `ctx.remote.<namespace>` is a traced child Service: reading the property
        // without declaring it throws `cannot get property ... without inject`, so the
        // namespace is obtained through `ctx.inject` (waiting for the mount) with a
        // direct `ctx.get` fast path.
        let remoteNamespace
        let resolveNamespace
        const namespaceReady = new Promise((resolve) => {
          resolveNamespace = resolve
        })
        ctx.inject([`remote.${NS}`], (ready) => {
          remoteNamespace = ready.remote[NS]
          recordDiag({ kind: 'namespace-ready' })
          resolveNamespace(remoteNamespace)
          return () => {
            remoteNamespace = undefined
          }
        })

        async function acquireNamespace() {
          await mounted
          let namespace = remoteNamespace
          if (!namespace && typeof ctx.get === 'function') {
            try {
              namespace = ctx.get(`remote.${NS}`)
            } catch {
              namespace = undefined
            }
          }
          if (!namespace) {
            await Promise.race([
              namespaceReady,
              new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error(`Host remote "remote.${NS}" did not mount within 8s`)), 8000)
              }),
            ])
            namespace = remoteNamespace
          }
          if (!namespace) throw new Error(`Host remote "remote.${NS}" is not mounted`)
          return namespace
        }

        async function callRemote(method, ...args) {
          try {
            const namespace = await acquireNamespace()
            const invoke = namespace[method]
            if (typeof invoke !== 'function') {
              throw new Error(`Host remote has no method "${method}"`)
            }
            const result = await invoke(...args)
            if (result && typeof result === 'object' && 'ok' in result) {
              if (result.ok === true) {
                recordDiag({ kind: 'call-ok', method })
                return result.value
              }
              const failure = result.error
              const error = new Error((failure && (failure.message || failure.code)) || 'Remote call failed')
              error.code = failure && failure.code
              throw error
            }
            recordDiag({ kind: 'call-ok', method })
            return result
          } catch (error) {
            recordDiag({ kind: 'call-failed', method, message: errorMessage(error), code: error && error.code, stack: error && error.stack })
            throw error
          }
        }

        const api = {
          list: () => callRemote('list'),
          preview: (sessionId) => callRemote('preview', sessionId),
          delete: (request) => callRemote('delete', request),
        }

        ctx.effect(() => {
          const existing = document.querySelector(`style[${STYLE_MARK}]`)
          if (existing) return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-session-admin')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'session-admin: styles')

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'session-admin.delete',
              order: 460,
              locale: LOCALE_NS,
              inject: () => ({ openDeleteDialog }),
            },
            DeleteMenuItem,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'session-admin.dialog',
              order: 900,
              locale: LOCALE_NS,
              inject: () => ({ api }),
            },
            DeleteDialog,
          ),
        )
      },
    }
  },
})
