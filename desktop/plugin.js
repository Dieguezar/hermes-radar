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

import { host } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'radar'
const PLUGIN_NAME = 'Radar'
const VERSION = '0.4.2'

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
  '.sp-stop:focus-visible{outline:2px solid ' + ORANGE + ';outline-offset:1px}' +
  '.sp-open{appearance:none;background:transparent;border:0;padding:0;margin:0;' +
  'color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0;' +
  'display:flex;align-items:center;gap:9px;flex:1}' +
  '.sp-open:focus-visible{outline:2px solid ' + ORANGE + ';outline-offset:-2px;border-radius:6px}'

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

function cachedAvatar(profile) {
  const key = String(profile || 'default').trim() || 'default'
  return AVATAR_CACHE.has(key) ? AVATAR_CACHE.get(key) : undefined
}

function loadAvatar(ctx, profile) {
  const key = String(profile || 'default').trim() || 'default'
  if (AVATAR_CACHE.has(key)) return Promise.resolve(AVATAR_CACHE.get(key))
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
      return url
    })
    .catch(() => {
      // A missing avatar is a fallback, not an error: remember it and stop asking.
      AVATAR_CACHE.set(key, null)
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
async function interruptSession(ctx, session) {
  let fresh
  try {
    fresh = await ctx.rest(LIVE_PATH)
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
            : { glyph: '●', color: DOT, label: 'ociosa' }

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
    if (!info.has_image) return undefined
    if (cachedAvatar(key) !== undefined) return undefined
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

function SessionRow({ session, now, stop, onOpen, onStop, ctx }) {
  const [hovered, setHovered] = useState(false)
  const stalled = session.state === 'stalled'
  const terminal = TERMINAL_STATES.includes(session.state)
  const confirming = stop && stop.phase === 'confirm' && stop.until > now
  const sending = stop && stop.phase === 'sending'
  const stopDone = stop && stop.phase === 'done' && stop.until > now
  const stopFailed = stop && stop.phase === 'error'
  const activity = activityFor(session, now)
  // Terminal rows keep the layout but drop the stop control: the turn already
  // ended, and offering a stop there would be a dead button.
  const canStop = Boolean(session.can_interrupt) && !terminal

  const base = stalled ? 'color-mix(in srgb, ' + DESTRUCTIVE + ' 9%, transparent)' : 'transparent'
  const background = !hovered
    ? base
    : stalled
      ? 'color-mix(in srgb, ' + DESTRUCTIVE + ' 15%, transparent)'
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
  const [snapshot, setSnapshot] = useState(null)
  const [offline, setOffline] = useState(false)
  const [stopping, setStopping] = useState({})
  const mounted = useRef(true)
  const debounce = useRef(0)

  const load = useCallback(async () => {
    try {
      const data = await ctx.rest(LIVE_PATH)
      if (!mounted.current) return
      setSnapshot(data)
      setOffline(false)
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
  const liveCount = totals.live || 0
  const dormant = totals.dormant || 0
  const finishedCount = rows.filter(session => TERMINAL_STATES.includes(session.state)).length
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
          gap: '6px',
          height: '22px',
          padding: '0 8px',
          borderTop: '1px solid ' + BORDER,
          fontFamily: MONO,
          fontSize: '9.5px',
          color: MUTED
        },
        children: [
          jsxs('span', {
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
              jsx('b', { style: { color: FG, fontWeight: 600 }, children: String(liveCount) }),
              ' live',
              // Only when it adds information: an all-live panel keeps one number.
              finishedCount
                ? jsxs('span', {
                    children: [
                      ' · ',
                      jsx('b', { style: { color: FG, fontWeight: 600 }, children: String(finishedCount) }),
                      ' terminadas'
                    ]
                  })
                : null,
              dormant
                ? jsxs('span', {
                    children: [
                      ' · ',
                      jsx('b', { style: { color: FG, fontWeight: 600 }, children: String(dormant) }),
                      ' inactivas'
                    ]
                  })
                : null
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
            style: offline ? { color: WARN } : undefined,
            children: offline ? 'sin conexión' : 'hace ' + age + 's'
          })
        ]
      })
    ]
  })
}

export default {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  version: VERSION,
  register(ctx) {
    // No `lifecycleKeepAlive`: collapse unmounts the body and stops the poll.
    ctx.register({
      id: 'radar',
      area: 'panes',
      title: 'Radar',
      data: {
        placement: 'floating',
        anchor: 'bottom-right',
        width: '320px',
        height: '214px'
      },
      render: () => jsx(RadarPane, { ctx })
    })
  }
}
