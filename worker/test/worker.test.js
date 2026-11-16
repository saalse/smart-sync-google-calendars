import { test } from "node:test"
import assert from "node:assert/strict"
import { handleRequest, isAuthorized } from "../src/index.js"
import { createMockICloud, SERVER_URL, USER, PASSWORD } from "./mock-icloud.js"
import { ics } from "./fixtures.js"

const TOKEN = "test-feed-token-0123456789abcdef0123456789"
const ENV = { FEED_TOKEN: TOKEN, ICLOUD_APPLE_ID: USER, ICLOUD_APP_PASSWORD: PASSWORD, CALDAV_SERVER_URL: SERVER_URL }
const ORIGIN = "https://feed.example.invalid"

const EVENT_A = ics([["UID:a1", "DTSTAMP:20260101T000000Z", "DTSTART:20261117T090000Z", "DTEND:20261117T100000Z", "SUMMARY:Top secret title"]])
const EVENT_B = ics([["UID:b1", "DTSTAMP:20260101T000000Z", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261122"]])

function calendars() {
  return [
    { name: "Calendar A", path: "cal-a", ctag: "ctag-a-1", objects: [EVENT_A] },
    { name: "Calendar B + More", path: "cal-b", ctag: "ctag-b-1", objects: [EVENT_B] },
    { name: "Reminders", path: "rem", components: ["VTODO"] },
  ]
}

class FakeCache {
  constructor() { this.store = new Map(); this.puts = 0 }
  async match(key) { const v = this.store.get(String(key)); return v ? new Response(v) : undefined }
  async put(key, response) { this.puts++; this.store.set(String(key), await response.text()) }
}

function req(path, { method = "GET", token = TOKEN, query = "" } = {}) {
  const headers = token === null ? {} : { Authorization: "Bearer " + token }
  return new Request(ORIGIN + path + query, { method, headers })
}

const BUSY_QUERY = "?calendars=Calendar%20A&calendars=Calendar%20B%20%2B%20More&start=2026-11-16T00:00:00Z&end=2026-11-30T00:00:00Z&tz=Europe%2FBerlin"

async function call(request, { state = { calendars: calendars() }, env = ENV, cache = null, logs = [] } = {}) {
  const mock = createMockICloud(state)
  const res = await handleRequest(request, env, {}, { fetchImpl: mock.fetchImpl, cache, log: (e) => logs.push(e) })
  const body = await res.json()
  return { res, body, mock, logs }
}

// --- HTTP layer -------------------------------------------------------------------------------------------------

test("401 without or with a wrong token, no detail", async () => {
  for (const token of [null, "wrong", TOKEN + "x", ""]) {
    const { res, body } = await call(req("/version", { token, query: "?calendars=Calendar%20A" }))
    assert.equal(res.status, 401)
    assert.deepEqual(body, { ok: false, error: "unauthorized" })
  }
})

test("405 for non-GET, 404 for unknown path", async () => {
  assert.equal((await call(req("/busy", { method: "POST" }))).res.status, 405)
  assert.equal((await call(req("/nope"))).res.status, 404)
})

test("500 not_configured when a secret is missing", async () => {
  assert.equal((await call(req("/version"), { env: { ...ENV, FEED_TOKEN: "" } })).body.error, "not_configured")
  const { res, body } = await call(req("/version", { query: "?calendars=A" }), { env: { ...ENV, ICLOUD_APP_PASSWORD: undefined } })
  assert.equal(res.status, 500)
  assert.equal(body.error, "not_configured")
})

test("400 for bad parameters", async () => {
  const cases = [
    "/version",
    "/version?calendars=%20",
    "/version?" + Array.from({ length: 11 }, (_, i) => "calendars=C" + i).join("&"),
    "/busy?calendars=A",
    "/busy?calendars=A&start=2026-11-16&end=2026-11-17T00:00:00Z",
    "/busy?calendars=A&start=2026-11-17T00:00:00Z&end=2026-11-16T00:00:00Z",
    "/busy?calendars=A&start=2026-01-01T00:00:00Z&end=2027-03-01T00:00:00Z",
    "/busy?calendars=A&start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z&tz=Mars%2FBase",
  ]
  for (const path of cases) {
    const { res, body } = await call(req(path))
    assert.equal(res.status, 400, path)
    assert.equal(body.error, "bad_request", path)
  }
})

test("responses are JSON with no-store and no CORS", async () => {
  const { res } = await call(req("/version", { query: "?calendars=Calendar%20A" }))
  assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8")
  assert.equal(res.headers.get("Cache-Control"), "no-store")
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null)
})

test("isAuthorized compares hashed values (works without timingSafeEqual too)", async () => {
  assert.equal(await isAuthorized("Bearer " + TOKEN, TOKEN), true)
  assert.equal(await isAuthorized("Bearer " + TOKEN.slice(0, -1), TOKEN), false)
  assert.equal(await isAuthorized("Basic " + TOKEN, TOKEN), false)
  assert.equal(await isAuthorized(null, TOKEN), false)
})

test("isAuthorized uses crypto.subtle.timingSafeEqual when the runtime has it", async () => {
  const calls = []
  crypto.subtle.timingSafeEqual = (a, b) => { calls.push([a.byteLength, b.byteLength]); return Buffer.from(a).equals(Buffer.from(b)) }
  try {
    assert.equal(await isAuthorized("Bearer short", TOKEN), false)
    assert.deepEqual(calls, [[32, 32]]) // both sides hashed, so lengths always match
  } finally {
    delete crypto.subtle.timingSafeEqual
  }
})

// --- /version ---------------------------------------------------------------------------------------------------

test("/version returns ok and a stable, order-independent version", async () => {
  const one = await call(req("/version", { query: "?calendars=Calendar%20A&calendars=Calendar%20B%20%2B%20More" }))
  const two = await call(req("/version", { query: "?calendars=Calendar%20B%20%2B%20More&calendars=Calendar%20A" }))
  assert.equal(one.res.status, 200)
  assert.equal(one.body.ok, true)
  assert.match(one.body.version, /^[0-9a-f]{64}$/)
  assert.equal(one.body.version, two.body.version)
  assert.deepEqual(one.body.calendars, [{ name: "Calendar A", ok: true }, { name: "Calendar B + More", ok: true }])
  // /version does not query events.
  assert.equal(one.mock.requests.filter((r) => r.method === "REPORT").length, 0)
})

test("/version changes when a ctag changes", async () => {
  const q = { query: "?calendars=Calendar%20A" }
  const before = await call(req("/version", q))
  const cals = calendars()
  cals[0].ctag = "ctag-a-2"
  const after = await call(req("/version", q), { state: { calendars: cals } })
  assert.notEqual(before.body.version, after.body.version)
})

test("/version: missing calendar and missing ctag", async () => {
  const cals = calendars()
  cals[1].ctag = null
  const { body } = await call(req("/version", { query: "?calendars=Calendar%20A&calendars=Nope&calendars=Calendar%20B%20%2B%20More" }), { state: { calendars: cals } })
  assert.equal(body.ok, false)
  assert.equal(body.version, null)
  assert.deepEqual(body.calendars, [
    { name: "Calendar A", ok: true },
    { name: "Nope", ok: false, error: "not_found" },
    { name: "Calendar B + More", ok: false, error: "no_ctag" },
  ])
})

test("a VTODO-only list with a matching name is not a calendar", async () => {
  const { body } = await call(req("/version", { query: "?calendars=Reminders" }))
  assert.deepEqual(body.calendars, [{ name: "Reminders", ok: false, error: "not_found" }])
})

test("iCloud 401 → 502 upstream_auth; iCloud down → 502 upstream_unavailable", async () => {
  const q = { query: "?calendars=Calendar%20A" }
  const auth = await call(req("/version", q), { state: { calendars: calendars(), rejectAuth: true } })
  assert.equal(auth.res.status, 502)
  assert.equal(auth.body.error, "upstream_auth")
  const down = await call(req("/version", q), { state: { calendars: calendars(), down: true } })
  assert.equal(down.res.status, 502)
  assert.equal(down.body.error, "upstream_unavailable")
})

test("wrong app password is upstream_auth", async () => {
  const { body } = await call(req("/version", { query: "?calendars=Calendar%20A" }), { env: { ...ENV, ICLOUD_APP_PASSWORD: "wrong" } })
  assert.equal(body.error, "upstream_auth")
})

// --- /busy ------------------------------------------------------------------------------------------------------

test("/busy returns intervals, counts and the version; no event text", async () => {
  const { res, body, mock } = await call(req("/busy", { query: BUSY_QUERY }))
  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.cache, "off")
  assert.match(body.version, /^[0-9a-f]{64}$/)
  assert.deepEqual(body.calendars, [
    { name: "Calendar A", ok: true, count: 1 },
    { name: "Calendar B + More", ok: true, count: 1 },
  ])
  assert.deepEqual(body.intervals, [
    { calendar: "Calendar A", id: "a1|-", start: "2026-11-17T09:00:00Z", end: "2026-11-17T10:00:00Z", allDay: false },
    { calendar: "Calendar B + More", id: "b1|-", start: "2026-11-20", end: "2026-11-22", allDay: true },
  ])
  assert.ok(!JSON.stringify(body).includes("Top secret"))

  // One calendar-query per calendar, VEVENT time-range widened by a day, no <expand>.
  const reports = mock.requests.filter((r) => r.method === "REPORT")
  assert.equal(reports.length, 2)
  for (const r of reports) {
    assert.equal(r.depth, "1")
    assert.match(r.body, /calendar-query/)
    assert.match(r.body, /name="VEVENT"/)
    assert.match(r.body, /start="20261115T000000Z"/)
    assert.match(r.body, /end="20261201T000000Z"/)
    assert.doesNotMatch(r.body, /expand/)
  }
})

test("/busy: version equals /version for the same state", async () => {
  const busy = await call(req("/busy", { query: BUSY_QUERY }))
  const version = await call(req("/version", { query: "?calendars=Calendar%20A&calendars=Calendar%20B%20%2B%20More" }))
  assert.equal(busy.body.version, version.body.version)
})

test("/busy: 5xx on one calendar → query_failed for it only, others still returned", async () => {
  const cals = calendars()
  cals[1].status = 500
  const { body } = await call(req("/busy", { query: BUSY_QUERY }), { state: { calendars: cals } })
  assert.equal(body.ok, false)
  assert.deepEqual(body.calendars[1], { name: "Calendar B + More", ok: false, error: "query_failed", count: 0 })
  assert.equal(body.intervals.length, 1)
  assert.equal(body.intervals[0].calendar, "Calendar A")
})

test("/busy: one bad object → parse_failed for that calendar", async () => {
  const cals = calendars()
  cals[0].objects = [EVENT_A, "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n"]
  const { body } = await call(req("/busy", { query: BUSY_QUERY }), { state: { calendars: cals } })
  assert.equal(body.ok, false)
  assert.deepEqual(body.calendars[0], { name: "Calendar A", ok: false, error: "parse_failed", count: 0 })
  assert.ok(body.intervals.every((i) => i.calendar !== "Calendar A"))
})

test("/busy: missing calendar → not_found, ok false, version null", async () => {
  const { body } = await call(req("/busy", { query: BUSY_QUERY + "&calendars=Gone" }))
  assert.equal(body.ok, false)
  assert.equal(body.version, null)
  assert.deepEqual(body.calendars.at(-1), { name: "Gone", ok: false, error: "not_found", count: 0 })
  assert.equal(body.intervals.length, 2)
})

test("/busy cache: miss then hit with the same ctags; new ctag misses again", async () => {
  const cache = new FakeCache()
  const first = await call(req("/busy", { query: BUSY_QUERY }), { cache })
  assert.equal(first.body.cache, "miss")
  assert.equal(cache.puts, 1)
  const [key] = cache.store.keys()
  assert.ok(key.startsWith(ORIGIN + "/__cache/busy/"))
  assert.ok(!key.includes("Calendar") && !key.includes(TOKEN))

  const second = await call(req("/busy", { query: BUSY_QUERY }), { cache })
  assert.equal(second.body.cache, "hit")
  assert.deepEqual({ ...second.body, cache: "x" }, { ...first.body, cache: "x" })
  assert.equal(second.mock.requests.filter((r) => r.method === "REPORT").length, 0)
  assert.equal(second.res.headers.get("Cache-Control"), "no-store")

  const cals = calendars()
  cals[0].ctag = "ctag-a-2"
  const third = await call(req("/busy", { query: BUSY_QUERY }), { cache, state: { calendars: cals } })
  assert.equal(third.body.cache, "miss")
})

test("/busy cache: failed responses are not cached", async () => {
  const cache = new FakeCache()
  const cals = calendars()
  cals[1].status = 500
  const { body } = await call(req("/busy", { query: BUSY_QUERY }), { cache, state: { calendars: cals } })
  assert.equal(body.cache, "off")
  assert.equal(cache.puts, 0)
})

test("/busy cache: a throwing cache is ignored", async () => {
  const cache = { match: async () => { throw new Error("no cache here") }, put: async () => { throw new Error("no") } }
  const { body } = await call(req("/busy", { query: BUSY_QUERY }), { cache })
  assert.equal(body.ok, true)
  assert.equal(body.cache, "off")
})

test("logs contain no token, password, Apple ID, calendar names, ICS text or UIDs", async () => {
  const logs = []
  const consoleLines = []
  const original = { log: console.log, error: console.error, warn: console.warn }
  console.log = console.error = console.warn = (...args) => consoleLines.push(args.join(" "))
  try {
    await call(req("/busy", { query: BUSY_QUERY }), { logs })
    await call(req("/busy", { query: BUSY_QUERY, token: "wrong-token" }), { logs })
    const cals = calendars()
    cals[0].objects = ["garbage"]
    await call(req("/busy", { query: BUSY_QUERY }), { logs, state: { calendars: cals } })
    // Default logger goes to console.log.
    await handleRequest(req("/version", { query: "?calendars=Calendar%20A" }), ENV, {}, { fetchImpl: createMockICloud({ calendars: calendars() }).fetchImpl })
  } finally {
    Object.assign(console, original)
  }
  const text = JSON.stringify(logs) + consoleLines.join("\n")
  for (const secret of [TOKEN, "wrong-token", PASSWORD, USER, "Calendar A", "Calendar B", "Top secret", "a1|", "BEGIN:VCALENDAR", "2026-11-17"]) {
    assert.ok(!text.includes(secret), "log leaked: " + secret)
  }
  assert.ok(logs.length >= 3)
  assert.deepEqual(Object.keys(logs[0]).sort(), ["cache", "calendars", "ms", "path", "status"])
})
