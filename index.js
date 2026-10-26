/**
 * Session Admin — Host half.
 *
 * The Harness has no session-deletion API: `dsh-workspace` and
 * `dsh-session-persistence-jsonl` both document deletion as an absent
 * capability. This plugin adds one, using only durable, supported seams:
 *
 *  - the session log directory under `<DSH_HOME>/sessions/<project>/<id>/`
 *  - the derived projection cache at `<DSH_HOME>/storages/session_projcache/sessions/<id>.json`
 *  - `Workspace.detachSession()` plus `unpinSession()` / `unarchiveSession()`
 *    for the durable workspace accounting
 *  - `api-session/removed` so the connected Client drops its catalog row
 *
 * The same operation is reachable from the Web UI (a Typert Remote namespace
 * mounted by `client.js`) and from the agent (`session_admin` tool).
 */
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'

const PACKAGE = '@local/dsh-session-admin'
const NS = 'sessionAdmin'

/** Tools whose durable call arguments name a file this Session wrote. */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'create_file', 'apply_patch'])

/* ------------------------------------------------------------------ paths */

function harnessHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

function roots() {
  const home = harnessHome()
  return {
    home,
    sessionsRoot: path.join(home, 'sessions'),
    projectionCacheRoot: path.join(home, 'storages', 'session_projcache', 'sessions'),
  }
}

/* ----------------------------------------------------------------- errors */

/**
 * A user-facing refusal. A linked profile bundle cannot import the Harness
 * packages, so this mirrors the protocol package's `RemoteError` shape: the
 * Gateway folds an unclassified throw into `gateway/internal` and the Client
 * surfaces the message; `code` stays readable for tool callers.
 */
function refusal(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}


function strictCodec(symbol, parse) {
  return {
    mode: 'strict',
    typeSymbol: `${PACKAGE}#${symbol}`,
    schema: { parse },
    create: () => ({ parse }),
  }
}

function parseSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('Invalid session id')
  }
  return value
}

function parseDeleteRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid delete request')
  const allowed = ['sessionId', 'deleteWorkspaceFiles', 'allowLive']
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unexpected delete request field: ${key}`)
  }
  parseSessionId(value.sessionId)
  if (value.deleteWorkspaceFiles !== undefined && typeof value.deleteWorkspaceFiles !== 'boolean') {
    throw new Error('deleteWorkspaceFiles must be a boolean')
  }
  if (value.allowLive !== undefined && typeof value.allowLive !== 'boolean') {
    throw new Error('allowLive must be a boolean')
  }
  return {
    sessionId: value.sessionId,
    deleteWorkspaceFiles: value.deleteWorkspaceFiles === true,
    allowLive: value.allowLive === true,
  }
}

const passThrough = (value) => value

const sessionIdCodec = strictCodec('SessionId', parseSessionId)
const deleteRequestCodec = strictCodec('DeleteRequest', parseDeleteRequest)
const listCodec = strictCodec('SessionList', passThrough)
const previewCodec = strictCodec('SessionPreview', passThrough)
const deleteResultCodec = strictCodec('DeleteResult', passThrough)

export const remoteContribution = {
  package: PACKAGE,
  descriptors: [
    {
      id: `${PACKAGE}#${NS}/list`,
      service: NS,
      namespace: NS,
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: listCodec,
    },
    {
      id: `${PACKAGE}#${NS}/preview`,
      service: NS,
      namespace: NS,
      method: 'preview',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec }],
      result: previewCodec,
    },
    {
      id: `${PACKAGE}#${NS}/delete`,
      service: NS,
      namespace: NS,
      method: 'delete',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: deleteRequestCodec }],
      result: deleteResultCodec,
    },
  ],
}

/* ------------------------------------------------------------ projections */

function projectionTitle(record) {
  const title = record?.rows?.title?.val
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
}

function projectionBlank(record) {
  const blank = record?.rows?.sessionListMetadata?.val?.blank
  return blank === true
}

function projectionPreset(record) {
  const preset = record?.rows?.agentPreset?.val
  return typeof preset === 'string' ? preset : undefined
}

async function readProjectionCache(ctx, id) {
  const file = path.join(roots().projectionCacheRoot, `${id}.json`)
  const bytes = await fileSize(file)
  // Live state lives in the storage domain; its in-memory table can be newer than
  // the file, and the cache service reads it directly.
  try {
    const record = optionalService(ctx, 'storageDomain')?.get?.('session_projcache')?.table?.('sessions')?.get?.(id)
    if (record) return { file, record, bytes, source: 'domain' }
  } catch {
    // fall back to the file below
  }
  if (bytes === 0) return { file, record: null, bytes: 0, source: 'none' }
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    return { file, record: parsed?.record ?? null, bytes, source: 'file' }
  } catch {
    return { file, record: null, bytes, source: 'unreadable' }
  }
}

/**
 * Remove one projection-cache row. Deleting only the file while the Host runs can
 * be undone by the in-memory domain table, so prefer the domain's own delete and
 * fall back to the file.
 */
async function removeProjectionCache(ctx, id) {
  const file = path.join(roots().projectionCacheRoot, `${id}.json`)
  const bytes = await fileSize(file)
  let removed = false
  try {
    const table = optionalService(ctx, 'storageDomain')?.get?.('session_projcache')?.table?.('sessions')
    if (table && typeof table.delete === 'function') {
      const existed = await table.delete(id)
      removed = existed !== false || bytes > 0
    }
  } catch {
    // the file removal below is the fallback
  }
  if ((await fileSize(file)) > 0) {
    try {
      await fsp.rm(file, { force: true })
      removed = true
    } catch (error) {
      return { file, bytes, removed: false, error: messageOf(error) }
    }
  }
  return { file, bytes, removed, error: undefined }
}

/* --------------------------------------------------------------- scanning */

async function listDirectoryEntries(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Locate a Session's own directory; Session ids are path-safe, so the name is identity. */
async function findSessionDirectories(id) {
  const { sessionsRoot } = roots()
  const found = []
  for (const entry of await listDirectoryEntries(sessionsRoot)) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(sessionsRoot, entry.name, id)
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isDirectory()) found.push(candidate)
    } catch {
      // absent in this project directory
    }
  }
  return found
}

async function directorySize(dir) {
  let total = 0
  let files = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full)
          total += stat.size
          files += 1
        } catch {
          // vanished while scanning
        }
      }
    }
  }
  return { bytes: total, files }
}

async function fileSize(file) {
  try {
    const stat = await fsp.stat(file)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

async function newestMtime(paths) {
  let newest = 0
  for (const target of paths) {
    try {
      const stat = await fsp.stat(target)
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
    } catch {
      // ignore
    }
  }
  return newest
}

/* ---------------------------------------------------------------- closure */

async function listSnapshots(ctx) {
  try {
    return await ctx.sessionPersistence.list()
  } catch (error) {
    throw refusal('session-admin/list-failed', `Could not enumerate session storage: ${messageOf(error)}`)
  }
}

/** The Session plus every descendant Session, found through durable `parentSession` headers. */
function descendantClosure(snapshots, rootId) {
  const children = new Map()
  for (const snapshot of snapshots) {
    const parent = snapshot.header.parentSession
    if (!parent) continue
    const bucket = children.get(parent)
    if (bucket) bucket.push(snapshot.header.id)
    else children.set(parent, [snapshot.header.id])
  }
  const ordered = [rootId]
  const seen = new Set(ordered)
  for (let index = 0; index < ordered.length; index += 1) {
    for (const child of children.get(ordered[index]) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      ordered.push(child)
    }
  }
  return ordered
}

async function workspaceOf(ctx, sessionId) {
  let workspaces = []
  try {
    workspaces = ctx.workspaceRegistry.list()
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    try {
      if (workspace.sessionIds.includes(sessionId)) {
        return { id: workspace.id, title: workspace.title, path: workspace.path }
      }
    } catch {
      // a single broken entity must not abort the scan
    }
  }
  return undefined
}

/* -------------------------------------------------------------- services */

function optionalService(ctx, name) {
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    // fall through to the direct property
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

async function sessionReminders(ctx, sessionId) {
  const schedule = optionalService(ctx, 'schedule')
  if (!schedule || typeof schedule.list !== 'function') return []
  try {
    const rows = await schedule.list({ sessionId })
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

async function removeReminders(ctx, sessionId) {
  const schedule = optionalService(ctx, 'schedule')
  const removed = []
  if (!schedule || typeof schedule.delete !== 'function') return removed
  for (const row of await sessionReminders(ctx, sessionId)) {
    try {
      await schedule.delete({ sessionId, id: row.id })
      removed.push(row.id)
    } catch {
      // a reminder that is already gone is not an error
    }
  }
  return removed
}

/* ------------------------------------------------------------ session rows */

function summaryOf(ctx, id) {
  const liveSession = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(id) : undefined
  const liveAgent = typeof ctx.agents?.get === 'function' ? ctx.agents.get(id) : undefined
  const status = liveAgent && typeof liveAgent.status === 'string' ? liveAgent.status : undefined
  return { live: Boolean(liveSession) || Boolean(liveAgent), liveAgent, status }
}

function currentSessionId(ctx) {
  try {
    return ctx.agents?.currentInitiator?.()?.id
  } catch {
    return undefined
  }
}

async function buildRow(ctx, snapshot) {
  const id = snapshot.header.id
  const cache = await readProjectionCache(ctx, id)
  const directories = await findSessionDirectories(id)
  let logBytes = 0
  let logFiles = 0
  for (const dir of directories) {
    const size = await directorySize(dir)
    logBytes += size.bytes
    logFiles += size.files
  }
  const updatedAtMs = await newestMtime([...directories, cache.file])
  const workspace = await workspaceOf(ctx, id)
  const summary = summaryOf(ctx, id)
  return {
    sessionId: id,
    title: projectionTitle(cache.record),
    blank: projectionBlank(cache.record),
    agentPreset: projectionPreset(cache.record),
    cwd: snapshot.header.cwd,
    origin: snapshot.header.origin,
    parentSessionId: snapshot.header.parentSession,
    createdAt: snapshot.header.createdAt,
    updatedAt: updatedAtMs > 0 ? Math.round(updatedAtMs) : snapshot.header.createdAt,
    live: summary.live,
    status: summary.status,
    formatStatus: snapshot.formatStatus,
    sizeBytes: typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : logBytes,
    logBytes,
    cacheBytes: cache.bytes,
    logFiles,
    logDirectories: directories,
    projectionCacheFile: cache.file,
    hasProjectionCache: cache.bytes > 0,
    workspace: workspace ?? null,
  }
}

/* --------------------------------------------------------- written files */

function readFileArgument(args) {
  const candidates = ['file_path', 'filePath', 'path', 'target_file']
  for (const key of candidates) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Files this Session's durable tool calls wrote, restricted to its own working directory. */
async function writtenFilesOf(ctx, sessionId, cwd) {
  if (!cwd) return []
  let events
  try {
    const log = await ctx.sessionQuery.readSession(sessionId)
    events = log.events
  } catch {
    return []
  }
  const files = new Map()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = event.data
    if (!data || !WRITE_TOOLS.has(data.name)) continue
    let args
    try {
      args = JSON.parse(data.arguments)
    } catch {
      continue
    }
    if (!args || typeof args !== 'object') continue
    const raw = readFileArgument(args)
    if (!raw) continue
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
    const relative = path.relative(cwd, resolved)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue
    const entry = files.get(resolved)
    if (entry) entry.tools.add(data.name)
    else files.set(resolved, { tools: new Set([data.name]) })
  }
  const result = []
  for (const [file, entry] of files) {
    const bytes = await fileSize(file)
    if (bytes === 0) continue
    result.push({ path: file, bytes, tools: [...entry.tools] })
  }
  result.sort((left, right) => left.path.localeCompare(right.path))
  return result
}

/* --------------------------------------------------------------- preview */

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Tool results and Remote results must be lossless JSON: drop `undefined` members. */
function jsonSafe(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/* ------------------------------------------------------------------ audit */

const AUDIT_LIMIT_BYTES = 512 * 1024

/**
 * Append one line to `<DSH_HOME>/session-admin/audit.jsonl`. Every Remote and
 * tool call lands here with its outcome, so a failing UI action can be told
 * apart from one that never reached the Host. Best-effort: never throws.
 */
async function appendAudit(ctx, entry) {
  try {
    const dir = path.join(roots().home, 'session-admin')
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'audit.jsonl')
    try {
      const stat = await fsp.stat(file)
      if (stat.size > AUDIT_LIMIT_BYTES) await fsp.rename(file, `${file}.1`).catch(() => {})
    } catch {
      // first write
    }
    await fsp.appendFile(file, `${JSON.stringify(entry)}\n`)
  } catch (error) {
    try {
      ctx.logger?.warn?.(`session-admin: audit write failed: ${messageOf(error)}`)
    } catch {
      // logging must never break a call
    }
  }
}

async function audited(ctx, method, detail, run) {
  const startedAt = Date.now()
  try {
    const value = await run()
    await appendAudit(ctx, {
      time: new Date().toISOString(),
      method,
      ...detail,
      ok: true,
      ms: Date.now() - startedAt,
    })
    return value
  } catch (error) {
    await appendAudit(ctx, {
      time: new Date().toISOString(),
      method,
      ...detail,
      ok: false,
      code: error && error.code,
      message: messageOf(error),
      ms: Date.now() - startedAt,
    })
    throw error
  }
}

async function buildPreview(ctx, sessionId) {
  const snapshots = await listSnapshots(ctx)
  const snapshot = snapshots.find((candidate) => candidate.header.id === sessionId)
  const directories = await findSessionDirectories(sessionId)
  if (!snapshot && directories.length === 0) {
    throw refusal('session-admin/not-found', `Session "${sessionId}" does not exist`, { sessionId })
  }
  const cache = await readProjectionCache(ctx, sessionId)
  const baseRows = snapshot
    ? [await buildRow(ctx, snapshot)]
    : [
        {
          sessionId,
          title: projectionTitle(cache.record),
          blank: projectionBlank(cache.record),
          agentPreset: projectionPreset(cache.record),
          cwd: undefined,
          origin: undefined,
          parentSessionId: undefined,
          createdAt: 0,
          updatedAt: 0,
          live: summaryOf(ctx, sessionId).live,
          status: summaryOf(ctx, sessionId).status,
          sizeBytes: 0,
          logBytes: 0,
          cacheBytes: cache.bytes,
          logFiles: 0,
          logDirectories: directories,
          projectionCacheFile: cache.file,
          hasProjectionCache: cache.bytes > 0,
          workspace: (await workspaceOf(ctx, sessionId)) ?? null,
        },
      ]
  const row = baseRows[0]

  const closure = snapshot ? descendantClosure(snapshots, sessionId) : [sessionId]
  const siblings = []
  for (const id of closure.slice(1)) {
    const childSnapshot = snapshots.find((candidate) => candidate.header.id === id)
    if (!childSnapshot) continue
    siblings.push(await buildRow(ctx, childSnapshot))
  }

  const writtenFiles = await writtenFilesOf(ctx, sessionId, row.cwd)

  const artifacts = []
  for (const dir of row.logDirectories) {
    const size = await directorySize(dir)
    artifacts.push({ kind: 'session-log', path: dir, bytes: size.bytes, files: size.files, removable: true })
  }
  if (cache.bytes > 0) {
    artifacts.push({ kind: 'projection-cache', path: cache.file, bytes: cache.bytes, files: 1, removable: true })
  }

  const blockers = []
  const liveSessions = []
  const current = currentSessionId(ctx)
  if (current && closure.includes(current)) {
    blockers.push('这是正在向你提问的会话，会话不能删除自己。请切换到其他会话后再删除它。')
  }
  for (const id of closure) {
    const summary = summaryOf(ctx, id)
    if (!summary.live) continue
    liveSessions.push({ sessionId: id, status: summary.status ?? 'unknown' })
    if (summary.status !== 'idle') {
      blockers.push(`会话 "${id}" 仍在运行（状态：${summary.status ?? 'unknown'}），请等它跑完再删除。`)
    }
  }
  const needsLiveConfirmation = liveSessions.length > 0 && blockers.length === 0

  const totalBytes =
    artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) +
    siblings.reduce((sum, child) => sum + child.sizeBytes, 0) +
    writtenFiles.reduce((sum, file) => sum + file.bytes, 0)

  return {
    session: row,
    children: siblings.map((child) => ({
      sessionId: child.sessionId,
      title: child.title,
      origin: child.origin,
      live: child.live,
      sizeBytes: child.sizeBytes,
      logDirectories: child.logDirectories,
      hasProjectionCache: child.hasProjectionCache,
      projectionCacheFile: child.projectionCacheFile,
    })),
    artifacts,
    writtenFiles,
    reminders: (await sessionReminders(ctx, sessionId)).map((row) => ({
      id: row.id,
      type: row.type ?? row.kind ?? row.cadence ?? null,
    })),
    totalBytes,
    blockers,
    liveSessions,
    needsLiveConfirmation,
    storageRoots: roots(),
  }
}

/* ---------------------------------------------------------------- delete */

async function removeDirectory(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true })
    return null
  } catch (error) {
    return messageOf(error)
  }
}

async function detachFromWorkspaces(ctx, sessionId) {
  const detached = []
  let workspaces = []
  try {
    workspaces = ctx.workspaceRegistry.list()
  } catch {
    return detached
  }
  for (const workspace of workspaces) {
    let member = false
    try {
      member = workspace.sessionIds.includes(sessionId)
    } catch {
      member = false
    }
    if (!member) continue
    await workspace.detachSession(sessionId)
    detached.push(workspace.id)
  }
  return detached
}

async function deleteSession(ctx, request) {
  const parsed = parseDeleteRequest(request)
  const sessionId = parsed.sessionId
  const deleteWorkspaceFiles = parsed.deleteWorkspaceFiles
  const allowLive = parsed.allowLive
  const preview = await buildPreview(ctx, sessionId)
  if (preview.blockers.length > 0) {
    throw refusal('session-admin/blocked', preview.blockers.join(' '), {
      sessionId,
      blockers: preview.blockers,
    })
  }

  const snapshots = await listSnapshots(ctx)
  const closure = descendantClosure(snapshots, sessionId)
  const liveIdle = []
  for (const id of closure) {
    const summary = summaryOf(ctx, id)
    if (!summary.live) continue
    if (summary.status !== 'idle') {
      throw refusal('session-admin/live', `会话 "${id}" 仍在运行（状态：${summary.status ?? 'unknown'}），请等它跑完再删除。`, {
        sessionId: id,
        status: summary.status ?? 'unknown',
      })
    }
    // A loaded-but-idle session is deletable: the UI warns and asks for a second
    // confirmation; `allowLive` only records that acknowledgement.
    liveIdle.push(id)
  }

  const warnings = []
  const removedSessions = []
  const artifacts = []
  const workspaceDetached = []
  const remindersDeleted = []
  let bytesFreed = 0

  for (const id of closure) {
    // 1. Quiesce session-owned reminders first: a wake after the log is gone
    //    would fail against a missing session.
    for (const reminderId of await removeReminders(ctx, id)) remindersDeleted.push(reminderId)

    // 2. Drop the derived projection-cache row through its storage domain.
    const cache = await readProjectionCache(ctx, id)
    if (cache.bytes > 0 || cache.source === 'domain') {
      const removal = await removeProjectionCache(ctx, id)
      artifacts.push({
        kind: 'projection-cache',
        path: removal.file,
        bytes: removal.bytes,
        removed: removal.removed,
        error: removal.error,
      })
      if (removal.removed) bytesFreed += removal.bytes
      else if (removal.error) warnings.push(`could not remove ${removal.file}: ${removal.error}`)
    }

    // 3. Remove the durable session log directory (the actual hard delete).
    const directories = await findSessionDirectories(id)
    for (const dir of directories) {
      const size = await directorySize(dir)
      const failure = await removeDirectory(dir)
      if (failure) {
        artifacts.push({ kind: 'session-log', path: dir, bytes: size.bytes, removed: false, error: failure })
        warnings.push(`could not remove ${dir}: ${failure}`)
      } else {
        artifacts.push({ kind: 'session-log', path: dir, bytes: size.bytes, removed: true })
        bytesFreed += size.bytes
      }
    }

    // 4. Forget the id in the durable workspace registry.
    workspaceDetached.push(...(await detachFromWorkspaces(ctx, id)))
    try {
      await ctx.workspaceRegistry.unpinSession(id)
    } catch (error) {
      warnings.push(`unpin ${id}: ${messageOf(error)}`)
    }
    try {
      await ctx.workspaceRegistry.unarchiveSession(id)
    } catch (error) {
      warnings.push(`unarchive ${id}: ${messageOf(error)}`)
    }

    removedSessions.push({
      sessionId: id,
      title: projectionTitle(cache.record),
      origin: snapshots.find((candidate) => candidate.header.id === id)?.header.origin,
    })
  }

  const filesDeleted = []
  const filesFailed = []
  if (deleteWorkspaceFiles) {
    const files = await writtenFilesOf(ctx, sessionId, preview.session.cwd)
    for (const file of files) {
      try {
        await fsp.rm(file.path, { force: true })
        filesDeleted.push({ path: file.path, bytes: file.bytes })
        bytesFreed += file.bytes
      } catch (error) {
        filesFailed.push({ path: file.path, error: messageOf(error) })
        warnings.push(`could not remove ${file.path}: ${messageOf(error)}`)
      }
    }
  }

  // Drop the row from every connected Client's Session catalog.
  for (const id of closure) {
    try {
      ctx.emit('api-session/removed', id)
    } catch (error) {
      warnings.push(`event ${id}: ${messageOf(error)}`)
    }
  }

  return {
    sessionId,
    deletedSessions: removedSessions,
    liveSessions: liveIdle,
    acknowledgedLive: allowLive === true,
    artifacts,
    workspaceDetached: [...new Set(workspaceDetached)],
    remindersDeleted,
    filesDeleted,
    filesFailed,
    bytesFreed,
    warnings,
  }
}

/* ---------------------------------------------------------------- service */

/**
 * The Host-side namespace implementation. It is registered with `ctx.provide`
 * so the Gateway resolves it as the Cordis Service named by every descriptor:
 * a linked profile bundle cannot import the Harness protocol package, and a
 * plain provided service is what the Gateway looks up by name.
 */
function createService(ctx) {
  const service = {
    async list() {
      return audited(ctx, 'list', {}, async () => {
        const snapshots = await listSnapshots(ctx)
        const rows = []
        for (const snapshot of snapshots) {
          rows.push(await buildRow(ctx, snapshot))
        }
        rows.sort((left, right) => right.updatedAt - left.updatedAt)
        return jsonSafe({ sessions: rows, storageRoots: roots() })
      })
    },
    async preview(sessionId) {
      return audited(ctx, 'preview', { sessionId }, async () => jsonSafe(await buildPreview(ctx, sessionId)))
    },
    async delete(request) {
      const sessionId = request && request.sessionId
      return audited(ctx, 'delete', { sessionId, allowLive: Boolean(request && request.allowLive) }, async () =>
        jsonSafe(await deleteSession(ctx, request)),
      )
    },
  }
  service.ctx = ctx
  // The Gateway refuses a receiver without a visible `typertRemote` binding
  // (gateway/binding-invalid); mirror what `TypertRemoteService` installs.
  service.typertRemote = Object.freeze({ service, serviceKey: NS, namespace: NS })
  return service
}

/* ------------------------------------------------------------------ tool */

const TOOL_DESCRIPTION = [
  'List, inspect, or PERMANENTLY delete Harness sessions.',
  '',
  'Actions:',
  '- list: every stored session with its size, workspace, liveness, and running status.',
  '- preview: what deleting one session would remove (its log, projection cache, child subagent sessions, reminders, and files it wrote inside its working directory). A running session is refused; a loaded-but-idle session is deletable after allowLive.',
  '- delete: permanently deletes the session and its stored files. Requires confirm: true. It cannot be undone. A session with running work is refused; a loaded-but-idle session additionally requires allowLive: true.',
].join('\n')

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'preview', 'delete'], description: 'Operation to perform.' },
    sessionId: { type: 'string', description: 'Target session id (required for preview and delete).' },
    deleteWorkspaceFiles: {
      type: 'boolean',
      description: 'For delete: also delete files this session wrote inside its working directory. Defaults to false.',
    },
    confirm: { type: 'boolean', description: 'For delete: must be true to confirm the irreversible deletion.' },
    allowLive: {
      type: 'boolean',
      description:
        'For delete: allow deleting a session that is loaded in the running application but has no running work. Without it such sessions are refused.',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

function toolContent(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/* ----------------------------------------------------------------- apply */

export const name = 'session-admin'
export const inject = ['sessionPersistence', 'workspaceRegistry', 'sessions', 'agents', 'sessionQuery', 'tools', 'typert']

export function apply(ctx) {
  const service = createService(ctx)
  ctx.effect(() => ctx.provide(NS, service), 'session-admin: service')

  ctx.effect(() =>
    ctx.typert.register({
      package: PACKAGE,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: remoteContribution.descriptors,
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({      name: 'session_admin',
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return toolContent(value)
        },
      },
      async execute(args) {
        const action = args && args.action
        if (action === 'list') return await service.list()
        if (action === 'preview') {
          if (typeof args.sessionId !== 'string') throw new Error('sessionId is required for preview')
          return await service.preview(args.sessionId)
        }
        if (action === 'delete') {
          if (typeof args.sessionId !== 'string') throw new Error('sessionId is required for delete')
          if (args.confirm !== true) throw new Error('Refusing to delete without confirm: true')
          // Stricter than the UI: an agent must acknowledge a loaded-but-idle session.
          const livePreview = await service.preview(args.sessionId)
          if (livePreview.needsLiveConfirmation && args.allowLive !== true) {
            throw new Error('该会话仍被应用加载（当前空闲）。确认要删除请显式传 allowLive: true。')
          }
          return await service.delete({
            sessionId: args.sessionId,
            deleteWorkspaceFiles: args.deleteWorkspaceFiles === true,
            allowLive: args.allowLive === true,
          })
        }
        throw new Error(`Unknown action "${String(action)}"; expected list, preview, or delete`)
      },
    }),
  )
}
