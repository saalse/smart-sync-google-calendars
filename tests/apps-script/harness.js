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

// Minimal Utilities.formatDate for the patterns ICloudSource.gs uses.
function formatDate(date, timeZone, pattern) {
  const parts = {}
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date)) parts[p.type] = p.value
  const num = {}
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date)) num[p.type] = p.value
  return pattern
    .replace("yyyyMMdd", num.year + num.month + num.day)
    .replace("EEE", parts.weekday)
    .replace("MMM", parts.month)
    .replace(/\bd\b/, parts.day)
    .replace("HH:mm", parts.hour + ":" + parts.minute)
}

/**
 * @param {object} opts
 * @param {object} [opts.config]      Config.gs constants, e.g. { ICLOUD_CALENDARS: [...] }
 * @param {object} [opts.properties]  initial Script Properties
 * @param {Array}  [opts.responses]   queue: { code, body } or an Error to throw
 * @param {number} [opts.now]         fixed clock (ms) for ICloudSource's icloudNow_()
 * @param {string[]} [opts.triggers]  handler names of existing project triggers
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
    Utilities: { formatDate, getUuid: () => require("node:crypto").randomUUID() },
    ScriptApp,
    Session: { getScriptTimeZone: () => "UTC" },
    SyncCalendarsIntoOne: () => syncCalls.push(Date.now()),
  }
  vm.createContext(context)

  const configLines = Object.entries(opts.config || {}).map(([k, v]) => `const ${k} = ${JSON.stringify(v)}`)
  vm.runInContext(configLines.join("\n"), context, { filename: "Config.gs" })
  vm.runInContext(fs.readFileSync(path.join(SCRIPTS, "ICloudSource.gs"), "utf8"), context, { filename: "ICloudSource.gs" })
  if (typeof opts.now === "number") context.icloudNow_ = () => opts.now

  return { context, properties, fetches, logs, responses, syncCalls, triggers }
}

module.exports = { load, SCRIPTS }
