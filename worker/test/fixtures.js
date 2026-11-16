// Synthetic iCalendar fixtures. No real data: UIDs, addresses and names are made up.

export const BERLIN_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
]

// Custom TZID name that only exists inside the object (as some clients write it).
export const CUSTOM_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Custom/Plus3",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0300",
  "TZOFFSETTO:+0300",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
]

/**
 * @param {string[][]} events  each event as an array of property lines (without BEGIN/END:VEVENT)
 * @param {string[]} [extra]   extra VCALENDAR lines (VTIMEZONEs)
 */
export function ics(events, extra = []) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//fixture//EN", ...extra]
  for (const props of events) lines.push("BEGIN:VEVENT", ...props, "END:VEVENT")
  lines.push("END:VCALENDAR")
  return lines.join("\r\n") + "\r\n"
}

export const ms = (iso) => Date.parse(iso)

/** A year of synthetic events for the CPU benchmark: ~300 single events plus long-running series. */
export function benchmarkObjects(year = 2026) {
  const objects = []
  for (let i = 0; i < 300; i++) {
    const day = new Date(Date.UTC(year, 0, 1 + Math.floor(i * 365 / 300)))
    const ymd = day.toISOString().slice(0, 10).replace(/-/g, "")
    const hour = String(8 + (i % 9)).padStart(2, "0")
    objects.push(ics([[
      "UID:bench-single-" + i + "@example.invalid",
      "DTSTAMP:20260101T000000Z",
      "DTSTART;TZID=Europe/Berlin:" + ymd + "T" + hour + "0000",
      "DTEND;TZID=Europe/Berlin:" + ymd + "T" + hour + "4500",
      "SUMMARY:Synthetic " + i,
      "DESCRIPTION:" + "x".repeat(200),
      "LOCATION:Somewhere",
    ]], BERLIN_VTIMEZONE))
  }
  // Daily series started six years ago, still running.
  objects.push(ics([[
    "UID:bench-daily@example.invalid",
    "DTSTAMP:20200101T000000Z",
    "DTSTART;TZID=Europe/Berlin:" + (year - 6) + "0101T073000",
    "DTEND;TZID=Europe/Berlin:" + (year - 6) + "0101T080000",
    "RRULE:FREQ=DAILY",
    "SUMMARY:Daily",
  ]], BERLIN_VTIMEZONE))
  // Weekly series with overrides and exdates.
  const overrides = []
  for (let w = 1; w <= 20; w++) {
    const d = new Date(Date.UTC(year, 0, 5 + w * 7))
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, "")
    overrides.push([
      "UID:bench-weekly@example.invalid",
      "DTSTAMP:20200101T000000Z",
      "RECURRENCE-ID;TZID=Europe/Berlin:" + ymd + "T100000",
      "DTSTART;TZID=Europe/Berlin:" + ymd + "T113000",
      "DTEND;TZID=Europe/Berlin:" + ymd + "T123000",
      "SUMMARY:Moved",
    ])
  }
  objects.push(ics([[
    "UID:bench-weekly@example.invalid",
    "DTSTAMP:20200101T000000Z",
    "DTSTART;TZID=Europe/Berlin:" + (year - 3) + "0105T100000",
    "DTEND;TZID=Europe/Berlin:" + (year - 3) + "0105T110000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
    "EXDATE;TZID=Europe/Berlin:" + year + "0302T100000," + year + "0304T100000",
    "SUMMARY:Weekly",
  ], ...overrides], BERLIN_VTIMEZONE))
  return objects
}
