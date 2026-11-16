// ICS calendar objects → busy intervals.
//
// Input: the calendar-data strings of one CalDAV calendar. Output: intervals with a stable id and no event text.
// Rules (docs/icloud-spec.md §5): recurrences are expanded here (never trust server-side expand), overrides are
// checked by their own times, TRANSPARENT / CANCELLED / declined / zero-length occurrences are skipped, TZIDs come
// from the object's VTIMEZONE or, failing that, from Intl as an IANA name, floating times use the `tz` option.
//
// Any problem with any object throws ExpandError: the caller marks the whole calendar parse_failed, because a
// partial list must never look complete.

import ICAL from "ical.js"

export const DEFAULT_MAX_ITERATIONS = 20000
const DAY_MS = 86400000

export class ExpandError extends Error {
  constructor(message) {
    super(message)
    this.name = "ExpandError"
  }
}

/**
 * @param {string[]} icsTexts           calendar-data of every object returned for one calendar
 * @param {object}   options
 * @param {number}   options.windowStart  window start, ms since epoch (inclusive)
 * @param {number}   options.windowEnd    window end, ms since epoch (exclusive)
 * @param {string}   [options.tz]         IANA zone for floating times and for the all-day window (default UTC)
 * @param {string[]} [options.selfAddresses]  calendar user addresses whose PARTSTAT=DECLINED means "not busy"
 * @param {number}   [options.maxIterations]  per-series cap
 * @param {boolean}  [options.fastForward]    default true; skip ahead in simple long-running series
 * @returns {{ id: string, start: string, end: string, allDay: boolean }[]} sorted by start, then id
 */
export function expandCalendarObjects(icsTexts, options) {
  const ctx = makeContext(options)
  const byId = new Map()
  for (const text of icsTexts) {
    for (const interval of expandObject(text, ctx)) {
      if (!byId.has(interval.id)) byId.set(interval.id, interval)
    }
  }
  return [...byId.values()].sort(compareIntervals)
}

function makeContext(options) {
  const tz = options.tz || "UTC"
  if (!isValidTimeZone(tz)) throw new ExpandError("invalid tz")
  if (!(options.windowEnd > options.windowStart)) throw new ExpandError("invalid window")
  return {
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    tz,
    // All-day intervals are compared with the window as local dates in `tz`.
    windowStartDate: localDateString(options.windowStart, tz),
    windowEndDate: localDateStringCeil(options.windowEnd, tz),
    selfAddresses: new Set((options.selfAddresses || []).map(normalizeAddress).filter(Boolean)),
    maxIterations: options.maxIterations || DEFAULT_MAX_ITERATIONS,
    fastForward: options.fastForward !== false, // tests turn it off to prove it changes nothing
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One calendar object (one .ics resource: a master and its overrides, sometimes several UIDs)

function expandObject(text, ctx) {
  let vcalendar
  try {
    vcalendar = new ICAL.Component(ICAL.parse(text))
  } catch (e) {
    throw new ExpandError("ics parse error")
  }
  if (vcalendar.name !== "vcalendar") throw new ExpandError("not a VCALENDAR")
  shareTimezones(vcalendar)

  const groups = new Map() // uid → { master, overrides[] }
  for (const vevent of vcalendar.getAllSubcomponents("vevent")) {
    const uid = vevent.getFirstPropertyValue("uid")
    if (!uid) throw new ExpandError("VEVENT without UID")
    if (!vevent.hasProperty("dtstart")) throw new ExpandError("VEVENT without DTSTART")
    let group = groups.get(uid)
    if (!group) groups.set(uid, (group = { master: null, overrides: [] }))
    if (vevent.hasProperty("recurrence-id")) group.overrides.push(vevent)
    else if (group.master) throw new ExpandError("two masters for one UID")
    else group.master = vevent
  }

  const out = []
  for (const [uid, group] of groups) {
    if (group.master) {
      const event = new ICAL.Event(group.master, { exceptions: group.overrides })
      if (event.isRecurring()) expandSeries(uid, event, ctx, out)
      else pushOccurrence(out, ctx, uid, "-", group.master, event.startDate, event.endDate)
    }
    // Overrides are always judged by their own start/end, so an occurrence moved into the window from outside is
    // caught and one moved out is dropped. An override without a master (an invitation to one instance) is just
    // a standalone event with the same id rule.
    for (const override of group.overrides) {
      const exception = new ICAL.Event(override, { exceptions: [] })
      const occId = occurrenceId(exception.recurrenceId, propTzid(override, "recurrence-id"), ctx)
      pushOccurrence(out, ctx, uid, occId, override, exception.startDate, exception.endDate)
    }
  }
  return out
}

// Every iCloud object carries its own copy of the same VTIMEZONE, and ical.js expands a zone's DST changes from
// the zone's DTSTART (often 1970) the first time it is used. Hydrating one Timezone per distinct VTIMEZONE text and
// handing it to every object cuts the CPU cost of a few hundred single events by an order of magnitude.
// Relies on ical.js resolving TZIDs through the root component's _timezoneCache (ical.js 2.2.1, pinned).
const zoneCache = new Map()
const ZONE_CACHE_LIMIT = 64

function shareTimezones(vcalendar) {
  const cache = vcalendar._timezoneCache
  if (!(cache instanceof Map)) return
  for (const vtimezone of vcalendar.getAllSubcomponents("vtimezone")) {
    const tzid = vtimezone.getFirstPropertyValue("tzid")
    if (!tzid) continue
    const key = vtimezone.toString()
    let zone = zoneCache.get(key)
    if (!zone) {
      zone = new ICAL.Timezone({ component: vtimezone, tzid: String(tzid) })
      if (zoneCache.size >= ZONE_CACHE_LIMIT) zoneCache.clear()
      zoneCache.set(key, zone)
    }
    cache.set(String(tzid), zone)
  }
}

function expandSeries(uid, event, ctx, out) {
  const masterComp = event.component
  const startTzid = propTzid(masterComp, "dtstart")
  const allDay = event.startDate.isDate

  // A RANGE=THISANDFUTURE override can shift later occurrences away from their recurrence id and change their
  // length; widen both ends of the scan by the largest such shift and length.
  let maxShiftMs = 0
  let maxLengthMs = spanMs(event, startTzid, ctx)
  for (const id of Object.keys(event.exceptions)) {
    const ex = event.exceptions[id]
    if (!ex.modifiesFuture()) continue
    const exStartTzid = propTzid(ex.component, "dtstart")
    const shift = Math.abs(toMs(ex.startDate, exStartTzid, ctx) -
      toMs(ex.recurrenceId, propTzid(ex.component, "recurrence-id"), ctx))
    if (shift > maxShiftMs) maxShiftMs = shift
    maxLengthMs = Math.max(maxLengthMs, spanMs(ex, exStartTzid, ctx))
  }
  const slackMs = maxShiftMs + DAY_MS // + 1 day: all-day dates are local, the window is UTC
  const stopMs = ctx.windowEnd + slackMs
  // Occurrences whose recurrence id is this early end before the window: no need for the costly details lookup.
  const skipBeforeMs = ctx.windowStart - maxLengthMs - slackMs

  const emit = (time) => {
    // A direct override replaces this occurrence; the override loop handles it.
    if (isDirectException(event, time)) return
    const details = event.getOccurrenceDetails(time)
    const itemComp = details.item ? details.item.component : masterComp
    const occId = allDay ? dateBasic(time) : utcBasic(toMs(time, startTzid, ctx))
    pushOccurrence(out, ctx, uid, occId, itemComp, details.startDate, details.endDate, startTzid)
  }

  // RFC 5545: DTSTART is always the first instance. ical.js skips it when the series has RDATE but no RRULE.
  if (!masterComp.hasProperty("rrule") && !isExcluded(masterComp, event.startDate, startTzid, ctx)) {
    emit(event.startDate)
  }

  // ical.js cannot start mid-series in general (COUNT and some BY rules need every occurrence counted), so iterate
  // from the series start, except for the simple rules where a later, aligned start gives the same occurrences.
  const iterator = event.iterator((ctx.fastForward && fastForwardStart(event, skipBeforeMs)) || undefined)
  let iterations = 0
  for (let next = iterator.next(); next; next = iterator.next()) {
    if (++iterations > ctx.maxIterations) throw new ExpandError("iteration cap reached")
    // Cheap pre-check on the wall-clock fields (no zone offset is ever more than a day), exact check after.
    const wallMs = Date.UTC(next.year, next.month - 1, next.day, next.hour, next.minute, next.second)
    if (wallMs + DAY_MS < skipBeforeMs) continue
    if (wallMs - DAY_MS >= stopMs) break
    const recurrenceMs = toMs(next, startTzid, ctx)
    if (recurrenceMs >= stopMs) break
    if (recurrenceMs < skipBeforeMs) continue
    emit(next) // a DTSTART emitted above comes again here at most once; the id de-duplication drops it
  }
}

// Fast-forward for long-running series (ical.js spends ~15 µs per RRULE step, so a daily series started six years
// ago costs ~40 ms of CPU just to reach today; the Workers Free plan allows 10 ms per request).
//
// Safe only when the occurrence set repeats every period with no counting: exactly one RRULE, FREQ=DAILY or WEEKLY,
// no COUNT, and no BY rule other than BYDAY (plus WKST). Then moving DTSTART forward by a whole number of periods,
// same local time, same weekday, gives exactly the original occurrences from that point on. The moved start itself
// may not be a real occurrence (DTSTART always counts in RFC 5545), so it is placed at least two days before
// `skipBeforeMs`, where the scan drops it unseen. EXDATE/RDATE/overrides still come from the component.
function fastForwardStart(event, skipBeforeMs) {
  const rrules = event.component.getAllProperties("rrule")
  if (rrules.length !== 1) return null
  const recur = rrules[0].getFirstValue()
  if (!recur || recur.count) return null
  const periodDays = recur.freq === "DAILY" ? 1 : recur.freq === "WEEKLY" ? 7 : 0
  if (!periodDays) return null
  if (Object.keys(recur.parts || {}).some((part) => part !== "BYDAY")) return null
  const step = periodDays * (recur.interval || 1)

  const start = event.startDate
  const startWallDay = Math.floor(Date.UTC(start.year, start.month - 1, start.day) / DAY_MS)
  const targetDay = Math.floor(skipBeforeMs / DAY_MS) - 2
  const periods = Math.floor((targetDay - startWallDay) / step)
  if (periods < 1) return null
  const moved = start.clone()
  moved.adjust(periods * step, 0, 0, 0)
  return moved
}

// Length of an event in ms (for all-day: whole days), never negative.
function spanMs(event, startTzid, ctx) {
  const start = event.startDate
  const end = event.endDate
  if (start.isDate) return Math.max(0, Date.parse(dateIso(end)) - Date.parse(dateIso(start)))
  if (end.isDate) return 0
  const endTzid = propTzid(event.component, "dtend") || startTzid
  return Math.max(0, toMs(end, endTzid, ctx) - toMs(start, startTzid, ctx))
}

function isExcluded(comp, time, tzid, ctx) {
  const key = time.isDate ? dateIso(time) : toMs(time, tzid, ctx)
  for (const prop of comp.getAllProperties("exdate")) {
    const exTzid = prop.getParameter("tzid") || tzid
    for (const value of prop.getValues()) {
      if ((value.isDate ? dateIso(value) : toMs(value, exTzid, ctx)) === key) return true
    }
  }
  return false
}

function isDirectException(event, time) {
  if (time.toString() in event.exceptions) return true
  return time.convertToZone(ICAL.Timezone.utcTimezone).toString() in event.exceptions
}

// Applies the skip rules and the window test, then appends one interval.
// tzidHint: TZID to use for a time whose zone ical.js could not resolve (generated occurrences lose the property).
function pushOccurrence(out, ctx, uid, occId, comp, start, end, tzidHint) {
  if (isSkipped(comp, ctx)) return

  const startTzid = propTzid(comp, "dtstart") || tzidHint
  const endTzid = propTzid(comp, "dtend") || startTzid

  if (start.isDate) {
    const startDate = dateIso(start)
    // A DATE start with a DATE-TIME end is invalid; use the end's calendar date.
    const endDate = dateIso(end)
    if (endDate <= startDate) return // zero or negative duration
    if (!(startDate < ctx.windowEndDate && endDate > ctx.windowStartDate)) return
    out.push({ id: uid + "|" + occId, start: startDate, end: endDate, allDay: true })
    return
  }

  const startMs = toMs(start, startTzid, ctx)
  const endMs = end.isDate ? startMs : toMs(end, endTzid, ctx)
  if (!(endMs > startMs)) return // zero-length (DATE-TIME start with no DTEND/DURATION) or negative
  if (!(startMs < ctx.windowEnd && endMs > ctx.windowStart)) return
  out.push({ id: uid + "|" + occId, start: isoUtc(startMs), end: isoUtc(endMs), allDay: false })
}

function isSkipped(comp, ctx) {
  const transp = comp.getFirstPropertyValue("transp")
  if (transp && String(transp).toUpperCase() === "TRANSPARENT") return true
  const status = comp.getFirstPropertyValue("status")
  if (status && String(status).toUpperCase() === "CANCELLED") return true
  if (ctx.selfAddresses.size) {
    for (const attendee of comp.getAllProperties("attendee")) {
      const partstat = attendee.getParameter("partstat")
      if (!partstat || String(partstat).toUpperCase() !== "DECLINED") continue
      if (ctx.selfAddresses.has(normalizeAddress(attendee.getFirstValue()))) return true
    }
  }
  return false
}

function occurrenceId(recurrenceId, tzid, ctx) {
  if (recurrenceId.isDate) return dateBasic(recurrenceId)
  return utcBasic(toMs(recurrenceId, tzid, ctx))
}

// ---------------------------------------------------------------------------------------------------------------
// Time conversion

function propTzid(comp, name) {
  const prop = comp.getFirstProperty(name)
  const tzid = prop && prop.getParameter("tzid")
  return tzid ? String(tzid) : null
}

// ICAL.Time (DATE-TIME) → ms since epoch.
// - "Z" values and values whose TZID resolved to a VTIMEZONE in the same object: ical.js knows the offset.
// - Unresolved TZID (no VTIMEZONE in the object): ical.js leaves the time floating; read it as an IANA name.
// - Floating (no TZID): read it in ctx.tz.
function toMs(time, tzid, ctx) {
  const zone = time.zone
  if (zone && (zone.tzid === "UTC" || zone.component)) return time.toUnixTime() * 1000
  const zoneName = tzid || ctx.tz
  if (!isValidTimeZone(zoneName)) throw new ExpandError("unknown TZID")
  return wallClockToUtc(time.year, time.month, time.day, time.hour, time.minute, time.second, zoneName)
}

const formatterCache = new Map()

function formatterFor(timeZone) {
  let f = formatterCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
    formatterCache.set(timeZone, f)
  }
  return f
}

function isValidTimeZone(timeZone) {
  try {
    formatterFor(timeZone)
    return true
  } catch (e) {
    return false
  }
}

// Wall-clock fields of an instant in a zone.
function zonedFields(ms, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms))
  const f = {}
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value)
  return f
}

function offsetMs(ms, timeZone) {
  const f = zonedFields(ms, timeZone)
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000
}

// Local wall-clock time in an IANA zone → UTC ms, following RFC 5545 §3.3.5: a time that occurs twice (DST ends)
// means the first occurrence; a time skipped by a DST jump is read with the offset from before the jump
// (02:30 in a 02:00→03:00 gap becomes 03:30 local).
export function wallClockToUtc(year, month, day, hour, minute, second, timeZone) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const before = offsetMs(asUtc - DAY_MS, timeZone)
  const after = offsetMs(asUtc + DAY_MS, timeZone)
  const candidates = [asUtc - before, asUtc - after].filter((c) => offsetMs(c, timeZone) === asUtc - c)
  if (candidates.length) return Math.min(...candidates)
  return asUtc - before
}

function localDateString(ms, timeZone) {
  const f = zonedFields(ms, timeZone)
  return ymd(f.year, f.month, f.day)
}

// First local date that starts at or after the instant (exclusive end date for a window end).
function localDateStringCeil(ms, timeZone) {
  const f = zonedFields(ms, timeZone)
  const date = ymd(f.year, f.month, f.day)
  if (f.hour === 0 && f.minute === 0 && f.second === 0) return date
  const next = new Date(Date.UTC(f.year, f.month - 1, f.day + 1))
  return ymd(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())
}

function ymd(y, m, d) {
  return String(y).padStart(4, "0") + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0")
}

function dateIso(time) {
  return ymd(time.year, time.month, time.day)
}

function dateBasic(time) {
  return dateIso(time).replace(/-/g, "")
}

function isoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z")
}

function utcBasic(ms) {
  return isoUtc(ms).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}

function normalizeAddress(value) {
  if (!value) return ""
  return String(value).trim().toLowerCase().replace(/^mailto:/, "")
}

function compareIntervals(a, b) {
  // All-day dates sort before timed instants on the same day; good enough for a stable, readable order.
  if (a.start < b.start) return -1
  if (a.start > b.start) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
