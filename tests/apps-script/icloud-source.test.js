const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { load, SCRIPTS } = require("./harness")

const FEED = "https://feed.example.invalid"
const TOKEN = "unit-test-token-not-a-secret"
const VERSION = "a".repeat(64)
const VERSION_2 = "b".repeat(64)
const CONFIG = {
  ICLOUD_CALENDARS: ["Calendar A", "Calendar B + More"],
  ICLOUD_FLOATING_TIMEZONE: "Europe/Berlin",
  MIRROR_EXTRA_PROVIDERS: ["fetchICloudBusyIntervals"],
}
const PROPS = { ICLOUD_FEED_URL: FEED + "/", ICLOUD_FEED_TOKEN: TOKEN }
const START = new Date("2026-11-16T00:00:00Z")
const END = new Date("2026-11-30T00:00:00Z")
const HOUR = 3600 * 1000

function busyBody(overrides = {}) {
  return {
    ok: true,
    version: VERSION,
    cache: "miss",
    calendars: [
      { name: "Calendar A", ok: true, count: 1 },
      { name: "Calendar B + More", ok: true, count: 1 },
    ],
    intervals: [
      { calendar: "Calendar A", id: "uid-1|20261117T090000Z", start: "2026-11-17T09:00:00Z", end: "2026-11-17T10:00:00Z", allDay: false },
      { calendar: "Calendar B + More", id: "uid-2|-", start: "2026-11-20", end: "2026-11-22", allDay: true },
    ],
    ...overrides,
  }
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString()

// --- fetchICloudBusyIntervals -------------------------------------------------------------------------------------

test("maps timed and all-day intervals to the MirrorBusy shape with readable keys", () => {
  const env = load({ config: CONFIG, properties: PROPS, responses: [{ code: 200, body: busyBody() }] })
  const result = env.context.fetchICloudBusyIntervals(START, END)
  assert.equal(result.ok, true)
  assert.deepEqual(JSON.parse(JSON.stringify(result.intervals)), [
    { key: "Calendar A|uid-1|20261117T090000Z", start: { dateTime: "2026-11-17T09:00:00.000Z" }, end: { dateTime: "2026-11-17T10:00:00.000Z" }, allDay: false },
    { key: "Calendar B + More|uid-2|-", start: { date: "2026-11-20" }, end: { date: "2026-11-22" }, allDay: true },
  ])
})

test("calls /busy with the bearer token, short timeout and encoded repeated calendars", () => {
  const env = load({ config: CONFIG, properties: PROPS, responses: [{ code: 200, body: busyBody() }] })
  env.context.fetchICloudBusyIntervals(START, END)
  assert.equal(env.fetches.length, 1)
  const { url, params } = env.fetches[0]
  assert.equal(url,
    FEED + "/busy?calendars=Calendar%20A&calendars=Calendar%20B%20%2B%20More" +
    "&start=2026-11-16T00%3A00%3A00.000Z&end=2026-11-30T00%3A00%3A00.000Z&tz=Europe%2FBerlin")
  assert.equal(params.method, "get")
  assert.equal(params.headers.Authorization, "Bearer " + TOKEN)
  assert.equal(params.muteHttpExceptions, true)
  assert.equal(params.timeoutSeconds, 60)
})

test("success stores the version and the ok time", () => {
  const env = load({ config: CONFIG, properties: PROPS, responses: [{ code: 200, body: busyBody() }] })
  env.context.fetchICloudBusyIntervals(START, END)
  assert.equal(env.properties.getProperty("ICLOUD_LAST_VERSION"), VERSION)
  assert.ok(Date.now() - Date.parse(env.properties.getProperty("ICLOUD_LAST_OK_AT")) < 5000)
  assert.equal(env.properties.getProperty("ICLOUD_LAST_FAILURE_AT"), null)
})

for (const [name, response] of [
  ["HTTP error", { code: 502, body: { ok: false, error: "upstream_auth" } }],
  ["non-JSON (Cloudflare error page)", { code: 503, body: "<html>Worker exceeded CPU</html>" }],
  ["fetch throws (timeout)", new Error("Timeout")],
  ["top-level ok false", { code: 200, body: busyBody({ ok: false }) }],
  ["missing version", { code: 200, body: busyBody({ version: null }) }],
]) {
  test("ok:false on " + name + "; records the failure, keeps the version", () => {
    const env = load({ config: CONFIG, properties: { ...PROPS, ICLOUD_LAST_VERSION: VERSION_2 }, responses: [response] })
    const result = env.context.fetchICloudBusyIntervals(START, END)
    assert.equal(result.ok, false)
    assert.ok(result.reason)
    assert.equal(env.properties.getProperty("ICLOUD_LAST_VERSION"), VERSION_2)
    assert.ok(env.properties.getProperty("ICLOUD_LAST_FAILURE_AT"))
    assert.equal(env.properties.getProperty("ICLOUD_LAST_OK_AT"), null)
  })
}

test("a failed calendar makes ok false but intervals from ok calendars are still returned", () => {
  const body = busyBody({
    ok: false,
    calendars: [{ name: "Calendar A", ok: true, count: 1 }, { name: "Calendar B + More", ok: false, error: "query_failed", count: 0 }],
  })
  const env = load({ config: CONFIG, properties: PROPS, responses: [{ code: 200, body }] })
  const result = env.context.fetchICloudBusyIntervals(START, END)
  assert.equal(result.ok, false)
  assert.deepEqual([...result.intervals.map((i) => i.key)], ["Calendar A|uid-1|20261117T090000Z"])
  assert.match(env.logs.map((l) => l[1]).join("\n"), /Calendar B \+ More: failed \(query_failed\)/)
})

test("a configured calendar missing from the response makes ok false", () => {
  const body = busyBody({ calendars: [{ name: "Calendar A", ok: true, count: 1 }] })
  const env = load({ config: CONFIG, properties: PROPS, responses: [{ code: 200, body }] })
  const result = env.context.fetchICloudBusyIntervals(START, END)
  assert.equal(result.ok, false)
  assert.deepEqual([...result.intervals.map((i) => i.key)], ["Calendar A|uid-1|20261117T090000Z"])
})

test("an invalid interval makes ok false, is dropped, the rest stays", () => {
  const bad = [
    { calendar: "Calendar A", id: "x1", start: "2026-11-17T10:00:00Z", end: "2026-11-17T09:00:00Z", allDay: false }, // end < start
    { calendar: "Calendar A", id: "x2", start: "2026-11-17", end: "2026-11-18", allDay: false }, // date in timed
    { calendar: "Calendar A", id: "x3", start: "2026-11-17T10:00:00Z", end: "2026-11-17T11:00:00Z", allDay: true }, // instant in all-day
    { calendar: "Calendar A", id: "x4", start: "2026-02-30", end: "2026-03-01", allDay: true }, // not a real date
    { calendar: "Calendar A", id: "", start: "2026-11-17T10:00:00Z", end: "2026-11-17T11:00:00Z", allDay: false }, // no id
  ]
  for (const interval of bad) {
    const env = load({ config: CONFIG, properties: PROPS, responses: [{ code: 200, body: busyBody({ intervals: [...busyBody().intervals, interval] }) }] })
    const result = env.context.fetchICloudBusyIntervals(START, END)
    assert.equal(result.ok, false, JSON.stringify(interval))
    assert.equal(result.intervals.length, 2)
  }
})

test("dryRun writes no properties, on success or failure", () => {
  for (const response of [{ code: 200, body: busyBody() }, { code: 502, body: { ok: false } }]) {
    const env = load({ config: CONFIG, properties: PROPS, responses: [response] })
    env.context.fetchICloudBusyIntervals(START, END, { dryRun: true })
    assert.deepEqual(env.properties.writes, [])
  }
})

test("not configured → ok false without any fetch", () => {
  const cases = [
    { config: { ...CONFIG, ICLOUD_CALENDARS: [] }, properties: PROPS },
    { config: { MIRROR_EXTRA_PROVIDERS: CONFIG.MIRROR_EXTRA_PROVIDERS }, properties: PROPS },
    { config: CONFIG, properties: { ICLOUD_FEED_TOKEN: TOKEN } },
    { config: CONFIG, properties: { ICLOUD_FEED_URL: FEED } },
    { config: CONFIG, properties: { ...PROPS, ICLOUD_FEED_URL: "http://feed.example.invalid" } },
    { config: CONFIG, properties: { ...PROPS, ICLOUD_FEED_URL: FEED + "/?token=x" } },
  ]
  for (const c of cases) {
    const env = load(c)
    const result = env.context.fetchICloudBusyIntervals(START, END)
    assert.equal(result.ok, false)
    assert.equal(env.fetches.length, 0)
  }
})

test("logs one summary line and never the token", () => {
  const env = load({ config: CONFIG, properties: PROPS, responses: [{ code: 200, body: busyBody() }] })
  env.context.fetchICloudBusyIntervals(START, END)
  const text = env.logs.map((l) => l[1]).join("\n")
  assert.equal(env.logs.length, 1)
  assert.equal(text, "iCloud: ok, cache miss; Calendar A: 1, Calendar B + More: 1")
  assert.ok(!text.includes(TOKEN))
})

// --- checkICloudAndSync -------------------------------------------------------------------------------------------

const RECENT = { ICLOUD_LAST_RUN_AT: iso(HOUR), ICLOUD_LAST_OK_AT: iso(HOUR), ICLOUD_LAST_VERSION: VERSION }
const versionOk = (version) => ({ code: 200, body: { ok: true, version, calendars: [{ name: "Calendar A", ok: true }, { name: "Calendar B + More", ok: true }] } })

test("check: not configured → nothing happens", () => {
  const env = load({ config: CONFIG, properties: {} })
  env.context.checkICloudAndSync()
  assert.equal(env.fetches.length, 0)
  assert.equal(env.syncCalls.length, 0)
})

test("check: provider not in MIRROR_EXTRA_PROVIDERS → no sync (would loop otherwise)", () => {
  for (const config of [{ ...CONFIG, MIRROR_EXTRA_PROVIDERS: [] }, { ICLOUD_CALENDARS: CONFIG.ICLOUD_CALENDARS }]) {
    const env = load({ config, properties: PROPS })
    env.context.checkICloudAndSync()
    assert.equal(env.fetches.length, 0)
    assert.equal(env.syncCalls.length, 0)
  }
})

test("check: same version → no sync", () => {
  const env = load({ config: CONFIG, properties: { ...PROPS, ...RECENT }, responses: [versionOk(VERSION)] })
  env.context.checkICloudAndSync()
  assert.equal(env.fetches.length, 1)
  assert.match(env.fetches[0].url, /\/version\?calendars=Calendar%20A&calendars=Calendar%20B%20%2B%20More$/)
  assert.equal(env.fetches[0].params.timeoutSeconds, 30)
  assert.equal(env.syncCalls.length, 0)
})

test("check: new version → sync and LAST_RUN_AT", () => {
  const env = load({ config: CONFIG, properties: { ...PROPS, ...RECENT }, responses: [versionOk(VERSION_2)] })
  env.context.checkICloudAndSync()
  assert.equal(env.syncCalls.length, 1)
  assert.ok(Date.now() - Date.parse(env.properties.getProperty("ICLOUD_LAST_RUN_AT")) < 5000)
})

test("check: daily rule runs a sync without asking /version", () => {
  for (const props of [{}, { ICLOUD_LAST_RUN_AT: iso(25 * HOUR), ICLOUD_LAST_OK_AT: iso(25 * HOUR) }]) {
    const env = load({ config: CONFIG, properties: { ...PROPS, ...props, ICLOUD_LAST_VERSION: VERSION } })
    try { env.context.checkICloudAndSync() } catch (e) { /* health check may throw; not under test here */ }
    assert.equal(env.fetches.length, 0)
    assert.equal(env.syncCalls.length, 1)
  }
})

test("check: a recent successful read counts for the daily rule", () => {
  const env = load({ config: CONFIG, properties: { ...PROPS, ICLOUD_LAST_RUN_AT: iso(30 * HOUR), ICLOUD_LAST_OK_AT: iso(HOUR), ICLOUD_LAST_VERSION: VERSION }, responses: [versionOk(VERSION)] })
  env.context.checkICloudAndSync()
  assert.equal(env.syncCalls.length, 0)
})

test("check: backs off for 15 minutes after a failed read", () => {
  const env = load({ config: CONFIG, properties: { ...PROPS, ...RECENT, ICLOUD_LAST_FAILURE_AT: iso(5 * 60 * 1000) } })
  env.context.checkICloudAndSync()
  assert.equal(env.fetches.length, 0)
  assert.equal(env.syncCalls.length, 0)
  assert.match(env.logs.map((l) => l[1]).join("\n"), /backing off/)

  const later = load({ config: CONFIG, properties: { ...PROPS, ...RECENT, ICLOUD_LAST_FAILURE_AT: iso(16 * 60 * 1000) }, responses: [versionOk(VERSION_2)] })
  later.context.checkICloudAndSync()
  assert.equal(later.syncCalls.length, 1)
})

test("check: /version failure → no sync, no throw while the last success is recent", () => {
  for (const response of [{ code: 502, body: { ok: false, error: "upstream_unavailable" } }, versionOk(null), new Error("Timeout")]) {
    const env = load({ config: CONFIG, properties: { ...PROPS, ...RECENT }, responses: [response] })
    env.context.checkICloudAndSync()
    assert.equal(env.syncCalls.length, 0)
  }
})

test("check: throws (owner gets Google's failure email) when iCloud failed for over 24 h", () => {
  const failing = { ...PROPS, ICLOUD_LAST_VERSION: VERSION, ICLOUD_LAST_RUN_AT: iso(HOUR), ICLOUD_LAST_OK_AT: iso(26 * HOUR), ICLOUD_LAST_FAILURE_AT: iso(HOUR) }
  const env = load({ config: CONFIG, properties: failing, responses: [{ code: 502, body: { ok: false } }] })
  assert.throws(() => env.context.checkICloudAndSync(), /iCloud has not synced for over 24 h/)

  const never = load({ config: CONFIG, properties: { ...PROPS, ICLOUD_LAST_RUN_AT: iso(HOUR), ICLOUD_LAST_FAILURE_AT: iso(HOUR) } })
  assert.throws(() => never.context.checkICloudAndSync(), /last success: never/)

  const recovered = load({ config: CONFIG, properties: { ...failing, ICLOUD_LAST_OK_AT: iso(10 * 60 * 1000), ICLOUD_LAST_FAILURE_AT: iso(HOUR) }, responses: [versionOk(VERSION)] })
  assert.doesNotThrow(() => recovered.context.checkICloudAndSync())

  const recentFailure = load({ config: CONFIG, properties: { ...PROPS, ...RECENT, ICLOUD_LAST_FAILURE_AT: iso(20 * 60 * 1000) }, responses: [versionOk(VERSION)] })
  assert.doesNotThrow(() => recentFailure.context.checkICloudAndSync())
})

// --- debugICloud --------------------------------------------------------------------------------------------------

test("debugICloud prints state and intervals and writes nothing", () => {
  const env = load({
    config: CONFIG,
    properties: { ...PROPS, ICLOUD_LAST_VERSION: VERSION },
    responses: [versionOk(VERSION), { code: 200, body: busyBody() }],
  })
  env.context.debugICloud(14)
  assert.deepEqual(env.properties.writes, [])
  const text = env.logs.map((l) => l[1]).join("\n")
  assert.match(text, /token set/)
  assert.ok(!text.includes(TOKEN))
  assert.match(text, /same as last sync/)
  assert.match(text, /Tue 17 Nov 10:00–11:00 · Calendar A/) // Europe/Berlin
  assert.match(text, /Fri 20 Nov – Sat 21 Nov \(all day\) · Calendar B \+ More/)
})

// --- syntax check of every Apps Script file ------------------------------------------------------------------------

test("node --check passes on every scripts/*.gs (copied to .js in a temp folder)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-check-"))
  try {
    // Config.gs is gitignored and holds the owner's data: check the example instead.
    const files = fs.readdirSync(SCRIPTS).filter((f) => f.endsWith(".gs") && f !== "Config.gs")
    files.push("Config.gs.example")
    assert.ok(files.includes("ICloudSource.gs"))
    for (const f of files) {
      const target = path.join(dir, f.replace(/\.gs(\.example)?$/, "") + ".js")
      fs.copyFileSync(path.join(SCRIPTS, f), target)
      const res = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" })
      assert.equal(res.status, 0, f + ": " + res.stderr)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
