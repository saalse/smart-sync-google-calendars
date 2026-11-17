// Loads Apps Script .gs files into a Node vm context with small mocks of the Apps Script services.
// No network, no Google APIs: UrlFetchApp answers from a queue of canned responses.

const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const SCRIPTS = path.join(__dirname, "..", "..", "scripts")

class MockProperties {
  constructor(initial = {}) {
    this.store = { ...initial }
    this.writes = []
  }
  getProperty(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null
  }
  setProperty(key, value) {
    this.writes.push(key)
    this.store[key] = String(value)
    return this
  }
  setProperties(values) {
    for (const [k, v] of Object.entries(values)) this.setProperty(k, v)
    return this
  }
}

function httpResponse(code, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  return { getResponseCode: () => code, getContentText: () => text }
}

// Minimal Utilities.formatDate for the patterns ICloudSource.gs and MirrorBusy.gs use.
function formatDate(date, timeZone, pattern) {
  if (pattern === "XXX") {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date)
      .find((p) => p.type === "timeZoneName").value
    return name === "GMT" ? "Z" : name.replace("GMT", "")
  }
  const parts = {}
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date)) parts[p.type] = p.value
  const num = {}
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)) num[p.type] = p.value
  return pattern
    .replace("yyyy-MM-dd", num.year + "-" + num.month + "-" + num.day)
    .replace("yyyyMMdd", num.year + num.month + num.day)
    .replace("EEE", parts.weekday)
    .replace("MMM", parts.month)
    .replace(/\bd\b/, parts.day)
    .replace("HH:mm", parts.hour + ":" + parts.minute)
}

// Start of an event time as ms; all-day dates count as UTC midnight.
function timeMs(t) {
  return t.date ? Date.parse(t.date + "T00:00:00Z") : Date.parse(t.dateTime)
}

/**
 * In-memory Google Calendar for the advanced Calendar service and for batch requests.
 * calendars: { [id]: { events: [...], accessRole?, timeZone?, failList?: boolean | Error, pageSize?, allDayOffsetMs? } }
 */
function makeCalendar(calendars) {
  const lists = []
  let nextId = 1
  const cal = (id) => {
    const c = calendars[id]
    if (!c) throw new Error("Not Found: " + id)
    return c
  }
  const Calendar = {
    Events: {
      list(id, params = {}) {
        const c = cal(id)
        lists.push({ id, params })
        if (c.failList) throw (c.failList instanceof Error ? c.failList : new Error("list failed: " + id))
        const min = params.timeMin ? Date.parse(params.timeMin) : -Infinity
        const max = params.timeMax ? Date.parse(params.timeMax) : Infinity
        // All-day dates are days in the calendar's own zone: allDayOffsetMs moves UTC midnight there.
        const ms = (t) => timeMs(t) + (t.date ? c.allDayOffsetMs || 0 : 0)
        let items = c.events.filter((ev) => ms(ev.end) > min && ms(ev.start) < max)
        if (params.privateExtendedProperty) {
          const [k, v] = params.privateExtendedProperty.split("=")
          items = items.filter((ev) => ev.extendedProperties?.private?.[k] === v)
        }
        items = items.slice(0, params.maxResults || 2500)
        const size = c.pageSize || items.length || 1
        const offset = params.pageToken ? Number(params.pageToken) : 0
        const page = items.slice(offset, offset + size)
        const out = { items: JSON.parse(JSON.stringify(page)) }
        if (offset + size < items.length) out.nextPageToken = String(offset + size)
        return out
      },
    },
    CalendarList: {
      get(id) {
        const c = cal(id)
        if (!c.accessRole) throw new Error("Not Found: " + id)
        return { id, accessRole: c.accessRole }
      },
    },
    Calendars: { get: (id) => ({ id, timeZone: cal(id).timeZone || "UTC" }) },
  }

  // Applies one batch request to the store, like the Calendar API would.
  function apply(req) {
    const m = req.endpoint.match(/\/calendars\/([^/?]+)\/events(?:\/([^?]+))?(?:\?(.*))?$/)
    if (!m) throw new Error("unexpected endpoint: " + req.endpoint)
    const c = cal(decodeURIComponent(m[1]))
    const eventId = m[2] ? decodeURIComponent(m[2]) : null
    const find = () => c.events.findIndex((ev) => ev.id === eventId)
    if (req.method === "POST") {
      const ev = { ...JSON.parse(JSON.stringify(req.requestBody)), id: "ev" + nextId++ }
      c.events.push(ev)
      return ev
    }
    const i = find()
    if (i === -1) return { error: { code: 404, message: "Not Found" } }
    if (req.method === "PUT") {
      c.events[i] = { ...JSON.parse(JSON.stringify(req.requestBody)), id: eventId }
      return c.events[i]
    }
    if (req.method === "PATCH") {
      c.events[i] = { ...c.events[i], ...JSON.parse(JSON.stringify(req.requestBody)) }
      return c.events[i]
    }
    if (req.method === "DELETE") {
      c.events.splice(i, 1)
      return "Content-Type: application/http\r\n\r\nHTTP/1.1 204 No Content\r\n"
    }
    throw new Error("unexpected method " + req.method)
  }

  return { Calendar, apply, lists }
}

/**
 * @param {object} opts
 * @param {object} [opts.config]      Config.gs constants, e.g. { ICLOUD_CALENDARS: [...] }
 * @param {object} [opts.properties]  initial Script Properties
 * @param {Array}  [opts.responses]   queue: { code, body } or an Error to throw
 * @param {number} [opts.now]         fixed clock (ms) for ICloudSource's icloudNow_()
 * @param {string[]} [opts.triggers]  handler names of existing project triggers
 * @param {string[]} [opts.files]     .gs files to load, in order (default: ICloudSource.gs)
 * @param {object} [opts.calendars]   in-memory calendars, see makeCalendar
 * @param {Function} [opts.failRequest]  (request) → true to make that batch request fail
 * @param {string} [opts.scriptTimeZone]  default "UTC"
 */
function load(opts = {}) {
  const properties = new MockProperties(opts.properties)
  const fetches = []
  const logs = []
  const responses = (opts.responses || []).slice()
  const syncCalls = []
  const triggers = (opts.triggers || []).map((name) => ({ name, every: null }))
  const ScriptApp = {
    getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.name, _t: t })),
    deleteTrigger: (wrapped) => { const i = triggers.indexOf(wrapped._t); if (i >= 0) triggers.splice(i, 1) },
    newTrigger: (name) => ({
      timeBased: () => ({
        everyMinutes: (n) => ({
          create: () => {
            if (![1, 5, 10, 15, 30].includes(n)) throw new Error("everyMinutes: invalid " + n)
            triggers.push({ name, every: n })
          },
        }),
      }),
    }),
  }

  const store = makeCalendar(opts.calendars || {})
  const batches = []
  // Stands in for the BatchRequest library (BatchRequests.gs): applies each request to the in-memory calendars.
  function BatchRequest(obj) {
    batches.push(obj.requests.map((r) => JSON.parse(JSON.stringify(r))))
    return obj.requests.map((r) => (opts.failRequest && opts.failRequest(r) ? { error: { code: 403, message: "Forbidden" } } : store.apply(r)))
  }
  let lockHeld = false
  const LockService = {
    getScriptLock: () => ({
      tryLock: () => { if (lockHeld) return false; lockHeld = true; return true },
      releaseLock: () => { lockHeld = false },
    }),
  }
  const CalendarApp = { getCalendarById: (id) => (opts.calendars && opts.calendars[id] ? { getId: () => id } : null) }

  const context = {
    console: {
      log: (...a) => logs.push(["log", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
    PropertiesService: { getScriptProperties: () => properties },
    UrlFetchApp: {
      fetch(url, params) {
        fetches.push({ url, params })
        const next = responses.shift()
        if (!next) throw new Error("unexpected fetch: " + url)
        if (next instanceof Error) throw next
        return httpResponse(next.code, next.body)
      },
    },
    Utilities: {
      formatDate,
      getUuid: () => require("node:crypto").randomUUID(),
      // Like Apps Script: signed bytes (-128..127).
      computeHmacSha256Signature: (value, key) =>
        Array.from(require("node:crypto").createHmac("sha256", key).update(value).digest()).map((b) => (b > 127 ? b - 256 : b)),
    },
    ScriptApp,
    Session: { getScriptTimeZone: () => opts.scriptTimeZone || "UTC" },
    SyncCalendarsIntoOne: () => syncCalls.push(Date.now()),
    Calendar: store.Calendar,
    CalendarApp,
    LockService,
    BatchRequest,
  }
  vm.createContext(context)

  const configLines = Object.entries(opts.config || {}).map(([k, v]) => `const ${k} = ${JSON.stringify(v)}`)
  vm.runInContext(configLines.join("\n"), context, { filename: "Config.gs" })
  for (const file of opts.files || ["ICloudSource.gs"]) {
    vm.runInContext(fs.readFileSync(path.join(SCRIPTS, file), "utf8"), context, { filename: file })
  }
  if (typeof opts.now === "number") {
    context.icloudNow_ = () => opts.now
    context.mirrorNow_ = () => opts.now
  }

  return { context, properties, fetches, logs, responses, syncCalls, triggers, calendars: opts.calendars || {}, batches, lists: store.lists }
}

module.exports = { load, SCRIPTS }
