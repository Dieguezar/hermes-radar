/**
 * Behaviour tests for `desktop/plugin.js`.
 *
 * The plugin is a real ESM module that imports React and the Hermes SDK, none
 * of which exist in this container. To exercise its logic, this harness strips
 * the import lines, injects tiny stubs for the hooks and the JSX factory, and
 * imports the result. That is enough to drive `interruptSession`, `SessionRow`
 * and `RadarPane` as plain functions and assert on the tree they build.
 *
 * Run directly (`node tests/desktop_behaviour.test.mjs`) or through
 * `tests/test_api.py`, which invokes it as a subprocess.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

const body = source
  .replace(/^import .*$/gm, '')
  .replace(/\nexport default \{[\s\S]*$/, '')

const stubs = `
const host = globalThis.__SP_HOST__
const useState = (initial) => {
  const queue = globalThis.__SP_STATE__ || []
  const value = queue.length ? queue.shift() : (typeof initial === 'function' ? initial() : initial)
  return [value, () => {}]
}
const useEffect = () => {}
const useRef = (value) => ({ current: value })
const useCallback = (fn) => fn
const jsx = (type, props) => ({ type, props: props || {} })
const jsxs = jsx
`

const exported = [
  'interruptSession',
  'activityFor',
  'SessionRow',
  'RadarPane',
  'Avatar',
  'avatarFor',
  'loadAvatar',
  'cachedAvatar',
  'shapeOf',
  'SHAPE_ORDER',
  'fmtAgo',
  'messageOf',
  'ANIMATION_CSS',
  'AVATARS',
  'FG'
]

const dir = mkdtempSync(join(tmpdir(), 'radar-js-'))
const modulePath = join(dir, 'plugin-under-test.mjs')
writeFileSync(modulePath, stubs + body + '\nexport { ' + exported.join(', ') + ' }\n')

const hostStub = {
  state: { profile: { get: () => 'default' } },
  request: async () => ({ status: 'interrupted' }),
  profileRoutes: async () => [],
  requestProfile: async () => ({ status: 'interrupted' }),
  openSession: async () => {},
  notify: () => {},
  onEvent: () => () => {}
}
globalThis.__SP_HOST__ = hostStub
globalThis.__SP_STATE__ = []

const mod = await import(pathToFileURL(modulePath).href)

// ---------------------------------------------------------------------------
// Tiny assertion helpers over the JSX tree
// ---------------------------------------------------------------------------

function walk(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) for (const child of children) walk(child, out)
  else if (children !== undefined) walk(children, out)
  return out
}

function strings(node) {
  return walk(node)
    .map(item => item.props && item.props.children)
    .filter(value => typeof value === 'string')
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000

function freshRow(overrides = {}) {
  return {
    id: 's1',
    profile: 'default',
    profile_label: 'default',
    title: 'Session one',
    state: 'running',
    can_interrupt: true,
    execution_generation: 4,
    last_activity_at: NOW_S - 20,
    elapsed_s: 20,
    tool: null,
    activity: '',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 4. The interrupt is fenced by a fresh /live read
// ---------------------------------------------------------------------------

test('interrupt aborts before the RPC when the generation moved', async () => {
  const calls = []
  hostStub.request = async (method, params) => {
    calls.push({ method, params })
    return { status: 'interrupted' }
  }
  const ctx = {
    rest: async () => ({ sessions: [freshRow({ execution_generation: 5 })] })
  }

  await assert.rejects(
    mod.interruptSession(ctx, freshRow({ execution_generation: 4 })),
    /cambió de turno/
  )
  assert.equal(calls.length, 0, 'the RPC must not fire for a stale row')
})

test('interrupt sends the generation it just re-read', async () => {
  const calls = []
  hostStub.request = async (method, params) => {
    calls.push({ method, params })
    return { status: 'interrupted' }
  }
  const ctx = { rest: async () => ({ sessions: [freshRow({ execution_generation: 7 })] }) }

  await mod.interruptSession(ctx, freshRow({ execution_generation: 7 }))
  assert.deepEqual(calls, [
    { method: 'session.interrupt', params: { session_id: 's1', execution_generation: 7 } }
  ])
})

test('interrupt refuses a row that left the window or stopped running', async () => {
  let called = false
  hostStub.request = async () => {
    called = true
    return { status: 'interrupted' }
  }

  await assert.rejects(
    mod.interruptSession({ rest: async () => ({ sessions: [] }) }, freshRow()),
    /ya no está en la ventana/
  )
  await assert.rejects(
    mod.interruptSession(
      { rest: async () => ({ sessions: [freshRow({ state: 'idle' })] }) },
      freshRow()
    ),
    /ya no está corriendo/
  )
  assert.equal(called, false)
})

test('a null generation never invents an execution_generation param', async () => {
  const calls = []
  hostStub.request = async (method, params) => {
    calls.push({ method, params })
    return { status: 'interrupted' }
  }
  await mod.interruptSession(
    { rest: async () => ({ sessions: [freshRow({ execution_generation: null })] }) },
    freshRow({ execution_generation: null })
  )
  assert.deepEqual(calls, [{ method: 'session.interrupt', params: { session_id: 's1' } }])
})

test('a not_interrupted receipt is an error, not a success', async () => {
  hostStub.request = async () => ({ status: 'not_interrupted' })
  await assert.rejects(
    mod.interruptSession({ rest: async () => ({ sessions: [freshRow()] }) }, freshRow()),
    /no interrumpió/
  )
})

// ---------------------------------------------------------------------------
// 13. Stalled rows say how long the heartbeat has been missing
// ---------------------------------------------------------------------------

test('a stalled row reports how long it has been silent', () => {
  const activity = mod.activityFor(
    { state: 'stalled', last_activity_at: NOW_S - 720 },
    NOW_MS
  )
  assert.equal(activity.text, 'sin latido hace 12 min')
  assert.equal(activity.warn, true)
  assert.equal(mod.fmtAgo(NOW_S - 720, NOW_MS), '12 min')
})

// ---------------------------------------------------------------------------
// 2 and 19. The stop control is mounted, reachable and not nested in a role
// ---------------------------------------------------------------------------

test('the stop button is mounted without hover and the row has no role=button', () => {
  globalThis.__SP_STATE__ = []
  const tree = mod.SessionRow({
    session: freshRow(),
    now: NOW_MS,
    stop: undefined,
    onOpen: () => {},
    onStop: () => {}
  })

  const nodes = walk(tree)
  const stop = nodes.find(node => node.props && node.props.className === 'sp-stop')
  assert.ok(stop, 'the stop button must be in the tree before any hover')
  assert.equal(stop.type, 'button')
  assert.match(stop.props['aria-label'], /^interrumpir /)
  assert.notEqual(stop.props.disabled, true)

  const open = nodes.find(node => node.props && node.props.className === 'sp-open')
  assert.ok(open, 'the row needs a real open button')
  assert.equal(open.type, 'button')

  assert.equal(
    nodes.some(node => node.props && node.props.role === 'button'),
    false,
    'no div should impersonate a button'
  )
})

test('the reveal CSS uses focus-within and keeps the button focusable', () => {
  assert.match(mod.ANIMATION_CSS, /\.sp-row:hover \.sp-stop/)
  assert.match(mod.ANIMATION_CSS, /\.sp-row:focus-within \.sp-stop/)
  assert.match(mod.ANIMATION_CSS, /\.sp-stop:focus-visible/)
  assert.match(mod.ANIMATION_CSS, /opacity:0/)
  assert.doesNotMatch(mod.ANIMATION_CSS, /visibility:hidden/)
})

test('a non-interruptible row renders no stop button', () => {
  globalThis.__SP_STATE__ = []
  const tree = mod.SessionRow({
    session: freshRow({ state: 'queued', can_interrupt: false }),
    now: NOW_MS,
    stop: undefined,
    onOpen: () => {},
    onStop: () => {}
  })
  assert.equal(
    walk(tree).some(node => node.props && node.props.className === 'sp-stop'),
    false
  )
})

// ---------------------------------------------------------------------------
// 3. Avatar ink is theme-derived, never a fixed light-only hex
// ---------------------------------------------------------------------------

test('avatar ink derives from the theme foreground', () => {
  assert.ok(mod.FG.includes('--dt-foreground'))
  for (const variant of mod.AVATARS) {
    assert.equal(variant.color, mod.FG, JSON.stringify(variant))
    assert.match(variant.background, /var\(--(foreground|dt-foreground)\)/)
  }
})

// ---------------------------------------------------------------------------
// 12. The pane footer names profiles that failed to load
// ---------------------------------------------------------------------------

test('the footer names profile_errors instead of hiding them', () => {
  const snapshot = {
    generated_at: NOW_S - 3,
    profiles: ['default'],
    window_s: 180,
    sessions: [freshRow()],
    totals: { running: 1, live: 1, dormant: 0, sessions: 1 },
    profile_errors: { broken: 'OperationalError: disk I/O error' }
  }
  globalThis.__SP_STATE__ = [snapshot, false, {}]
  const tree = mod.RadarPane({ ctx: { rest: async () => snapshot } })
  const text = strings(tree).join(' | ')
  assert.match(text, /sin conexión · broken/)
})

test('the footer keeps no error segment when every profile loaded', () => {
  const snapshot = {
    generated_at: NOW_S - 3,
    profiles: ['default'],
    window_s: 180,
    sessions: [freshRow()],
    totals: { running: 1, live: 1, dormant: 0, sessions: 1 }
  }
  globalThis.__SP_STATE__ = [snapshot, false, {}]
  const tree = mod.RadarPane({ ctx: { rest: async () => snapshot } })
  assert.doesNotMatch(strings(tree).join(' | '), /sin conexión/)
})

// ---------------------------------------------------------------------------
// 4. Real profile avatars: one request per profile, cached in the module
// ---------------------------------------------------------------------------

test('an avatar is requested once per profile and cached', async () => {
  const paths = []
  const ctx = {
    rest: async path => {
      paths.push(path)
      return { data_url: 'data:image/png;base64,Q0FDSEU=' }
    }
  }

  const first = await mod.loadAvatar(ctx, 'cache-probe')
  const second = await mod.loadAvatar(ctx, 'cache-probe')
  const concurrent = await Promise.all([
    mod.loadAvatar(ctx, 'cache-probe'),
    mod.loadAvatar(ctx, 'cache-probe')
  ])

  assert.equal(paths.length, 1, JSON.stringify(paths))
  assert.equal(paths[0], '/avatar/cache-probe')
  assert.equal(first, 'data:image/png;base64,Q0FDSEU=')
  assert.equal(second, first)
  assert.deepEqual(concurrent, [first, first])
  assert.equal(mod.cachedAvatar('cache-probe'), first)
})

test('a failed avatar lookup caches the fallback instead of retrying', async () => {
  let calls = 0
  const ctx = {
    rest: async () => {
      calls += 1
      throw new Error('offline')
    }
  }
  assert.equal(await mod.loadAvatar(ctx, 'broken-probe'), null)
  assert.equal(await mod.loadAvatar(ctx, 'broken-probe'), null)
  assert.equal(calls, 1)
  assert.equal(mod.cachedAvatar('broken-probe'), null)
})

test('Avatar renders the real <img> once the cache is warm', async () => {
  await mod.loadAvatar(
    { rest: async () => ({ data_url: 'data:image/png;base64,SU1H' }) },
    'img-probe'
  )
  globalThis.__SP_STATE__ = []

  const node = mod.Avatar({
    profile: 'img-probe',
    title: 'Maca',
    avatar: { has_image: true, shape: 'blobatar', color: '#ff4d00' },
    ctx: {}
  })

  assert.equal(node.type, 'img')
  assert.equal(node.props.src, 'data:image/png;base64,SU1H')
  assert.equal(node.props.alt, '')
  assert.equal(node.props.width, 30)
  assert.equal(node.props.height, 30)
  assert.equal(node.props.style.width, '30px')
  assert.equal(node.props.style.height, '30px')
  assert.equal(node.props.style.borderRadius, '22%')
  assert.equal(node.props.style.objectFit, 'cover')
})

test('Avatar uses a soft square for a photo profile with no image', () => {
  globalThis.__SP_STATE__ = []
  const node = mod.Avatar({
    profile: 'photo-probe',
    title: 'Maca',
    avatar: { has_image: false, shape: 'hexagon', color: '#ff4d00', image_kind: 'photo' },
    ctx: {}
  })

  assert.notEqual(node.type, 'img')
  assert.equal(node.props.style.borderRadius, '22%')
  assert.equal(node.props.style.clipPath, undefined, 'photo fallback must not clip')
  assert.equal(node.props.style.width, '30px')
  assert.equal(node.props.style.height, '30px')
  assert.equal(node.props.style.flex, '0 0 30px')
  assert.equal(node.props.children.props.children, 'M')
})

test('Avatar paints the stored shape, color and initial when there is no PNG', () => {
  globalThis.__SP_STATE__ = []
  const node = mod.Avatar({
    profile: 'shape-probe',
    title: 'Writera',
    avatar: { has_image: false, shape: 'hexagon', color: '#12ab34' },
    ctx: {}
  })

  assert.notEqual(node.type, 'img')
  assert.match(node.props.style.clipPath, /polygon/)
  assert.match(node.props.style.background, /#12ab34/)
  assert.match(node.props.style.background, /color-mix/)
  assert.equal(node.props.style.width, '30px')
  assert.equal(node.props.style.height, '30px')
  assert.equal(node.props.style.flex, '0 0 30px')
  assert.equal(node.props.style.borderRadius, undefined, 'a silhouette is not a soft square')
  assert.equal(node.props.children.props.children, 'W')
})

test('the open button leaves 9px between the avatar and the title', () => {
  assert.match(mod.ANIMATION_CSS, /\.sp-open\{[^}]*gap:9px/)
})

test('shapeOf understands blobatar kinds and stays stable per name', () => {
  assert.equal(mod.shapeOf('blobatar:rkr2yf0m:cloud', 'marketer'), 'cloud')
  assert.equal(mod.shapeOf('blobatar::hexagon', 'maca'), 'hexagon')
  assert.equal(mod.shapeOf('squircle', 'maca'), 'squircle')
  const first = mod.shapeOf('blobatar', 'maca')
  const second = mod.shapeOf('blobatar', 'maca')
  assert.equal(first, second)
  assert.ok(mod.SHAPE_ORDER.includes(first), first)
  assert.ok(mod.SHAPE_ORDER.includes(mod.shapeOf(undefined, 'maca')))
})

test('the row badge shows profile_title instead of the slug', () => {
  const tree = mod.SessionRow({
    session: freshRow({
      profile: 'maca',
      profile_label: 'maca',
      profile_title: 'Maca',
      avatar: { has_image: true, shape: 'blobatar', color: '#ff4d00' }
    }),
    now: NOW_MS,
    stop: undefined,
    onOpen: () => {},
    onStop: () => {},
    ctx: { rest: async () => ({ data_url: null }) }
  })

  const text = strings(tree)
  assert.ok(text.includes('Maca'), JSON.stringify(text))
  assert.equal(text.includes('maca'), false, JSON.stringify(text))
})

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log('PASS ' + name)
  } catch (error) {
    failures += 1
    console.error('FAIL ' + name)
    console.error(error && error.stack ? error.stack : error)
  }
}

console.log(`\n${tests.length - failures}/${tests.length} passed`)
process.exit(failures ? 1 : 0)
