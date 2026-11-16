// CPU benchmark for the heavy /busy path (docs/icloud-spec.md §12, §17).
// Runs the real handler against the in-memory iCloud mock: XML parsing (tsdav/xml-js) + ICS expansion (ical.js).
// Workers Free allows 10 ms CPU per request. Node's V8 is close to workerd's, but treat the numbers as an estimate:
// the real figure is the CPU time per request in the Cloudflare dashboard.
//
//   node test/bench.mjs          # the default horizon: 30 days ahead (ICLOUD_DAYS_AHEAD)
//   node test/bench.mjs 366      # a year ahead
//
// The window is the one ICloudSource.gs sends: yesterday 00:00 UTC to + days + 2. Like iCloud's time-range filter,
// only objects that can overlap it are returned (single events by date; series always).

import { handleRequest } from "../src/index.js"
import { createMockICloud, SERVER_URL, USER, PASSWORD } from "./mock-icloud.js"
import { benchmarkObjects } from "./fixtures.js"

const DAY = 86400000
const days = Number(process.argv[2] || 30)
const today = Date.UTC(2026, 10, 17)
const start = today - DAY
const end = start + (days + 2) * DAY

const all = benchmarkObjects(2026).concat(benchmarkObjects(2027))
const objects = all.filter((o) => {
  if (!o.includes("UID:bench-single")) return true
  const m = /DTSTART;TZID=Europe\/Berlin:(\d{4})(\d{2})(\d{2})/.exec(o)
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3])
  return t >= start - DAY && t < end + DAY
})

const TOKEN = "bench-token"
const ENV = { FEED_TOKEN: TOKEN, ICLOUD_APPLE_ID: USER, ICLOUD_APP_PASSWORD: PASSWORD, CALDAV_SERVER_URL: SERVER_URL }
const mock = createMockICloud({ calendars: [{ name: "Bench", path: "bench", ctag: "c1", objects }] })
const url = "https://feed.example.invalid/busy?calendars=Bench&start=" + new Date(start).toISOString() +
  "&end=" + new Date(end).toISOString() + "&tz=Europe%2FBerlin"

async function once() {
  const before = process.cpuUsage()
  const res = await handleRequest(new Request(url, { headers: { Authorization: "Bearer " + TOKEN } }), ENV, {},
    { fetchImpl: mock.fetchImpl, cache: null, log: () => {} })
  const body = await res.json()
  const used = process.cpuUsage(before)
  return { ms: (used.user + used.system) / 1000, count: body.intervals.length, ok: body.ok }
}

const first = await once() // cold: a fresh process, like a fresh Worker isolate
const runs = []
for (let i = 0; i < 30; i++) runs.push((await once()).ms)
runs.sort((a, b) => a - b)

console.log(JSON.stringify({
  daysAhead: days,
  objectsReturned: objects.length,
  intervals: first.count,
  ok: first.ok,
  coldMs: +first.ms.toFixed(1),
  warmMedianMs: +runs[Math.floor(runs.length / 2)].toFixed(1),
  warmP90Ms: +runs[Math.floor(runs.length * 0.9)].toFixed(1),
}))
