/**
 * Radar — Desktop half.
 *
 * One floating pane (`placement: 'floating'`) that shows every Hermes session
 * across every profile and can stop a hung turn.
 *
 * Two things this file deliberately does NOT do:
 *
 * 1. It never gates its refresh on `host.paneVisibility('radar')`. A floating
 *    pane is not in the layout tree, so that predicate is always `false` there.
 *    Instead the pane is registered WITHOUT `lifecycleKeepAlive`: collapsing it
 *    unmounts the body, and the component's 2 s interval dies with it. Mounted
 *    means refreshing.
 * 2. It draws no title-bar, drag handle or collapse chevron: the app's floating
 *    chrome owns those. This file only renders the pane body.
 *
 * Data comes from the plugin's own backend (`ctx.rest('/live')`), pushed hints
 * arrive on `plugin.radar.changed`, and a stop is a gateway RPC
 * (`session.interrupt`), which is why the manifest no longer calls the plugin
 * "read-only".
 */

import { host, blobatarSvg } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'radar'
const PLUGIN_NAME = 'Radar'
const VERSION = '0.7.1'

const SIDEBAR_NAV_AREA = 'sidebar.nav'
const ROUTES_AREA = 'routes'
const PALETTE_AREA = 'palette'
const RADAR_ROUTE = '/radar'

const LIVE_PATH = '/live?profiles=all&window=180'
const REFRESH_MS = 2000
const EVENT_DEBOUNCE_MS = 500
const CONFIRM_MS = 4000
const INTERRUPTED_MS = 3000
const RPC_TIMEOUT_MS = 8000

const ORANGE = '#FF4D00'
const AMBER_HUE = '#d29922'
const GREEN_HUE = '#3fb950'

// Every ink derives from the theme tokens the Desktop publishes, so a light
// skin darkens the same markup a dark skin lightens. Nothing here is a fixed
// hex that would vanish on white: avatars, dots and the tool accent all mix
// `--dt-foreground` (or `--dt-muted-foreground`) with the hue.
const FG = 'var(--foreground, var(--dt-foreground))'
const CARD = 'var(--card, var(--dt-card))'
const BORDER = 'var(--border, var(--dt-border))'
const MUTED = 'var(--muted-foreground, var(--dt-muted-foreground))'
// Status marks are graphics, not body text: 3:1 is the floor, so they lean on
// the foreground instead of the dimmer tertiary ink.
const DOT = 'color-mix(in srgb, ' + FG + ' 68%, ' + MUTED + ')'
const DESTRUCTIVE = 'var(--dt-destructive, var(--destructive, #f85149))'
const ACCENT_INK = 'var(--dt-primary-solid-foreground, #1a0700)'
const WARN = 'color-mix(in srgb, ' + FG + ' 55%, ' + DESTRUCTIVE + ')'
const VIOLET = 'color-mix(in srgb, ' + FG + ' 62%, var(--dt-primary, ' + FG + '))'
const AMBER = 'color-mix(in srgb, ' + FG + ' 50%, ' + AMBER_HUE + ')'
const GREEN = 'color-mix(in srgb, ' + FG + ' 45%, ' + GREEN_HUE + ')'
const SANS = 'var(--dt-font-sans, system-ui, -apple-system, "Segoe UI", sans-serif)'
const MONO = 'var(--dt-font-mono, ui-monospace, "Cascadia Code", "DejaVu Sans Mono", monospace)'

// ---------------------------------------------------------------------------
// Settings (persisted through the host's plugin storage)
// ---------------------------------------------------------------------------

// The host namespaces these under `hermes.plugin.radar.`, so the literal keys
// stay `radar.*` on both the real SDK and the fallback.
const SETTING_KEYS = {
  filter: 'radar.filter',
  profiles: 'radar.profiles',
  window: 'radar.window',
  finished: 'radar.finished',
  density: 'radar.density',
  size: 'radar.size'
}

const DEFAULT_SETTINGS = {
  filter: 'all',
  profiles: 'all',
  window: 180,
  finished: true,
  density: 'comfortable'
}

const WINDOW_CHOICES = [60, 180, 600]

// Floating pane sizes. There is no free resize in the Desktop, but the pane
// registry replaces a contribution by id, so registering `radar` again with
// another `width`/`height` resizes it without remounting the body (the floating
// key is `source:id`, which does not change).
const PANE_SIZES = {
  s: { width: '320px', height: '214px' },
  m: { width: '420px', height: '300px' },
  l: { width: '520px', height: '380px' },
  xl: { width: '620px', height: '460px' }
}
const SIZE_ORDER = ['s', 'm', 'l', 'xl']
// The registration id inside this plugin; the host scopes it to `radar:panel`
// as the tree/contribution id (`${PLUGIN_ID}:${PANEL_PANE_ID}`).
const PANEL_PANE_ID = 'radar:panel'
const PANEL_PANE_TARGET = PLUGIN_ID + ':' + PANEL_PANE_ID
let floatingPaneDispose = null
const MEMORY_SETTINGS = new Map()
const MEMORY_STORAGE = {
  get: (key, fallback) => (MEMORY_SETTINGS.has(key) ? MEMORY_SETTINGS.get(key) : fallback),
  set: (key, value) => {
    MEMORY_SETTINGS.set(key, value)
  },
  remove: key => {
    MEMORY_SETTINGS.delete(key)
  }
}

/**
 * The verified SDK surface is `ctx.storage` (`get/set/remove`). `host.storage`
 * never existed, but an older host may still expose one, so both are probed
 * before the in-memory fallback keeps the panel usable.
 */
function storageFor(ctx) {
  if (ctx && ctx.storage && typeof ctx.storage.get === 'function') return ctx.storage
  if (typeof host !== 'undefined' && host && host.storage && typeof host.storage.get === 'function') {
    return host.storage
  }
  return MEMORY_STORAGE
}

async function readSetting(ctx, key, fallback) {
  try {
    const value = await storageFor(ctx).get(key, fallback)
    return value === undefined || value === null ? fallback : value
  } catch (_error) {
    return fallback
  }
}

async function writeSetting(ctx, key, value) {
  try {
    await storageFor(ctx).set(key, value)
  } catch (_error) {
    // Storage is a convenience: a host that refuses it must not break the panel.
  }
  return value
}

/** Normalise any stored value to one of the four known size keys. */
function paneSize(value) {
  const key = String(value === undefined || value === null ? '' : value).toLowerCase()
  return PANE_SIZES[key] ? key : 's'
}

/**
 * Read the remembered size synchronously so the very first registration can
 * use it. The real `ctx.storage.get` is synchronous; a host that answers with a
 * promise leaves us at `s` for this registration and the async settings path
 * would pick it up on a later mount.
 */
function storedSize(ctx) {
  try {
    const value = storageFor(ctx).get(SETTING_KEYS.size, 's')
    return typeof value === 'string' ? paneSize(value) : 's'
  } catch (_error) {
    return 's'
  }
}

let currentCtx = null
let activeFullViews = 0
let paneRegistered = false

function hideRadarFloatingPane() {
  if (typeof floatingPaneDispose === 'function') {
    try {
      floatingPaneDispose()
    } catch (_error) {
      // Host may have already torn down the contribution
    }
    floatingPaneDispose = null
  }
  paneRegistered = false
}

function showRadarFloatingPane(ctx) {
  if (paneRegistered) return
  const targetCtx = ctx || currentCtx
  if (!targetCtx) return
  paneRegistered = true
  registerRadarPane(targetCtx, storedSize(targetCtx))
}

function enterFullView(ctx) {
  if (ctx) currentCtx = ctx
  activeFullViews += 1
  if (activeFullViews === 1) {
    hideRadarFloatingPane()
  }
}

function exitFullView(ctx) {
  if (ctx) currentCtx = ctx
  activeFullViews = Math.max(0, activeFullViews - 1)
  if (activeFullViews === 0) {
    showRadarFloatingPane(ctx || currentCtx)
  }
}

/**
 * Register (or re-register) the floating quick view at one of the four sizes.
 * Re-registration by id is the only resize the Desktop offers: the previous
 * contribution is disposed and the same id is registered again, which keeps the
 * component mounted under its stable `source:id` key.
 */
function registerRadarPane(ctx, sizeKey) {
  if (ctx) currentCtx = ctx
  const key = paneSize(sizeKey)
  const size = PANE_SIZES[key]

  if (activeFullViews > 0) {
    paneRegistered = false
    return size
  }

  if (typeof floatingPaneDispose === 'function') {
    try {
      floatingPaneDispose()
    } catch (_error) {
      // A host that already dropped the entry must not block the new size.
    }
  }

  floatingPaneDispose = ctx.register({
    id: 'radar',
    area: 'panes',
    title: 'Radar',
    data: {
      placement: 'floating',
      anchor: 'bottom-right',
      width: size.width,
      height: size.height
    },
    render: () => jsx(RadarPane, { ctx })
  })
  paneRegistered = true

  return size
}

/** Bring the full side panel to the front, when the host exposes revealPane. */
function expandRadarPanel() {
  if (typeof host.revealPane === 'function') host.revealPane(PANEL_PANE_TARGET)
}

/** Navigate to the full-page `/radar` route registered in the left sidebar. */
function openRadarPage() {
  if (typeof host.navigate === 'function') host.navigate(RADAR_ROUTE)
}

function livePathFor(settings) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const profiles = source.profiles === 'current' ? 'current' : 'all'
  const window = WINDOW_CHOICES.includes(Number(source.window)) ? Number(source.window) : 180
  return '/live?profiles=' + profiles + '&window=' + window
}

const PANEL_GROUPS = [
  { key: 'working', label: 'Trabajando', states: ['running', 'queued'] },
  { key: 'waiting', label: 'Esperando', states: ['idle'] },
  { key: 'stalled', label: 'Colgadas', states: ['stalled'] },
  { key: 'finished', label: 'Terminadas', states: ['done', 'failed'] }
]

const PANEL_FILTERS = [
  { key: 'all', label: 'Todas' },
  { key: 'working', label: 'Trabajando' },
  { key: 'waiting', label: 'Esperan' },
  { key: 'problem', label: 'Problema' }
]

/** Group rows for the side panel; terminal rows obey the `finished` setting. */
function panelGroups(sessions, settings) {
  const list = Array.isArray(sessions) ? sessions : []
  const source = settings && typeof settings === 'object' ? settings : {}
  const showFinished = source.finished !== false
  // Every configured group keeps its header and count, even at zero: the panel
  // is a map of the whole session state, not only the non-empty slice.
  return PANEL_GROUPS.filter(def => showFinished || def.key !== 'finished').map(def => ({
    key: def.key,
    label: def.label,
    states: def.states,
    items: list.filter(session => def.states.includes(session.state))
  }))
}

function sessionsForFilter(sessions, filter) {
  const list = Array.isArray(sessions) ? sessions : []
  if (filter === 'working') {
    return list.filter(session => session.state === 'running' || session.state === 'queued')
  }
  if (filter === 'waiting') return list.filter(session => session.state === 'idle')
  if (filter === 'problem') {
    return list.filter(session => session.state === 'stalled' || session.state === 'failed')
  }
  return list
}

/** Copy the session id through the Desktop clipboard, with guarded fallbacks. */
async function copySessionId(ctx, session) {
  const text = String((session && session.id) || '')
  if (!text) return false

  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (_error) {
      // A webview may expose the API and still deny permission: fall through.
    }
  }
  if (ctx && ctx.os && typeof ctx.os.writeClipboard === 'function') {
    try {
      await ctx.os.writeClipboard(text)
      return true
    } catch (_error) {
      // Try the host-level fallback below.
    }
  }
  if (typeof host !== 'undefined' && host && host.os && typeof host.os.writeClipboard === 'function') {
    try {
      await host.os.writeClipboard(text)
      return true
    } catch (_error) {
      return false
    }
  }
  return false
}

/**
 * Panel order, mirroring the backend's `_STATE_ORDER`. Terminal rows are listed
 * (dimmed, never stoppable) so the panel shows what just finished, not only what
 * is still moving. `dormant` stays out: it is history, not a live warning.
 */
const STATE_ORDER = { running: 0, stalled: 1, queued: 2, idle: 3, done: 4, failed: 5 }
const LISTED_STATES = ['running', 'stalled', 'queued', 'idle', 'done', 'failed']
const TERMINAL_STATES = ['done', 'failed']

const ANIMATION_CSS =
  '@keyframes sp-blink{0%,60%,100%{opacity:.25}30%{opacity:1}}' +
  '.sp-dot{display:inline-block;animation:sp-blink 1.4s infinite}' +
  // The stop control stays mounted (so Tab reaches it and the row never
  // reflows) and simply fades in on hover or when anything inside the row has
  // focus. `visibility` is deliberately not used: it would drop the button out
  // of the tab order.
  '.sp-row:hover .sp-stop,.sp-row:focus-within .sp-stop,.sp-stop:focus-visible{opacity:1;pointer-events:auto}' +
  '.sp-stop{opacity:0;pointer-events:none;transition:opacity .12s ease}' +
  // The full panel has room for the actions: keep stop/copy always visible
  // there, while the narrow floating card reveals stop only on hover/focus.
  '.sp-panel-row .sp-stop{opacity:1;pointer-events:auto}' +
  '.sp-stop:focus-visible{outline:2px solid ' + ORANGE + ';outline-offset:1px}' +
  '.sp-open{appearance:none;background:transparent;border:0;padding:0;margin:0;' +
  'color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0;' +
  'display:flex;align-items:center;gap:9px;flex:1}' +
  '.sp-open:focus-visible{outline:2px solid ' + ORANGE + ';outline-offset:-2px;border-radius:6px}' +
  '.sp-size:not(.sp-size-on):hover,.sp-expand:hover,.sp-pip:not(.sp-pip-on):hover,.sp-page:hover{border-color:' + MUTED + '!important}' +
  '.sp-size:focus-visible,.sp-expand:focus-visible,.sp-pip:focus-visible,.sp-page:focus-visible{outline:2px solid ' + ORANGE + ';outline-offset:1px}'

const AVATARS = [
  {
    borderRadius: '50%',
    background: 'color-mix(in srgb, ' + FG + ' 10%, transparent)',
    color: FG,
    inner: undefined
  },
  {
    borderRadius: '6px',
    background: 'color-mix(in srgb, ' + FG + ' 16%, transparent)',
    color: FG,
    inner: undefined
  },
  {
    borderRadius: '3px',
    background: 'color-mix(in srgb, ' + FG + ' 22%, transparent)',
    color: FG,
    transform: 'rotate(45deg)',
    inner: 'rotate(-45deg)'
  },
  {
    borderRadius: '0',
    clipPath: 'polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0% 50%)',
    background: 'color-mix(in srgb, ' + FG + ' 13%, transparent)',
    color: FG,
    inner: undefined
  }
]

/** Stable shape + tint per profile: the same profile always looks the same. */
function avatarFor(profile) {
  const text = String(profile || 'default').trim() || 'default'
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return { variant: AVATARS[hash % AVATARS.length], label: text.charAt(0).toUpperCase() }
}

/** Silhouettes the panel can paint when a profile has no raster avatar. */
const SHAPE_ORDER = ['circle', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop', 'blob']
const SHAPE_STYLES = {
  circle: { borderRadius: '50%' },
  squircle: { borderRadius: '8px' },
  pill: { borderRadius: '13px' },
  triangle: { clipPath: 'polygon(50% 2%, 98% 96%, 2% 96%)' },
  hexagon: { clipPath: 'polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0% 50%)' },
  cloud: { borderRadius: '52% 48% 44% 56% / 58% 62% 38% 42%' },
  drop: { borderRadius: '50% 50% 50% 50% / 62% 62% 38% 38%' },
  blob: { borderRadius: '46% 54% 52% 48% / 55% 46% 54% 45%' }
}
// Blobatar pins one of ten silhouettes; the six without a direct analogue map
// to the closest CSS shape instead of silently falling back to a circle.
const BLOB_KIND_SHAPE = {
  round: 'circle',
  organic: 'blob',
  boxy: 'squircle',
  capsule: 'pill',
  nub: 'drop',
  cloud: 'cloud',
  droplet: 'drop',
  hexagon: 'hexagon',
  sun: 'circle',
  triangle: 'triangle'
}
const AVATAR_DATA_PREFIX = 'data:image/png;base64,'

function nameHash(text) {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0
  }
  return hash
}

function shapeOf(shape, key) {
  const text = String(key || 'default')
  const fallback = SHAPE_ORDER[nameHash(text) % SHAPE_ORDER.length]
  const raw = String(shape || '').trim().toLowerCase()
  if (raw.indexOf('blobatar') === 0) {
    const kind = raw.split(':')[2] || ''
    return BLOB_KIND_SHAPE[kind] || fallback
  }
  return SHAPE_ORDER.includes(raw) ? raw : fallback
}

// One module-level cache per panel: a profile's avatar is requested once, no
// matter how many rows share it or how often the 2 s poll re-renders the list.
const AVATAR_CACHE = new Map()
const AVATAR_INFLIGHT = new Map()
const AVATAR_IMAGES = new Map()
const AVATAR_FAILED_AT = new Map()
const FAILED_RETRY_MS = 10000

function cachedAvatar(profile) {
  const key = String(profile || 'default').trim() || 'default'
  if (AVATAR_CACHE.has(key)) {
    const val = AVATAR_CACHE.get(key)
    if (val !== null) return val
    const failedAt = AVATAR_FAILED_AT.get(key) || 0
    if (Date.now() - failedAt < FAILED_RETRY_MS) return null
    AVATAR_CACHE.delete(key)
    AVATAR_FAILED_AT.delete(key)
    return undefined
  }
  return undefined
}

function rememberAvatarImage(key, url) {
  if (!url || AVATAR_IMAGES.has(key)) return
  if (typeof Image === 'function') {
    try {
      const img = new Image()
      img.src = url
      AVATAR_IMAGES.set(key, img)
    } catch (_error) {
      // Headless test harnesses without Image still cache the data URL.
    }
  }
}

function loadAvatar(ctx, profile) {
  const key = String(profile || 'default').trim() || 'default'
  const cached = cachedAvatar(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const inflight = AVATAR_INFLIGHT.get(key)
  if (inflight) return inflight

  const request = Promise.resolve()
    .then(() =>
      ctx && typeof ctx.rest === 'function' ? ctx.rest('/avatar/' + encodeURIComponent(key)) : null
    )
    .then(payload => {
      const url =
        payload && typeof payload.data_url === 'string' && payload.data_url.indexOf(AVATAR_DATA_PREFIX) === 0
          ? payload.data_url
          : null
      AVATAR_CACHE.set(key, url)
      if (url) {
        AVATAR_FAILED_AT.delete(key)
        rememberAvatarImage(key, url)
      } else {
        AVATAR_FAILED_AT.set(key, Date.now())
      }
      return url
    })
    .catch(() => {
      // A missing avatar is a fallback, not an error: retry after cooldown.
      AVATAR_CACHE.set(key, null)
      AVATAR_FAILED_AT.set(key, Date.now())
      return null
    })
    .finally(() => {
      AVATAR_INFLIGHT.delete(key)
    })

  AVATAR_INFLIGHT.set(key, request)
  return request
}

function messageOf(error) {
  if (!error) return 'error'
  if (typeof error === 'string') return error
  const data = error.data && typeof error.data === 'object' ? error.data.reason || error.data.message : ''
  return String(error.message || data || error)
}

function normalizeGeneration(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function activeProfile() {
  try {
    const atom = host.state && host.state.profile
    if (atom && typeof atom.get === 'function') return String(atom.get() || '').trim()
  } catch (_error) {
    // A host without `host.state.profile` simply routes through host.request.
  }
  return ''
}

/**
 * Gateway RPC for one session. The panel spans profiles, so a session owned by
 * another profile is routed through that profile's route descriptor instead of
 * the active socket; without a route we refuse rather than interrupt a
 * same-named session on the wrong backend.
 */
async function sessionRpc(session, method, params) {
  const profile = String(session.profile || '').trim()
  const active = activeProfile()
  if (profile && active && profile !== active) {
    if (typeof host.profileRoutes !== 'function' || typeof host.requestProfile !== 'function') {
      throw new Error('este Desktop no puede enrutar RPC a otro perfil')
    }
    let routes = []
    try {
      routes = await host.profileRoutes()
    } catch (error) {
      throw new Error('sin ruta al perfil ' + profile + ': ' + messageOf(error))
    }
    const route = (Array.isArray(routes) ? routes : []).find(
      item => String((item && (item.targetProfile || item.profile)) || '').trim() === profile
    )
    if (!route) throw new Error('sin ruta al perfil ' + profile)
    return host.requestProfile(route, method, params, RPC_TIMEOUT_MS, { spawnPriority: 'foreground' })
  }
  return host.request(method, params)
}

/**
 * Stop a turn with a client-side fence.
 *
 * `session.interrupt` does NOT read `execution_generation`: it always cancels
 * whatever turn the session is running. So the panel re-reads `/live` right
 * before sending and aborts when the row disappeared, is no longer
 * running/stalled, or advanced to a different generation. There is no
 * `stale_generation` retry to wait for, because the handler never returns it.
 */
async function interruptSession(ctx, session, livePath = LIVE_PATH) {
  let fresh
  try {
    // The panel re-reads with its CURRENT profiles/window query; the floating
    // quick view keeps the all/180 default it has always used.
    fresh = await ctx.rest(livePath)
  } catch (error) {
    throw new Error('no se pudo confirmar el turno: ' + messageOf(error))
  }

  const row = (fresh && Array.isArray(fresh.sessions) ? fresh.sessions : []).find(
    item => item.id === session.id
  )
  if (!row) throw new Error('la sesión ya no está en la ventana')
  if (row.state !== 'running' && row.state !== 'stalled') {
    throw new Error('la sesión ya no está corriendo')
  }

  const expected = normalizeGeneration(session.execution_generation)
  const current = normalizeGeneration(row.execution_generation)
  if (expected !== current) throw new Error('la sesión cambió de turno; vuelve a intentarlo')

  // The canonical wire contract for `session.interrupt` is a closed key set:
  // `session_id` (+ the optional profile route). Sending `execution_generation`
  // makes the gateway answer 4001 `invalid_params` before the handler runs, so
  // the fence stays client-side: we already re-read `/live` and compared above.
  const result = await sessionRpc(session, 'session.interrupt', { session_id: session.id })
  if (result && (result.status === 'not_interrupted' || result.interrupted === false)) {
    throw new Error('el gateway no interrumpió el turno')
  }
  return result
}

function fmtAgo(ts, now = Date.now()) {
  if (!ts) return '—'
  const delta = Math.max(0, Math.floor(now / 1000) - Number(ts))
  if (delta < 60) return delta + ' s'
  if (delta < 3600) return Math.floor(delta / 60) + ' min'
  if (delta < 86400) return Math.floor(delta / 3600) + ' h'
  return Math.floor(delta / 86400) + ' d'
}

function StateGlyph({ state }) {
  if (state === 'running') {
    return jsx('span', {
      'aria-label': 'corriendo',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '14px',
        color: DOT,
        fontFamily: MONO,
        fontSize: '10px',
        lineHeight: 1
      },
      children: jsx('span', { className: 'sp-dot', children: '●' })
    })
  }

  const meta =
    state === 'stalled'
      ? { glyph: '!', color: DESTRUCTIVE, label: 'colgada' }
      : state === 'queued'
        ? { glyph: '◷', color: AMBER, label: 'en cola' }
        : state === 'done'
          ? { glyph: '✓', color: GREEN, label: 'terminada' }
          : state === 'failed'
            ? { glyph: '✕', color: DESTRUCTIVE, label: 'fallida' }
            : { glyph: '●', color: DOT, label: 'espera' }

  return jsx('span', {
    'aria-label': meta.label,
    style: {
      width: '16px',
      textAlign: 'center',
      color: meta.color,
      fontFamily: MONO,
      fontSize: '12px',
      lineHeight: 1
    },
    children: meta.glyph
  })
}

/**
 * The real profile avatar.
 *
 * The list never waits for the image: the tinted initial paints immediately
 * and is replaced when the (single, cached) request resolves. When there is no
 * PNG the stored shape/color still paint a real-looking fallback.
 */
function Avatar({ profile, title, avatar, ctx }) {
  const key = String(profile || 'default').trim() || 'default'
  const info = avatar && typeof avatar === 'object' ? avatar : {}
  const [image, setImage] = useState(() => {
    const cached = cachedAvatar(key)
    return cached === undefined ? null : cached
  })

  useEffect(() => {
    const cached = cachedAvatar(key)
    if (cached) {
      setImage(cached)
      return undefined
    }
    if (!info.has_image) {
      return undefined
    }
    let alive = true
    loadAvatar(ctx, key).then(url => {
      if (alive && url) setImage(url)
    })
    return () => {
      alive = false
    }
  }, [ctx, key, info.has_image])

  const label = String(title || profile || 'default').trim().charAt(0).toUpperCase() || '?'
  const color =
    typeof info.color === 'string' && /^#[0-9a-f]{6}$/i.test(info.color) ? info.color : null
  const background = color
    ? 'color-mix(in srgb, ' + color + ' 30%, transparent)'
    : 'color-mix(in srgb, ' + FG + ' 13%, transparent)'
  // A photo profile keeps the roster's soft square even before (or without) its
  // PNG: the stored silhouette is a fallback vocabulary, not a crop of a face.
  const shape =
    info.image_kind === 'photo'
      ? { borderRadius: '22%' }
      : SHAPE_STYLES[shapeOf(info.shape, key)] || SHAPE_STYLES.circle

  if (image) {
    // Same treatment the Bots roster gives a photo (`BotFace`): a soft square.
    return jsx('img', {
      'aria-hidden': true,
      alt: '',
      src: image,
      width: 30,
      height: 30,
      onError: () => {
        AVATAR_CACHE.set(key, null)
        AVATAR_FAILED_AT.set(key, Date.now())
        setImage(null)
      },
      style: {
        width: '30px',
        height: '30px',
        flex: '0 0 30px',
        borderRadius: '22%',
        objectFit: 'cover',
        display: 'block'
      }
    })
  }

  if (
    typeof blobatarSvg === 'function' &&
    info.shape &&
    (info.shape === 'blobatar' || info.shape.indexOf('blobatar') === 0)
  ) {
    try {
      const svg = blobatarSvg(key, { size: 30 })
      if (svg) {
        return jsx('span', {
          'aria-hidden': true,
          dangerouslySetInnerHTML: { __html: svg },
          style: {
            width: '30px',
            height: '30px',
            flex: '0 0 30px',
            display: 'block',
            lineHeight: 0,
            borderRadius: '22%',
            overflow: 'hidden'
          }
        })
      }
    } catch (_error) {
      // Fall through to initial silhouette if SVG fails
    }
  }

  return jsx('span', {
    'aria-hidden': true,
    style: {
      width: '30px',
      height: '30px',
      flex: '0 0 30px',
      display: 'grid',
      placeItems: 'center',
      overflow: 'hidden',
      fontSize: '10px',
      fontWeight: 700,
      lineHeight: 1,
      color: FG,
      background,
      ...shape
    },
    children: jsx('span', { style: { display: 'block' }, children: label })
  })
}

function activityFor(session, now = Date.now()) {
  if (session.state === 'stalled') {
    // "sin latido" alone does not answer the only question that matters before
    // interrupting: how long has it been silent?
    return { text: 'sin latido hace ' + fmtAgo(session.last_activity_at, now), warn: true }
  }
  if (session.activity && session.activity !== session.tool) return { text: session.activity, warn: false }
  if (session.state === 'queued') return { text: 'esperando slot', warn: false }
  if (session.state === 'idle') return { text: 'esperando al usuario', warn: false }
  return { text: '', warn: false }
}

// ---------------------------------------------------------------------------
// Always-on-Top mini-window (Native Chromium Picture-in-Picture)
// ---------------------------------------------------------------------------

const PIP_WIDTH = 720
const PIP_HEIGHT = 450

const PIP_STATE = {
  canvas: null,
  video: null,
  stream: null,
  timer: 0,
  active: false,
  ctx: null,
  lastSnapshot: null,
  listeners: new Set()
}

function isRadarPipActive() {
  if (
    typeof document !== 'undefined' &&
    document &&
    document.pictureInPictureElement &&
    PIP_STATE.video &&
    document.pictureInPictureElement === PIP_STATE.video
  ) {
    return true
  }
  return Boolean(PIP_STATE.active)
}

function subscribeRadarPip(listener) {
  if (typeof listener !== 'function') return () => {}
  PIP_STATE.listeners.add(listener)
  return () => {
    PIP_STATE.listeners.delete(listener)
  }
}

function notifyRadarPip() {
  const active = isRadarPipActive()
  for (const listener of PIP_STATE.listeners) {
    try {
      listener(active)
    } catch (_error) {
      // A listener error must not break the PiP state machine.
    }
  }
}

function clipText(text, maxChars) {
  const raw = String(text || '').trim()
  if (raw.length <= maxChars) return raw
  return raw.slice(0, Math.max(1, maxChars - 1)) + '…'
}

function fillRoundedRect(g, x, y, w, h, r, fill, stroke) {
  g.beginPath()
  if (typeof g.roundRect === 'function') {
    g.roundRect(x, y, w, h, r)
  } else if (typeof g.rect === 'function') {
    g.rect(x, y, w, h)
  }
  if (fill) {
    g.fillStyle = fill
    g.fill()
  }
  if (stroke) {
    g.strokeStyle = stroke
    g.lineWidth = 1
    g.stroke()
  }
}

/**
 * Paint the live Radar mini-card onto a 2x canvas for Picture-in-Picture.
 * Chromium streams this canvas into an OS-level Always-on-Top overlay window
 * (`VideoOverlayWindowViews`) that stays visible even when Hermes is minimized.
 */
function renderRadarPipCanvas(canvas, snapshot, now = Date.now()) {
  if (!canvas || typeof canvas.getContext !== 'function') return null
  if (canvas.width !== PIP_WIDTH) canvas.width = PIP_WIDTH
  if (canvas.height !== PIP_HEIGHT) canvas.height = PIP_HEIGHT

  const g = canvas.getContext('2d')
  if (!g) return null

  const data = snapshot && typeof snapshot === 'object' ? snapshot : {}
  const totals = data.totals && typeof data.totals === 'object' ? data.totals : {}
  const workingCount =
    totals.working !== undefined ? totals.working : (totals.running || 0) + (totals.queued || 0)
  const waitingCount = totals.waiting !== undefined ? totals.waiting : totals.idle || 0
  const stalledCount = totals.stalled || 0

  const rows = (Array.isArray(data.sessions) ? data.sessions : [])
    .filter(session => LISTED_STATES.includes(session.state))
    .sort(
      (left, right) =>
        (STATE_ORDER[left.state] ?? 9) - (STATE_ORDER[right.state] ?? 9) ||
        (right.elapsed_s || 0) - (left.elapsed_s || 0)
    )

  // Surface background & top Hermes orange bar
  g.fillStyle = '#0d1117'
  g.fillRect(0, 0, PIP_WIDTH, PIP_HEIGHT)
  g.fillStyle = ORANGE
  g.fillRect(0, 0, PIP_WIDTH, 4)

  // Header bar
  fillRoundedRect(g, 16, 14, 28, 28, 6, ORANGE, null)
  g.fillStyle = '#1a0700'
  g.font = '800 13px system-ui, sans-serif'
  g.fillText('RD', 20, 33)

  g.fillStyle = '#e6edf3'
  g.font = '700 16px system-ui, sans-serif'
  g.fillText('Radar · Siempre encima', 54, 33)

  const statusText = stalledCount
    ? '! ' + stalledCount + (stalledCount === 1 ? ' colgada' : ' colgadas')
    : waitingCount
      ? '● ' + waitingCount + ' esperando'
      : '● ' + workingCount + ' en vivo'
  const statusBg = stalledCount ? '#3d1518' : waitingCount ? '#382a10' : '#122d1f'
  const statusFg = stalledCount ? '#f85149' : waitingCount ? AMBER_HUE : GREEN_HUE
  fillRoundedRect(g, PIP_WIDTH - 166, 15, 150, 26, 13, statusBg, statusFg)
  g.fillStyle = statusFg
  g.font = '600 12px ui-monospace, monospace'
  g.fillText(clipText(statusText, 18), PIP_WIDTH - 154, 32)

  // Three metric counters
  const cards = [
    { label: 'TRABAJANDO', value: String(workingCount), color: workingCount ? GREEN_HUE : '#e6edf3' },
    { label: 'ESPERANDO', value: String(waitingCount), color: waitingCount ? AMBER_HUE : '#9aa4af' },
    { label: 'COLGADAS', value: String(stalledCount), color: stalledCount ? '#f85149' : '#9aa4af' }
  ]
  const cardW = 222
  cards.forEach((card, index) => {
    const x = 16 + index * (cardW + 11)
    fillRoundedRect(g, x, 50, cardW, 52, 8, '#161b22', '#30363d')
    g.fillStyle = card.color
    g.font = '700 22px system-ui, sans-serif'
    g.fillText(card.value, x + 14, 78)
    g.fillStyle = '#9aa4af'
    g.font = '600 11px ui-monospace, monospace'
    g.fillText(card.label, x + 56, 75)
  })

  // Session rows (up to 5)
  const visibleRows = rows.slice(0, 5)
  if (!visibleRows.length) {
    fillRoundedRect(g, 16, 114, PIP_WIDTH - 32, 294, 10, '#161b22', '#21262d')
    g.fillStyle = '#e6edf3'
    g.font = '600 16px system-ui, sans-serif'
    g.fillText('Ninguna sesión activa en la ventana', 215, 252)
    g.fillStyle = '#9aa4af'
    g.font = '500 13px ui-monospace, monospace'
    g.fillText((totals.dormant || 0) + ' inactivas fuera de la ventana', 248, 278)
  } else {
    visibleRows.forEach((session, idx) => {
      const y = 114 + idx * 59
      const stalled = session.state === 'stalled'
      const waiting = session.state === 'idle'
      const running = session.state === 'running'
      const rowBg = stalled ? '#291417' : waiting ? '#261f12' : '#161b22'
      const rowBorder = stalled ? '#f85149' : waiting ? AMBER_HUE : '#21262d'
      fillRoundedRect(g, 16, y, PIP_WIDTH - 32, 53, 8, rowBg, rowBorder)

      const stripe = stalled ? '#f85149' : waiting ? AMBER_HUE : running ? GREEN_HUE : '#30363d'
      fillRoundedRect(g, 16, y, 5, 53, 3, stripe, null)

      const profileKey = String(session.profile || 'default').trim() || 'default'
      const avatarInfo = session.avatar && typeof session.avatar === 'object' ? session.avatar : {}
      const avatarColor =
        typeof avatarInfo.color === 'string' && /^#[0-9a-f]{6}$/i.test(avatarInfo.color)
          ? avatarInfo.color
          : ORANGE
      const ax = 30
      const ay = y + 9
      fillRoundedRect(g, ax, ay, 35, 35, 8, avatarColor, null)

      const img = AVATAR_IMAGES.get(profileKey)
      let drewImage = false
      if (img && img.complete !== false && typeof g.drawImage === 'function') {
        try {
          g.drawImage(img, ax, ay, 35, 35)
          drewImage = true
        } catch (_error) {
          drewImage = false
        }
      }
      if (!drewImage) {
        const initial =
          String(session.profile_title || session.profile_label || profileKey)
            .trim()
            .charAt(0)
            .toUpperCase() || '?'
        g.fillStyle = '#ffffff'
        g.font = '700 15px system-ui, sans-serif'
        g.fillText(initial, ax + 11, ay + 23)
      }

      // Title + profile badge
      g.fillStyle = '#e6edf3'
      g.font = '600 14px system-ui, sans-serif'
      g.fillText(clipText(session.title || session.id, 38), 76, y + 23)

      const act = activityFor(session, now)
      const subParts = []
      if (session.profile_title || session.profile_label || session.profile) {
        subParts.push(String(session.profile_title || session.profile_label || session.profile))
      }
      if (session.tool) subParts.push(String(session.tool))
      if (act.text) subParts.push(act.text)
      g.fillStyle = stalled ? '#f85149' : waiting ? AMBER_HUE : '#9aa4af'
      g.font = '500 12px ui-monospace, monospace'
      g.fillText(clipText(subParts.join(' · ') || session.state, 52), 76, y + 42)

      // Right state badge + age
      const badgeLabel = stalled
        ? '! COLGADA'
        : waiting
          ? 'ESPERA'
          : running
            ? '● ACTIVA'
            : session.state === 'queued'
              ? '◷ COLA'
              : session.state === 'done'
                ? '✓ LISTA'
                : '✕ FALLÓ'
      const badgeColor = stalled
        ? '#f85149'
        : waiting || session.state === 'queued'
          ? AMBER_HUE
          : running || session.state === 'done'
            ? GREEN_HUE
            : '#f85149'
      g.fillStyle = badgeColor
      g.font = '700 11px ui-monospace, monospace'
      g.fillText(badgeLabel, PIP_WIDTH - 116, y + 23)

      const when = session.last_activity_at
        ? fmtAgo(session.last_activity_at, now)
        : Math.max(0, Math.round(Number(session.elapsed_s) || 0)) + ' s'
      g.fillStyle = '#7d8590'
      g.font = '500 11px ui-monospace, monospace'
      g.fillText(when, PIP_WIDTH - 116, y + 42)
    })
  }

  // Footer
  const age = data.generated_at ? Math.max(0, Math.floor(now / 1000) - Number(data.generated_at)) : 0
  g.fillStyle = '#7d8590'
  g.font = '500 11px ui-monospace, monospace'
  g.fillText(
    'Ventana ' + (data.window_s || 180) + 's · Minimiza Hermes y esta ventana seguirá siempre visible',
    16,
    436
  )
  g.fillText('hace ' + age + 's', PIP_WIDTH - 78, 436)

  return {
    workingCount,
    waitingCount,
    stalledCount,
    rowCount: visibleRows.length
  }
}

function stopRadarPipLoop() {
  if (PIP_STATE.timer) {
    clearInterval(PIP_STATE.timer)
    PIP_STATE.timer = 0
  }
  PIP_STATE.active = false
  notifyRadarPip()
}

function updateRadarPipSnapshot(ctx, snapshot) {
  if (ctx) PIP_STATE.ctx = ctx
  if (!snapshot || typeof snapshot !== 'object') return
  PIP_STATE.lastSnapshot = snapshot
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
  for (const session of sessions) {
    if (session && session.avatar && session.avatar.has_image && session.profile) {
      loadAvatar(ctx, session.profile)
    }
  }
  if (PIP_STATE.canvas && isRadarPipActive()) {
    renderRadarPipCanvas(PIP_STATE.canvas, snapshot, Date.now())
  }
}

async function toggleRadarPip(ctx, snapshot) {
  if (ctx) PIP_STATE.ctx = ctx
  if (snapshot && typeof snapshot === 'object') PIP_STATE.lastSnapshot = snapshot

  if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
    return false
  }

  if (isRadarPipActive()) {
    try {
      if (document.pictureInPictureElement && typeof document.exitPictureInPicture === 'function') {
        await document.exitPictureInPicture()
      }
    } catch (_error) {
      // Closing PiP is idempotent.
    }
    stopRadarPipLoop()
    return false
  }

  try {
    if (!PIP_STATE.lastSnapshot && PIP_STATE.ctx && typeof PIP_STATE.ctx.rest === 'function') {
      try {
        PIP_STATE.lastSnapshot = await PIP_STATE.ctx.rest(LIVE_PATH)
      } catch (_error) {
        // Proceed with an empty snapshot; the interval will populate it.
      }
    }

    if (!PIP_STATE.canvas) {
      PIP_STATE.canvas = document.createElement('canvas')
      PIP_STATE.canvas.width = PIP_WIDTH
      PIP_STATE.canvas.height = PIP_HEIGHT
    }
    renderRadarPipCanvas(PIP_STATE.canvas, PIP_STATE.lastSnapshot || {}, Date.now())

    if (!PIP_STATE.video) {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.setAttribute('aria-hidden', 'true')
      video.style.position = 'fixed'
      video.style.width = '1px'
      video.style.height = '1px'
      video.style.opacity = '0'
      video.style.pointerEvents = 'none'
      video.style.bottom = '0'
      video.style.right = '0'
      if (typeof video.addEventListener === 'function') {
        video.addEventListener('leavepictureinpicture', () => {
          stopRadarPipLoop()
        })
      }
      if (document.body && typeof document.body.appendChild === 'function') {
        document.body.appendChild(video)
      }
      PIP_STATE.video = video
    }

    if (!PIP_STATE.stream && typeof PIP_STATE.canvas.captureStream === 'function') {
      PIP_STATE.stream = PIP_STATE.canvas.captureStream(2)
      PIP_STATE.video.srcObject = PIP_STATE.stream
    }

    if (typeof PIP_STATE.video.play === 'function') {
      await PIP_STATE.video.play()
    }
    if (typeof PIP_STATE.video.requestPictureInPicture !== 'function') {
      throw new Error('Picture-in-Picture no está disponible en este entorno')
    }
    await PIP_STATE.video.requestPictureInPicture()
    PIP_STATE.active = true
    notifyRadarPip()

    if (PIP_STATE.timer) clearInterval(PIP_STATE.timer)
    PIP_STATE.timer = setInterval(async () => {
      if (!isRadarPipActive()) {
        stopRadarPipLoop()
        return
      }
      if (PIP_STATE.ctx && typeof PIP_STATE.ctx.rest === 'function') {
        try {
          const fresh = await PIP_STATE.ctx.rest(LIVE_PATH)
          updateRadarPipSnapshot(PIP_STATE.ctx, fresh)
          return
        } catch (_error) {
          // Redraw with the last known snapshot so the clock keeps ticking.
        }
      }
      if (PIP_STATE.canvas) {
        renderRadarPipCanvas(PIP_STATE.canvas, PIP_STATE.lastSnapshot || {}, Date.now())
      }
    }, REFRESH_MS)

    return true
  } catch (error) {
    stopRadarPipLoop()
    if (typeof host.notify === 'function') {
      host.notify({ kind: 'error', message: 'No se pudo activar Siempre encima: ' + messageOf(error) })
    }
    return false
  }
}

function SessionRow({ session, now, stop, onOpen, onStop, ctx }) {
  const [hovered, setHovered] = useState(false)
  const stalled = session.state === 'stalled'
  // F8: the turn ended and the user is awaited. Amber, never grey.
  const waiting = session.state === 'idle'
  const terminal = TERMINAL_STATES.includes(session.state)
  const confirming = stop && stop.phase === 'confirm' && stop.until > now
  const sending = stop && stop.phase === 'sending'
  const stopDone = stop && stop.phase === 'done' && stop.until > now
  const stopFailed = stop && stop.phase === 'error'
  const activity = activityFor(session, now)
  // Terminal rows keep the layout but drop the stop control: the turn already
  // ended, and offering a stop there would be a dead button.
  const canStop = Boolean(session.can_interrupt) && !terminal

  const base = stalled
    ? 'color-mix(in srgb, ' + DESTRUCTIVE + ' 9%, transparent)'
    : waiting
      ? 'color-mix(in srgb, ' + AMBER + ' 10%, transparent)'
      : 'transparent'
  const background = !hovered
    ? base
    : stalled
      ? 'color-mix(in srgb, ' + DESTRUCTIVE + ' 15%, transparent)'
      : waiting
        ? 'color-mix(in srgb, ' + AMBER + ' 18%, transparent)'
        : 'color-mix(in srgb, ' + FG + ' 7%, transparent)'

  const stopLabel = sending ? '…' : confirming ? '¿seguro?' : 'parar'

  return jsxs('div', {
    className: 'sp-row',
    title: session.id + (session.git_branch ? ' · ' + session.git_branch : ''),
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px',
      borderRadius: '7px',
      background,
      // Terminal rows stay readable but recede: they must not compete with a
      // running or stalled session.
      opacity: terminal ? 0.72 : undefined,
      borderLeft: stalled ? '3px solid ' + DESTRUCTIVE : waiting ? '3px solid ' + AMBER : undefined,
      boxShadow: stalled
        ? 'inset 0 0 0 1px color-mix(in srgb, ' + DESTRUCTIVE + ' 34%, transparent)'
        : 'none'
    },
    children: [
      // The click target is a real button; the row itself is not interactive,
      // so there is no `role="button"` wrapping another button.
      jsxs('button', {
        type: 'button',
        className: 'sp-open',
        onClick: () => onOpen(session),
        children: [
          jsx(Avatar, {
            profile: session.profile,
            title: session.profile_title || session.profile_label,
            avatar: session.avatar,
            ctx
          }),
          jsxs('div', {
            style: { flex: 1, minWidth: 0 },
            children: [
              jsx('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  minWidth: 0
                },
                children: [
                  jsx('span', {
                    style: {
                      flex: 1,
                      minWidth: 0,
                      fontSize: '11.5px',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    },
                    children: session.title || session.id
                  }),
                  waiting
                    ? jsx('span', {
                        style: {
                          flex: '0 0 auto',
                          padding: '0 3px',
                          border: '1px solid color-mix(in srgb, ' + AMBER + ' 34%, transparent)',
                          borderRadius: '3px',
                          color: AMBER,
                          background: 'color-mix(in srgb, ' + AMBER + ' 12%, transparent)',
                          fontFamily: MONO,
                          fontSize: '8.5px',
                          lineHeight: '1.4',
                          whiteSpace: 'nowrap'
                        },
                        children: 'espera'
                      })
                    : null,
                  // The bot's title, never the raw slug. It sits after the
                  // title and truncates first so the session name keeps its room.
                  jsx('span', {
                    title: session.profile_title || session.profile_label || session.profile || 'default',
                    style: {
                      flex: '0 0 auto',
                      maxWidth: '62px',
                      padding: '0 3px',
                      border: '1px solid ' + BORDER,
                      borderRadius: '3px',
                      color: MUTED,
                      fontFamily: MONO,
                      fontSize: '8.5px',
                      lineHeight: '1.4',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    },
                    children:
                      session.profile_title || session.profile_label || session.profile || 'default'
                  })
                ]
              }),
              stopFailed
                ? jsx('div', {
                    style: {
                      marginTop: '2px',
                      fontFamily: MONO,
                      fontSize: '9px',
                      color: WARN,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    },
                    children: stop.message
                  })
                : stopDone
                  ? jsx('div', {
                      style: { marginTop: '2px', fontFamily: MONO, fontSize: '9px', color: GREEN },
                      children: 'interrumpida'
                    })
                  : jsxs('div', {
                      style: {
                        marginTop: '2px',
                        display: 'flex',
                        gap: '6px',
                        minWidth: 0,
                        fontFamily: MONO,
                        fontSize: '9.5px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      },
                      children: [
                        session.tool
                          ? jsx('span', { style: { color: VIOLET, flex: '0 0 auto' }, children: session.tool })
                          : null,
                        activity.text
                          ? jsx('span', {
                              style: {
                                color: activity.warn ? WARN : MUTED,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                              },
                              children: activity.text
                            })
                          : null
                      ]
                    })
            ]
          })
        ]
      }),
      jsx(StateGlyph, { state: session.state }),
      canStop
        ? jsx('button', {
            type: 'button',
            className: 'sp-stop',
            'aria-label': 'interrumpir ' + (session.title || session.id),
            disabled: sending,
            onClick: event => {
              event.stopPropagation()
              onStop(session)
            },
            style: {
              // Fixed width: the label changes on confirm and the row must not
              // re-flow under the pointer.
              flex: '0 0 auto',
              width: '52px',
              textAlign: 'center',
              border: '1px solid ' + (confirming || hovered ? ORANGE : BORDER),
              borderRadius: '5px',
              background: confirming ? ORANGE : 'transparent',
              color: confirming ? ACCENT_INK : hovered ? FG : MUTED,
              fontFamily: MONO,
              fontSize: '9px',
              lineHeight: 1.4,
              padding: '1px 4px',
              cursor: sending ? 'default' : 'pointer'
            },
            children: stopLabel
          })
        : null
    ]
  })
}

function RadarPane({ ctx }) {
  if (activeFullViews > 0) return null
  const [snapshot, setSnapshot] = useState(null)
  const [offline, setOffline] = useState(false)
  const [stopping, setStopping] = useState({})
  const [size, setSize] = useState(() => storedSize(ctx))
  const [pipActive, setPipActive] = useState(() => isRadarPipActive())
  const mounted = useRef(true)
  const debounce = useRef(0)

  const load = useCallback(async () => {
    try {
      const data = await ctx.rest(LIVE_PATH)
      if (!mounted.current) return
      setSnapshot(data)
      setOffline(false)
      updateRadarPipSnapshot(ctx, data)
    } catch (_error) {
      if (!mounted.current) return
      // Keep the last good picture and say so in the footer.
      setOffline(true)
    }
  }, [ctx])

  useEffect(() => {
    mounted.current = true
    load()
    // The interval belongs to the mounted component: collapsing the floating
    // pane unmounts it, and the poll stops with it (no lifecycleKeepAlive).
    const interval = setInterval(load, REFRESH_MS)
    const offPip = subscribeRadarPip(active => {
      if (mounted.current) setPipActive(active)
    })
    const off = host.onEvent('plugin.radar.changed', () => {
      if (debounce.current) clearTimeout(debounce.current)
      debounce.current = setTimeout(() => {
        debounce.current = 0
        load()
      }, EVENT_DEBOUNCE_MS)
    })
    return () => {
      mounted.current = false
      clearInterval(interval)
      if (debounce.current) clearTimeout(debounce.current)
      if (typeof offPip === 'function') offPip()
      if (typeof off === 'function') off()
    }
  }, [load])

  const open = useCallback(session => {
    const profile = String(session.profile || '').trim()
    const request = profile ? host.openSession(session.id, { profile }) : host.openSession(session.id)
    Promise.resolve(request).catch(error => {
      if (typeof host.notify === 'function') {
        host.notify({ kind: 'error', message: 'No se pudo abrir la sesión: ' + messageOf(error) })
      }
    })
  }, [])

  const stop = useCallback(
    session => {
      const current = stopping[session.id]
      const now = Date.now()
      if (current && current.phase === 'confirm' && current.until > now) {
        setStopping(state => ({ ...state, [session.id]: { phase: 'sending' } }))
        interruptSession(ctx, session)
          .then(() => {
            if (!mounted.current) return
            setStopping(state => ({
              ...state,
              [session.id]: { phase: 'done', until: Date.now() + INTERRUPTED_MS }
            }))
            load()
          })
          .catch(error => {
            if (!mounted.current) return
            setStopping(state => ({
              ...state,
              [session.id]: { phase: 'error', message: messageOf(error) }
            }))
          })
        return
      }
      setStopping(state => ({
        ...state,
        [session.id]: { phase: 'confirm', until: now + CONFIRM_MS }
      }))
    },
    [ctx, load, stopping]
  )

  // Re-registering the pane is the only resize the host allows. It happens one
  // macrotask later so the component is not unmounted in the middle of the
  // render that received the click.
  const chooseSize = useCallback(
    next => {
      const key = paneSize(next)
      if (key === size) return
      setSize(key)
      writeSetting(ctx, SETTING_KEYS.size, key)
      setTimeout(() => {
        try {
          registerRadarPane(ctx, key)
        } catch (_error) {
          // The plugin may have been unloaded between the click and this tick.
        }
      }, 0)
    },
    [ctx, size]
  )

  const data = snapshot || {}
  const totals = data.totals || {}
  const now = Date.now()
  const rows = (Array.isArray(data.sessions) ? data.sessions : [])
    .filter(session => LISTED_STATES.includes(session.state))
    .sort(
      (left, right) =>
        (STATE_ORDER[left.state] ?? 9) - (STATE_ORDER[right.state] ?? 9) ||
        (right.elapsed_s || 0) - (left.elapsed_s || 0)
    )

  const age = data.generated_at ? Math.max(0, Math.floor(now / 1000) - Number(data.generated_at)) : 0
  const dormant = totals.dormant || 0
  // F8: the footer leads with the two numbers the user acts on, plus stalled.
  // Both aggregates fall back to their per-state parts on an older payload.
  const workingCount =
    totals.working !== undefined ? totals.working : (totals.running || 0) + (totals.queued || 0)
  const waitingCount = totals.waiting !== undefined ? totals.waiting : totals.idle || 0
  const stalledCount = totals.stalled || 0
  const profileErrors = Object.keys(data.profile_errors || {})

  return jsxs('div', {
    style: {
      height: '100%',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      background: CARD,
      color: FG,
      fontFamily: SANS,
      overflow: 'hidden'
    },
    children: [
      jsx('style', { children: ANIMATION_CSS }),
      // Compact header: the four sizes on the left, «expandir» on the right.
      // No title: the Desktop's floating chrome already carries one.
      jsxs('div', {
        className: 'sp-head',
        style: {
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '3px',
          height: '22px',
          padding: '0 6px 0 8px',
          borderBottom: '1px solid ' + BORDER,
          fontFamily: MONO,
          fontSize: '9.5px',
          color: MUTED
        },
        children: [
          ...SIZE_ORDER.map(key =>
            jsx(
              'button',
              {
                type: 'button',
                className: 'sp-size' + (key === size ? ' sp-size-on' : ''),
                'data-size': key,
                'aria-pressed': key === size ? 'true' : 'false',
                'aria-label': 'tamaño ' + key.toUpperCase(),
                title: PANE_SIZES[key].width + ' × ' + PANE_SIZES[key].height,
                onClick: () => chooseSize(key),
                children: key.toUpperCase(),
                style: {
                  appearance: 'none',
                  height: '16px',
                  padding: '0 4px',
                  border: '1px solid ' + (key === size ? ORANGE : 'transparent'),
                  borderRadius: '4px',
                  background:
                    key === size ? 'color-mix(in srgb, ' + ORANGE + ' 16%, transparent)' : 'transparent',
                  color: key === size ? FG : MUTED,
                  fontFamily: MONO,
                  fontSize: '9.5px',
                  fontWeight: key === size ? 700 : 400,
                  lineHeight: 1,
                  cursor: 'pointer'
                }
              },
              key
            )
          ),
          jsx('span', { style: { flex: 1 } }),
          jsx(
            'button',
            {
              type: 'button',
              className: 'sp-pip' + (pipActive ? ' sp-pip-on' : ''),
              'aria-pressed': pipActive ? 'true' : 'false',
              'aria-label': 'siempre encima',
              title: 'Siempre encima (Picture-in-Picture al minimizar)',
              onClick: () => {
                toggleRadarPip(ctx, snapshot)
              },
              children: '📌',
              style: {
                appearance: 'none',
                height: '16px',
                padding: '0 4px',
                border: '1px solid ' + (pipActive ? ORANGE : BORDER),
                borderRadius: '4px',
                background:
                  pipActive ? 'color-mix(in srgb, ' + ORANGE + ' 16%, transparent)' : 'transparent',
                color: pipActive ? FG : MUTED,
                fontFamily: MONO,
                fontSize: '10px',
                lineHeight: 1,
                cursor: 'pointer'
              }
            },
            'pip'
          ),
          typeof host.navigate === 'function'
            ? jsx(
                'button',
                {
                  type: 'button',
                  className: 'sp-page',
                  'aria-label': 'abrir vista completa',
                  title: 'Abrir Radar en vista completa (/radar)',
                  onClick: openRadarPage,
                  children: '⊞',
                  style: {
                    appearance: 'none',
                    height: '16px',
                    padding: '0 4px',
                    border: '1px solid ' + BORDER,
                    borderRadius: '4px',
                    background: 'transparent',
                    color: MUTED,
                    fontFamily: MONO,
                    fontSize: '10.5px',
                    lineHeight: 1,
                    cursor: 'pointer'
                  }
                },
                'page'
              )
            : null,
          typeof host.revealPane === 'function'
            ? jsx(
                'button',
                {
                  type: 'button',
                  className: 'sp-expand',
                  'aria-label': 'expandir panel lateral',
                  title: 'Expandir en el panel lateral',
                  onClick: expandRadarPanel,
                  children: '⤢',
                  style: {
                    appearance: 'none',
                    height: '16px',
                    padding: '0 4px',
                    border: '1px solid ' + BORDER,
                    borderRadius: '4px',
                    background: 'transparent',
                    color: MUTED,
                    fontFamily: MONO,
                    fontSize: '11px',
                    lineHeight: 1,
                    cursor: 'pointer'
                  }
                },
                '⤢'
              )
            : null
        ]
      }),
      rows.length
        ? jsx('div', {
            style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 6px', scrollbarWidth: 'thin' },
            children: rows.map(session =>
              jsx(
                SessionRow,
                {
                  session,
                  now,
                  stop: stopping[session.id],
                  onOpen: open,
                  onStop: stop,
                  ctx
                },
                session.id
              )
            )
          })
        : jsxs('div', {
            style: {
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              padding: '10px'
            },
            children: [
              jsx('span', { style: { fontSize: '11.5px', fontWeight: 600 }, children: 'Ninguna sesión en la ventana' }),
              jsx('span', {
                style: { fontFamily: MONO, fontSize: '9.5px', color: MUTED },
                children: dormant + ' inactivas'
              })
            ]
          }),
      jsxs('div', {
        style: {
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          height: '22px',
          padding: '0 8px',
          borderTop: '1px solid ' + BORDER,
          fontFamily: MONO,
          fontSize: '9.5px',
          color: MUTED,
          // The counts are the footer's contract: never wrap them under the
          // card. The age gives way first (the parent clips the overflow).
          overflow: 'hidden'
        },
        children: [
          jsxs('span', {
            style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
            children: [
              jsx('span', {
                'aria-hidden': true,
                style: {
                  display: 'inline-block',
                  width: '5px',
                  height: '5px',
                  borderRadius: '50%',
                  background: ORANGE,
                  marginRight: '4px',
                  verticalAlign: 'middle'
                }
              }),
              jsx('b', { style: { color: FG, fontWeight: 600 }, children: String(workingCount) }),
              ' trabajando · ',
              jsx('b', { style: { color: waitingCount ? AMBER : FG, fontWeight: 600 }, children: String(waitingCount) }),
              ' esperando · ',
              jsx('b', {
                style: { color: stalledCount ? WARN : FG, fontWeight: 600 },
                children: String(stalledCount)
              }),
              ' colgadas'
            ]
          }),
          profileErrors.length
            ? jsx('span', {
                // A corrupt profile used to disappear in silence: name it here.
                title: profileErrors
                  .map(name => name + ': ' + String((data.profile_errors || {})[name] || 'error'))
                  .join(' · '),
                style: {
                  color: WARN,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                },
                children: 'sin conexión · ' + profileErrors.join(', ')
              })
            : null,
          jsx('span', { style: { flex: 1 } }),
          jsx('span', {
            style: { flex: '0 0 auto', whiteSpace: 'nowrap', color: offline ? WARN : undefined },
            children: offline ? 'sin conexión' : 'hace ' + age + 's'
          })
        ]
      })
    ]
  })
}

/**
 * One row in the full side panel.
 *
 * It keeps the floating row's open/stop contract and adds the two affordances a
 * full-width panel can afford: the session id copy and the activity timestamp.
 * Waiting rows are amber; stalled rows are red. Neither colour is used for the
 * other state.
 */
function PanelRow({ session, now, compact, stop, copied, onOpen, onStop, onCopy, ctx }) {
  const [hovered, setHovered] = useState(false)
  const waiting = session.state === 'idle'
  const stalled = session.state === 'stalled'
  const terminal = TERMINAL_STATES.includes(session.state)
  const canStop =
    Boolean(session.can_interrupt) &&
    (session.state === 'running' || session.state === 'stalled')
  const confirming = stop && stop.phase === 'confirm' && stop.until > now
  const sending = stop && stop.phase === 'sending'
  const stopDone = stop && stop.phase === 'done' && stop.until > now
  const stopFailed = stop && stop.phase === 'error'
  const activity = activityFor(session, now)
  const when = session.last_activity_at
    ? fmtAgo(session.last_activity_at, now)
    : Math.max(0, Math.round(Number(session.elapsed_s) || 0)) + ' s'

  const base = stalled
    ? 'color-mix(in srgb, ' + DESTRUCTIVE + ' 9%, transparent)'
    : waiting
      ? 'color-mix(in srgb, ' + AMBER + ' 10%, transparent)'
      : 'transparent'
  const background = !hovered
    ? base
    : stalled
      ? 'color-mix(in srgb, ' + DESTRUCTIVE + ' 15%, transparent)'
      : 'color-mix(in srgb, ' + FG + ' 7%, transparent)'

  const stopLabel = sending ? '…' : confirming ? '¿seguro?' : 'parar'

  return jsxs('div', {
    className: 'sp-row sp-panel-row',
    title: session.id + (session.git_branch ? ' · ' + session.git_branch : ''),
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: compact ? '4px 6px' : '7px 8px',
      borderRadius: '7px',
      background,
      borderLeft: stalled
        ? '3px solid ' + DESTRUCTIVE
        : waiting
          ? '3px solid ' + AMBER
          : '3px solid transparent',
      opacity: terminal ? 0.72 : undefined
    },
    children: [
      jsxs('button', {
        type: 'button',
        className: 'sp-open',
        onClick: () => onOpen(session),
        children: [
          jsx(Avatar, {
            profile: session.profile,
            title: session.profile_title || session.profile_label,
            avatar: session.avatar,
            ctx
          }),
          jsxs('div', {
            style: { flex: 1, minWidth: 0 },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
                children: [
                  jsx('span', {
                    style: {
                      flex: 1,
                      minWidth: 0,
                      fontSize: '11.5px',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    },
                    children: session.title || session.id
                  }),
                  waiting
                    ? jsx('span', {
                        style: {
                          flex: '0 0 auto',
                          padding: '0 4px',
                          border: '1px solid color-mix(in srgb, ' + AMBER + ' 34%, transparent)',
                          borderRadius: '3px',
                          color: AMBER,
                          background: 'color-mix(in srgb, ' + AMBER + ' 12%, transparent)',
                          fontFamily: MONO,
                          fontSize: '9px',
                          lineHeight: '1.4',
                          whiteSpace: 'nowrap'
                        },
                        children: 'espera'
                      })
                    : null,
                  jsx('span', {
                    title:
                      session.profile_title || session.profile_label || session.profile || 'default',
                    style: {
                      flex: '0 0 auto',
                      maxWidth: '92px',
                      padding: '0 3px',
                      border: '1px solid ' + BORDER,
                      borderRadius: '3px',
                      color: MUTED,
                      fontFamily: MONO,
                      fontSize: '8.5px',
                      lineHeight: '1.4',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    },
                    children:
                      session.profile_title || session.profile_label || session.profile || 'default'
                  })
                ]
              }),
              stopFailed
                ? jsx('div', {
                    style: { marginTop: '2px', fontFamily: MONO, fontSize: '9px', color: WARN },
                    children: stop.message
                  })
                : stopDone
                  ? jsx('div', {
                      style: { marginTop: '2px', fontFamily: MONO, fontSize: '9px', color: GREEN },
                      children: 'interrumpida'
                    })
                  : jsxs('div', {
                      style: {
                        marginTop: '2px',
                        display: 'flex',
                        gap: '6px',
                        minWidth: 0,
                        fontFamily: MONO,
                        fontSize: '9.5px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      },
                      children: [
                        session.tool
                          ? jsx('span', {
                              style: { color: VIOLET, flex: '0 0 auto' },
                              children: session.tool
                            })
                          : null,
                        activity.text
                          ? jsx('span', {
                              style: {
                                color: activity.warn ? WARN : MUTED,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                              },
                              children: activity.text
                            })
                          : null
                      ]
                    })
            ]
          })
        ]
      }),
      jsx('span', {
        style: {
          flex: '0 0 auto',
          minWidth: '42px',
          textAlign: 'right',
          fontFamily: MONO,
          fontSize: '9px',
          color: waiting ? AMBER : MUTED
        },
        children: when
      }),
      canStop
        ? jsx('button', {
            type: 'button',
            className: 'sp-stop',
            'aria-label': 'interrumpir ' + (session.title || session.id),
            disabled: sending,
            onClick: event => {
              event.stopPropagation()
              onStop(session)
            },
            style: {
              flex: '0 0 auto',
              width: '56px',
              textAlign: 'center',
              border: '1px solid ' + (confirming ? ORANGE : BORDER),
              borderRadius: '5px',
              background: confirming ? ORANGE : 'transparent',
              color: confirming ? ACCENT_INK : MUTED,
              fontFamily: MONO,
              fontSize: '9px',
              lineHeight: 1.4,
              padding: '1px 4px',
              cursor: sending ? 'default' : 'pointer'
            },
            children: stopLabel
          })
        : null,
      jsx('button', {
        type: 'button',
        'aria-label': 'copiar id de ' + (session.title || session.id),
        onClick: event => {
          event.stopPropagation()
          onCopy(session)
        },
        style: {
          flex: '0 0 auto',
          width: '52px',
          textAlign: 'center',
          border: '1px solid ' + BORDER,
          borderRadius: '5px',
          background: 'transparent',
          color: copied ? GREEN : MUTED,
          fontFamily: MONO,
          fontSize: '9px',
          lineHeight: 1.4,
          padding: '1px 4px',
          cursor: 'pointer'
        },
        children: copied ? 'copiado' : 'copiar'
      })
    ]
  })
}

/**
 * The full panel.
 *
 * Registered as `radar:panel` with `placement: 'right'` and a 380 px width, so
 * the Desktop tiles it into the right sidebar role instead of floating it. The
 * floating card stays the quick view. Like the quick view, it owns its interval
 * and its `plugin.radar.changed` subscription: no `lifecycleKeepAlive`.
 */
function RadarPanel({ ctx, fullPage = false }) {
  const [snapshot, setSnapshot] = useState(null)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [offline, setOffline] = useState(false)
  const [stopping, setStopping] = useState({})
  const [copied, setCopied] = useState({})
  const [pipActive, setPipActive] = useState(() => isRadarPipActive())
  const [query, setQuery] = useState('')
  const mounted = useRef(true)
  const debounce = useRef(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => {
    enterFullView(ctx)
    return () => {
      exitFullView(ctx)
    }
  }, [ctx])

  const load = useCallback(async () => {
    try {
      const data = await ctx.rest(livePathFor(settingsRef.current))
      if (!mounted.current) return
      setSnapshot(data)
      setOffline(false)
      updateRadarPipSnapshot(ctx, data)
    } catch (_error) {
      if (!mounted.current) return
      setOffline(true)
    }
  }, [ctx])

  useEffect(() => {
    mounted.current = true
    let alive = true

    Promise.all([
      readSetting(ctx, SETTING_KEYS.filter, DEFAULT_SETTINGS.filter),
      readSetting(ctx, SETTING_KEYS.profiles, DEFAULT_SETTINGS.profiles),
      readSetting(ctx, SETTING_KEYS.window, DEFAULT_SETTINGS.window),
      readSetting(ctx, SETTING_KEYS.finished, DEFAULT_SETTINGS.finished),
      readSetting(ctx, SETTING_KEYS.density, DEFAULT_SETTINGS.density)
    ]).then(values => {
      if (!alive) return
      const next = {
        filter: ['all', 'working', 'waiting', 'problem'].includes(values[0]) ? values[0] : 'all',
        profiles: values[1] === 'current' ? 'current' : 'all',
        window: WINDOW_CHOICES.includes(Number(values[2])) ? Number(values[2]) : 180,
        finished: values[3] !== false && values[3] !== 'false',
        density: values[4] === 'compact' ? 'compact' : 'comfortable'
      }
      settingsRef.current = next
      setSettings(next)
      load()
    })

    load()
    const interval = setInterval(load, REFRESH_MS)
    const offPip = subscribeRadarPip(active => {
      if (mounted.current) setPipActive(active)
    })
    const off = host.onEvent('plugin.radar.changed', () => {
      if (debounce.current) clearTimeout(debounce.current)
      debounce.current = setTimeout(() => {
        debounce.current = 0
        load()
      }, EVENT_DEBOUNCE_MS)
    })
    return () => {
      alive = false
      mounted.current = false
      clearInterval(interval)
      if (debounce.current) clearTimeout(debounce.current)
      if (typeof offPip === 'function') offPip()
      if (typeof off === 'function') off()
    }
  }, [ctx, load])

  const changeSetting = useCallback(
    (key, value) => {
      const next = { ...settingsRef.current, [key]: value }
      settingsRef.current = next
      setSettings(next)
      writeSetting(ctx, SETTING_KEYS[key], value)
      if (key === 'profiles' || key === 'window') load()
    },
    [ctx, load]
  )

  const open = useCallback(session => {
    const profile = String(session.profile || '').trim()
    const request = profile ? host.openSession(session.id, { profile }) : host.openSession(session.id)
    Promise.resolve(request).catch(error => {
      if (typeof host.notify === 'function') {
        host.notify({ kind: 'error', message: 'No se pudo abrir la sesión: ' + messageOf(error) })
      }
    })
  }, [])

  const stop = useCallback(
    session => {
      const current = stopping[session.id]
      const now = Date.now()
      if (current && current.phase === 'confirm' && current.until > now) {
        setStopping(state => ({ ...state, [session.id]: { phase: 'sending' } }))
        interruptSession(ctx, session, livePathFor(settingsRef.current))
          .then(() => {
            if (!mounted.current) return
            setStopping(state => ({
              ...state,
              [session.id]: { phase: 'done', until: Date.now() + INTERRUPTED_MS }
            }))
            load()
          })
          .catch(error => {
            if (!mounted.current) return
            setStopping(state => ({
              ...state,
              [session.id]: { phase: 'error', message: messageOf(error) }
            }))
          })
        return
      }
      setStopping(state => ({
        ...state,
        [session.id]: { phase: 'confirm', until: Date.now() + CONFIRM_MS }
      }))
    },
    [ctx, load, stopping]
  )

  const copy = useCallback(
    session => {
      copySessionId(ctx, session).then(ok => {
        if (!ok || !mounted.current) return
        setCopied(state => ({ ...state, [session.id]: true }))
        setTimeout(() => {
          if (!mounted.current) return
          setCopied(state => {
            const next = { ...state }
            delete next[session.id]
            return next
          })
        }, 1600)
      })
    },
    [ctx]
  )

  const data = snapshot || {}
  const totals = data.totals || {}
  const now = Date.now()
  const sessions = (Array.isArray(data.sessions) ? data.sessions : []).filter(
    session => session.state !== 'dormant'
  )

  const workingCount =
    totals.working !== undefined
      ? totals.working
      : (totals.running || 0) + (totals.queued || 0)
  const waitingCount = totals.waiting !== undefined ? totals.waiting : totals.idle || 0
  const stalledCount = totals.stalled || 0

  const filterCounts = {
    all: sessions.filter(
      session => settings.finished !== false || !TERMINAL_STATES.includes(session.state)
    ).length,
    working: sessions.filter(
      session => session.state === 'running' || session.state === 'queued'
    ).length,
    waiting: sessions.filter(session => session.state === 'idle').length,
    problem: sessions.filter(
      session =>
        session.state === 'stalled' ||
        (session.state === 'failed' && settings.finished !== false)
    ).length
  }
  const trimmedQuery = String(query || '').trim().toLowerCase()
  const filteredByQuery = trimmedQuery
    ? sessions.filter(session => {
        const hay = [
          session.title,
          session.id,
          session.profile_title,
          session.profile_label,
          session.profile,
          session.tool,
          session.activity,
          session.model,
          session.git_branch
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return hay.includes(trimmedQuery)
      })
    : sessions

  const visible = sessionsForFilter(filteredByQuery, settings.filter)
  // Only non-empty groups are painted: the header counters already carry the
  // zero counts, and a filtered view should not spend its height on empties.
  const groups = panelGroups(visible, settings).filter(group => group.items.length > 0)
  const shown = groups.reduce((total, group) => total + group.items.length, 0)
  const compact = settings.density === 'compact'
  const age = data.generated_at ? Math.max(0, Math.floor(now / 1000) - Number(data.generated_at)) : 0
  const profileErrors = Object.keys(data.profile_errors || {})

  const counters = [
    { key: 'working', label: 'trabajando', value: workingCount, color: FG },
    { key: 'waiting', label: 'esperando', value: waitingCount, color: waitingCount ? AMBER : MUTED },
    // `problem` is the filter that covers stalled rows; the label stays "colgadas".
    { key: 'problem', label: 'colgadas', value: stalledCount, color: stalledCount ? DESTRUCTIVE : MUTED }
  ]

  const select = (label, value, options, onChange) =>
    jsxs('label', {
      style: { display: 'grid', gap: '2px', fontFamily: MONO, fontSize: '9.5px', color: MUTED },
      children: [
        label,
        jsx('select', {
          value,
          onChange: event => onChange(event.target.value),
          style: {
            width: '100%',
            padding: '2px 4px',
            border: '1px solid ' + BORDER,
            borderRadius: '5px',
            background: CARD,
            color: FG,
            fontFamily: MONO,
            fontSize: '10px'
          },
          children: options.map(option =>
            jsx('option', { value: option[0], children: option[1] }, option[0])
          )
        })
      ]
    })

  return jsxs('div', {
    style: {
      height: '100%',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      background: CARD,
      color: FG,
      fontFamily: SANS,
      overflow: 'hidden'
    },
    children: [
      jsx('style', { children: ANIMATION_CSS }),
      fullPage
        ? jsxs('div', {
            className: 'sp-page-head',
            style: {
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
              padding: '12px 14px 10px',
              borderBottom: '1px solid ' + BORDER
            },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
                children: [
                  jsx('span', {
                    'aria-hidden': true,
                    style: {
                      width: '22px',
                      height: '22px',
                      borderRadius: '6px',
                      background: ORANGE,
                      color: ACCENT_INK,
                      fontFamily: MONO,
                      fontSize: '10px',
                      fontWeight: 800,
                      display: 'grid',
                      placeItems: 'center'
                    },
                    children: 'RD'
                  }),
                  jsx('span', {
                    style: { fontSize: '15px', fontWeight: 700, letterSpacing: '.2px' },
                    children: 'Radar'
                  })
                ]
              }),
              jsx('input', {
                type: 'search',
                value: query,
                'aria-label': 'buscar sesiones',
                placeholder: 'Filtrar por sesión, herramienta, perfil, modelo o rama…',
                onChange: event => setQuery(event.target.value),
                style: {
                  flex: '1 1 200px',
                  minWidth: '140px',
                  maxWidth: '380px',
                  padding: '4px 8px',
                  border: '1px solid ' + BORDER,
                  borderRadius: '6px',
                  background: 'transparent',
                  color: FG,
                  fontFamily: SANS,
                  fontSize: '11.5px'
                }
              }),
              jsx('span', { style: { flex: 1 } }),
              jsx('button', {
                type: 'button',
                className: 'sp-pip' + (pipActive ? ' sp-pip-on' : ''),
                'aria-pressed': pipActive ? 'true' : 'false',
                'aria-label': 'siempre encima',
                title: 'Mantener mini-ventana siempre encima aunque minimices Hermes',
                onClick: () => {
                  toggleRadarPip(ctx, snapshot)
                },
                style: {
                  appearance: 'none',
                  padding: '4px 8px',
                  border: '1px solid ' + (pipActive ? ORANGE : BORDER),
                  borderRadius: '6px',
                  background:
                    pipActive ? 'color-mix(in srgb, ' + ORANGE + ' 16%, transparent)' : 'transparent',
                  color: pipActive ? FG : MUTED,
                  fontFamily: MONO,
                  fontSize: '10px',
                  fontWeight: pipActive ? 700 : 500,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                },
                children: pipActive ? '📌 Siempre encima (activo)' : '📌 Siempre encima'
              }),
              typeof host.revealPane === 'function'
                ? jsx('button', {
                    type: 'button',
                    className: 'sp-expand',
                    'aria-label': 'expandir panel lateral',
                    title: 'Mostrar también en el panel lateral derecho',
                    onClick: expandRadarPanel,
                    style: {
                      appearance: 'none',
                      padding: '4px 8px',
                      border: '1px solid ' + BORDER,
                      borderRadius: '6px',
                      background: 'transparent',
                      color: MUTED,
                      fontFamily: MONO,
                      fontSize: '10px',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap'
                    },
                    children: '⤢ Panel lateral'
                  })
                : null
            ]
          })
        : null,
      jsxs('div', {
        style: {
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: fullPage ? '10px 14px 8px' : '8px 8px 6px',
          borderBottom: '1px solid ' + BORDER
        },
        children: [
          ...counters.map(counter =>
            jsxs(
              'button',
              {
                type: 'button',
                'data-counter': counter.key,
                onClick: () => changeSetting('filter', counter.key),
                style: {
                  flex: 1,
                  minWidth: 0,
                  display: 'grid',
                  gap: '1px',
                  padding: '4px 6px',
                  border: '1px solid ' + BORDER,
                  borderRadius: '7px',
                  background: 'transparent',
                  color: counter.color,
                  textAlign: 'left',
                  cursor: 'pointer'
                },
                children: [
                  jsx('b', { style: { fontSize: '19px', lineHeight: 1, fontWeight: 700 }, children: String(counter.value) }),
                  jsx('span', {
                    style: { fontFamily: MONO, fontSize: '9px', color: MUTED, whiteSpace: 'nowrap' },
                    children: counter.label
                  })
                ]
              },
              counter.key
            )
          ),
          !fullPage
            ? jsx('button', {
                type: 'button',
                className: 'sp-pip' + (pipActive ? ' sp-pip-on' : ''),
                'aria-pressed': pipActive ? 'true' : 'false',
                'aria-label': 'siempre encima',
                title: 'Siempre encima (Picture-in-Picture al minimizar)',
                onClick: () => {
                  toggleRadarPip(ctx, snapshot)
                },
                style: {
                  appearance: 'none',
                  flex: '0 0 auto',
                  padding: '4px 6px',
                  border: '1px solid ' + (pipActive ? ORANGE : BORDER),
                  borderRadius: '6px',
                  background:
                    pipActive ? 'color-mix(in srgb, ' + ORANGE + ' 16%, transparent)' : 'transparent',
                  color: pipActive ? FG : MUTED,
                  fontFamily: MONO,
                  fontSize: '10px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                },
                children: '📌'
              })
            : null,
          jsxs('details', {
            style: { position: 'relative', flex: '0 0 auto' },
            children: [
              jsx('summary', {
                style: {
                  cursor: 'pointer',
                  fontFamily: MONO,
                  fontSize: '9.5px',
                  color: MUTED,
                  padding: '4px 5px',
                  border: '1px solid ' + BORDER,
                  borderRadius: '6px',
                  whiteSpace: 'nowrap'
                },
                children: 'Ajustes'
              }),
              jsxs('div', {
                style: {
                  position: 'absolute',
                  right: 0,
                  top: '100%',
                  zIndex: 20,
                  width: '188px',
                  display: 'grid',
                  gap: '6px',
                  marginTop: '4px',
                  padding: '8px',
                  border: '1px solid ' + BORDER,
                  borderRadius: '8px',
                  background: CARD,
                  boxShadow: '0 8px 22px rgba(0, 0, 0, .28)'
                },
                children: [
                  select(
                    'Perfiles',
                    settings.profiles,
                    [
                      ['all', 'Todos'],
                      ['current', 'Solo el actual']
                    ],
                    value => changeSetting('profiles', value)
                  ),
                  select(
                    'Ventana',
                    String(settings.window),
                    [
                      ['60', '1 min'],
                      ['180', '3 min'],
                      ['600', '10 min']
                    ],
                    value => changeSetting('window', Number(value))
                  ),
                  select(
                    'Mostrar terminadas',
                    settings.finished ? 'true' : 'false',
                    [
                      ['true', 'sí'],
                      ['false', 'no']
                    ],
                    value => changeSetting('finished', value === 'true')
                  ),
                  select(
                    'Densidad',
                    settings.density,
                    [
                      ['compact', 'compacta'],
                      ['comfortable', 'cómoda']
                    ],
                    value => changeSetting('density', value)
                  )
                ]
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        style: {
          flex: '0 0 auto',
          display: 'flex',
          gap: '3px',
          padding: fullPage ? '8px 14px 0' : '6px 8px 0'
        },
        children: PANEL_FILTERS.map(tab =>
          jsx(
            'button',
            {
              type: 'button',
              'data-filter': tab.key,
              onClick: () => changeSetting('filter', tab.key),
              style: {
                flex: 1,
                padding: '3px 4px',
                border: '1px solid ' + (settings.filter === tab.key ? BORDER : 'transparent'),
                borderRadius: '6px',
                background:
                  settings.filter === tab.key ? 'color-mix(in srgb, ' + FG + ' 8%, transparent)' : 'transparent',
                color: settings.filter === tab.key ? FG : MUTED,
                fontFamily: MONO,
                fontSize: '9px',
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              },
              children: tab.label + ' ' + (filterCounts[tab.key] || 0)
            },
            tab.key
          )
        )
      }),
      shown
        ? jsx('div', {
            style: {
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              padding: fullPage ? '6px 14px 10px' : '4px 6px 6px',
              scrollbarWidth: 'thin'
            },
            children: groups.map(group =>
              jsxs(
                'section',
                {
                  children: [
                    jsxs('div', {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 4px 3px',
                        fontFamily: MONO,
                        fontSize: '9px',
                        color: MUTED,
                        letterSpacing: '.3px',
                        textTransform: 'uppercase'
                      },
                      children: [
                        jsx('span', { style: { flex: 1 }, children: group.label }),
                        jsx('span', { children: String(group.items.length) })
                      ]
                    }),
                    fullPage
                      ? jsx('div', {
                          style: {
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
                            gap: '6px'
                          },
                          children: group.items.map(session =>
                            jsx(
                              PanelRow,
                              {
                                session,
                                now,
                                compact,
                                stop: stopping[session.id],
                                copied: Boolean(copied[session.id]),
                                onOpen: open,
                                onStop: stop,
                                onCopy: copy,
                                ctx
                              },
                              session.id
                            )
                          )
                        })
                      : group.items.map(session =>
                          jsx(
                            PanelRow,
                            {
                              session,
                              now,
                              compact,
                              stop: stopping[session.id],
                              copied: Boolean(copied[session.id]),
                              onOpen: open,
                              onStop: stop,
                              onCopy: copy,
                              ctx
                            },
                            session.id
                          )
                        )
                  ]
                },
                group.key
              )
            )
          })
        : jsxs('div', {
            style: {
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              padding: '12px',
              textAlign: 'center'
            },
            children: [
              jsx('span', { style: { fontSize: '11.5px', fontWeight: 600 }, children: 'Ninguna sesión en la ventana' }),
              jsx('span', {
                style: { fontFamily: MONO, fontSize: '9.5px', color: MUTED },
                children: (totals.dormant || 0) + ' inactivas'
              })
            ]
          }),
      jsxs('div', {
        style: {
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          minHeight: '20px',
          padding: fullPage ? '0 14px' : '0 8px',
          borderTop: '1px solid ' + BORDER,
          fontFamily: MONO,
          fontSize: '9px',
          color: MUTED
        },
        children: [
          jsx('span', {
            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: profileErrors.length
              ? 'sin conexión · ' + profileErrors.join(', ')
              : 'ventana ' + settings.window + ' s · ' + settings.profiles
          }),
          jsx('span', {
            style: offline ? { color: WARN } : undefined,
            children: offline ? 'sin conexión' : 'hace ' + age + 's'
          })
        ]
      })
    ]
  })
}

/**
 * Full-page view mounted at `/radar` when opened from the left sidebar (`sidebar.nav`).
 */
function RadarPage({ ctx }) {
  return RadarPanel({ ctx, fullPage: true })
}

/**
 * Register all Radar surfaces:
 * 1. `radar` — floating quick view (`placement: 'floating'`, S/M/L/XL).
 * 2. `radar:panel` — right side panel (`placement: 'right'`, 380 px).
 * 4. `nav` — left sidebar navigation item (`sidebar.nav` -> `/radar`).
 * 5. `page` — full-page route (`routes` at `/radar`).
 * 6. `command:open` & `command:pip` — command palette actions (`palette`).
 */
function register(ctx) {
  // The remembered size is read synchronously, so the pane never mounts at the
  // default and then jumps: the first registration is already the right one.
  registerRadarPane(ctx, storedSize(ctx))

  ctx.register({
    id: 'radar:panel',
    area: 'panes',
    title: 'Radar',
    data: {
      placement: 'right',
      width: '380px'
    },
    render: () => jsx(RadarPanel, { ctx })
  })

  ctx.register({
    id: 'nav',
    area: SIDEBAR_NAV_AREA,
    data: {
      path: RADAR_ROUTE,
      label: 'Radar',
      codicon: 'pulse'
    }
  })

  ctx.register({
    id: 'page',
    area: ROUTES_AREA,
    title: 'Radar',
    data: {
      path: RADAR_ROUTE
    },
    render: () => jsx(RadarPage, { ctx })
  })

  ctx.register({
    id: 'command:open',
    area: PALETTE_AREA,
    data: {
      id: 'radar.open',
      label: 'Radar: Abrir vista completa',
      keywords: ['radar', 'sessions', 'sesiones', 'live', 'htop'],
      run: () => openRadarPage()
    }
  })

  ctx.register({
    id: 'command:pip',
    area: PALETTE_AREA,
    data: {
      id: 'radar.pip',
      label: 'Radar: Siempre encima (Picture-in-Picture)',
      keywords: ['radar', 'pip', 'always on top', 'siempre encima', 'flotante'],
      run: () => {
        toggleRadarPip(ctx)
      }
    }
  })
}

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  version: VERSION,
  register
}
