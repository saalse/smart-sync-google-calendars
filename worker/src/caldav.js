// iCloud CalDAV access through tsdav: discovery, ctag version, calendar-query.
//
// Calendars are listed with one PROPFIND Depth:1 on the calendar home (tsdav's fetchCalendars would add one
// supported-report-set PROPFIND per calendar, which costs subrequests and gives nothing we need).
// Events are read with one REPORT calendar-query per selected calendar, no <C:expand> (docs/icloud-spec.md §4).

import { createAccount, propfind, calendarQuery } from "tsdav"

export const DEFAULT_SERVER_URL = "https://caldav.icloud.com"

export class UpstreamError extends Error {
  /** @param {"upstream_auth" | "upstream_unavailable"} code */
  constructor(code, message) {
    super(message || code)
    this.name = "UpstreamError"
    this.code = code
  }
}

export function basicAuthHeader(username, password) {
  const bytes = new TextEncoder().encode(username + ":" + password)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return "Basic " + btoa(binary)
}

/**
 * Logs in and lists the calendars of the account.
 * @returns {Promise<{ headers: object, calendars: { url: string, displayName: string, ctag: string|null }[] }>}
 * @throws {UpstreamError}
 */
export async function discoverCalendars({ serverUrl, username, password, fetchImpl }) {
  const headers = { authorization: basicAuthHeader(username, password) }
  const fetchOpt = fetchImpl ? { fetch: fetchImpl } : {}

  let account
  try {
    account = await createAccount({
      account: { serverUrl: serverUrl || DEFAULT_SERVER_URL, accountType: "caldav" },
      headers,
      ...fetchOpt,
    })
  } catch (e) {
    const message = String((e && e.message) || "")
    if (message.startsWith("Invalid credentials")) throw new UpstreamError("upstream_auth")
    throw new UpstreamError("upstream_unavailable")
  }

  let responses
  try {
    responses = await propfind({
      url: account.homeUrl,
      props: {
        "d:displayname": {},
        "cs:getctag": {},
        "d:resourcetype": {},
        "c:supported-calendar-component-set": {},
      },
      depth: "1",
      headers,
      ...fetchOpt,
    })
  } catch (e) {
    throw new UpstreamError("upstream_unavailable")
  }

  if (responses.length === 1 && !responses[0].ok && !responses[0].props) {
    // Whole request failed (not a multistatus).
    if (responses[0].status === 401 || responses[0].status === 403) throw new UpstreamError("upstream_auth")
    throw new UpstreamError("upstream_unavailable")
  }

  const calendars = []
  for (const r of responses) {
    if (!r.ok || !r.props) continue
    const resourceTypes = Object.keys(r.props.resourcetype || {})
    if (!resourceTypes.includes("calendar")) continue
    const components = componentNames(r.props.supportedCalendarComponentSet)
    if (components.length && !components.includes("VEVENT")) continue // e.g. Reminders lists
    calendars.push({
      url: new URL(r.href || "", account.homeUrl).href,
      displayName: davText(r.props.displayname).trim(),
      ctag: davText(r.props.getctag) || null,
    })
  }
  return { headers, calendars }
}

/**
 * Matches requested display names against the discovered calendars.
 * Several calendars with the same display name are all included (union), so nothing is silently dropped.
 * @returns {{ name: string, matches: object[], error?: "not_found" | "no_ctag" }[]} in request order
 */
export function selectCalendars(calendars, names) {
  return names.map((name) => {
    const matches = calendars.filter((c) => c.displayName === name)
    if (!matches.length) return { name, matches, error: "not_found" }
    if (matches.some((c) => !c.ctag)) return { name, matches, error: "no_ctag" }
    return { name, matches }
  })
}

/**
 * version = SHA-256 hex of "name\0ctag\n" lines sorted by name; null if any calendar is missing or has no ctag.
 * Independent of parameter order.
 */
export async function computeVersion(selected) {
  if (selected.some((s) => s.error)) return null
  const lines = selected
    .map((s) => s.name + "\u0000" + s.matches.map((c) => c.ctag).sort().join(",") + "\n")
    .sort()
  return sha256Hex(lines.join(""))
}

/**
 * calendar-query for one calendar, VEVENTs overlapping [start, end).
 * @returns {Promise<string[]>} calendar-data of every returned object
 * @throws {Error} on any failed response; the caller marks that calendar query_failed
 */
export async function queryCalendar({ url, headers, start, end, fetchImpl }) {
  const responses = await calendarQuery({
    url,
    props: { "d:getetag": {}, "c:calendar-data": {} },
    filters: {
      "comp-filter": {
        _attributes: { name: "VCALENDAR" },
        "comp-filter": {
          _attributes: { name: "VEVENT" },
          "time-range": { _attributes: { start: utcBasic(start), end: utcBasic(end) } },
        },
      },
    },
    depth: "1",
    headers,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  const texts = []
  for (const r of responses) {
    if (!r.ok) throw new Error("object status " + r.status)
    const data = davText(r.props && r.props.calendarData)
    if (!data) throw new Error("object without calendar-data")
    texts.push(data)
  }
  return texts
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// tsdav (xml-js compact form) gives text either as a string, { _text }, { _cdata } or an array of those.
function davText(value) {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map(davText).join("")
  if (typeof value === "object") {
    if ("_cdata" in value) return davText(value._cdata)
    if ("_text" in value) return davText(value._text)
  }
  return ""
}

function componentNames(set) {
  if (!set || !set.comp) return []
  const comps = Array.isArray(set.comp) ? set.comp : [set.comp]
  return comps.map((c) => String((c && c._attributes && c._attributes.name) || "").toUpperCase()).filter(Boolean)
}

function utcBasic(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z"
}
