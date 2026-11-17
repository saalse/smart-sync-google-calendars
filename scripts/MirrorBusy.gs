// MirrorBusy: plain "Busy" copies of your busy time in a proxy calendar (docs/proxy-setup.md).
// Author: Alex Samson (https://saalse.com). Project: https://github.com/saalse/busy-calendars
//
// setupMirrorBusy()        run by hand: checks the config and the proxy share, creates the key secret, shows the plan.
// dryRunMirrorBusy()       run by hand: logs what the next sync would change in the proxy. Writes nothing.
// debugProxyDay(date)      run by hand: lists the proxy's events on one day and where each "Busy" came from.
// mirrorBusyAfterSync_()   called by SyncCalendarsIntoOne at the end of every sync, inside its lock.
//
// Config.gs:          MIRROR_BUSY_TO (proxy calendar ID; empty = off), MIRROR_EXTRA_PROVIDERS (function names)
// Script Properties:  MIRROR_KEY_SECRET (created here; changing it replaces every proxy event once)
//
// Sources: every busy event in Busy Time, plus the intervals of each function in MIRROR_EXTRA_PROVIDERS, called as
// fn(startTime, endTime, {dryRun}) → { ok, intervals: [{ key, start, end, allDay }], coverage?: { start, end } }.
// Each source item becomes one proxy event: title "Busy", private, opaque, no reminders, no location, description,
// guests or conference. The proxy event stores only HMAC values, never a calendar name, title or event ID.
// While any source failed to load, nothing is deleted from the proxy (creates and updates go on).

const MIRROR_TITLE = "Busy"
const MIRROR_MARKER = "mirrorBusy"
const MIRROR_MARKER_VALUE = "1"
const MIRROR_BUSY_TIME_SOURCE = "busytime"
const MIRROR_PROP_SECRET = "MIRROR_KEY_SECRET"
const MIRROR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars"
const MIRROR_BATCH_PATH = "batch/calendar/v3"
const MIRROR_DAY_MS = 24 * 60 * 60 * 1000
const MIRROR_LIST_MARGIN_MS = 2 * MIRROR_DAY_MS
const MIRROR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MIRROR_DRY_RUN_LINES = 30

/**
 * Called by SyncCalendarsIntoOne inside its lock, after Busy Time is up to date. Never throws.
 * @param {Date=} endTime  end of the sync window
 */
function mirrorBusyAfterSync_(endTime) {
  try {
    const cfg = mirrorConfig_()
    if (cfg.off) return
    if (cfg.error) {
      console.error("MirrorBusy: " + cfg.error + " Nothing was written to the proxy.")
      return
    }
    mirrorRun_(cfg, mirrorWindow_(endTime), false)
  } catch (e) {
    console.error("MirrorBusy failed: " + (e && e.stack || e))
  }
}

/**
 * Run by hand, any number of times. Checks the config and the proxy share, creates MIRROR_KEY_SECRET if missing and
 * logs what the next sync would change. Writes nothing to any calendar.
 */
function setupMirrorBusy() {
  const cfg = mirrorConfig_()
  if (cfg.off) {
    console.log("MirrorBusy setup: set MIRROR_BUSY_TO in Config.gs to the proxy account's address (the ID of its " +
      "primary calendar) and run setupMirrorBusy again.")
    return
  }
  if (cfg.error) {
    console.warn("MirrorBusy setup: " + cfg.error)
    return
  }

  mirrorSecret_()

  const access = mirrorCheckAccess_(cfg)
  if (!access.ok) {
    console.warn("MirrorBusy setup: " + access.message)
    return
  }
  console.log("MirrorBusy setup: " + access.message)

  for (const name of cfg.providers) {
    console.log("MirrorBusy setup: extra source " + name + ": " +
      (typeof mirrorGlobal_()[name] === "function" ? "found" : "NOT FOUND (no function with that name in this project)"))
  }

  mirrorRun_(cfg, mirrorWindow_(), true)
  console.log("MirrorBusy setup: done. Run SyncCalendarsIntoOne once to write the proxy; after that every sync " +
    "updates it. Check the proxy with debugProxyDay(\"YYYY-MM-DD\").")
}

/** Run by hand: logs what the next sync would create, update and delete in the proxy. Writes nothing. */
function dryRunMirrorBusy() {
  const cfg = mirrorConfig_()
  if (cfg.off) {
    console.log("MirrorBusy dry run: MIRROR_BUSY_TO is empty, the mirror is off.")
    return
  }
  if (cfg.error) {
    console.warn("MirrorBusy dry run: " + cfg.error)
    return
  }
  mirrorRun_(cfg, mirrorWindow_(), true)
}

/**
 * Run by hand: every event in the proxy on one day, and for each "Busy" the source it came from. Writes nothing.
 * Source names appear only in this log; the proxy itself holds HMAC values only.
 * @param {string=} dateStr  "YYYY-MM-DD" in the proxy calendar's time zone; default today
 */
function debugProxyDay(dateStr) {
  const cfg = mirrorConfig_()
  if (cfg.off || cfg.error) {
    console.warn("MirrorBusy debug: " + (cfg.error || "MIRROR_BUSY_TO is empty, the mirror is off."))
    return
  }
  const tz = mirrorProxyTimeZone_(cfg)
  const day = typeof dateStr === "string" && MIRROR_DATE_RE.test(dateStr.trim())
    ? dateStr.trim()
    : Utilities.formatDate(new Date(mirrorNow_()), tz, "yyyy-MM-dd")
  const dayStart = mirrorStartOfDay_(day, tz)
  const window = { start: new Date(dayStart), end: new Date(dayStart + MIRROR_DAY_MS) }

  let items
  try {
    items = mirrorListAll_(cfg.target, { timeMin: window.start.toISOString(), timeMax: window.end.toISOString() })
  } catch (e) {
    console.warn("MirrorBusy debug: cannot read the proxy calendar (" + e.message + ")")
    return
  }

  const collected = mirrorCollect_(cfg, window, mirrorSecret_(), true)
  console.log("MirrorBusy debug: " + day + " (" + tz + "), " + items.length + " event(s) in the proxy; sources: " +
    collected.sources.map(mirrorSourceText_).join(", "))

  items.sort(function (a, b) { return mirrorStartMs_(a.start) - mirrorStartMs_(b.start) })
  for (const ev of items) {
    const when = mirrorFormatRange_(ev.start, ev.end, tz)
    const props = mirrorPrivate_(ev)
    if (props[MIRROR_MARKER] !== MIRROR_MARKER_VALUE) {
      console.log("  " + when + "  \"" + (ev.summary || "") + "\": not written by MirrorBusy (a booking or added by hand)")
      continue
    }
    const want = props.mirrorKey ? collected.desired.get(props.mirrorKey) : null
    const problems = mirrorProblems_(ev, want)
    console.log("  " + when + "  Busy ← " + (want ? want.label : "no current source (deleted at the next sync " +
      "unless a source fails)") + (problems.length ? "; fixed at the next sync: " + problems.join(", ") : ""))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One mirror run

function mirrorRun_(cfg, window, dryRun) {
  const secret = mirrorSecret_()
  const collected = mirrorCollect_(cfg, window, secret, dryRun)

  let existing
  try {
    existing = mirrorListAll_(cfg.target, {
      timeMin: new Date(window.start.getTime() - MIRROR_LIST_MARGIN_MS).toISOString(),
      timeMax: new Date(window.end.getTime() + MIRROR_LIST_MARGIN_MS).toISOString(),
      privateExtendedProperty: MIRROR_MARKER + "=" + MIRROR_MARKER_VALUE,
    })
  } catch (e) {
    console.error("MirrorBusy: cannot read the proxy calendar (" + e.message + "). Is it shared with this account " +
      "with \"Make changes to events\"? Run setupMirrorBusy. Nothing was written.")
    return null
  }

  const plan = mirrorPlan_(collected, existing, window)
  let failed = 0
  if (!dryRun) failed = mirrorExecute_(cfg, plan)

  console.log(mirrorSummaryLine_(collected, plan, failed, dryRun))
  if (dryRun) mirrorLogPlan_(plan, mirrorProxyTimeZone_(cfg))
  return { collected: collected, plan: plan, failed: failed }
}

// Everything that should be in the proxy: mirrorKey → { key, tag, start, end, label }, plus one status per source.
function mirrorCollect_(cfg, window, secret, dryRun) {
  const desired = new Map()
  const sources = []

  const add = function (source, rawKey, start, end, label) {
    if (!mirrorOverlaps_(start, end, window)) return
    const key = mirrorHmac_(secret, source.name + ":" + rawKey)
    if (!desired.has(key)) desired.set(key, { key: key, tag: source.tag, start: start, end: end, label: label })
  }

  const busyTime = { name: MIRROR_BUSY_TIME_SOURCE, label: "Busy Time", tag: mirrorTag_(secret, MIRROR_BUSY_TIME_SOURCE), coverage: null }
  const bt = mirrorReadBusyTime_(cfg, window)
  busyTime.ok = bt.ok
  busyTime.reason = bt.reason
  busyTime.count = bt.items.length
  for (const ev of bt.items) {
    add(busyTime, ev.id, mirrorTime_(ev.start), mirrorTime_(ev.end), "Busy Time" + mirrorBusyTimePrefix_(ev))
  }
  sources.push(busyTime)

  for (const name of cfg.providers) {
    const source = { name: name, label: name, tag: mirrorTag_(secret, name), coverage: null }
    const result = mirrorCallProvider_(name, window, dryRun)
    source.ok = result.ok
    source.reason = result.reason
    source.count = result.intervals.length
    source.coverage = result.coverage
    for (const i of result.intervals) {
      const calendar = i.key.indexOf("|") > 0 ? " · " + i.key.split("|")[0] : ""
      add(source, i.key, i.start, i.end, name + calendar)
    }
    sources.push(source)
  }

  return { desired: desired, sources: sources }
}

function mirrorReadBusyTime_(cfg, window) {
  const items = []
  try {
    const all = mirrorListAll_(cfg.busyTime, { timeMin: window.start.toISOString(), timeMax: window.end.toISOString() })
    for (const ev of all) if (mirrorIsBusy_(ev, cfg)) items.push(ev)
  } catch (e) {
    return { ok: false, reason: "cannot read Busy Time: " + (e && e.message), items: items }
  }
  return { ok: true, reason: "", items: items }
}

// A Busy Time event that blocks time and did not come from the proxy (loop guard).
function mirrorIsBusy_(ev, cfg) {
  if (!ev || ev.status === "cancelled" || ev.transparency === "transparent") return false
  if (ev.eventType === "workingLocation") return false
  const props = mirrorPrivate_(ev)
  if (props[MIRROR_MARKER]) return false
  if (props.sourceCalendarId && mirrorSameId_(props.sourceCalendarId, cfg.target)) return false
  return !!(mirrorTime_(ev.start) && mirrorTime_(ev.end))
}

// Calls one provider; a missing or throwing function, or one returning anything odd, counts as not ok.
function mirrorCallProvider_(name, window, dryRun) {
  const fn = mirrorGlobal_()[name]
  if (typeof fn !== "function") return { ok: false, reason: "no function named " + name, intervals: [], coverage: null }
  let result
  try {
    result = fn(new Date(window.start.getTime()), new Date(window.end.getTime()), { dryRun: !!dryRun })
  } catch (e) {
    return { ok: false, reason: "threw: " + (e && e.message), intervals: [], coverage: null }
  }
  if (!result || typeof result !== "object") return { ok: false, reason: "returned nothing", intervals: [], coverage: null }

  const intervals = []
  let invalid = 0
  for (const i of Array.isArray(result.intervals) ? result.intervals : []) {
    const start = i && mirrorTime_(i.start)
    const end = i && mirrorTime_(i.end)
    const valid = start && end && typeof i.key === "string" && i.key !== "" &&
      !!start.date === !!end.date && (i.allDay === undefined || !!i.allDay === !!start.date) &&
      mirrorStartMs_(end) > mirrorStartMs_(start)
    if (valid) intervals.push({ key: i.key, start: start, end: end })
    else invalid++
  }

  let coverage = null
  if (result.coverage && typeof result.coverage === "object") {
    const s = Date.parse(result.coverage.start)
    const e = Date.parse(result.coverage.end)
    if (isFinite(s) && isFinite(e) && e > s) coverage = { start: s, end: e }
  }

  const reasons = []
  if (result.ok !== true) reasons.push(result.reason ? String(result.reason) : "ok is not true")
  if (invalid) reasons.push(invalid + " invalid interval(s)")
  return { ok: reasons.length === 0, reason: reasons.join(", "), intervals: intervals, coverage: coverage }
}

// Decides creates, updates and deletes. Deletes only inside the window, only while every source is ok, and for a
// provider with `coverage` only inside it. Extra copies of one key are always removed.
function mirrorPlan_(collected, existing, window) {
  const toCreate = []
  const toUpdate = []
  const toDelete = []
  let unchanged = 0
  let kept = 0
  const deletionsAllowed = collected.sources.every(function (s) { return s.ok })
  const sourceByTag = {}
  for (const s of collected.sources) sourceByTag[s.tag] = s
  const seen = new Set()

  for (const ev of existing) {
    const props = mirrorPrivate_(ev)
    const key = props.mirrorKey
    const want = key ? collected.desired.get(key) : null
    if (want && !seen.has(key)) {
      seen.add(key)
      if (mirrorProblems_(ev, want).length) toUpdate.push({ id: ev.id, want: want, event: ev })
      else unchanged++
      continue
    }
    if (want) {
      toDelete.push({ id: ev.id, event: ev, why: "duplicate" })
      continue
    }
    const start = mirrorTime_(ev.start)
    const end = mirrorTime_(ev.end)
    if (start && end && !mirrorOverlaps_(start, end, window)) continue
    if (!deletionsAllowed) {
      kept++
      continue
    }
    const source = sourceByTag[props.mirrorSource]
    if (source && source.coverage && start && end && !mirrorOverlaps_(start, end, source.coverage)) continue
    toDelete.push({ id: ev.id, event: ev, why: "gone" })
  }

  collected.desired.forEach(function (want, key) {
    if (!seen.has(key)) toCreate.push(want)
  })
  return { toCreate: toCreate, toUpdate: toUpdate, toDelete: toDelete, unchanged: unchanged, kept: kept, deletionsAllowed: deletionsAllowed }
}

// What differs between a proxy event and what it should be. Empty = nothing to do.
function mirrorProblems_(ev, want) {
  const problems = []
  if (ev.summary !== MIRROR_TITLE) problems.push("title")
  if (ev.visibility !== "private") problems.push("visibility")
  if (ev.transparency === "transparent") problems.push("shown as free")
  if (ev.location || ev.description) problems.push("details")
  if (Array.isArray(ev.attendees) && ev.attendees.length) problems.push("guests")
  if (ev.conferenceData || ev.hangoutLink) problems.push("conference")
  if (!ev.reminders || ev.reminders.useDefault !== false || (Array.isArray(ev.reminders.overrides) && ev.reminders.overrides.length)) {
    problems.push("reminders")
  }
  if (want) {
    if (!mirrorSameTime_(ev.start, want.start) || !mirrorSameTime_(ev.end, want.end)) problems.push("time")
    if (mirrorPrivate_(ev).mirrorSource !== want.tag) problems.push("source tag")
  }
  return problems
}

// The whole proxy event. Sent as POST (create) or PUT (update): PUT replaces the event, so anything added by hand
// (place, notes, guests, conference) is removed.
function mirrorBody_(want) {
  const body = {
    summary: MIRROR_TITLE,
    start: want.start,
    end: want.end,
    visibility: "private",
    transparency: "opaque",
    reminders: { useDefault: false },
    extendedProperties: { private: {} },
  }
  body.extendedProperties.private[MIRROR_MARKER] = MIRROR_MARKER_VALUE
  body.extendedProperties.private.mirrorKey = want.key
  body.extendedProperties.private.mirrorSource = want.tag
  return body
}

// Sends the plan in batches. Returns the number of failed requests (a failed create or delete is retried next run).
function mirrorExecute_(cfg, plan) {
  const base = MIRROR_EVENTS_ENDPOINT + "/" + encodeURIComponent(cfg.target) + "/events"
  const requests = []
  for (const d of plan.toDelete) {
    requests.push({ method: "DELETE", endpoint: base + "/" + encodeURIComponent(d.id) + "?sendUpdates=none" })
  }
  for (const u of plan.toUpdate) {
    requests.push({ method: "PUT", endpoint: base + "/" + encodeURIComponent(u.id) + "?sendUpdates=none", requestBody: mirrorBody_(u.want) })
  }
  for (const c of plan.toCreate) {
    requests.push({ method: "POST", endpoint: base + "?sendUpdates=none", requestBody: mirrorBody_(c) })
  }
  if (!requests.length) return 0

  const responses = new BatchRequest({ useFetchAll: true, batchPath: MIRROR_BATCH_PATH, requests: requests })
  let failed = 0
  for (const r of Array.isArray(responses) ? responses : []) {
    if (r && typeof r === "object" && r.error) failed++
    else if (typeof r === "string" && /HTTP\/\d(\.\d)? [45]\d\d/.test(r)) failed++
  }
  return failed
}

// ---------------------------------------------------------------------------------------------------------------
// Config, keys, access

function mirrorConfig_() {
  const target = typeof MIRROR_BUSY_TO !== "undefined" && MIRROR_BUSY_TO ? String(MIRROR_BUSY_TO).trim() : ""
  if (!target) return { off: true }
  const busyTime = typeof CALENDAR_TO_MERGE_INTO !== "undefined" && CALENDAR_TO_MERGE_INTO ? String(CALENDAR_TO_MERGE_INTO).trim() : ""
  if (!busyTime) return { error: "CALENDAR_TO_MERGE_INTO is not set in Config.gs." }
  if (mirrorSameId_(target, busyTime)) return { error: "MIRROR_BUSY_TO is the Busy Time calendar itself; set it to the proxy calendar." }

  const sources = typeof CALENDARS_TO_MERGE !== "undefined" && CALENDARS_TO_MERGE && typeof CALENDARS_TO_MERGE === "object"
    ? Object.keys(CALENDARS_TO_MERGE).map(function (k) { return String(CALENDARS_TO_MERGE[k]) })
    : []
  if (sources.some(function (id) { return mirrorSameId_(id, target) })) {
    return { error: "MIRROR_BUSY_TO is also in CALENDARS_TO_MERGE, so its Busy events would loop back into Busy Time. " +
      "Remove the proxy from CALENDARS_TO_MERGE." }
  }

  const providers = []
  if (typeof MIRROR_EXTRA_PROVIDERS !== "undefined") {
    if (!Array.isArray(MIRROR_EXTRA_PROVIDERS)) return { error: "MIRROR_EXTRA_PROVIDERS must be a list of function names, like [\"fetchICloudBusyIntervals\"]." }
    for (const raw of MIRROR_EXTRA_PROVIDERS) {
      const name = String(raw).trim()
      if (name && name !== MIRROR_BUSY_TIME_SOURCE && providers.indexOf(name) === -1) providers.push(name)
    }
  }
  return { target: target, busyTime: busyTime, providers: providers }
}

// MIRROR_KEY_SECRET, created on first use (64 hex from two random UUIDs). Never logged.
function mirrorSecret_() {
  const props = PropertiesService.getScriptProperties()
  let secret = String(props.getProperty(MIRROR_PROP_SECRET) || "").trim()
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "")
    props.setProperty(MIRROR_PROP_SECRET, secret)
    console.log("MirrorBusy: created " + MIRROR_PROP_SECRET + " in Script Properties. Leave it as it is: a new value " +
      "replaces every proxy event once.")
  }
  return secret
}

function mirrorHmac_(secret, text) {
  const bytes = Utilities.computeHmacSha256Signature(text, secret)
  let hex = ""
  for (const b of bytes) hex += ((b + 256) % 256).toString(16).padStart(2, "0")
  return hex
}

// A short opaque tag per source, so a run can tell whose event it is without naming the source.
function mirrorTag_(secret, sourceName) {
  return mirrorHmac_(secret, "source:" + sourceName).slice(0, 16)
}

function mirrorCheckAccess_(cfg) {
  let role = null
  try {
    const entry = Calendar.CalendarList.get(cfg.target)
    role = entry && entry.accessRole
  } catch (e) {
    role = null
  }
  if (role === "owner" || role === "writer") {
    return { ok: true, message: "the proxy calendar is shared with this account with write access (" + role + ")." }
  }
  if (role === "reader" || role === "freeBusyReader") {
    return { ok: false, message: "this account can only " + (role === "reader" ? "see" : "see free/busy of") + " the proxy " +
      "calendar. In the proxy account, change the share to \"Make changes to events\" and run setupMirrorBusy again." }
  }
  try {
    Calendar.Events.list(cfg.target, { maxResults: 1, timeMin: new Date(mirrorNow_()).toISOString() })
  } catch (e) {
    return { ok: false, message: "cannot open the proxy calendar (" + e.message + "). In the proxy account: Google " +
      "Calendar → Settings → its primary calendar → Share with specific people → add this account with \"Make " +
      "changes to events\". Then open the email it gets, click the link to add the calendar, and run setupMirrorBusy again." }
  }
  return { ok: true, message: "the proxy calendar can be read, but its access level is unknown because it is not in " +
    "this account's calendar list. If writes fail, add it from the share email (\"Make changes to events\")." }
}

// ---------------------------------------------------------------------------------------------------------------
// Calendar reads

function mirrorListAll_(calendarId, extra) {
  const items = []
  let pageToken = null
  do {
    const params = { singleEvents: true, showDeleted: false, maxResults: 2500 }
    for (const k of Object.keys(extra)) params[k] = extra[k]
    if (pageToken) params.pageToken = pageToken
    const res = Calendar.Events.list(calendarId, params)
    for (const ev of (res && res.items) || []) items.push(ev)
    pageToken = res && res.nextPageToken
  } while (pageToken)
  return items
}

function mirrorProxyTimeZone_(cfg) {
  try {
    const tz = Calendar.Calendars.get(cfg.target).timeZone
    if (tz) return tz
  } catch (e) {
    // fall through to the script's zone
  }
  return Session.getScriptTimeZone()
}

// ---------------------------------------------------------------------------------------------------------------
// Times and windows

// [yesterday 00:00, end of the sync window). The past doesn't matter to booking pages.
function mirrorWindow_(endTime) {
  const start = new Date(mirrorNow_())
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - 1)
  let end = endTime
  if (!(end instanceof Date) || !isFinite(end.getTime())) {
    const days = typeof SYNC_DAYS_IN_FUTURE !== "undefined" && SYNC_DAYS_IN_FUTURE > 0 ? SYNC_DAYS_IN_FUTURE : 365
    end = new Date(mirrorNow_())
    end.setHours(0, 0, 0, 0)
    end.setDate(end.getDate() + days + 1)
  }
  return { start: start, end: end }
}

// { date } or { dateTime[, timeZone] } with nothing else, or null.
function mirrorTime_(t) {
  if (!t || typeof t !== "object") return null
  if (typeof t.date === "string" && MIRROR_DATE_RE.test(t.date) && isFinite(Date.parse(t.date + "T00:00:00Z"))) return { date: t.date }
  if (typeof t.dateTime === "string" && isFinite(Date.parse(t.dateTime))) {
    const out = { dateTime: t.dateTime }
    if (typeof t.timeZone === "string" && t.timeZone) out.timeZone = t.timeZone
    return out
  }
  return null
}

// Instants compare as instants (Google may return the same moment with another offset); dates as dates.
function mirrorSameTime_(a, b) {
  const x = mirrorTime_(a)
  const y = mirrorTime_(b)
  if (!x || !y || !!x.date !== !!y.date) return false
  return x.date ? x.date === y.date : Date.parse(x.dateTime) === Date.parse(y.dateTime)
}

// All-day dates count as UTC days, widened by a day each side, so no time zone can drop an all-day event at the edge.
function mirrorStartMs_(t) {
  return t.date ? Date.parse(t.date + "T00:00:00Z") : Date.parse(t.dateTime)
}

function mirrorOverlaps_(start, end, window) {
  const ws = window.start instanceof Date ? window.start.getTime() : window.start
  const we = window.end instanceof Date ? window.end.getTime() : window.end
  let s = mirrorStartMs_(start)
  let e = mirrorStartMs_(end)
  if (start.date) s -= MIRROR_DAY_MS
  if (end.date) e += MIRROR_DAY_MS
  return e > ws && s < we
}

// Midnight of "YYYY-MM-DD" in the given zone, as ms.
function mirrorStartOfDay_(day, tz) {
  const noon = new Date(day + "T12:00:00Z")
  const offset = Utilities.formatDate(noon, tz, "XXX")
  return Date.parse(day + "T00:00:00" + (offset === "Z" ? "Z" : offset))
}

function mirrorNow_() {
  return Date.now()
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers and logging

function mirrorGlobal_() {
  return typeof globalThis !== "undefined" ? globalThis : this
}

function mirrorPrivate_(ev) {
  return (ev && ev.extendedProperties && ev.extendedProperties.private) || {}
}

function mirrorSameId_(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
}

// " [personal]" from a Busy Time title made by the sync ("​personal Meeting"); "" for anything else.
function mirrorBusyTimePrefix_(ev) {
  const marker = typeof SEARCH_CHARACTER !== "undefined" ? SEARCH_CHARACTER : "​"
  const summary = typeof ev.summary === "string" ? ev.summary : ""
  if (summary.indexOf(marker) !== 0) return ""
  const prefix = summary.slice(marker.length).split(" ")[0]
  return prefix ? " [" + prefix + "]" : ""
}

function mirrorSourceText_(s) {
  return s.label + " " + (s.ok ? s.count : "FAILED (" + s.reason + ")")
}

// "MirrorBusy: Busy Time 42, fetchICloudBusyIntervals 5 → proxy: 2 created, 1 updated, 0 deleted, 44 unchanged"
function mirrorSummaryLine_(collected, plan, failed, dryRun) {
  const verb = dryRun ? ["to create", "to update", "to delete"] : ["created", "updated", "deleted"]
  let line = "MirrorBusy" + (dryRun ? " dry run" : "") + ": " + collected.sources.map(mirrorSourceText_).join(", ") +
    " → proxy: " + plan.toCreate.length + " " + verb[0] + ", " + plan.toUpdate.length + " " + verb[1] + ", " +
    plan.toDelete.length + " " + verb[2] + ", " + plan.unchanged + " unchanged"
  if (!plan.deletionsAllowed) line += "; deletions skipped because a source failed (" + plan.kept + " kept)"
  if (failed) line += "; " + failed + " request(s) failed, retried at the next sync"
  return line
}

function mirrorLogPlan_(plan, tz) {
  const lines = []
  for (const c of plan.toCreate) lines.push([mirrorStartMs_(c.start), "  + create " + mirrorFormatRange_(c.start, c.end, tz) + "  ← " + c.label])
  for (const u of plan.toUpdate) {
    lines.push([mirrorStartMs_(u.want.start), "  ~ update " + mirrorFormatRange_(u.want.start, u.want.end, tz) + "  ← " +
      u.want.label + " (" + mirrorProblems_(u.event, u.want).join(", ") + ")"])
  }
  for (const d of plan.toDelete) {
    const s = mirrorTime_(d.event.start)
    const e = mirrorTime_(d.event.end)
    lines.push([s ? mirrorStartMs_(s) : 0, "  - delete " + (s && e ? mirrorFormatRange_(s, e, tz) : "(no time)") + " (" + d.why + ")"])
  }
  lines.sort(function (a, b) { return a[0] - b[0] })
  for (const l of lines.slice(0, MIRROR_DRY_RUN_LINES)) console.log(l[1])
  if (lines.length > MIRROR_DRY_RUN_LINES) console.log("  … and " + (lines.length - MIRROR_DRY_RUN_LINES) + " more")
}

// "Fri 20 Nov 10:00–11:00" in the zone; all-day: "Fri 20 Nov (all day)" or "Fri 20 Nov – Sun 22 Nov (all day)".
function mirrorFormatRange_(start, end, tz) {
  const s = mirrorTime_(start)
  const e = mirrorTime_(end)
  if (!s || !e) return "(no time)"
  if (s.date) {
    const first = new Date(s.date + "T12:00:00Z")
    const last = new Date(Date.parse(e.date + "T12:00:00Z") - MIRROR_DAY_MS)
    const fmt = function (d) { return Utilities.formatDate(d, "UTC", "EEE d MMM") }
    return fmt(first) + (last > first ? " – " + fmt(last) : "") + " (all day)"
  }
  const a = new Date(s.dateTime)
  const b = new Date(e.dateTime)
  const sameDay = Utilities.formatDate(a, tz, "yyyyMMdd") === Utilities.formatDate(b, tz, "yyyyMMdd")
  return Utilities.formatDate(a, tz, "EEE d MMM HH:mm") + "–" + Utilities.formatDate(b, tz, sameDay ? "HH:mm" : "EEE d MMM HH:mm")
}
