// iCloud busy time for the proxy calendar (docs/icloud-spec.md §7; setup: docs/icloud-setup.md).
//
// setupICloud()                                 run by hand: creates the feed token, checks the Worker, creates
//                                               the trigger. Safe to run again at any time (docs/icloud-setup.md).
// fetchICloudBusyIntervals(startTime, endTime)  MirrorBusy provider: reads the iCloud Worker's /busy feed.
// checkICloudAndSync()                          5-minute trigger: runs SyncCalendarsIntoOne when iCloud changed.
// debugICloud(days)                             run by hand: prints status and intervals, writes nothing.
//
// Config.gs:          ICLOUD_FEED_URL, ICLOUD_CALENDARS (empty = all), ICLOUD_FLOATING_TIMEZONE, ICLOUD_DAYS_AHEAD,
//                     MIRROR_EXTRA_PROVIDERS
// Script Properties:  ICLOUD_FEED_TOKEN (created by setupICloud), ICLOUD_FEED_URL (older setups; Config.gs wins)
//                     ICLOUD_LAST_VERSION, ICLOUD_LAST_OK_AT, ICLOUD_LAST_FAILURE_AT, ICLOUD_LAST_RUN_AT (set here)
//
// The token is never logged. Calendar names appear only in this project's own execution log.

const ICLOUD_PROVIDER_NAME = "fetchICloudBusyIntervals"
const ICLOUD_TRIGGER_FUNCTION = "checkICloudAndSync"
const ICLOUD_TRIGGER_MINUTES = 5
const ICLOUD_ALL_CALENDARS = "*"
const ICLOUD_PROP = {
  FEED_URL: "ICLOUD_FEED_URL",
  FEED_TOKEN: "ICLOUD_FEED_TOKEN",
  LAST_VERSION: "ICLOUD_LAST_VERSION",
  LAST_OK_AT: "ICLOUD_LAST_OK_AT",
  LAST_FAILURE_AT: "ICLOUD_LAST_FAILURE_AT",
  LAST_RUN_AT: "ICLOUD_LAST_RUN_AT",
}
const ICLOUD_BUSY_TIMEOUT_SECONDS = 60
const ICLOUD_VERSION_TIMEOUT_SECONDS = 30
const ICLOUD_MAX_CALENDARS = 10
const ICLOUD_DAILY_MS = 24 * 60 * 60 * 1000
const ICLOUD_BACKOFF_MS = 15 * 60 * 1000
const ICLOUD_ALARM_MS = 24 * 60 * 60 * 1000
const ICLOUD_DAY_MS = 24 * 60 * 60 * 1000
const ICLOUD_DEFAULT_DAYS_AHEAD = 30
const ICLOUD_MAX_DAYS_AHEAD = 366

/**
 * Run by hand from the editor, as often as needed. Each run does what is still missing and says what comes next:
 * 1. creates the feed token in Script Properties (only if there is none; the value is never logged),
 * 2. once ICLOUD_FEED_URL is set: checks the Worker, lists the iCloud calendars, prints the next 7 days,
 * 3. once MIRROR_EXTRA_PROVIDERS has fetchICloudBusyIntervals: (re)creates the 5-minute checkICloudAndSync trigger.
 * Writes nothing to any calendar.
 */
function setupICloud() {
  const props = PropertiesService.getScriptProperties()

  if (!String(props.getProperty(ICLOUD_PROP.FEED_TOKEN) || "").trim()) {
    props.setProperty(ICLOUD_PROP.FEED_TOKEN, icloudNewToken_())
    console.log("iCloud setup: created the feed token. Copy it from Project Settings → Script Properties → " +
      ICLOUD_PROP.FEED_TOKEN + " into the FEED_TOKEN field when you deploy the Worker.")
  } else {
    console.log("iCloud setup: feed token is set (Project Settings → Script Properties → " + ICLOUD_PROP.FEED_TOKEN + ").")
  }

  if (!icloudFeedUrl_()) {
    console.log("iCloud setup: next, deploy the Worker with the Deploy to Cloudflare button (docs/icloud-setup.md), " +
      "put its workers.dev URL into ICLOUD_FEED_URL in Config.gs, and run setupICloud again.")
    return
  }

  const cfg = icloudConfig_()
  if (cfg.error) {
    console.warn("iCloud setup: " + cfg.error)
    return
  }

  const listed = icloudGet_(cfg, "/calendars", ICLOUD_VERSION_TIMEOUT_SECONDS)
  if (listed.error) {
    console.warn("iCloud setup: the Worker did not answer (" + listed.error + "). " + icloudSetupHint_(listed.error))
    return
  }
  const names = (Array.isArray(listed.body.calendars) ? listed.body.calendars : [])
    .map(function (c) { return c && typeof c.name === "string" ? c.name : null })
    .filter(function (n) { return n !== null })
  console.log("iCloud setup: the Worker works. iCloud calendars: " + (names.length ? names.join(", ") : "(none)"))

  if (cfg.all) {
    if (names.length > ICLOUD_MAX_CALENDARS) {
      console.warn("iCloud setup: more than " + ICLOUD_MAX_CALENDARS + " calendars. Put the ones that matter into " +
        "ICLOUD_CALENDARS in Config.gs, copied from the list above, and run setupICloud again.")
      return
    }
    console.log("iCloud setup: ICLOUD_CALENDARS is empty, so all of them are read.")
  } else {
    const missing = cfg.calendars.filter(function (n) { return names.indexOf(n) === -1 })
    if (missing.length) {
      console.warn("iCloud setup: not found in iCloud: " + missing.join(", ") + ". Copy the names from the list " +
        "above into ICLOUD_CALENDARS (case and spaces count), or leave it empty to read all calendars.")
      return
    }
  }

  debugICloud(7)

  if (!icloudProviderEnabled_()) {
    console.log("iCloud setup: reading iCloud works. To show it in the proxy calendar, add \"" + ICLOUD_PROVIDER_NAME +
      "\" to MIRROR_EXTRA_PROVIDERS in Config.gs and run setupICloud again; that also creates the trigger.")
    return
  }
  icloudInstallTrigger_()
  console.log("iCloud setup: done. " + ICLOUD_TRIGGER_FUNCTION + " now runs every " + ICLOUD_TRIGGER_MINUTES + " minutes.")
}

/**
 * MirrorBusy provider. Never throws: every problem becomes ok: false (MirrorBusy then skips all deletions).
 * Intervals from calendars that were read fine are returned even when ok is false (creating is safe).
 *
 * Horizon: only [yesterday 00:00 UTC, that + ICLOUD_DAYS_AHEAD + 2 days) is read, clipped to the requested window.
 * The past and the far future don't matter for booking, and a short window keeps the Worker within the Workers
 * Free plan's 10 ms of CPU. Whole UTC days keep the Worker's cache key stable for a day. `coverage` says which
 * part of the requested window the result covers; outside it the provider returns nothing.
 *
 * @param {Date} startTime
 * @param {Date} endTime
 * @param {{dryRun: boolean}=} options  dryRun: write no properties (debugICloud only)
 * @return {{ok: boolean, intervals: Array<{key: string, start: Object, end: Object, allDay: boolean}>,
 *           coverage: ?{start: string, end: string}, reason: string, calendars: Array, cache: string,
 *           version: ?string}}
 */
function fetchICloudBusyIntervals(startTime, endTime, options) {
  const dryRun = !!(options && options.dryRun)
  let result
  try {
    result = icloudReadBusy_(startTime, endTime)
  } catch (e) {
    result = { ok: false, reason: "exception: " + (e && e.message), intervals: [], coverage: null, calendars: [], cache: "off", version: null }
  }

  console.log(icloudSummaryLine_(result))

  if (!dryRun) {
    const props = PropertiesService.getScriptProperties()
    const nowIso = new Date(icloudNow_()).toISOString()
    if (result.ok) {
      props.setProperties({ [ICLOUD_PROP.LAST_VERSION]: result.version, [ICLOUD_PROP.LAST_OK_AT]: nowIso })
    } else {
      props.setProperty(ICLOUD_PROP.LAST_FAILURE_AT, nowIso)
    }
  }
  return result
}

/**
 * Time-driven trigger, every 5 minutes (setupICloud creates it).
 * Runs the full sync when the iCloud calendars changed, and at least once a day. Backs off for 15 minutes after a
 * failed iCloud read. Throws (so Google emails the owner) when iCloud has not been read successfully for 24 h,
 * because while iCloud fails MirrorBusy deletes nothing from the proxy at all.
 */
function checkICloudAndSync() {
  const cfg = icloudConfig_()
  if (cfg.error) {
    console.warn("iCloud check: not configured (" + cfg.error + ")")
    return
  }
  if (!icloudProviderEnabled_()) {
    // Without the provider nothing would ever store ICLOUD_LAST_VERSION, and every check would run a full sync.
    console.warn("iCloud check: " + ICLOUD_PROVIDER_NAME + " is not in MIRROR_EXTRA_PROVIDERS; nothing to do")
    return
  }

  const props = PropertiesService.getScriptProperties()
  const now = icloudNow_()
  const lastRun = Math.max(icloudTime_(props, ICLOUD_PROP.LAST_RUN_AT), icloudTime_(props, ICLOUD_PROP.LAST_OK_AT))
  const lastFailure = icloudTime_(props, ICLOUD_PROP.LAST_FAILURE_AT)

  let reason = null
  if (!lastRun || now - lastRun >= ICLOUD_DAILY_MS) {
    reason = "daily"
  } else if (lastFailure && now - lastFailure < ICLOUD_BACKOFF_MS) {
    console.log("iCloud check: backing off after a failed read at " + new Date(lastFailure).toISOString())
  } else {
    const v = icloudReadVersion_(cfg)
    if (!v.ok) {
      console.warn("iCloud check: /version failed (" + v.reason + ")")
    } else if (v.version === props.getProperty(ICLOUD_PROP.LAST_VERSION)) {
      console.log("iCloud check: no change")
    } else {
      reason = "changed"
    }
  }

  if (reason) {
    console.log("iCloud check: running SyncCalendarsIntoOne (" + reason + ")")
    props.setProperty(ICLOUD_PROP.LAST_RUN_AT, new Date(now).toISOString())
    SyncCalendarsIntoOne()
  }

  icloudHealthCheck_(props, icloudNow_())
}

/**
 * Run by hand from the editor. Prints the state, /version and every interval of the next `days` days.
 * Writes nothing to any calendar or property.
 * @param {number=} days  default 7
 */
function debugICloud(days) {
  const span = typeof days === "number" && days > 0 ? days : 7
  const props = PropertiesService.getScriptProperties()
  const cfg = icloudConfig_()

  console.log("iCloud debug: feed URL " + (icloudFeedUrl_() ? "set" : "missing") +
    ", token " + (props.getProperty(ICLOUD_PROP.FEED_TOKEN) ? "set" : "missing") +
    ", provider " + (icloudProviderEnabled_() ? "enabled" : "not in MIRROR_EXTRA_PROVIDERS"))
  for (const key of [ICLOUD_PROP.LAST_VERSION, ICLOUD_PROP.LAST_OK_AT, ICLOUD_PROP.LAST_FAILURE_AT, ICLOUD_PROP.LAST_RUN_AT]) {
    console.log("  " + key + " = " + (props.getProperty(key) || "(none)"))
  }
  if (cfg.error) {
    console.warn("iCloud debug: not configured (" + cfg.error + ")")
    return
  }

  const v = icloudReadVersion_(cfg)
  console.log("iCloud debug: /version " + (v.ok ? "ok" : "FAILED (" + v.reason + ")") +
    (v.version && v.version === props.getProperty(ICLOUD_PROP.LAST_VERSION) ? ", same as last sync" : ""))
  for (const c of v.calendars || []) console.log("  " + c.name + ": " + (c.ok ? "ok" : c.error))

  const now = new Date(icloudNow_())
  const result = fetchICloudBusyIntervals(now, new Date(now.getTime() + span * ICLOUD_DAY_MS), { dryRun: true })
  console.log("iCloud debug: cache " + result.cache + ", " + result.intervals.length + " intervals in the next " + span +
    " days" + (span > cfg.daysAhead ? " (but only " + cfg.daysAhead + " days ahead are read: ICLOUD_DAYS_AHEAD)" : ""))

  const tz = cfg.tz !== "UTC" ? cfg.tz : Session.getScriptTimeZone()
  const sorted = result.intervals.slice().sort(function (a, b) {
    return icloudIntervalStartMs_(a) - icloudIntervalStartMs_(b)
  })
  for (const i of sorted) console.log("  " + icloudFormatInterval_(i, tz))
}

// ---------------------------------------------------------------------------------------------------------------
// Worker calls

function icloudReadBusy_(startTime, endTime) {
  const cfg = icloudConfig_()
  const empty = { ok: false, intervals: [], coverage: null, calendars: [], cache: "off", version: null }
  if (cfg.error) return Object.assign(empty, { reason: "not configured (" + cfg.error + ")" })
  if (!icloudIsDate_(startTime) || !icloudIsDate_(endTime) || !(endTime.getTime() > startTime.getTime())) {
    return Object.assign(empty, { reason: "invalid window" })
  }

  const horizon = icloudHorizon_(cfg.daysAhead, icloudNow_())
  const windowStart = new Date(Math.max(startTime.getTime(), horizon.start))
  const windowEnd = new Date(Math.min(endTime.getTime(), horizon.end))
  if (!(windowEnd.getTime() > windowStart.getTime())) {
    return Object.assign(empty, { reason: "requested window is outside the iCloud horizon" })
  }
  const coverage = { start: windowStart.toISOString(), end: windowEnd.toISOString() }

  const query = icloudCalendarQuery_(cfg.calendars) +
    "&start=" + encodeURIComponent(coverage.start) +
    "&end=" + encodeURIComponent(coverage.end) +
    "&tz=" + encodeURIComponent(cfg.tz)
  const response = icloudGet_(cfg, "/busy?" + query, ICLOUD_BUSY_TIMEOUT_SECONDS)
  if (response.error) return Object.assign(empty, { reason: response.error, coverage: coverage })

  const body = response.body
  const reasons = []
  if (body.ok !== true) reasons.push("feed ok=false")

  // Every configured calendar must be present and ok. With ICLOUD_CALENDARS empty ("all"), the feed's list is the
  // configured set.
  const byName = {}
  const feedNames = []
  for (const c of Array.isArray(body.calendars) ? body.calendars : []) {
    if (c && typeof c.name === "string") {
      byName[c.name] = c
      feedNames.push(c.name)
    }
  }
  const calendars = (cfg.all ? feedNames : cfg.calendars).map(function (name) {
    const c = byName[name]
    if (!c) return { name: name, ok: false, error: "missing", count: 0 }
    return { name: name, ok: c.ok === true, error: c.ok === true ? undefined : String(c.error || "failed"), count: Number(c.count) || 0 }
  })
  if (calendars.some(function (c) { return !c.ok })) reasons.push("calendar failed")

  const okNames = {}
  for (const c of calendars) if (c.ok) okNames[c.name] = true

  const intervals = []
  let invalid = 0
  for (const raw of Array.isArray(body.intervals) ? body.intervals : []) {
    if (!raw || !okNames[raw.calendar]) continue
    const mapped = icloudMapInterval_(raw)
    if (mapped) intervals.push(mapped)
    else invalid++
  }
  if (invalid) reasons.push(invalid + " invalid interval(s)")

  const version = typeof body.version === "string" && /^[0-9a-f]{64}$/.test(body.version) ? body.version : null
  if (!version && !reasons.length) reasons.push("no version")

  return {
    ok: reasons.length === 0,
    reason: reasons.join(", "),
    intervals: intervals,
    coverage: coverage,
    calendars: calendars,
    cache: typeof body.cache === "string" ? body.cache : "off",
    version: version,
  }
}

function icloudReadVersion_(cfg) {
  const response = icloudGet_(cfg, "/version?" + icloudCalendarQuery_(cfg.calendars), ICLOUD_VERSION_TIMEOUT_SECONDS)
  if (response.error) return { ok: false, reason: response.error, version: null, calendars: [] }
  const body = response.body
  const calendars = Array.isArray(body.calendars) ? body.calendars : []
  const version = typeof body.version === "string" && /^[0-9a-f]{64}$/.test(body.version) ? body.version : null
  if (body.ok !== true || !version) {
    const failed = calendars.filter(function (c) { return c && c.ok !== true }).map(function (c) { return c.name + ": " + c.error })
    return { ok: false, reason: "feed ok=false" + (failed.length ? " (" + failed.join(", ") + ")" : ""), version: null, calendars: calendars }
  }
  return { ok: true, version: version, calendars: calendars }
}

// GET with the bearer token. Returns { body } for HTTP 200 + JSON, else { error } with a short reason.
function icloudGet_(cfg, pathAndQuery, timeoutSeconds) {
  let response
  try {
    response = UrlFetchApp.fetch(cfg.url + pathAndQuery, {
      method: "get",
      headers: { Authorization: "Bearer " + cfg.token },
      muteHttpExceptions: true,
      followRedirects: false,
      timeoutSeconds: timeoutSeconds,
    })
  } catch (e) {
    return { error: "fetch failed: " + (e && e.message) }
  }
  const code = response.getResponseCode()
  let body = null
  try {
    body = JSON.parse(response.getContentText())
  } catch (e) {
    return { error: "http " + code + ", not JSON" }
  }
  if (code !== 200) {
    return { error: "http " + code + (body && body.error ? " " + body.error : "") + (body && typeof body.message === "string" ? ": " + body.message : "") }
  }
  if (!body || typeof body !== "object") return { error: "http 200, empty body" }
  return { body: body }
}

// ---------------------------------------------------------------------------------------------------------------
// Mapping and validation

const ICLOUD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ICLOUD_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

// Worker interval → MirrorBusy interval, or null when anything is off.
function icloudMapInterval_(raw) {
  if (typeof raw.calendar !== "string" || typeof raw.id !== "string" || !raw.id) return null
  if (typeof raw.start !== "string" || typeof raw.end !== "string") return null
  const key = raw.calendar + "|" + raw.id

  if (raw.allDay === true) {
    if (!ICLOUD_DATE_RE.test(raw.start) || !ICLOUD_DATE_RE.test(raw.end)) return null
    const s = Date.parse(raw.start + "T00:00:00Z")
    const e = Date.parse(raw.end + "T00:00:00Z")
    if (!isFinite(s) || !isFinite(e) || !(e > s)) return null
    if (new Date(s).toISOString().slice(0, 10) !== raw.start || new Date(e).toISOString().slice(0, 10) !== raw.end) return null
    return { key: key, start: { date: raw.start }, end: { date: raw.end }, allDay: true }
  }
  if (raw.allDay === false) {
    if (!ICLOUD_INSTANT_RE.test(raw.start) || !ICLOUD_INSTANT_RE.test(raw.end)) return null
    const s = Date.parse(raw.start)
    const e = Date.parse(raw.end)
    if (!isFinite(s) || !isFinite(e) || !(e > s)) return null
    return { key: key, start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(e).toISOString() }, allDay: false }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Config, state, logging

function icloudConfig_() {
  const calendars = typeof ICLOUD_CALENDARS !== "undefined" && Array.isArray(ICLOUD_CALENDARS)
    ? ICLOUD_CALENDARS.map(function (n) { return String(n).trim() }).filter(function (n) { return n })
    : []
  if (calendars.indexOf(ICLOUD_ALL_CALENDARS) !== -1) return { error: "ICLOUD_CALENDARS: leave it empty to read all calendars, not \"*\"" }
  if (calendars.length > ICLOUD_MAX_CALENDARS) return { error: "ICLOUD_CALENDARS has more than " + ICLOUD_MAX_CALENDARS + " names" }
  const all = calendars.length === 0

  const props = PropertiesService.getScriptProperties()
  const url = icloudFeedUrl_()
  const token = String(props.getProperty(ICLOUD_PROP.FEED_TOKEN) || "").trim()
  if (!url) return { error: "ICLOUD_FEED_URL is not set in Config.gs" }
  if (!/^https:\/\/[^/?#]+(\/[^?#]*)?$/.test(url)) return { error: "ICLOUD_FEED_URL must be an https URL with no query" }
  if (!token) return { error: ICLOUD_PROP.FEED_TOKEN + " is not set" }

  const tz = typeof ICLOUD_FLOATING_TIMEZONE !== "undefined" && ICLOUD_FLOATING_TIMEZONE ? String(ICLOUD_FLOATING_TIMEZONE) : "UTC"

  let daysAhead = ICLOUD_DEFAULT_DAYS_AHEAD
  if (typeof ICLOUD_DAYS_AHEAD !== "undefined" && ICLOUD_DAYS_AHEAD !== null && ICLOUD_DAYS_AHEAD !== "") {
    daysAhead = Number(ICLOUD_DAYS_AHEAD)
    if (!(daysAhead >= 1 && daysAhead <= ICLOUD_MAX_DAYS_AHEAD && Math.floor(daysAhead) === daysAhead)) {
      return { error: "ICLOUD_DAYS_AHEAD must be a whole number from 1 to " + ICLOUD_MAX_DAYS_AHEAD }
    }
  }
  return { calendars: all ? [ICLOUD_ALL_CALENDARS] : calendars, all: all, url: url, token: token, tz: tz, daysAhead: daysAhead }
}

// Config.gs first; the Script Property is kept for setups made before ICLOUD_FEED_URL moved to Config.gs.
function icloudFeedUrl_() {
  const fromConfig = typeof ICLOUD_FEED_URL !== "undefined" && ICLOUD_FEED_URL ? String(ICLOUD_FEED_URL) : ""
  const raw = fromConfig.trim() || String(PropertiesService.getScriptProperties().getProperty(ICLOUD_PROP.FEED_URL) || "").trim()
  return raw.replace(/\/+$/, "")
}

// 64 hex characters from two random v4 UUIDs (2 × 122 random bits).
function icloudNewToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "")
}

// Replaces every checkICloudAndSync trigger with one time-driven trigger, so running setup twice leaves one.
function icloudInstallTrigger_() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === ICLOUD_TRIGGER_FUNCTION) ScriptApp.deleteTrigger(t)
  }
  ScriptApp.newTrigger(ICLOUD_TRIGGER_FUNCTION).timeBased().everyMinutes(ICLOUD_TRIGGER_MINUTES).create()
}

// What to do about a failed Worker call during setup.
function icloudSetupHint_(error) {
  if (/^http 401/.test(error)) return "The token differs: put ICLOUD_FEED_TOKEN from Script Properties into the Worker's FEED_TOKEN (Cloudflare → Workers → your Worker → Settings → Variables & Secrets)."
  if (/not_configured/.test(error)) return "A Worker secret is missing: check ICLOUD_APPLE_ID, ICLOUD_APP_PASSWORD and FEED_TOKEN in Cloudflare → Workers → your Worker → Settings → Variables & Secrets."
  if (/upstream_auth/.test(error)) return "Apple rejected the sign-in: check the Apple ID and create a new app-specific password, then update ICLOUD_APP_PASSWORD in Cloudflare."
  if (/^http 404/.test(error)) return "Check ICLOUD_FEED_URL: it should be the Worker's address only, like https://icloud-busy-feed.<name>.workers.dev."
  return "Check ICLOUD_FEED_URL and try again in a minute."
}

// [yesterday 00:00 UTC, + daysAhead + 2 days): covers all of "today" in any time zone and at least daysAhead
// days ahead, and stays the same all day long, so the Worker's cache key does too.
function icloudHorizon_(daysAhead, nowMs) {
  const start = Math.floor(nowMs / ICLOUD_DAY_MS) * ICLOUD_DAY_MS - ICLOUD_DAY_MS
  return { start: start, end: start + (daysAhead + 2) * ICLOUD_DAY_MS }
}

// The clock, in one place so tests can set it.
function icloudNow_() {
  return Date.now()
}

function icloudProviderEnabled_() {
  return typeof MIRROR_EXTRA_PROVIDERS !== "undefined" && Array.isArray(MIRROR_EXTRA_PROVIDERS) &&
    MIRROR_EXTRA_PROVIDERS.indexOf(ICLOUD_PROVIDER_NAME) !== -1
}

function icloudIsDate_(value) {
  return Object.prototype.toString.call(value) === "[object Date]" && isFinite(value.getTime())
}

function icloudCalendarQuery_(names) {
  return names.map(function (n) { return "calendars=" + encodeURIComponent(n) }).join("&")
}

function icloudTime_(props, key) {
  const value = props.getProperty(key)
  const ms = value ? Date.parse(value) : NaN
  return isFinite(ms) ? ms : 0
}

function icloudHealthCheck_(props, now) {
  const lastOk = icloudTime_(props, ICLOUD_PROP.LAST_OK_AT)
  const lastFailure = icloudTime_(props, ICLOUD_PROP.LAST_FAILURE_AT)
  if (lastFailure && lastFailure > lastOk && (!lastOk || now - lastOk > ICLOUD_ALARM_MS)) {
    throw new Error("iCloud has not synced for over 24 h (last success: " +
      (lastOk ? new Date(lastOk).toISOString() : "never") + ", last failure: " + new Date(lastFailure).toISOString() +
      "). While this lasts, no proxy events are deleted. Run debugICloud() for details.")
  }
}

// One line per run: "iCloud: ok; Calendar A: 12, Calendar B: 3" or "iCloud: FAILED (reason); ...".
function icloudSummaryLine_(result) {
  const parts = (result.calendars || []).map(function (c) {
    return c.name + ": " + (c.ok ? c.count : "failed (" + c.error + ")")
  })
  return "iCloud: " + (result.ok ? "ok" : "FAILED (" + result.reason + ")") +
    (result.cache && result.cache !== "off" ? ", cache " + result.cache : "") +
    (parts.length ? "; " + parts.join(", ") : "")
}

function icloudIntervalStartMs_(i) {
  return i.allDay ? Date.parse(i.start.date + "T00:00:00Z") : Date.parse(i.start.dateTime)
}

// "Tue 17 Nov 09:00–10:00 · Calendar A" in the given zone; all-day: "Fri 20 Nov – Sat 21 Nov (all day) · Calendar A".
function icloudFormatInterval_(i, tz) {
  const calendar = i.key.split("|")[0]
  if (i.allDay) {
    const s = new Date(i.start.date + "T12:00:00Z")
    const last = new Date(Date.parse(i.end.date + "T12:00:00Z") - 24 * 60 * 60 * 1000)
    const fmt = function (d) { return Utilities.formatDate(d, "UTC", "EEE d MMM") }
    return fmt(s) + (last > s ? " – " + fmt(last) : "") + " (all day) · " + calendar
  }
  const s = new Date(i.start.dateTime)
  const e = new Date(i.end.dateTime)
  const sameDay = Utilities.formatDate(s, tz, "yyyyMMdd") === Utilities.formatDate(e, tz, "yyyyMMdd")
  return Utilities.formatDate(s, tz, "EEE d MMM HH:mm") + "–" +
    Utilities.formatDate(e, tz, sameDay ? "HH:mm" : "EEE d MMM HH:mm") + " · " + calendar
}
