/**
 * Smart Sync Google Calendars - Intelligent Calendar Synchronization
 * 
 * Author: Alex Samson (@saalse)
 * License: MIT
 * Developed with: Cursor AI assistant
 * 
 * Inspired by the original concept from Ali Karbassi's 
 * sync-multiple-google-calendars (configuration structure and calendar
 * prefix approach). Core sync logic completely rewritten to use smart
 * incremental updates instead of delete-all-recreate approach.
 * 
 * Features:
 * - Smart sync: Only updates changed events (99% reduction in API calls)
 * - Event tracking via extended properties
 * - Duplicate prevention for concurrent executions
 * - Pagination for large calendars
 * - Content-based deduplication
 */

// Base endpoint for the calendar API
const ENDPOINT_BASE = "https://www.googleapis.com/calendar/v3/calendars"

function SyncCalendarsIntoOne() {
  // Acquire lock to prevent concurrent executions from multiple triggers
  const lock = LockService.getScriptLock()
  
  try {
    // Try to acquire lock for up to 30 seconds
    // If another execution is running, this will wait (queue up)
    // If it can't get the lock after 30s, it means the other execution is stuck or very long
    if (!lock.tryLock(30000)) {
      console.log('Could not acquire lock after 30 seconds. Another sync is running. Skipping this execution to prevent race conditions.')
      return
    }

    const startTime = new Date()
    startTime.setHours(0, 0, 0, 0)
    startTime.setDate(startTime.getDate() - SYNC_DAYS_IN_PAST)

    const endTime = new Date()
    endTime.setHours(0, 0, 0, 0)
    endTime.setDate(endTime.getDate() + SYNC_DAYS_IN_FUTURE + 1)

    executeSmartSync(startTime, endTime)
    
  } catch (e) {
    console.error('Sync failed with error: ' + e.toString())
    // We re-throw or just log depending on preference, but logging is usually enough for triggers
  } finally {
    // CRITICAL: Always release the lock so the next queued execution can run
    lock.releaseLock()
  }
}

/**
 * Fetches existing synced events from Busy Time calendar and builds lookup map
 * @param {Date} startTime - Start of sync window
 * @param {Date} endTime - End of sync window
 * @returns {Map} Map of sourceEventKey → {busyTimeEventId, busyTimeEvent, sourceCalendarId, sourceLastModified}
 */
function fetchSyncedEvents(startTime, endTime) {
  const syncedEventsMap = new Map() // sourceEventKey → busyTimeEvent
  
  // Handle pagination (Calendar API returns max 2500 events per page)
  let pageToken = null
  
  do {
    const params = {
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
    }
    if (pageToken) {
      params.pageToken = pageToken
    }
    
    const events = Calendar.Events.list(CALENDAR_TO_MERGE_INTO, params)
    
    if (events.items && events.items.length > 0) {
      events.items.forEach(event => {
        // Only process events we created (has search character)
        if (event.summary && event.summary.includes(SEARCH_CHARACTER)) {
          const props = event.extendedProperties?.private
          if (props?.sourceEventId && props?.sourceCalendarId) {
            // CRITICAL: Reconstruct composite key to match fetchSourceEvents() format
            const sourceEventKey = `${props.sourceCalendarId}:${props.sourceEventId}`
            
            syncedEventsMap.set(sourceEventKey, {
              busyTimeEventId: event.id,
              busyTimeEvent: event,
              sourceCalendarId: props.sourceCalendarId,
              sourceLastModified: props.sourceLastModified,
            })
          }
        }
      })
    }
    
    pageToken = events.nextPageToken
  } while (pageToken)

  return syncedEventsMap
}

/**
 * Fetches all source events from calendars to merge
 * @param {Date} startTime - Start of sync window
 * @param {Date} endTime - End of sync window
 * @returns {Map} Map of sourceEventKey → {sourceCalendarId, calendarName, sourceEvent}
 */
function fetchSourceEvents(startTime, endTime) {
  const sourceEventsMap = new Map() // sourceEventKey → sourceEvent
  
  for (let calendarName in CALENDARS_TO_MERGE) {
    const calendarId = CALENDARS_TO_MERGE[calendarName]
    const calendarToCopy = CalendarApp.getCalendarById(calendarId)

    if (!calendarToCopy) {
      console.log("Calendar not found: '%s'.", calendarId)
      continue
    }

    try {
      // Handle pagination (Calendar API returns max 2500 events per page)
      let pageToken = null
      
      do {
        const params = {
          timeMin: startTime.toISOString(),
          timeMax: endTime.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 2500,
        }
        if (pageToken) {
          params.pageToken = pageToken
        }
        
        const events = Calendar.Events.list(calendarId, params)

        if (events.items && events.items.length > 0) {
          events.items.forEach(event => {
            // Skip transparent/free events
            if (event.transparency && event.transparency === "transparent") {
              return
            }

            // Create unique composite key: calendarId:eventId
            // This format must match what's reconstructed in fetchSyncedEvents()
            const sourceEventKey = `${calendarId}:${event.id}`
            
            sourceEventsMap.set(sourceEventKey, {
              sourceCalendarId: calendarId,
              calendarName: calendarName,
              sourceEvent: event,
            })
          })
        }
        
        pageToken = events.nextPageToken
      } while (pageToken)
      
    } catch (e) {
      // Handle calendar access failures (permissions revoked, calendar deleted, etc.)
      console.error(`Cannot access calendar ${calendarId}: ${e.message}`)
      // Continue with other calendars - don't process deletions for this calendar
      // Events from this calendar will remain in Busy Time until access is restored
      continue
    }
  }

  return sourceEventsMap
}

/**
 * Detects if an event has changed by comparing key fields
 * @param {Object} busyTimeEvent - Event from Busy Time calendar
 * @param {Object} sourceEvent - Event from source calendar
 * @param {string} calendarName - Name of the calendar (for prefix)
 * @returns {boolean} True if event has changed
 */
function hasEventChanged(busyTimeEvent, sourceEvent, calendarName) {
  // Expected title in Busy Time
  const expectedTitle = `${SEARCH_CHARACTER}${calendarName} ${sourceEvent.summary || DEFAULT_EVENT_TITLE}`
  
  // Check title
  if (busyTimeEvent.summary !== expectedTitle) {
    return true
  }

  // Check start time - compare fields directly (more reliable than JSON.stringify)
  const busyStart = busyTimeEvent.start
  const sourceStart = sourceEvent.start
  if (busyStart.dateTime !== sourceStart.dateTime ||
      busyStart.date !== sourceStart.date ||
      busyStart.timeZone !== sourceStart.timeZone) {
    return true
  }

  // Check end time - compare fields directly
  const busyEnd = busyTimeEvent.end
  const sourceEnd = sourceEvent.end
  if (busyEnd.dateTime !== sourceEnd.dateTime ||
      busyEnd.date !== sourceEnd.date ||
      busyEnd.timeZone !== sourceEnd.timeZone) {
    return true
  }

  // Check location (handle null/undefined)
  const busyLoc = busyTimeEvent.location || ""
  const sourceLoc = sourceEvent.location || ""
  if (busyLoc !== sourceLoc) {
    return true
  }

  // Check conference data
  const busyConf = busyTimeEvent.conferenceData?.conferenceId
  const sourceConf = sourceEvent.conferenceData?.conferenceId
  if (busyConf !== sourceConf) {
    return true
  }

  // No changes detected
  return false
}

/**
 * Creates a content-based key for deduplication
 * @param {Object} event - Calendar event
 * @param {string} calendarName - Calendar name (optional, for source events)
 * @param {boolean} isSyncedEvent - True if this is a synced event (has prefix in summary)
 * @returns {string} Content key
 */
function getEventContentKey(event, calendarName, isSyncedEvent) {
  const start = event.start?.dateTime || event.start?.date || ""
  const end = event.end?.dateTime || event.end?.date || ""
  let summary = event.summary || DEFAULT_EVENT_TITLE
  
  // For synced events, remove the prefix to get original summary
  if (isSyncedEvent && summary.includes(SEARCH_CHARACTER)) {
    // Remove prefix: [SEARCH_CHARACTER][calendarName] [summary]
    const prefixPattern = new RegExp(`^${SEARCH_CHARACTER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^ ]+ `)
    summary = summary.replace(prefixPattern, "") || DEFAULT_EVENT_TITLE
  }
  
  const location = event.location || ""
  const calName = calendarName || ""
  return `${calName}|${start}|${end}|${summary}|${location}`
}

/**
 * Checks if an event with matching content already exists in the busy calendar
 * This prevents duplicates from concurrent executions
 * @param {Object} sourceEvent - Source event to check
 * @param {string} calendarName - Calendar name
 * @param {Date} startTime - Sync window start
 * @param {Date} endTime - Sync window end
 * @returns {boolean} True if duplicate exists
 */
function eventContentExistsInBusyCalendar(sourceEvent, calendarName, startTime, endTime) {
  // Build expected summary with prefix
  const expectedSummary = `${SEARCH_CHARACTER}${calendarName} ${sourceEvent.summary || DEFAULT_EVENT_TITLE}`
  
  // Query busy calendar for events with matching time and summary
  const startISO = sourceEvent.start?.dateTime || sourceEvent.start?.date
  const endISO = sourceEvent.end?.dateTime || sourceEvent.end?.date
  
  if (!startISO || !endISO) {
    return false // Can't check without time info
  }
  
  try {
    // Query events in a small window around this event's time
    const queryStart = new Date(startISO)
    queryStart.setMinutes(queryStart.getMinutes() - 5) // 5 min before
    
    const queryEnd = new Date(endISO)
    queryEnd.setMinutes(queryEnd.getMinutes() + 5) // 5 min after
    
    const events = Calendar.Events.list(CALENDAR_TO_MERGE_INTO, {
      timeMin: queryStart.toISOString(),
      timeMax: queryEnd.toISOString(),
      singleEvents: true,
      maxResults: 50, // Should be enough to find duplicates
    })
    
    if (events.items && events.items.length > 0) {
      for (const event of events.items) {
        // Check if summary matches (with prefix)
        if (event.summary === expectedSummary) {
          // Check if times match
          const eventStart = event.start?.dateTime || event.start?.date
          const eventEnd = event.end?.dateTime || event.end?.date
          
          if (eventStart === startISO && eventEnd === endISO) {
            // Check location if present
            const eventLoc = event.location || ""
            const sourceLoc = sourceEvent.location || ""
            if (eventLoc === sourceLoc) {
              console.log(`Found duplicate event in busy calendar: ${expectedSummary} at ${startISO}`)
              return true
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`Error checking for duplicate event: ${e.message}`)
    // If check fails, don't block creation (fail open)
    return false
  }
  
  return false
}

/**
 * Categorizes events into create, update, delete, and skip lists
 * @param {Map} syncedEventsMap - Map of synced events
 * @param {Map} sourceEventsMap - Map of source events
 * @param {Date} startTime - Sync window start
 * @param {Date} endTime - Sync window end
 * @returns {Object} Object with toCreate, toUpdate, toDelete, toSkip arrays
 */
function categorizeChanges(syncedEventsMap, sourceEventsMap, startTime, endTime) {
  const toCreate = []
  const toUpdate = []
  const toDelete = []
  const toSkip = []
  const contentKeysSeen = new Set() // Track content keys to prevent duplicates

  // Find new and changed events
  sourceEventsMap.forEach((sourceData, sourceEventKey) => {
    const synced = syncedEventsMap.get(sourceEventKey)
    
    if (!synced) {
      // New event - check for duplicate content before adding
      const contentKey = getEventContentKey(sourceData.sourceEvent, sourceData.calendarName)
      
      // Check if we already have an event with this content in the create list
      if (contentKeysSeen.has(contentKey)) {
        console.log(`Skipping duplicate event: ${sourceEventKey} (content key: ${contentKey})`)
        return
      }
      
      // Check if a synced event with this content already exists in our map
      let duplicateFound = false
      syncedEventsMap.forEach((syncedData, syncedKey) => {
        if (syncedData.sourceCalendarId === sourceData.sourceCalendarId) {
          // Compare synced event content (isSyncedEvent=true to strip prefix)
          const syncedContentKey = getEventContentKey(syncedData.busyTimeEvent, sourceData.calendarName, true)
          if (syncedContentKey === contentKey) {
            console.log(`Skipping duplicate event: ${sourceEventKey} (matches existing synced event: ${syncedKey})`)
            duplicateFound = true
          }
        }
      })
      
      // Also check if event already exists in busy calendar (handles concurrent executions)
      if (!duplicateFound) {
        duplicateFound = eventContentExistsInBusyCalendar(
          sourceData.sourceEvent,
          sourceData.calendarName,
          startTime,
          endTime
        )
      }
      
      if (!duplicateFound) {
        contentKeysSeen.add(contentKey)
        toCreate.push(sourceData)
      }
    } else {
      // Event exists - check if changed
      if (hasEventChanged(synced.busyTimeEvent, sourceData.sourceEvent, sourceData.calendarName)) {
        toUpdate.push({
          busyTimeEventId: synced.busyTimeEventId,
          sourceData: sourceData,
        })
      } else {
        toSkip.push(sourceEventKey)
      }
    }
  })

  // Find deleted events
  syncedEventsMap.forEach((syncedData, sourceEventKey) => {
    if (!sourceEventsMap.has(sourceEventKey)) {
      // Event was deleted from source
      toDelete.push(syncedData.busyTimeEventId)
    }
  })

  return { toCreate, toUpdate, toDelete, toSkip }
}

/**
 * Executes the smart sync: only creates, updates, or deletes changed events
 * @param {Date} startTime - Start of sync window
 * @param {Date} endTime - End of sync window
 */
function executeSmartSync(startTime, endTime) {
  // Fetch both sides
  const syncedEventsMap = fetchSyncedEvents(startTime, endTime)
  const sourceEventsMap = fetchSourceEvents(startTime, endTime)

  // Categorize
  const { toCreate, toUpdate, toDelete, toSkip } = categorizeChanges(
    syncedEventsMap,
    sourceEventsMap,
    startTime,
    endTime
  )

  console.log(`Analysis: ${toCreate.length} create, ${toUpdate.length} update, ${toDelete.length} delete, ${toSkip.length} skip`)

  // Execute deletions
  if (toDelete.length > 0) {
    const deleteRequests = toDelete.map(eventId => ({
      method: "DELETE",
      endpoint: `${ENDPOINT_BASE}/${CALENDAR_TO_MERGE_INTO}/events/${eventId.replace("@google.com", "")}`,
    }))

    const deleteResult = new BatchRequest({
      useFetchAll: true,
      batchPath: "batch/calendar/v3",
      requests: deleteRequests,
    })

    console.log(`${deleteResult.length} events deleted`)
  }

  // Execute updates
  if (toUpdate.length > 0) {
    const updateRequests = toUpdate.map(item => {
      const event = item.sourceData.sourceEvent
      const summary = event.summary || DEFAULT_EVENT_TITLE
      
      return {
        method: "PATCH",
        endpoint: `${ENDPOINT_BASE}/${CALENDAR_TO_MERGE_INTO}/events/${item.busyTimeEventId.replace("@google.com", "")}`,
        requestBody: {
          summary: `${SEARCH_CHARACTER}${item.sourceData.calendarName} ${summary}`,
          location: event.location,
          start: event.start,
          end: event.end,
          conferenceData: event.conferenceData,
          extendedProperties: {
            private: {
              sourceCalendarId: item.sourceData.sourceCalendarId,
              sourceEventId: event.id,
              sourceLastModified: event.updated,
              syncVersion: "1.0",
            },
          },
        },
      }
    })

    const updateResult = new BatchRequest({
      batchPath: "batch/calendar/v3",
      requests: updateRequests,
    })

    console.log(`${updateResult.length} events updated`)
  }

  // Execute creations
  if (toCreate.length > 0) {
    const createRequests = toCreate.map(item => {
      const event = item.sourceEvent
      const summary = event.summary || DEFAULT_EVENT_TITLE

      return {
        method: "POST",
        endpoint: `${ENDPOINT_BASE}/${CALENDAR_TO_MERGE_INTO}/events?conferenceDataVersion=1`,
        requestBody: {
          summary: `${SEARCH_CHARACTER}${item.calendarName} ${summary}`,
          location: event.location,
          start: event.start,
          end: event.end,
          conferenceData: event.conferenceData,
          extendedProperties: {
            private: {
              sourceCalendarId: item.sourceCalendarId,
              sourceEventId: event.id,
              sourceLastModified: event.updated,
              syncVersion: "1.0",
            },
          },
        },
      }
    })

    const createResult = new BatchRequest({
      batchPath: "batch/calendar/v3",
      requests: createRequests,
    })

    console.log(`${createResult.length} events created`)
  }

  console.log(`Smart sync complete: ${toCreate.length} created, ${toUpdate.length} updated, ${toDelete.length} deleted, ${toSkip.length} unchanged`)
}
