# Configuration & Setup Guide

This guide walks you through setting up Smart Sync Google Calendars using the **Apps Script Editor** (UI-based method). This is the easiest way to get started — no command-line tools required!

## What You'll Accomplish

By the end of this guide, you'll have:
- ✅ A Google Apps Script project that syncs multiple calendars
- ✅ Automatic triggers that keep calendars in sync
- ✅ A single "Busy Time" calendar showing all your events with prefixes like `[personal]` and `[work1]`

---

## 🚀 For Developers: CLI Alternative

**Are you a developer who wants:**
- Local file editing with your favorite editor (VS Code, Cursor, etc.)
- Version control integration
- AI assistant integration (Cursor, GitHub Copilot)
- Command-line deployment workflow

**→ See the [CLI Setup Guide](./setup-cli-based.md) for the CLI/clasp method.**

Otherwise, continue below for the UI-based setup! ⬇️

---

## Prerequisites

You only need:
- A Google account
- Access to multiple Google Calendars (personal, work, etc.)
- 20 minutes of setup time

## Step 1: Create a Google Apps Script Project

1. Go to [Google Apps Script](https://script.google.com/home)
2. Click **"New project"** (+ button in top-left)
3. Click on "Untitled project" at the top and rename it to: **Smart Sync Google Calendars**
4. You should see a default `Code.gs` file with a sample function — we'll replace this next

## Step 2: Add Script Files

Now we'll add the three script files that make up the sync system.

### 2.1: Replace Code.gs with SyncCalendarsIntoOne.gs

1. Click on `Code.gs` in the left sidebar (if not already open)
2. **Select all** the default code (Cmd+A or Ctrl+A) and **delete it**
3. Copy the entire contents of [`scripts/SyncCalendarsIntoOne.gs`](https://github.com/saalse/smart-sync-google-calendars/blob/main/scripts/SyncCalendarsIntoOne.gs) from the repository
4. Paste it into the editor
5. Rename the file:
   - Click the three dots (⋮) next to `Code.gs`
   - Select **"Rename"**
   - Name it: `SyncCalendarsIntoOne`
6. The `.gs` extension will be added automatically

### 2.2: Add BatchRequests.gs

1. Click the **"+"** button next to "Files" in the left sidebar
2. Select **"Script"**
3. Name it: `BatchRequests`
4. Copy the entire contents of [`scripts/BatchRequests.gs`](https://github.com/saalse/smart-sync-google-calendars/blob/main/scripts/BatchRequests.gs) from the repository
5. Paste it into the new file
6. Press Cmd+S (Mac) or Ctrl+S (Windows) to save

### 2.3: Add Config.gs (Your Private Configuration)

1. Click the **"+"** button next to "Files" in the left sidebar
2. Select **"Script"**
3. Name it: `Config`
4. Copy the template below and paste it into the new file:

```javascript
// Configuration file - Your private calendar setup
// This file contains your calendar IDs and settings

// Calendars to merge from.
// The keys (e.g., "personal", "work1") become prefixes in event titles.
const CALENDARS_TO_MERGE = {
  "personal": "your-personal@gmail.com",
  "work1": "work@company1.com",
  "work2": "work@company2.com",
  // Add more calendars as needed
}

// The ID of the target calendar where all events will be synced
const CALENDAR_TO_MERGE_INTO = "your-target-calendar-id@group.calendar.google.com"

// Number of days in the past and future to sync
const SYNC_DAYS_IN_PAST = 30
const SYNC_DAYS_IN_FUTURE = 365

// Default title for events that don't have a title
const DEFAULT_EVENT_TITLE = "Busy"

// Unique character to identify synced events (don't change this)
// https://unicode-table.com/en/200B/
const SEARCH_CHARACTER = "\u200B"
```

5. **Don't worry about the placeholder values yet** — we'll fill in your actual calendar IDs in Step 3
6. Press Cmd+S (Mac) or Ctrl+S (Windows) to save

## Step 3: Find Your Calendar IDs

You need the Calendar IDs for each calendar you want to sync. Here's how to find them:

### 3.1: Personal Calendar ID

1. Open [Google Calendar](https://calendar.google.com) in a new tab
2. Look at the left sidebar under "My calendars"
3. Click the **three dots (⋮)** next to your main calendar
4. Select **"Settings and sharing"**
5. Scroll down to the **"Integrate calendar"** section
6. Copy the **"Calendar ID"** (usually your email address like `user@gmail.com`)

### 3.2: Work Calendar IDs

For each work calendar you want to sync:

**First, ensure the calendar is shared with you:**
1. Open the work calendar's settings (same as above)
2. Under **"Share with specific people"**, verify your personal email is listed
3. You need at least **"See all event details"** permission (not just "See only free/busy")

**Then, get the Calendar ID:**
1. Follow the same steps as for your personal calendar
2. The ID is typically the email address (e.g., `work@company.com`)

### 3.3: Target Calendar ID

You need a target calendar where all synced events will appear.

**Option A: Create a New Calendar**
1. In Google Calendar, click the **"+"** next to "Other calendars"
2. Select **"Create new calendar"**
3. Name it something like: **"Busy Time"** or **"All Calendars"**
4. Optionally add a description
5. Click **"Create calendar"**
6. Find its Calendar ID using the steps from 3.1 above
7. The ID will look like: `abc123def456...@group.calendar.google.com`

**Option B: Use an Existing Calendar**
1. Find the Calendar ID of your existing calendar
2. **Warning:** All synced events will be added to this calendar

## Step 4: Edit Your Configuration

Now that you have all your calendar IDs, let's add them to your `Config.gs` file:

1. Go back to the **Apps Script Editor** tab
2. Click on `Config.gs` in the left sidebar
3. Replace the placeholder values with your actual calendar IDs:

```javascript
const CALENDARS_TO_MERGE = {
  "personal": "john.doe@gmail.com",              // ← Your actual personal calendar ID
  "work1": "john.doe@company1.com",              // ← Your first work calendar ID
  "work2": "john.contractor@company2.com",       // ← Your second work calendar ID
  // Add more calendars as needed, or remove lines you don't need
}

const CALENDAR_TO_MERGE_INTO = "abc123def456...@group.calendar.google.com"  // ← Your target calendar ID
```

**Important Notes:**
- The **keys** (`"personal"`, `"work1"`, etc.) become prefixes in synced event titles
- Example: An event "Team Meeting" from "personal" becomes `[personal] Team Meeting`
- You can use any label you want (e.g., `"home"`, `"consulting"`, `"client-work"`)
- You can add or remove calendars as needed — just follow the same format

4. Press **Cmd+S** (Mac) or **Ctrl+S** (Windows) to save

### 4.1: Optional Settings

You can also customize these settings in `Config.gs`:

```javascript
// How far back and forward to sync (in days)
const SYNC_DAYS_IN_PAST = 30       // Default: 30 days
const SYNC_DAYS_IN_FUTURE = 365    // Default: 365 days (1 year)

// What to show for events without a title
const DEFAULT_EVENT_TITLE = "Busy" // Default: "Busy"
```

## Step 5: Enable the Calendar API

The script needs access to the Google Calendar API to sync events:

1. In the Apps Script Editor, click **"Services"** (+ button) in the left sidebar
2. Scroll down and find **"Google Calendar API"**
3. Click on it, then click **"Add"**
4. You should now see "Calendar" listed under "Services" in the left sidebar

## Step 6: First Test Run & Authorization

Now let's test the script and authorize it to access your calendars:

1. Make sure `SyncCalendarsIntoOne.gs` is open in the editor
2. At the top of the editor, select **`SyncCalendarsIntoOne`** from the function dropdown
3. Click the **Run** button (▶️)

**First Run - Authorization Required:**

4. You'll see a dialog: **"Authorization required"**
5. Click **"Review permissions"**
6. A new window will open asking you to choose an account
7. **Select your Google account** (the one hosting this script)
8. You may see a warning: **"Google hasn't verified this app"**
   - This is normal for personal scripts you create
   - Click **"Advanced"**
   - Click **"Go to Smart Sync Google Calendars (unsafe)"**
   - This is safe because YOU are the developer
9. Review the permissions requested:
   - View and edit your calendars
   - Connect to external services
10. Click **"Allow"**

**After Authorization:**

11. The script will run automatically
12. Wait 10-30 seconds for it to complete
13. Check the **Execution log** (View → Logs or Cmd/Ctrl + Enter)
14. You should see output like:
    ```
    Analysis: 15 create, 0 update, 0 delete, 0 skip
    15 events created
    Smart sync complete: 15 created, 0 updated, 0 deleted, 0 unchanged
    ```

## Step 7: Verify Synced Events

Let's confirm everything worked:

1. Go to [Google Calendar](https://calendar.google.com)
2. Find your **target calendar** in the left sidebar (e.g., "Busy Time")
3. Make sure it's checked/visible
4. Look for synced events with prefixes matching your config, like:
   - `[personal] Team Meeting`
   - `[work1] Client Call`
   - `[work2] Design Review`
5. Verify that events from the past 30 days and future 365 days are synced
6. Click on a synced event to verify:
   - Title includes the calendar prefix
   - Time matches the source event
   - Location is included
   - Conference links (Zoom, Meet) are preserved

## Step 8: Set Up Automatic Triggers

Right now, the sync only runs when you manually click "Run". Let's set up automatic triggers so your calendars stay in sync automatically.

### Calendar-Based Triggers (Recommended)

Calendar-based triggers run the sync automatically whenever any of your source calendars are updated. This provides near-instant syncing.

**Set up one trigger per source calendar:**

1. In the Apps Script editor, click the **clock icon (⏰)** in the left sidebar
2. Click **"+ Add Trigger"** (bottom-right)
3. Configure the first trigger:
   - **Choose which function to run:** `SyncCalendarsIntoOne`
   - **Choose which deployment should run:** `Head`
   - **Select event source:** `From calendar`
   - **Enter calendar details:** Enter your first source calendar ID (e.g., `john.doe@gmail.com`)
   - **Notification settings:** Leave as default (or customize as needed)
4. Click **"Save"**
5. **Repeat steps 2-4 for each of your other source calendars:**
   - Add a trigger for your second calendar (e.g., `john.doe@company1.com`)
   - Add a trigger for your third calendar (e.g., `john.contractor@company2.com`)
   - Continue for all calendars in your `CALENDARS_TO_MERGE` config

**Result:** You should have **one trigger per source calendar** (typically 3-5 triggers total).

**Note:** The first time you save a trigger, you may be prompted to authorize the script again. This is normal — just follow the authorization flow.

### Time-Based Trigger (Alternative)

If you prefer to sync on a schedule instead of event-based:

1. Click the **clock icon (⏰)** in the left sidebar
2. Click **"+ Add Trigger"**
3. Configure:
   - **Choose which function to run:** `SyncCalendarsIntoOne`
   - **Choose which deployment should run:** `Head`
   - **Select event source:** `Time-driven`
   - **Select type of time based trigger:** `Minutes timer`
   - **Select minute interval:** `Every 15 minutes` (or your preference)
4. Click **"Save"**

**Note:** Time-based triggers are simpler but less responsive than calendar-based triggers.

## Step 9: Test Automatic Sync

Let's verify the triggers are working:

1. Go to [Google Calendar](https://calendar.google.com)
2. Open one of your **source calendars** (personal or work)
3. **Create a test event:**
   - Title: "Test Event"
   - Date/time: Tomorrow at 2:00 PM
   - Save the event
4. **Wait 1-2 minutes** for the trigger to fire
5. Go to your **target calendar** (e.g., "Busy Time")
6. Look for the synced event: **`[personal] Test Event`** (or whatever prefix matches)
7. If you see it, **success!** Your automatic sync is working
8. You can delete the test event from both calendars

**Troubleshooting:**
- If the event doesn't appear after 2-3 minutes, check the **Executions** page in Apps Script (left sidebar, clock with checkmark icon)
- Look for recent executions and any error messages
- See the Troubleshooting section below for common issues

## Step 10: View Execution History

You can monitor sync activity:

1. In the Apps Script editor, click the **"Executions"** icon (clock with checkmark) in the left sidebar
2. You'll see a list of recent sync runs with:
   - Timestamp when they ran
   - How long they took
   - Status (Success or Failed)
3. Click on any execution to view its detailed logs
4. This is helpful for debugging if events aren't syncing as expected

## Troubleshooting

### Events Not Syncing

**Problem:** No events appear in the target calendar after running the script.

**Solutions:**
1. Check the execution log for errors (View → Logs in the editor)
2. Verify all calendar IDs in `Config.gs` are correct
3. Ensure work calendars are shared with your primary Google account with at least "See all event details" permission
4. Confirm you have events in your source calendars within the sync window (past 30 days, future 365 days)
5. Check that the Calendar API is enabled (Step 5)

### Calendar Not Found Error

**Problem:** Execution log shows "Calendar not found: 'calendar@example.com'"

**Solutions:**
1. Double-check the Calendar ID in `Config.gs` — make sure there are no typos or extra spaces
2. For work calendars, verify they are shared with your primary Google account
3. Verify the sharing permission is **"See all event details"** (not just "See only free/busy")
4. Try accessing the calendar in Google Calendar's web interface to confirm you can see it

### Authorization Keeps Appearing

**Problem:** Script keeps asking for authorization every time you run it.

**Solutions:**
1. Make sure you completed the full authorization flow (Steps 6.4-6.10)
2. When you see "Google hasn't verified this app", you must click "Advanced" → "Go to Smart Sync Google Calendars (unsafe)"
3. Grant all requested permissions
4. This is safe because you are the developer and owner of the script

### Duplicate Events

**Problem:** Events appearing multiple times in the target calendar.

**Solutions:**
1. The script includes advanced duplicate prevention using `LockService` to handle concurrent executions.
2. This prevents race conditions when multiple triggers fire simultaneously (e.g. adding multiple events quickly).
3. If you still see duplicates, delete all events from the target calendar and run the sync once manually to reset.

### Wrong Event Times

**Problem:** Events syncing with incorrect times or timezones.

**Solutions:**
1. The script preserves the original timezone from source events
2. Check your Google Calendar timezone settings (Settings → General → Your current time zone)
3. Verify the source event has the correct timezone
4. The synced event should match the source event exactly

### Triggers Not Firing

**Problem:** Automatic sync isn't working even though triggers are set up.

**Solutions:**
1. Check the Executions page for errors
2. Verify triggers are configured correctly (clock icon in left sidebar)
3. For calendar-based triggers, make sure the calendar ID is entered correctly
4. Try creating a test event in a source calendar and wait 1-2 minutes
5. Check that you've authorized the script to run automatically (authorization includes trigger permissions)

### Too Many Events / Quota Exceeded

**Problem:** Script fails with quota or rate limit errors.

**Solutions:**
- Google Apps Script allows 5,000 calendar events created per day
- The smart sync only creates/updates changed events, so this is rarely an issue
- If you hit limits, reduce `SYNC_DAYS_IN_PAST` or `SYNC_DAYS_IN_FUTURE` in `Config.gs`
- Check quota usage at the [Google Cloud Console](https://console.cloud.google.com/)

## Security & Privacy

### What's Private

Your `Config.gs` file contains sensitive information (calendar IDs, email addresses). When using the UI method:
- **Your config stays in Google Apps Script** — it's not stored anywhere else
- **Only you can access it** — it's tied to your Google account
- **Google secures it** — uses Google's authentication and authorization

### What Gets Synced

The script only syncs specific event information:
- ✅ **Event title** (with calendar prefix)
- ✅ **Start and end times** (with timezone)
- ✅ **Location**
- ✅ **Conference links** (Zoom, Meet, etc.)
- ❌ **Descriptions** (NOT synced for privacy)
- ❌ **Attendees** (NOT synced for privacy)
- ❌ **Free/transparent events** (NOT synced)

### Data Storage

The script uses Google Calendar's extended properties to track synced events:
- `sourceCalendarId` - Which calendar the event came from
- `sourceEventId` - Original event ID
- `sourceLastModified` - When it was last updated
- This data is stored within your Google Calendar and never leaves Google's systems

## What's Next?

Congratulations! Your calendar sync is now set up and running automatically. 🎉

### Optional: Share Your Target Calendar

You can now share your "Busy Time" calendar with others:

1. Go to [Google Calendar](https://calendar.google.com)
2. Find your target calendar in the left sidebar
3. Click the three dots (⋮) next to it
4. Select **"Settings and sharing"**
5. Under **"Share with specific people"**, add email addresses
6. Choose permission level (usually "See only free/busy" is sufficient for family/colleagues)
7. Or, share the calendar URL with iCloud or other calendar apps

### Making Changes

If you need to add/remove calendars or change settings:

1. Go back to the [Apps Script Editor](https://script.google.com/home)
2. Open your project: "Smart Sync Google Calendars"
3. Edit `Config.gs` with your changes
4. Press **Cmd+S** or **Ctrl+S** to save
5. Changes take effect immediately — the next sync will use the new settings
6. If you added a new source calendar, **remember to add a trigger for it** (Step 8)

### Monitoring

To keep an eye on your sync:
- Check the **Executions** page occasionally for errors
- Your target calendar should update within 1-2 minutes of changes in source calendars
- If you notice issues, check the Troubleshooting section above

## Advanced: Using CLI for Ongoing Maintenance

If you want to switch to local file editing and version control for ongoing maintenance:

1. Follow the [CLI Setup Guide](./setup-cli-based.md) to set up clasp
2. Pull your existing script to your local machine
3. Edit files locally and deploy changes with `npm run deploy`
4. Your triggers and config will remain intact

## Questions & Support

- **Calendar API Documentation:** [Google Calendar API Docs](https://developers.google.com/calendar/api)
- **Apps Script Documentation:** [Google Apps Script Docs](https://developers.google.com/apps-script)
- **Project Repository:** [GitHub](https://github.com/saalse/smart-sync-google-calendars)
- **For CLI Setup:** See [CLI Setup Guide](./setup-cli-based.md)
- **For Code Updates:** See [Updating Deployments Guide](./updating-deployments.md)

---

**Need help?** Check the Troubleshooting section above or review the execution logs in the Apps Script editor.
