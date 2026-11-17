// A tiny in-memory CalDAV server that answers like iCloud does, used as the `fetch` passed to tsdav.
// Hosts end in .invalid, so nothing here can reach the network.

export const SERVER_URL = "https://caldav.example.invalid"
const POD = "https://p01-caldav.example.invalid"
const PRINCIPAL = "/1000001/principal/"
const HOME = "/1000001/calendars/"

export const USER = "owner@example.invalid"
export const PASSWORD = "fake-pw"

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * @param {object} state
 * @param {{ name: string, path: string, ctag?: string|null, objects?: string[], status?: number, components?: string[] }[]} state.calendars
 * @param {boolean} [state.rejectAuth]   answer 401 to everything
 * @param {boolean} [state.down]         answer 503 to everything
 * @param {string}  [state.podUrl]       per-account host to redirect to (default: a .invalid host)
 */
export function createMockICloud(state) {
  const requests = []
  const pod = state.podUrl || POD

  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url)
    const method = (init.method || "GET").toUpperCase()
    const headers = new Headers(init.headers || {})
    const body = typeof init.body === "string" ? init.body : ""
    requests.push({ method, url: url.href, depth: headers.get("depth"), body })

    if (state.down) return text(503, "Service Unavailable")
    const expected = "Basic " + btoa(USER + ":" + PASSWORD)
    if (state.rejectAuth || headers.get("authorization") !== expected) return text(401, "Unauthorized")

    if (url.pathname === "/.well-known/caldav") {
      return new Response(null, { status: 301, headers: { Location: pod + "/" } })
    }
    if (method === "PROPFIND" && url.pathname === "/" && body.includes("current-user-principal")) {
      return multistatus([response("/", `<d:current-user-principal><d:href>${PRINCIPAL}</d:href></d:current-user-principal>`)])
    }
    if (method === "PROPFIND" && url.pathname === PRINCIPAL) {
      return multistatus([response(PRINCIPAL, `<cal:calendar-home-set><d:href>${pod}${HOME}</d:href></cal:calendar-home-set>`)])
    }
    if (method === "PROPFIND" && url.pathname === HOME) {
      const items = [response(HOME, `<d:resourcetype><d:collection/></d:resourcetype>`)]
      items.push(response(HOME + "inbox/", `<d:resourcetype><d:collection/><cal:schedule-inbox/></d:resourcetype>`))
      for (const c of state.calendars) {
        const comps = (c.components || ["VEVENT"]).map((n) => `<cal:comp name="${n}"/>`).join("")
        const ctag = c.ctag === null ? "" : `<cs:getctag>${xmlEscape(c.ctag || "ctag-" + c.path)}</cs:getctag>`
        items.push(response(HOME + c.path + "/",
          `<d:displayname>${xmlEscape(c.name)}</d:displayname>${ctag}` +
          `<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>` +
          `<cal:supported-calendar-component-set>${comps}</cal:supported-calendar-component-set>`))
      }
      return multistatus(items)
    }
    if (method === "REPORT") {
      const cal = state.calendars.find((c) => url.pathname === HOME + c.path + "/")
      if (!cal) return text(404, "Not Found")
      if (cal.status) return text(cal.status, "Error")
      const items = (cal.objects || []).map((ics, i) => response(`${HOME}${cal.path}/obj-${i}.ics`,
        `<d:getetag>"etag-${i}"</d:getetag><cal:calendar-data>${xmlEscape(ics)}</cal:calendar-data>`))
      return multistatus(items)
    }
    return text(404, "Not Found")
  }

  return { fetchImpl, requests }
}

function text(status, body) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } })
}

function response(href, props) {
  return `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop>` +
    `<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

function multistatus(items) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">` +
    items.join("") + `</d:multistatus>`
  return new Response(xml, { status: 207, headers: { "Content-Type": "text/xml; charset=utf-8" } })
}
