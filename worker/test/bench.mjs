// CPU benchmark for the heavy /busy path (docs/icloud-spec.md §12, open question 1).
// Runs the real handler against the in-memory iCloud mock: XML parsing (tsdav/xml-js) + ICS expansion (ical.js).
// Workers Free allows 10 ms CPU per request; Node's V8 is close to workerd's, but treat the numbers as an estimate.
//
//   node test/bench.mjs

import { handleRequest } from "../src/index.js"
import { createMockICloud, SERVER_URL, USER, PASSWORD } from "./mock-icloud.js"
import { benchmarkObjects } from "./fixtures.js"

const TOKEN = "bench-token"
const ENV = { FEED_TOKEN: TOKEN, ICLOUD_APPLE_ID: USER, ICLOUD_APP_PASSWORD: PASSWORD, CALDAV_SERVER_URL: SERVER_URL }
// Same window as SyncCalendarsIntoOne: 30 days back, 366 days ahead.
const start = new Date(Date.UTC(2026, 10, 16) - 30 * 86400000).toISOString()
const end = new Date(Date.UTC(2026, 10, 16) + 366 * 86400000).toISOString()

const objects = benchmarkObjects(2026).concat(benchmarkObjects(2027).slice(0, 150))
const mock = createMockICloud({ calendars: [{ name: "Bench", path: "bench", ctag: "c1", objects }] })
const url = "https://feed.example.invalid/busy?calendars=Bench&start=" + start + "&end=" + end + "&tz=Europe%2FBerlin"
const quiet = () => {}

async function once() {
  const before = process.cpuUsage()
  const res = await handleRequest(new Request(url, { headers: { Authorization: "Bearer " + TOKEN } }), ENV, {},
    { fetchImpl: mock.fetchImpl, cache: null, log: quiet })
  const body = await res.json()
  const used = process.cpuUsage(before)
  return { ms: (used.user + used.system) / 1000, count: body.intervals.length, ok: body.ok }
}

// Mock response building is included in the measurement; subtract it separately.
async function mockOnly() {
  const before = process.cpuUsage()
  await (await mock.fetchImpl(SERVER_URL.replace("caldav.", "p01-caldav.") + "/1000001/calendars/bench/", {
    method: "REPORT", headers: { authorization: "Basic " + btoa(USER + ":" + PASSWORD) },
  })).text()
  const used = process.cpuUsage(before)
  return (used.user + used.system) / 1000
}

const first = await once()
const runs = []
for (let i = 0; i < 20; i++) runs.push((await once()).ms)
const mockMs = []
for (let i = 0; i < 20; i++) mockMs.push(await mockOnly())
runs.sort((a, b) => a - b)
mockMs.sort((a, b) => a - b)
const median = (a) => a[Math.floor(a.length / 2)]

console.log(JSON.stringify({
  objects: objects.length,
  intervals: first.count,
  ok: first.ok,
  firstRunMs: +first.ms.toFixed(1),
  warmMedianMs: +median(runs).toFixed(1),
  warmP90Ms: +runs[Math.floor(runs.length * 0.9)].toFixed(1),
  mockOverheadMedianMs: +median(mockMs).toFixed(1),
}, null, 2))
