// CPU benchmark for the Worker's request paths (docs/icloud-spec.md §12, §17).
// Runs the real handler against the in-memory iCloud mock: XML parsing (tsdav/xml-js) + ICS expansion (ical.js).
// Workers Free allows 10 ms CPU per HTTP request; an isolate tolerates infrequent overruns (Cloudflare limits docs).
// Node's V8 is close to workerd's, but treat the numbers as an estimate: the real figure is the CPU time per
// request in the Cloudflare dashboard.
//
//   node test/bench.mjs              # /busy, default horizon: 30 days ahead (ICLOUD_DAYS_AHEAD)
//   node test/bench.mjs 366          # /busy, a year ahead
//   node test/bench.mjs version      # /version
//
// "1st call" is the first request served by fresh code: in Node, the platform pieces that workerd has built in
// (Request/Response, WebCrypto, Intl, URL) and the mock are warmed up first with unrelated work, and module loading
// happens at import time (Workers count it as startup, which has its own 1 s limit). So "1st call" is what a fresh
// isolate spends on our code and its libraries, mostly compiling them.
//
// The /busy window is the one ICloudSource.gs sends: yesterday 00:00 UTC to + days + 2. Like iCloud's time-range
// filter, only objects that can overlap it are returned (single events by date; series always).

import { handleRequest } from "../src/index.js"
import { createMockICloud, SERVER_URL, USER, PASSWORD } from "./mock-icloud.js"
import { benchmarkObjects } from "./fixtures.js"

const DAY = 86400000
const mode = process.argv[2] === "version" ? "version" : "busy"
const days = mode === "busy" ? Number(process.argv[2] || 30) : null
const today = Date.UTC(2026, 10, 17)
const start = today - DAY
const end = start + ((days || 30) + 2) * DAY

const objects = benchmarkObjects(2026).concat(benchmarkObjects(2027)).filter((o) => {
  if (!o.includes("UID:bench-single")) return true
  const m = /DTSTART;TZID=Europe\/Berlin:(\d{4})(\d{2})(\d{2})/.exec(o)
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3])
  return t >= start - DAY && t < end + DAY
})

const TOKEN = "bench-token"
const ENV = { FEED_TOKEN: TOKEN, ICLOUD_APPLE_ID: USER, ICLOUD_APP_PASSWORD: PASSWORD, CALDAV_SERVER_URL: SERVER_URL }
const calendars = [{ name: "Bench", path: "bench", ctag: "c1", objects }]
for (let i = 0; i < 10; i++) calendars.push({ name: "Other " + i, path: "other" + i, ctag: "o" + i })
const mock = createMockICloud({ calendars })
const url = mode === "version"
  ? "https://feed.example.invalid/version?calendars=Bench"
  : "https://feed.example.invalid/busy?calendars=Bench&start=" + new Date(start).toISOString() +
    "&end=" + new Date(end).toISOString() + "&tz=Europe%2FBerlin"

// Warm the platform and the mock (neither is part of the Worker's own CPU in production).
const auth = { authorization: "Basic " + btoa(USER + ":" + PASSWORD) }
for (let i = 0; i < 200; i++) {
  await new Response(new Request("https://warm.invalid/?a=" + i, { headers: { a: "b" } }).url).text()
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode("warm" + i))
  new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", hour: "2-digit" }).formatToParts(new Date())
  new URL("https://warm.invalid/p?q=" + i).searchParams.getAll("q")
}
for (const [method, path, body] of [
  ["PROPFIND", "/.well-known/caldav", ""], ["PROPFIND", "/", "current-user-principal"],
  ["PROPFIND", "/1000001/principal/", ""], ["PROPFIND", "/1000001/calendars/", ""], ["REPORT", "/1000001/calendars/bench/", ""],
]) {
  for (let i = 0; i < 50; i++) await (await mock.fetchImpl(SERVER_URL + path, { method, headers: auth, body })).text()
}

async function once() {
  const before = process.cpuUsage()
  const res = await handleRequest(new Request(url, { headers: { Authorization: "Bearer " + TOKEN } }), ENV, {},
    { fetchImpl: mock.fetchImpl, cache: null, log: () => {} })
  const body = await res.json()
  const used = process.cpuUsage(before)
  return { ms: (used.user + used.system) / 1000, body }
}

const runs = []
let first
for (let i = 0; i < 40; i++) {
  const r = await once()
  if (i === 0) first = r.body
  runs.push(r.ms)
}
const warm = runs.slice(10).sort((a, b) => a - b)
const r1 = (x) => +x.toFixed(1)

console.log(JSON.stringify({
  path: "/" + mode,
  ...(mode === "busy" ? { daysAhead: days, objectsReturned: objects.length, intervals: first.intervals.length } : {}),
  ok: first.ok,
  firstCallMs: r1(runs[0]),
  secondCallMs: r1(runs[1]),
  thirdCallMs: r1(runs[2]),
  warmMedianMs: r1(warm[Math.floor(warm.length / 2)]),
  warmP90Ms: r1(warm[Math.floor(warm.length * 0.9)]),
}))
