import { test } from "node:test"
import assert from "node:assert/strict"
import { expandCalendarObjects, wallClockToUtc, ExpandError } from "../src/expand.js"
import { ics, ms, BERLIN_VTIMEZONE, CUSTOM_VTIMEZONE } from "./fixtures.js"

const WINDOW = { windowStart: ms("2026-10-01T00:00:00Z"), windowEnd: ms("2026-12-01T00:00:00Z"), tz: "UTC" }
const run = (objects, opts = {}) => expandCalendarObjects(objects, { ...WINDOW, ...opts })
const base = (uid) => [`UID:${uid}`, "DTSTAMP:20260101T000000Z"]

test("single timed event with TZID and VTIMEZONE", () => {
  const out = run([ics([[...base("a"), "DTSTART;TZID=Europe/Berlin:20261110T090000", "DTEND;TZID=Europe/Berlin:20261110T100000", "SUMMARY:Secret"]], BERLIN_VTIMEZONE)])
  assert.deepEqual(out, [{ id: "a|-", start: "2026-11-10T08:00:00Z", end: "2026-11-10T09:00:00Z", allDay: false }])
})

test("weekly series keeps local time across the DST change", () => {
  const out = run([ics([[...base("w"), "DTSTART;TZID=Europe/Berlin:20261015T090000", "DTEND;TZID=Europe/Berlin:20261015T093000", "RRULE:FREQ=WEEKLY;COUNT=3"]], BERLIN_VTIMEZONE)])
  assert.deepEqual(out.map((i) => [i.id, i.start]), [
    ["w|20261015T070000Z", "2026-10-15T07:00:00Z"], // CEST
    ["w|20261022T070000Z", "2026-10-22T07:00:00Z"], // CEST
    ["w|20261029T080000Z", "2026-10-29T08:00:00Z"], // CET after 25 Oct
  ])
})

test("all-day single and multi-day, end exclusive", () => {
  const out = run([
    ics([[...base("d1"), "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106"]]),
    ics([[...base("d3"), "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261123"]]),
  ])
  assert.deepEqual(out, [
    { id: "d1|-", start: "2026-11-05", end: "2026-11-06", allDay: true },
    { id: "d3|-", start: "2026-11-20", end: "2026-11-23", allDay: true },
  ])
})

test("DATE start without DTEND lasts one day", () => {
  const out = run([ics([[...base("d"), "DTSTART;VALUE=DATE:20261105"]])])
  assert.deepEqual(out, [{ id: "d|-", start: "2026-11-05", end: "2026-11-06", allDay: true }])
})

test("DURATION instead of DTEND", () => {
  const out = run([ics([[...base("dur"), "DTSTART:20261105T100000Z", "DURATION:PT90M"]])])
  assert.equal(out[0].end, "2026-11-05T11:30:00Z")
})

test("weekly RRULE with EXDATE", () => {
  const out = run([ics([[...base("x"), "DTSTART:20261102T100000Z", "DTEND:20261102T110000Z", "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE:20261109T100000Z"]])])
  assert.deepEqual(out.map((i) => i.start), ["2026-11-02T10:00:00Z", "2026-11-16T10:00:00Z", "2026-11-23T10:00:00Z"])
})

test("RDATE adds occurrences", () => {
  const out = run([ics([[...base("r"), "DTSTART:20261102T100000Z", "DTEND:20261102T110000Z", "RDATE:20261105T150000Z,20261107T150000Z"]])])
  assert.deepEqual(out.map((i) => i.id), ["r|20261102T100000Z", "r|20261105T150000Z", "r|20261107T150000Z"])
})

test("COUNT and UNTIL stop the series", () => {
  const out = run([
    ics([[...base("c"), "DTSTART:20261102T100000Z", "DTEND:20261102T110000Z", "RRULE:FREQ=DAILY;COUNT=2"]]),
    ics([[...base("u"), "DTSTART:20261102T120000Z", "DTEND:20261102T130000Z", "RRULE:FREQ=DAILY;UNTIL=20261104T120000Z"]]),
  ])
  assert.equal(out.filter((i) => i.id.startsWith("c|")).length, 2)
  assert.equal(out.filter((i) => i.id.startsWith("u|")).length, 3)
})

test("series started years ago is counted from its start (COUNT)", () => {
  const out = run([ics([[...base("old"), "DTSTART:20200106T100000Z", "DTEND:20200106T110000Z", "RRULE:FREQ=WEEKLY;COUNT=360"]])])
  // 360 weekly occurrences from 2020-01-06 end on 2026-11-23.
  assert.equal(out.at(-1).start, "2026-11-23T10:00:00Z")
  assert.equal(out.length, 8)
})

test("override moved into the window from outside, and one moved out", () => {
  const master = [...base("m"), "DTSTART:20260901T100000Z", "DTEND:20260901T110000Z", "RRULE:FREQ=MONTHLY;COUNT=4"]
  const movedIn = [...base("m"), "RECURRENCE-ID:20260901T100000Z", "DTSTART:20261002T100000Z", "DTEND:20261002T110000Z"]
  const movedOut = [...base("m"), "RECURRENCE-ID:20261101T100000Z", "DTSTART:20261215T100000Z", "DTEND:20261215T110000Z"]
  const out = run([ics([master, movedIn, movedOut])])
  assert.deepEqual(out.map((i) => [i.id, i.start]), [
    ["m|20260901T100000Z", "2026-10-02T10:00:00Z"],
    ["m|20261001T100000Z", "2026-10-01T10:00:00Z"],
  ].sort((a, b) => (a[1] < b[1] ? -1 : 1)))
})

test("moved occurrence keeps its id (move = update)", () => {
  const master = [...base("k"), "DTSTART:20261102T100000Z", "DTEND:20261102T110000Z", "RRULE:FREQ=DAILY;COUNT=3"]
  const before = run([ics([master])])
  const after = run([ics([master, [...base("k"), "RECURRENCE-ID:20261103T100000Z", "DTSTART:20261103T150000Z", "DTEND:20261103T160000Z"]])])
  assert.deepEqual(before.map((i) => i.id).sort(), after.map((i) => i.id).sort())
  assert.equal(after.find((i) => i.id === "k|20261103T100000Z").start, "2026-11-03T15:00:00Z")
})

test("cancelled and transparent overrides are skipped", () => {
  const master = [...base("s"), "DTSTART:20261102T100000Z", "DTEND:20261102T110000Z", "RRULE:FREQ=DAILY;COUNT=3"]
  const out = run([ics([
    master,
    [...base("s"), "RECURRENCE-ID:20261103T100000Z", "DTSTART:20261103T100000Z", "DTEND:20261103T110000Z", "STATUS:CANCELLED"],
    [...base("s"), "RECURRENCE-ID:20261104T100000Z", "DTSTART:20261104T100000Z", "DTEND:20261104T110000Z", "TRANSP:TRANSPARENT"],
  ])])
  assert.deepEqual(out.map((i) => i.id), ["s|20261102T100000Z"])
})

test("transparent and cancelled masters are skipped", () => {
  const out = run([
    ics([[...base("t"), "DTSTART:20261102T100000Z", "DTEND:20261102T110000Z", "TRANSP:TRANSPARENT"]]),
    ics([[...base("c"), "DTSTART:20261102T100000Z", "DTEND:20261102T110000Z", "STATUS:CANCELLED"]]),
  ])
  assert.deepEqual(out, [])
})

test("RANGE=THISANDFUTURE shifts later occurrences", () => {
  const master = [...base("f"), "DTSTART:20261102T100000Z", "DTEND:20261102T110000Z", "RRULE:FREQ=DAILY;COUNT=4"]
  const range = [...base("f"), "RECURRENCE-ID;RANGE=THISANDFUTURE:20261103T100000Z", "DTSTART:20261103T140000Z", "DTEND:20261103T150000Z"]
  const out = run([ics([master, range])])
  assert.deepEqual(out.map((i) => [i.id, i.start]), [
    ["f|20261102T100000Z", "2026-11-02T10:00:00Z"],
    ["f|20261103T100000Z", "2026-11-03T14:00:00Z"],
    ["f|20261104T100000Z", "2026-11-04T14:00:00Z"],
    ["f|20261105T100000Z", "2026-11-05T14:00:00Z"],
  ])
})

test("orphan override (invitation to one instance) is a standalone event", () => {
  const out = run([ics([[...base("o"), "RECURRENCE-ID:20261110T090000Z", "DTSTART:20261110T093000Z", "DTEND:20261110T100000Z"]])])
  assert.deepEqual(out, [{ id: "o|20261110T090000Z", start: "2026-11-10T09:30:00Z", end: "2026-11-10T10:00:00Z", allDay: false }])
})

test("floating time is read in the tz option", () => {
  const out = run([ics([[...base("fl"), "DTSTART:20261110T090000", "DTEND:20261110T100000"]])], { tz: "America/New_York" })
  assert.equal(out[0].start, "2026-11-10T14:00:00Z")
})

test("TZID without VTIMEZONE falls back to the IANA zone via Intl", () => {
  const out = run([ics([[...base("i"), "DTSTART;TZID=Asia/Tokyo:20261110T090000", "DTEND;TZID=Asia/Tokyo:20261110T100000"]])])
  assert.equal(out[0].start, "2026-11-10T00:00:00Z")
})

test("TZID without VTIMEZONE in a series keeps local time across DST", () => {
  const out = run([ics([[...base("ny"), "DTSTART;TZID=America/New_York:20261029T090000", "DTEND;TZID=America/New_York:20261029T100000", "RRULE:FREQ=WEEKLY;COUNT=2"]])])
  assert.deepEqual(out.map((i) => i.start), ["2026-10-29T13:00:00Z", "2026-11-05T14:00:00Z"])
})

test("custom TZID resolved from the object's own VTIMEZONE", () => {
  const out = run([ics([[...base("cu"), "DTSTART;TZID=Custom/Plus3:20261110T090000", "DTEND;TZID=Custom/Plus3:20261110T100000"]], CUSTOM_VTIMEZONE)])
  assert.equal(out[0].start, "2026-11-10T06:00:00Z")
})

test("unknown TZID fails the calendar", () => {
  assert.throws(() => run([ics([[...base("bad"), "DTSTART;TZID=Not/AZone:20261110T090000", "DTEND;TZID=Not/AZone:20261110T100000"]])]), ExpandError)
})

test("declined by the account owner is skipped; tentative still busy", () => {
  const selfAddresses = ["Owner@Example.invalid"]
  const out = run([
    ics([[...base("dec"), "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z", "ATTENDEE;PARTSTAT=DECLINED:mailto:owner@example.invalid"]]),
    ics([[...base("ten"), "DTSTART:20261110T110000Z", "DTEND:20261110T120000Z", "ATTENDEE;PARTSTAT=TENTATIVE:mailto:owner@example.invalid"]]),
    ics([[...base("oth"), "DTSTART:20261110T130000Z", "DTEND:20261110T140000Z", "ATTENDEE;PARTSTAT=DECLINED:mailto:someone@example.invalid"]]),
  ], { selfAddresses })
  assert.deepEqual(out.map((i) => i.id), ["ten|-", "oth|-"])
})

test("zero-length and negative events are skipped", () => {
  const out = run([
    ics([[...base("z1"), "DTSTART:20261110T090000Z"]]),
    ics([[...base("z2"), "DTSTART:20261110T090000Z", "DTEND:20261110T090000Z"]]),
    ics([[...base("z3"), "DTSTART:20261110T090000Z", "DTEND:20261110T080000Z"]]),
  ])
  assert.deepEqual(out, [])
})

test("window edges are half-open", () => {
  const opts = { windowStart: ms("2026-11-10T10:00:00Z"), windowEnd: ms("2026-11-10T12:00:00Z") }
  const out = run([
    ics([[...base("endsAtStart"), "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z"]]),
    ics([[...base("startsAtEnd"), "DTSTART:20261110T120000Z", "DTEND:20261110T130000Z"]]),
    ics([[...base("overlapsStart"), "DTSTART:20261110T093000Z", "DTEND:20261110T103000Z"]]),
    ics([[...base("inside"), "DTSTART:20261110T110000Z", "DTEND:20261110T113000Z"]]),
  ], opts)
  assert.deepEqual(out.map((i) => i.id), ["overlapsStart|-", "inside|-"])
})

test("all-day window uses local dates in tz", () => {
  // Window starts 2026-11-09T23:00Z = 2026-11-10 00:00 in Berlin.
  const opts = { windowStart: ms("2026-11-09T23:00:00Z"), windowEnd: ms("2026-11-11T23:00:00Z"), tz: "Europe/Berlin" }
  const out = run([
    ics([[...base("d9"), "DTSTART;VALUE=DATE:20261109", "DTEND;VALUE=DATE:20261110"]]),
    ics([[...base("d10"), "DTSTART;VALUE=DATE:20261110", "DTEND;VALUE=DATE:20261111"]]),
    ics([[...base("d11"), "DTSTART;VALUE=DATE:20261111", "DTEND;VALUE=DATE:20261112"]]),
    ics([[...base("d12"), "DTSTART;VALUE=DATE:20261112", "DTEND;VALUE=DATE:20261113"]]),
  ], opts)
  assert.deepEqual(out.map((i) => i.id), ["d10|-", "d11|-"])
})

test("all-day series uses YYYYMMDD occurrence ids", () => {
  const out = run([ics([[...base("ad"), "DTSTART;VALUE=DATE:20261102", "DTEND;VALUE=DATE:20261103", "RRULE:FREQ=WEEKLY;COUNT=2"]])])
  assert.deepEqual(out.map((i) => i.id), ["ad|20261102", "ad|20261109"])
})

test("iteration cap fails the calendar instead of truncating", () => {
  const obj = ics([[...base("cap"), "DTSTART:20000101T000000Z", "DTEND:20000101T001500Z", "RRULE:FREQ=HOURLY"]])
  assert.throws(() => run([obj], { maxIterations: 1000 }), /iteration cap/)
})

test("malformed ICS and missing DTSTART fail the calendar", () => {
  assert.throws(() => run(["BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n"]), ExpandError)
  assert.throws(() => run([ics([[...base("nostart"), "DTEND:20261110T100000Z"]])]), ExpandError)
})

test("output has no event text", () => {
  const out = run([ics([[...base("p"), "DTSTART:20261110T090000Z", "DTEND:20261110T100000Z", "SUMMARY:Doctor", "LOCATION:Clinic", "DESCRIPTION:private"]])])
  const text = JSON.stringify(out)
  for (const word of ["Doctor", "Clinic", "private"]) assert.ok(!text.includes(word))
})

test("wallClockToUtc: DST gap and repeated hour follow RFC 5545", () => {
  // Berlin 2026-03-29 02:30 does not exist → read with the pre-jump offset (+01:00) → 01:30Z (03:30 CEST).
  assert.equal(new Date(wallClockToUtc(2026, 3, 29, 2, 30, 0, "Europe/Berlin")).toISOString(), "2026-03-29T01:30:00.000Z")
  // Berlin 2026-10-25 02:30 happens twice → first occurrence (CEST) → 00:30Z.
  assert.equal(new Date(wallClockToUtc(2026, 10, 25, 2, 30, 0, "Europe/Berlin")).toISOString(), "2026-10-25T00:30:00.000Z")
  assert.equal(new Date(wallClockToUtc(2026, 7, 1, 12, 0, 0, "Europe/Berlin")).toISOString(), "2026-07-01T10:00:00.000Z")
})

test("fast-forward gives exactly the same occurrences as full iteration", () => {
  const window = { windowStart: ms("2026-10-01T00:00:00Z"), windowEnd: ms("2027-11-01T00:00:00Z"), tz: "Europe/Berlin" }
  const series = [
    // daily, interval 3, across DST, with EXDATE and an override
    ics([
      [...base("ff1"), "DTSTART;TZID=Europe/Berlin:20200103T073000", "DTEND;TZID=Europe/Berlin:20200103T080000", "RRULE:FREQ=DAILY;INTERVAL=3", "EXDATE;TZID=Europe/Berlin:20261103T073000"],
      [...base("ff1"), "RECURRENCE-ID;TZID=Europe/Berlin:20261106T073000", "DTSTART;TZID=Europe/Berlin:20261106T120000", "DTEND;TZID=Europe/Berlin:20261106T130000"],
    ], BERLIN_VTIMEZONE),
    // weekly, interval 2, WKST=SU, DTSTART weekday not in BYDAY
    ics([[...base("ff2"), "DTSTART;TZID=Europe/Berlin:20210107T100000", "DTEND;TZID=Europe/Berlin:20210107T110000", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;WKST=SU"]], BERLIN_VTIMEZONE),
    // weekly all-day with UNTIL inside the window
    ics([[...base("ff3"), "DTSTART;VALUE=DATE:20190302", "DTEND;VALUE=DATE:20190303", "RRULE:FREQ=WEEKLY;UNTIL=20270301"]]),
    // daily with BYDAY (weekdays), floating time
    ics([[...base("ff4"), "DTSTART:20180101T090000", "DTEND:20180101T091500", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR"]]),
    // THISANDFUTURE range override in a long series
    ics([
      [...base("ff5"), "DTSTART:20200101T100000Z", "DTEND:20200101T110000Z", "RRULE:FREQ=WEEKLY"],
      [...base("ff5"), "RECURRENCE-ID;RANGE=THISANDFUTURE:20261202T100000Z", "DTSTART:20261201T090000Z", "DTEND:20261201T093000Z"],
    ]),
  ]
  for (const obj of series) {
    const fast = expandCalendarObjects([obj], window)
    const full = expandCalendarObjects([obj], { ...window, fastForward: false })
    assert.ok(full.length > 10)
    assert.deepEqual(fast, full)
  }
})
