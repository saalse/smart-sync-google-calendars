// MirrorBusy.gs: Busy Time (+ extra providers) → proxy calendar as plain "Busy". Synthetic data only, no network.
process.env.TZ = "UTC"

const { test } = require("node:test")
const assert = require("node:assert/strict")
const { load } = require("./harness")

const BUSY = "busy-time@group.calendar.example"
const PROXY = "proxy@example.invalid"
const SOURCE = "source@example.invalid"
const NOW = Date.parse("2026-11-17T10:00:00Z")
const ZW = "​"
const CONFIG = {
  CALENDARS_TO_MERGE: { personal: SOURCE },
  CALENDAR_TO_MERGE_INTO: BUSY,
  SYNC_DAYS_IN_PAST: 30,
  SYNC_DAYS_IN_FUTURE: 365,
  DEFAULT_EVENT_TITLE: "Busy",
  SEARCH_CHARACTER: ZW,
  MIRROR_BUSY_TO: PROXY,
}
const SECRET = { MIRROR_KEY_SECRET: "c".repeat(64) }

function busyEvent(id, start, end, extra = {}) {
  const t = (v) => (v.length === 10 ? { date: v } : { dateTime: v, timeZone: "Asia/Ho_Chi_Minh" })
  return {
    id,
    summary: ZW + "personal Dentist with Dr Who",
    location: "Secret Street 1",
    start: t(start),
    end: t(end),
    extendedProperties: { private: { sourceCalendarId: SOURCE, sourceEventId: "src-" + id } },
    ...extra,
  }
}

function setup({ busy = [], proxy = [], config = {}, properties = SECRET, files = ["MirrorBusy.gs"], calendars = {}, ...rest } = {}) {
  return load({
    now: NOW,
    files,
    config: { ...CONFIG, ...config },
    properties,
    calendars: {
      [BUSY]: { events: busy },
      [PROXY]: { events: proxy, accessRole: "writer", timeZone: "Asia/Ho_Chi_Minh" },
      ...calendars,
    },
    ...rest,
  })
}

const proxyEvents = (env) => env.calendars[PROXY].events
const mirrored = (env) => proxyEvents(env).filter((e) => e.extendedProperties?.private?.mirrorBusy === "1")
const logText = (env) => env.logs.map((l) => l[1]).join("\n")
const sync = (env) => env.context.mirrorBusyAfterSync_()

// A provider registered in the vm's global scope, as a .gs function would be.
function provider(env, name, fn) {
  env.context[name] = fn
}

// --- what a proxy event looks like -------------------------------------------------------------------------------

test("creates one plain private Busy per Busy Time event, with nothing from the source", () => {
  const env = setup({
    busy: [
      busyEvent("b1", "2026-11-20T10:00:00+07:00", "2026-11-20T11:00:00+07:00", { conferenceData: { conferenceId: "abc" }, description: "notes" }),
      busyEvent("b2", "2026-11-25", "2026-11-27"),
    ],
  })
  sync(env)

  const events = mirrored(env)
  assert.equal(events.length, 2)
  for (const ev of events) {
    assert.deepEqual(Object.keys(ev).sort(), ["end", "extendedProperties", "id", "reminders", "start", "summary", "transparency", "visibility"])
    assert.equal(ev.summary, "Busy")
    assert.equal(ev.visibility, "private")
    assert.equal(ev.transparency, "opaque")
    assert.deepEqual(ev.reminders, { useDefault: false })
    assert.deepEqual(Object.keys(ev.extendedProperties.private).sort(), ["mirrorBusy", "mirrorKey", "mirrorSource"])
    assert.match(ev.extendedProperties.private.mirrorKey, /^[0-9a-f]{64}$/)
    assert.match(ev.extendedProperties.private.mirrorSource, /^[0-9a-f]{16}$/)
  }
  const text = JSON.stringify(env.batches)
  for (const leak of ["Dentist", "Secret Street", "notes", "abc", SOURCE, BUSY, "b1", "src-", "personal"]) {
    assert.ok(!text.includes(leak), "proxy requests contain " + leak)
  }
  const timed = events.find((e) => e.start.dateTime)
  assert.deepEqual(timed.start, { dateTime: "2026-11-20T10:00:00+07:00", timeZone: "Asia/Ho_Chi_Minh" })
  const allDay = events.find((e) => e.start.date)
  assert.deepEqual([allDay.start, allDay.end], [{ date: "2026-11-25" }, { date: "2026-11-27" }])
  assert.ok(env.batches[0].every((r) => r.endpoint.includes("sendUpdates=none")))
  assert.ok(env.batches[0][0].endpoint.includes(encodeURIComponent(PROXY)))
})

test("skips free, cancelled, working-location, proxy-born and mirror events (loop guards)", () => {
  const env = setup({
    busy: [
      busyEvent("free", "2026-11-20T01:00:00Z", "2026-11-20T02:00:00Z", { transparency: "transparent" }),
      busyEvent("gone", "2026-11-20T02:00:00Z", "2026-11-20T03:00:00Z", { status: "cancelled" }),
      busyEvent("where", "2026-11-20T03:00:00Z", "2026-11-20T04:00:00Z", { eventType: "workingLocation" }),
      busyEvent("fromProxy", "2026-11-20T04:00:00Z", "2026-11-20T05:00:00Z", { extendedProperties: { private: { sourceCalendarId: PROXY.toUpperCase() } } }),
      busyEvent("mirror", "2026-11-20T05:00:00Z", "2026-11-20T06:00:00Z", { extendedProperties: { private: { mirrorBusy: "1" } } }),
      busyEvent("real", "2026-11-20T06:00:00Z", "2026-11-20T07:00:00Z"),
    ],
  })
  sync(env)
  assert.equal(mirrored(env).length, 1)
  assert.equal(mirrored(env)[0].start.dateTime, "2026-11-20T06:00:00Z")
})

test("a second run changes nothing", () => {
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z"), busyEvent("b2", "2026-11-21", "2026-11-22")] })
  sync(env)
  const before = JSON.stringify(proxyEvents(env))
  sync(env)
  assert.equal(env.batches.length, 1)
  assert.equal(JSON.stringify(proxyEvents(env)), before)
  assert.match(logText(env), /0 created, 0 updated, 0 deleted, 2 unchanged/)
})

test("same instant with another offset is not a change; a moved event is updated in place", () => {
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00+07:00", "2026-11-20T11:00:00+07:00")] })
  sync(env)
  const id = mirrored(env)[0].id
  mirrored(env)[0].start = { dateTime: "2026-11-20T03:00:00Z", timeZone: "UTC" }
  sync(env)
  assert.equal(env.batches.length, 1)

  env.calendars[BUSY].events[0].end = { dateTime: "2026-11-20T12:00:00+07:00" }
  sync(env)
  assert.equal(env.batches.length, 2)
  assert.equal(env.batches[1][0].method, "PUT")
  assert.equal(mirrored(env).length, 1)
  assert.equal(mirrored(env)[0].id, id)
  assert.equal(mirrored(env)[0].end.dateTime, "2026-11-20T12:00:00+07:00")
})

test("details added by hand to a proxy Busy are wiped by a full replace", () => {
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")] })
  sync(env)
  Object.assign(mirrored(env)[0], {
    summary: "Dentist", location: "x", description: "y", attendees: [{ email: "a@example.invalid" }],
    visibility: "default", reminders: { useDefault: true },
  })
  sync(env)
  assert.equal(env.batches[1][0].method, "PUT")
  const ev = mirrored(env)[0]
  assert.equal(ev.summary, "Busy")
  for (const k of ["location", "description", "attendees"]) assert.equal(ev[k], undefined)
  assert.equal(ev.visibility, "private")
  assert.deepEqual(ev.reminders, { useDefault: false })

  mirrored(env)[0].description = "only a note"
  sync(env)
  assert.equal(env.batches.length, 3)
  assert.equal(mirrored(env)[0].description, undefined)
})

test("an all-day event at the window's edge is created once, even when the calendars' zones differ", () => {
  // The window ends 18 Nov 2027 00:00 UTC. Busy Time (UTC+7) lists this day; a proxy at UTC-8 would not without the
  // margin, and the event would be created again on every run.
  const env = setup({ busy: [busyEvent("edge", "2027-11-18", "2027-11-19")] })
  env.calendars[BUSY].allDayOffsetMs = -7 * 3600 * 1000
  env.calendars[PROXY].allDayOffsetMs = 8 * 3600 * 1000
  sync(env)
  sync(env)
  assert.equal(mirrored(env).length, 1)
  assert.equal(env.batches.length, 1)
})

test("deletes the Busy when its Busy Time event is gone; never touches other proxy events", () => {
  const booking = { id: "booking", summary: "Mentoring session", start: { dateTime: "2026-11-20T09:00:00Z" }, end: { dateTime: "2026-11-20T10:00:00Z" } }
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")], proxy: [booking] })
  sync(env)
  assert.equal(proxyEvents(env).length, 2)
  env.calendars[BUSY].events = []
  sync(env)
  assert.equal(env.batches[1][0].method, "DELETE")
  assert.deepEqual(proxyEvents(env).map((e) => e.id), ["booking"])
  assert.equal(proxyEvents(env)[0].summary, "Mentoring session")
})

test("leaves proxy events outside the window alone (the past is not cleaned up)", () => {
  // 15 Nov is before the window (from 16 Nov) but inside the 2-day margin the proxy is read with.
  const env = setup({ busy: [busyEvent("old", "2026-11-15T10:00:00Z", "2026-11-15T11:00:00Z")] })
  const old = { id: "oldMirror", summary: "Busy", start: { dateTime: "2026-11-15T10:00:00Z" }, end: { dateTime: "2026-11-15T11:00:00Z" },
    extendedProperties: { private: { mirrorBusy: "1", mirrorKey: "f".repeat(64), mirrorSource: "0".repeat(16) } } }
  env.calendars[PROXY].events.push(old)
  sync(env)
  assert.equal(env.batches.length, 0)
  assert.deepEqual(proxyEvents(env).map((e) => e.id), ["oldMirror"])
})

test("removes extra copies of one key and mirror events without a key", () => {
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")] })
  sync(env)
  const copy = JSON.parse(JSON.stringify(mirrored(env)[0]))
  env.calendars[PROXY].events.push({ ...copy, id: "dup" })
  env.calendars[PROXY].events.push({ ...copy, id: "nokey", extendedProperties: { private: { mirrorBusy: "1" } } })
  sync(env)
  assert.equal(mirrored(env).length, 1)
})

test("paginated reads of Busy Time and the proxy see every event", () => {
  const busy = []
  for (let d = 0; d < 7; d++) busy.push(busyEvent("b" + d, `2026-11-2${d}T10:00:00Z`, `2026-11-2${d}T11:00:00Z`))
  const env = setup({ busy, calendars: {} })
  env.calendars[BUSY].pageSize = 2
  env.calendars[PROXY].pageSize = 3
  sync(env)
  sync(env)
  assert.equal(mirrored(env).length, 7)
  assert.equal(env.batches.length, 1)
})

// --- failures never delete ----------------------------------------------------------------------------------------

test("Busy Time unreadable → nothing deleted, providers still create", () => {
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")], config: { MIRROR_EXTRA_PROVIDERS: ["fakeProvider"] } })
  provider(env, "fakeProvider", () => ({ ok: true, intervals: [] }))
  sync(env)
  env.calendars[BUSY].failList = new Error("Forbidden")
  provider(env, "fakeProvider", () => ({ ok: true, intervals: [{ key: "k1", start: { dateTime: "2026-11-21T01:00:00.000Z" }, end: { dateTime: "2026-11-21T02:00:00.000Z" }, allDay: false }] }))
  sync(env)
  assert.equal(mirrored(env).length, 2)
  assert.match(logText(env), /Busy Time FAILED \(cannot read Busy Time: Forbidden\)/)
  assert.match(logText(env), /deletions skipped because a source failed \(1 kept\)/)
})

for (const [name, fn] of [
  ["returns ok: false", () => ({ ok: false, reason: "iCloud down", intervals: [] })],
  ["throws", () => { throw new Error("boom") }],
  ["returns nothing", () => undefined],
  ["returns an invalid interval", () => ({ ok: true, intervals: [{ key: "", start: { dateTime: "x" }, end: {} }] })],
]) {
  test(`a provider that ${name} blocks every deletion, Busy Time's too`, () => {
    const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")], config: { MIRROR_EXTRA_PROVIDERS: ["p"] } })
    provider(env, "p", () => ({ ok: true, intervals: [] }))
    sync(env)
    env.calendars[BUSY].events = [busyEvent("b2", "2026-11-22T10:00:00Z", "2026-11-22T11:00:00Z")]
    provider(env, "p", fn)
    sync(env)
    assert.equal(mirrored(env).length, 2, "b1's Busy is kept, b2's is created")
    assert.match(logText(env), /p FAILED/)
  })
}

test("a provider named in config but missing from the project counts as failed", () => {
  const env = setup({ busy: [], config: { MIRROR_EXTRA_PROVIDERS: ["fetchNothing"] } })
  sync(env)
  assert.match(logText(env), /fetchNothing FAILED \(no function named fetchNothing\)/)
})

test("failed batch requests are counted and retried next run", () => {
  let fail = true
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")], failRequest: () => fail })
  sync(env)
  assert.equal(mirrored(env).length, 0)
  assert.match(logText(env), /1 request\(s\) failed, retried at the next sync/)
  fail = false
  sync(env)
  assert.equal(mirrored(env).length, 1)
})

test("proxy unreadable → nothing written, a clear error", () => {
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")] })
  env.calendars[PROXY].failList = new Error("Not Found")
  sync(env)
  assert.equal(env.batches.length, 0)
  assert.match(logText(env), /cannot read the proxy calendar \(Not Found\)/)
})

// --- providers -------------------------------------------------------------------------------------------------

test("provider intervals become Busy events; keys are HMACs, per provider", () => {
  const interval = { key: "Cal|uid-1|-", start: { dateTime: "2026-11-21T01:00:00.000Z" }, end: { dateTime: "2026-11-21T02:00:00.000Z" }, allDay: false }
  const env = setup({ config: { MIRROR_EXTRA_PROVIDERS: ["p1", "p2", "p1"] } })
  const calls = []
  provider(env, "p1", (s, e, o) => { calls.push(["p1", s, e, o]); return { ok: true, intervals: [interval] } })
  provider(env, "p2", () => ({ ok: true, intervals: [interval, { key: "d", start: { date: "2026-11-23" }, end: { date: "2026-11-24" }, allDay: true }] }))
  sync(env)
  assert.equal(calls.length, 1, "duplicate names are called once")
  const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]"
  assert.ok(isDate(calls[0][1]) && isDate(calls[0][2]))
  assert.deepEqual({ ...calls[0][3] }, { dryRun: false })
  assert.equal(mirrored(env).length, 3)
  const keys = mirrored(env).map((e) => e.extendedProperties.private.mirrorKey)
  assert.equal(new Set(keys).size, 3)
  assert.ok(!JSON.stringify(env.batches).includes("uid-1"))
  assert.ok(!JSON.stringify(env.batches).includes("Cal|"))
})

test("a provider's events are deleted only inside its coverage", () => {
  const inside = { key: "in", start: { dateTime: "2026-11-21T01:00:00.000Z" }, end: { dateTime: "2026-11-21T02:00:00.000Z" }, allDay: false }
  const later = { key: "later", start: { dateTime: "2027-02-01T01:00:00.000Z" }, end: { dateTime: "2027-02-01T02:00:00.000Z" }, allDay: false }
  const env = setup({ config: { MIRROR_EXTRA_PROVIDERS: ["p"] } })
  provider(env, "p", () => ({ ok: true, intervals: [inside, later] }))
  sync(env)
  assert.equal(mirrored(env).length, 2)
  provider(env, "p", () => ({ ok: true, intervals: [], coverage: { start: "2026-11-16T00:00:00.000Z", end: "2026-12-19T00:00:00.000Z" } }))
  sync(env)
  assert.deepEqual(mirrored(env).map((e) => e.start.dateTime), ["2027-02-01T01:00:00.000Z"])
})

test("removing a provider from config removes its Busy events", () => {
  const env = setup({ config: { MIRROR_EXTRA_PROVIDERS: ["p"] } })
  provider(env, "p", () => ({ ok: true, intervals: [{ key: "k", start: { date: "2026-11-23" }, end: { date: "2026-11-24" } }] }))
  sync(env)
  assert.equal(mirrored(env).length, 1)
  const env2 = setup({ proxy: env.calendars[PROXY].events, config: { MIRROR_EXTRA_PROVIDERS: [] } })
  sync(env2)
  assert.equal(mirrored(env2).length, 0)
})

test("with the real ICloudSource: Worker intervals reach the proxy, a failed read deletes nothing", () => {
  const env = setup({
    files: ["ICloudSource.gs", "MirrorBusy.gs"],
    config: { MIRROR_EXTRA_PROVIDERS: ["fetchICloudBusyIntervals"], ICLOUD_FEED_URL: "https://feed.example.invalid", ICLOUD_CALENDARS: ["Family"] },
    properties: { ...SECRET, ICLOUD_FEED_TOKEN: "unit-test-token-not-a-secret" },
    busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")],
    responses: [
      { code: 200, body: { ok: true, version: "a".repeat(64), cache: "miss", calendars: [{ name: "Family", ok: true, count: 1 }],
        intervals: [{ calendar: "Family", id: "uid-9|-", start: "2026-11-19T02:00:00Z", end: "2026-11-19T03:00:00Z", allDay: false }] } },
      { code: 502, body: { ok: false, error: "upstream_unavailable" } },
    ],
  })
  sync(env)
  assert.equal(mirrored(env).length, 2)
  assert.ok(!JSON.stringify(env.batches).includes("Family"))
  env.calendars[BUSY].events = []
  sync(env)
  assert.equal(mirrored(env).length, 2, "iCloud failed, so b1's Busy stays too")
  assert.match(logText(env), /fetchICloudBusyIntervals FAILED \(http 502 upstream_unavailable\)/)
})

// --- config and loop guards ---------------------------------------------------------------------------------------

test("off when MIRROR_BUSY_TO is empty or missing: no reads, no writes, no logs", () => {
  for (const config of [{ MIRROR_BUSY_TO: "" }, { MIRROR_BUSY_TO: undefined }]) {
    const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")], config })
    sync(env)
    assert.equal(env.lists.length, 0)
    assert.equal(env.batches.length, 0)
    assert.equal(env.logs.length, 0)
  }
})

test("refuses to run when the proxy is also a source or is Busy Time itself", () => {
  for (const [config, pattern] of [
    [{ CALENDARS_TO_MERGE: { personal: SOURCE, proxy: " " + PROXY.toUpperCase() } }, /also in CALENDARS_TO_MERGE/],
    [{ MIRROR_BUSY_TO: BUSY }, /Busy Time calendar itself/],
    [{ MIRROR_EXTRA_PROVIDERS: "fetchICloudBusyIntervals" }, /must be a list/],
  ]) {
    const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")], config })
    sync(env)
    assert.equal(env.batches.length, 0)
    assert.match(logText(env), pattern)
  }
})

test("the key secret is created once and never logged", () => {
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")], properties: {} })
  sync(env)
  const secret = env.properties.getProperty("MIRROR_KEY_SECRET")
  assert.match(secret, /^[0-9a-f]{64}$/)
  sync(env)
  assert.equal(env.properties.getProperty("MIRROR_KEY_SECRET"), secret)
  assert.equal(env.properties.writes.filter((k) => k === "MIRROR_KEY_SECRET").length, 1)
  assert.ok(!logText(env).includes(secret))
})

// --- run by hand ----------------------------------------------------------------------------------------------------

test("dryRunMirrorBusy writes nothing to calendars and lists the plan", () => {
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00+07:00", "2026-11-20T11:00:00+07:00")], config: { MIRROR_EXTRA_PROVIDERS: ["p"] } })
  let options
  provider(env, "p", (s, e, o) => { options = o; return { ok: true, intervals: [] } })
  env.context.dryRunMirrorBusy()
  assert.equal(env.batches.length, 0)
  assert.deepEqual({ ...options }, { dryRun: true })
  assert.match(logText(env), /MirrorBusy dry run: Busy Time 1, p 0 → proxy: 1 to create/)
  assert.match(logText(env), /\+ create Fri 20 Nov 10:00–11:00 {2}← Busy Time \[personal\]/)
})

test("setupMirrorBusy explains each missing step and writes no calendar", () => {
  const off = setup({ config: { MIRROR_BUSY_TO: "" } })
  off.context.setupMirrorBusy()
  assert.match(logText(off), /set MIRROR_BUSY_TO in Config.gs/)

  const notShared = setup({ calendars: { [PROXY]: { events: [], failList: new Error("Not Found") } } })
  notShared.context.setupMirrorBusy()
  assert.match(logText(notShared), /Share with specific people/)

  const readOnly = setup({ calendars: { [PROXY]: { events: [], accessRole: "freeBusyReader" } } })
  readOnly.context.setupMirrorBusy()
  assert.match(logText(readOnly), /Make changes to events/)

  const ok = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00Z", "2026-11-20T11:00:00Z")], properties: {}, config: { MIRROR_EXTRA_PROVIDERS: ["missingFn"] } })
  ok.context.setupMirrorBusy()
  assert.match(logText(ok), /write access \(writer\)/)
  assert.match(logText(ok), /missingFn: NOT FOUND/)
  assert.match(logText(ok), /1 to create/)
  assert.match(ok.properties.getProperty("MIRROR_KEY_SECRET"), /^[0-9a-f]{64}$/)
  for (const env of [off, notShared, readOnly, ok]) assert.equal(env.batches.length, 0)
})

test("debugProxyDay names the source of each Busy in the proxy's zone and flags other events", () => {
  const booking = { id: "booking", summary: "Mentoring session", start: { dateTime: "2026-11-20T02:00:00Z" }, end: { dateTime: "2026-11-20T03:00:00Z" } }
  const env = setup({ busy: [busyEvent("b1", "2026-11-20T10:00:00+07:00", "2026-11-20T11:00:00+07:00")], proxy: [booking], config: { MIRROR_EXTRA_PROVIDERS: ["p"] } })
  provider(env, "p", () => ({ ok: true, intervals: [{ key: "Family|uid|-", start: { dateTime: "2026-11-20T05:00:00.000Z" }, end: { dateTime: "2026-11-20T06:00:00.000Z" } }] }))
  sync(env)
  mirrored(env)[0].summary = "edited"
  const batches = env.batches.length
  env.context.debugProxyDay("2026-11-20")
  const text = logText(env)
  assert.match(text, /2026-11-20 \(Asia\/Ho_Chi_Minh\), 3 event\(s\)/)
  assert.match(text, /Fri 20 Nov 09:00–10:00 {2}"Mentoring session": not written by MirrorBusy/)
  assert.match(text, /Fri 20 Nov 10:00–11:00 {2}Busy ← Busy Time \[personal\]; fixed at the next sync: title/)
  assert.match(text, /Fri 20 Nov 12:00–13:00 {2}Busy ← p · Family/)
  assert.equal(env.batches.length, batches)
})

// --- inside SyncCalendarsIntoOne ------------------------------------------------------------------------------------

function fullProject(sourceEvents, extra = {}) {
  return setup({
    files: ["SyncCalendarsIntoOne.gs", "MirrorBusy.gs"],
    calendars: { [SOURCE]: { events: sourceEvents } },
    ...extra,
  })
}

test("SyncCalendarsIntoOne fills Busy Time, then the proxy, in one run", () => {
  const env = fullProject([{ id: "s1", summary: "Dentist", location: "Secret Street 1", start: { dateTime: "2026-11-20T03:00:00Z" }, end: { dateTime: "2026-11-20T04:00:00Z" } }])
  env.context.SyncCalendarsIntoOne()
  assert.equal(env.calendars[BUSY].events.length, 1)
  assert.equal(env.calendars[BUSY].events[0].summary, ZW + "personal Dentist")
  assert.equal(mirrored(env).length, 1)
  assert.equal(mirrored(env)[0].summary, "Busy")
  assert.equal(mirrored(env)[0].location, undefined)
})

test("SyncCalendarsIntoOne still mirrors when the Busy Time sync itself fails", () => {
  const env = fullProject([], { config: { MIRROR_EXTRA_PROVIDERS: ["p"] } })
  provider(env, "p", () => ({ ok: true, intervals: [{ key: "k", start: { date: "2026-11-23" }, end: { date: "2026-11-24" } }] }))
  env.calendars[BUSY].failList = new Error("Busy Time down")
  env.context.SyncCalendarsIntoOne()
  assert.match(logText(env), /Sync failed with error: Error: Busy Time down/)
  assert.equal(mirrored(env).length, 1)
})

test("the sync never copies MirrorBusy events from a source (loop guard 1)", () => {
  const env = fullProject([
    { id: "m1", summary: "Busy", start: { dateTime: "2026-11-20T03:00:00Z" }, end: { dateTime: "2026-11-20T04:00:00Z" }, extendedProperties: { private: { mirrorBusy: "1" } } },
    { id: "s1", summary: "Real", start: { dateTime: "2026-11-21T03:00:00Z" }, end: { dateTime: "2026-11-21T04:00:00Z" } },
  ], { config: { MIRROR_BUSY_TO: "" } })
  env.context.SyncCalendarsIntoOne()
  assert.deepEqual(env.calendars[BUSY].events.map((e) => e.summary), [ZW + "personal Real"])
})
