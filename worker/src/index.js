// iCloud busy-time feed: a read-only Worker for the Apps Script side (docs/icloud-spec.md §3).
//
//   GET /calendars                                           → display names of the event calendars
//   GET /version?calendars=A&calendars=B                     → ctag fingerprint of the selected calendars
//   GET /busy?calendars=A&start=ISO&end=ISO[&tz=IANA]        → busy intervals, no event text
//
// calendars=* selects every event calendar (at most MAX_CALENDARS). Every request needs
// "Authorization: Bearer <FEED_TOKEN>". Secrets: ICLOUD_APPLE_ID, ICLOUD_APP_PASSWORD, FEED_TOKEN (set in the
// Deploy to Cloudflare form, the dashboard, or wrangler secret put). Optional var CALDAV_SERVER_URL is for tests.
//
// Logs never contain the Authorization header, credentials, calendar names, ICS text, UIDs or times.

import { discoverCalendars, selectCalendars, computeVersion, queryCalendar, sha256Hex, UpstreamError } from "./caldav.js"
import { expandCalendarObjects } from "./expand.js"

const MAX_CALENDARS = 10
const MAX_WINDOW_MS = 400 * 86400000
const QUERY_MARGIN_MS = 86400000 // CalDAV range is widened by a day each side; the exact window is applied locally
const CACHE_MAX_AGE = 3600
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  },
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {{ waitUntil?: Function }} [ctx]
 * @param {{ fetchImpl?: Function, cache?: object|null, log?: Function }} [deps]  test seams
 */
export async function handleRequest(request, env, ctx, deps = {}) {
  const started = Date.now()
  const url = new URL(request.url)
  const log = deps.log || ((entry) => console.log(JSON.stringify(entry)))
  const summary = { path: url.pathname, status: 0 }

  let response
  try {
    response = await route(request, url, env, ctx, deps, summary)
  } catch (e) {
    // Unexpected bug: say nothing specific to the caller, log only the error class.
    summary.exception = (e && e.name) || "Error"
    response = json(500, { ok: false, error: "internal_error" })
  }
  summary.status = response.status
  summary.ms = Date.now() - started
  log(summary)
  return response
}

async function route(request, url, env, ctx, deps, summary) {
  if (request.method !== "GET") return json(405, { ok: false, error: "method_not_allowed" })
  if (!env.FEED_TOKEN) return json(500, { ok: false, error: "not_configured" })
  if (!(await isAuthorized(request.headers.get("Authorization"), env.FEED_TOKEN))) {
    return json(401, { ok: false, error: "unauthorized" })
  }
  if (!["/calendars", "/version", "/busy"].includes(url.pathname)) return json(404, { ok: false, error: "not_found" })
  if (!env.ICLOUD_APPLE_ID || !env.ICLOUD_APP_PASSWORD) return json(500, { ok: false, error: "not_configured" })

  const params = url.pathname === "/calendars" ? {} : parseParams(url, url.pathname === "/busy")
  if (params.error) return json(400, { ok: false, error: "bad_request", message: params.error })

  let discovered
  try {
    discovered = await discoverCalendars({
      serverUrl: env.CALDAV_SERVER_URL,
      username: env.ICLOUD_APPLE_ID,
      password: env.ICLOUD_APP_PASSWORD,
      fetchImpl: deps.fetchImpl,
    })
  } catch (e) {
    const code = e instanceof UpstreamError ? e.code : "upstream_unavailable"
    summary.upstream = code
    return json(502, { ok: false, error: code })
  }

  const allNames = [...new Set(discovered.calendars.map((c) => c.displayName))].sort()
  if (url.pathname === "/calendars") {
    summary.calendars = allNames.length
    return json(200, { ok: true, calendars: allNames.map((name) => ({ name })) })
  }

  if (params.all) {
    const matching = discovered.calendars.length
    if (matching > MAX_CALENDARS) {
      return json(400, { ok: false, error: "bad_request", message: "more than " + MAX_CALENDARS + " calendars; name them" })
    }
    params.calendars = allNames
  }
  const selected = selectCalendars(discovered.calendars, params.calendars)
  const version = await computeVersion(selected)

  if (url.pathname === "/version") {
    const calendars = selected.map((s) => (s.error ? { name: s.name, ok: false, error: s.error } : { name: s.name, ok: true }))
    summary.calendars = calendars.map((c) => (c.ok ? "ok" : c.error))
    return json(200, { ok: version !== null, version, calendars })
  }

  return busy(url, env, ctx, deps, summary, params, discovered, selected, version)
}

async function busy(url, env, ctx, deps, summary, params, discovered, selected, version) {
  const cache = deps.cache !== undefined ? deps.cache : defaultCache()
  let cacheKey = null
  if (cache && version) {
    const hash = await sha256Hex(JSON.stringify([version, params.startMs, params.endMs, params.tz, params.all ? ["*"] : [...params.calendars].sort()]))
    // Same origin as the Worker (Cloudflare's documented pattern). The path is never served: every request to the
    // Worker runs this code, which answers 401/404 for it.
    cacheKey = new URL("/__cache/busy/" + hash, url.origin).href
    try {
      const hit = await cache.match(cacheKey)
      if (hit) {
        const body = (await hit.text()).replace('"cache":"miss"', '"cache":"hit"')
        summary.cache = "hit"
        return new Response(body, { status: 200, headers: jsonHeaders() })
      }
    } catch (e) {
      cacheKey = null // cache unusable on this domain; carry on without it
    }
  }

  const selfAddresses = [env.ICLOUD_APPLE_ID]
  const queryStart = params.startMs - QUERY_MARGIN_MS
  const queryEnd = params.endMs + QUERY_MARGIN_MS

  const results = await Promise.all(selected.map(async (s) => {
    if (s.error) return { name: s.name, ok: false, error: s.error, count: 0, intervals: [] }
    let texts = []
    try {
      for (const cal of s.matches) {
        texts = texts.concat(await queryCalendar({
          url: cal.url, headers: discovered.headers, start: queryStart, end: queryEnd, fetchImpl: deps.fetchImpl,
        }))
      }
    } catch (e) {
      return { name: s.name, ok: false, error: "query_failed", count: 0, intervals: [] }
    }
    try {
      const intervals = expandCalendarObjects(texts, {
        windowStart: params.startMs, windowEnd: params.endMs, tz: params.tz, selfAddresses,
      })
      return { name: s.name, ok: true, count: intervals.length, intervals }
    } catch (e) {
      return { name: s.name, ok: false, error: "parse_failed", count: 0, intervals: [] }
    }
  }))

  const ok = results.every((r) => r.ok)
  const intervals = []
  for (const r of results) {
    for (const i of r.intervals) intervals.push({ calendar: r.name, id: i.id, start: i.start, end: i.end, allDay: i.allDay })
  }
  const calendars = results.map((r) => (r.ok
    ? { name: r.name, ok: true, count: r.count }
    : { name: r.name, ok: false, error: r.error, count: 0 }))

  const cacheState = cacheKey && ok ? "miss" : "off"
  // Key order matters: "cache" comes before any calendar name, so the hit path can rewrite it with one replace.
  const body = JSON.stringify({ ok, version, cache: cacheState, calendars, intervals })

  summary.cache = cacheState
  summary.calendars = results.map((r) => (r.ok ? r.count : r.error))

  if (cacheState === "miss") {
    const stored = new Response(body, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "max-age=" + CACHE_MAX_AGE },
    })
    const put = Promise.resolve().then(() => cache.put(cacheKey, stored)).catch(() => {})
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put)
    else await put
  }
  return new Response(body, { status: 200, headers: jsonHeaders() })
}

// ---------------------------------------------------------------------------------------------------------------

function parseParams(url, needsWindow) {
  const names = []
  for (const raw of url.searchParams.getAll("calendars")) {
    const name = raw.trim()
    if (name && !names.includes(name)) names.push(name)
  }
  if (names.length < 1) return { error: "calendars is required" }
  if (names.includes("*") && names.length > 1) return { error: "calendars=* cannot be combined with names" }
  if (names.length > MAX_CALENDARS) return { error: "at most " + MAX_CALENDARS + " calendars" }
  const all = names[0] === "*"
  if (!needsWindow) return { calendars: names, all }

  const start = url.searchParams.get("start") || ""
  const end = url.searchParams.get("end") || ""
  if (!ISO_INSTANT.test(start) || !ISO_INSTANT.test(end)) return { error: "start and end must be ISO 8601 instants" }
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { error: "start and end must be ISO 8601 instants" }
  if (!(endMs > startMs)) return { error: "end must be after start" }
  if (endMs - startMs > MAX_WINDOW_MS) return { error: "window is longer than 400 days" }

  const tz = (url.searchParams.get("tz") || "UTC").trim()
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
  } catch (e) {
    return { error: "tz must be an IANA time zone" }
  }
  return { calendars: names, all, startMs, endMs, tz }
}

// Constant-time token check: hash both values so lengths match, then compare digests
// (crypto.subtle.timingSafeEqual on Workers; a full-length XOR loop elsewhere, e.g. Node tests).
export async function isAuthorized(header, expected) {
  const match = /^Bearer (.+)$/.exec(header || "")
  const provided = match ? match[1] : ""
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ])
  const equal = typeof crypto.subtle.timingSafeEqual === "function"
    ? crypto.subtle.timingSafeEqual(a, b)
    : xorEqual(new Uint8Array(a), new Uint8Array(b))
  return equal && match !== null
}

function xorEqual(a, b) {
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function defaultCache() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null
  } catch (e) {
    return null
  }
}

function jsonHeaders() {
  return { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders() })
}
