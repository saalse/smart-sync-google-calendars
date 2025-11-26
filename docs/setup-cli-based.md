# First-Time Deployment & Development Setup (CLI Method)

This guide is for **developers** who want to work with the Smart Sync Google Calendars project using local development tools, version control, and command-line deployment.

## Why Use the CLI Method?

The CLI (Command-Line Interface) method provides:

- ✅ **Local file editing** - Use your favorite editor (VS Code, Cursor, Vim, etc.)
- ✅ **Version control** - Track changes with Git, create branches, roll back changes
- ✅ **AI assistant integration** - Use with Cursor, GitHub Copilot, or other AI coding tools
- ✅ **Automation** - Deploy with a single command (`npm run deploy`)
- ✅ **Team collaboration** - Share changes via Git, review code with pull requests
- ✅ **Professional workflow** - Matches standard software development practices

## Alternative: UI-Based Setup

**Prefer a simpler, browser-only setup?** → See the [UI Setup Guide](./setup-ui-based.md) for the UI method (no command-line tools required).

---

## Overview

This project syncs multiple Google calendars into a single "Busy Time" calendar using Google Apps Script.

**Source Calendars:**
- Your personal calendar (e.g., `user@gmail.com`)
- Your work calendars (e.g., `work1@company.com`, `work2@company.com`, etc.)

**Target Calendar:**
- "Busy Time" calendar (a shared Google Calendar where all events are synced with prefixes)

**Sync Configuration:**
- Window: 30 days in the past, 365 days in the future
- Trigger: Event-based (syncs when any source calendar updates)
- Privacy: No descriptions synced, locations included
- Prefixes: Events tagged with source calendar labels (e.g., `[personal]`, `[work1]`, `[work2]`)

---

## 1. Prerequisites

### a. Check nvm Installation

```bash
# Check if nvm is installed
which nvm
```

If nvm is not installed, install it from [nvm-sh/nvm](https://github.com/nvm-sh/nvm).

### b. Check Available Node.js Versions

```bash
# List installed Node.js versions
nvm ls
```

### c. Activate Node.js Using .nvmrc

The project includes an `.nvmrc` file that specifies the recommended Node.js version.

```bash
# Navigate to project root
cd /path/to/smart-sync-google-calendars

# Use the Node.js version specified in .nvmrc (LTS)
nvm use
```

If the LTS version isn't installed, install it:

```bash
# Install the latest LTS version
nvm install --lts

# Use it as the project version
nvm use
```

**Troubleshooting nvm:**

If `nvm` command is not found, ensure it's loaded in your `~/.zshrc`:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

Then reload: `source ~/.zshrc`

**Optional: Auto-Switch Node Versions**

To automatically switch Node versions when entering the project directory, add this to your `~/.zshrc`:

```bash
# Auto-load .nvmrc when entering directories
autoload -U add-zsh-hook
load-nvmrc() {
  local node_version="$(nvm version)"
  local nvmrc_path="$(nvm_find_nvmrc)"

  if [ -n "$nvmrc_path" ]; then
    local nvmrc_node_version=$(nvm version "$(cat "${nvmrc_path}")")

    if [ "$nvmrc_node_version" = "N/A" ]; then
      nvm install
    elif [ "$nvmrc_node_version" != "$node_version" ]; then
      nvm use
    fi
  elif [ "$node_version" != "$(nvm version default)" ]; then
    echo "Reverting to nvm default version"
    nvm use default
  fi
}
add-zsh-hook chpwd load-nvmrc
load-nvmrc
```

Then reload: `source ~/.zshrc`

### d. Verify Node.js and npm are Active

```bash
# These should now work and show version numbers
node -v
npm -v
npx --version  # Verify npx is also available
```

If any of these commands fail, ensure you've run `nvm use` in the project directory.

## 2. Install Project Dependencies

The project includes a `package.json` file with `clasp` as a development dependency.

```bash
# Install all dependencies locally
npm install
```

This installs `clasp` locally in the `node_modules` directory rather than globally, ensuring version consistency.

## 3. Verify Clasp Installation

```bash
# Check if clasp is available (should show version)
npx clasp --version
```

## 4. Authenticate with Google Apps Script

### a. Enable the Google Apps Script API

1. Visit the [Apps Script API page](https://script.google.com/home/usersettings) in your user settings
2. Make sure you're logged in to your primary Google account (the one that will host the script)
3. Turn on **"Google Apps Script API"**

### b. Log In to your Google Account

```bash
# Login using the locally installed clasp
npx clasp login
```

This command will:
1. Open a new tab in your default web browser
2. Prompt you to log in to your Google account (use your primary Google account)
3. Ask you to grant `clasp` permissions to manage your Apps Script projects

After you approve the permissions, you can close the browser tab. Your terminal will show that you have been successfully logged in.

## 5. Create Google Apps Script Project

Now you can create the Apps Script project in your Google account.

```bash
npm run clasp:create
```

This runs: `clasp create --title "Smart Sync Google Calendars" --rootDir .` (from the `scripts/` directory)

This command creates a new standalone Google Apps Script project in your Google account and creates a `.clasp.json` file in the `scripts/` directory.

**Important Note:** After running this command, check the `scripts/.clasp.json` file. If it contains a `rootDir` that's not `"."`, update it to:

```json
{"scriptId":"YOUR_SCRIPT_ID_HERE", "rootDir":"."}
```

## 6. Configure Your Calendars

Before deploying, you need to configure which calendars to sync.

### Create Your Config File

```bash
# Copy the example config to create your own
cp scripts/Config.gs.example scripts/Config.gs
```

### Find Your Calendar IDs

You need to find the Calendar IDs for:
- Your personal calendar
- Each work calendar you want to sync
- Your target calendar (where synced events will appear)

**→ See [UI Setup Guide - Step 3: Find Your Calendar IDs](./setup-ui-based.md#step-3-find-your-calendar-ids) for detailed instructions.**

This section covers:
- How to find your personal calendar ID
- How to find work calendar IDs (including sharing requirements)
- How to create or identify a target calendar

### Edit Your Config File

Open `scripts/Config.gs` in your editor and fill in your actual calendar IDs:

```javascript
const CALENDARS_TO_MERGE = {
  "personal": "john.doe@gmail.com",              // Your personal calendar ID
  "work1": "john.doe@company1.com",              // First work calendar
  "work2": "john.contractor@company2.com",       // Second work calendar
  // Add or remove calendars as needed
}

const CALENDAR_TO_MERGE_INTO = "abc123def456...@group.calendar.google.com"  // Target calendar ID
```

**Notes:**
- The keys (`"personal"`, `"work1"`, etc.) become prefixes in synced event titles
- You can customize the sync window and other settings in this file
- This file is git-ignored to protect your privacy

## 7. Initial Deployment

After creating the project and configuring your calendars, deploy the code:

```bash
npm run deploy
```

This command pushes your local files (`scripts/SyncCalendarsIntoOne.gs`, `scripts/BatchRequests.gs`, `scripts/Config.gs`, `scripts/appsscript.json`) to Google Apps Script.

**What happens during deployment:**
- Your local `.gs` files are uploaded to Google Apps Script
- The `appsscript.json` manifest configures the project settings
- Your `Config.gs` file is deployed (but remains git-ignored locally)

## 8. Create Initial Deployment Version

After the first push, create a "production" deployment. This gives you a stable version for your triggers to run against.

1. **Create a version:**
   ```bash
   npm run clasp:version "Initial deployment"
   ```
   Note the version number that's output (e.g., "1").

2. **Create a new deployment:**
   ```bash
   npx clasp deploy --description "Production deployment" --versionNumber {VERSION_NUMBER}
   ```
   Replace `{VERSION_NUMBER}` with the version number from step 1 (e.g., `--versionNumber 1`).

   **Note:** If the above command doesn't work, try:
   ```bash
   npx clasp deploy
   ```
   This creates a deployment using the latest version.

3. **Save the Deployment ID:** The command will output a Deployment ID. Save this for future reference, or run `npx clasp deployments` to see it later.

## 9. Authorize and Test the Script

### Open the Apps Script Editor

```bash
npm run clasp:open
```

This opens your project in the Google Apps Script web editor.

### First Test Run

**→ See [UI Setup Guide - Step 6: First Test Run & Authorization](./setup-ui-based.md#step-6-first-test-run--authorization) for detailed authorization and testing instructions.**

This section covers:
- How to run the function manually
- Authorizing the script to access your calendars
- Understanding the "unsafe app" warning (it's safe because you're the developer)
- Checking execution logs

**Quick summary:**
1. Select `SyncCalendarsIntoOne` from the function dropdown
2. Click Run (▶️)
3. Complete the authorization flow
4. Check execution logs for success

### Verify Synced Events

**→ See [UI Setup Guide - Step 7: Verify Synced Events](./setup-ui-based.md#step-7-verify-synced-events) for instructions on verifying the sync worked.**

This section covers:
- Finding synced events in your target calendar
- Verifying event prefixes
- Checking that times, locations, and conference links are preserved

### View Execution Logs (CLI)

You can also view logs from the command line:

```bash
npm run clasp:logs
```

This shows recent execution logs, which is helpful for debugging.

## 10. Set Up Automatic Triggers

The sync only runs when triggered. Set up triggers so your calendars stay in sync automatically.

**→ See [UI Setup Guide - Step 8: Set Up Automatic Triggers](./setup-ui-based.md#step-8-set-up-automatic-triggers) for complete trigger setup instructions.**

This section covers:
- **Calendar-based triggers (recommended)** - Syncs when source calendars update
- **Time-based triggers (alternative)** - Syncs on a schedule
- How to configure each trigger
- Best practices (one trigger per source calendar)

**Quick summary:**
1. Open the Apps Script editor: `npm run clasp:open`
2. Click the clock icon (⏰) to open Triggers
3. Add one trigger per source calendar:
   - Function: `SyncCalendarsIntoOne`
   - Deployment: `Head`
   - Event source: `From calendar`
   - Calendar: Enter the calendar ID

## 11. Test Automatic Sync

**→ See [UI Setup Guide - Step 9: Test Automatic Sync](./setup-ui-based.md#step-9-test-automatic-sync) for testing instructions.**

This section covers:
- Creating a test event in a source calendar
- Verifying it appears in the target calendar
- Checking execution history

## 12. Development Workflow

Now that your project is set up, here's your typical development workflow:

### Making Code Changes

1. **Edit files locally** in your favorite editor:
   ```bash
   # Open in VS Code
   code scripts/SyncCalendarsIntoOne.gs
   
   # Or use Cursor, Vim, etc.
   ```

2. **Deploy your changes:**
   ```bash
   npm run deploy
   ```
   Changes take effect immediately for the `Head` deployment.

3. **Test your changes:**
   - Open the Apps Script editor: `npm run clasp:open`
   - Run the function manually
   - Check execution logs: `npm run clasp:logs`

### Updating Your Config

If you need to add/remove calendars or change settings:

1. **Edit `scripts/Config.gs` locally**
2. **Deploy changes:**
   ```bash
   npm run deploy
   ```
3. **Add/remove triggers** if you added/removed source calendars

### Version Control

Since you're using Git, you can:

```bash
# Check status
git status

# Create a branch for your changes
git checkout -b feature/improve-sync-logic

# Commit your changes
git add scripts/SyncCalendarsIntoOne.gs
git commit -m "Improve event change detection"

# Push to remote
git push origin feature/improve-sync-logic
```

**Remember:** `scripts/Config.gs` and `scripts/.clasp.json` are git-ignored to protect your private information.

### Creating New Deployment Versions

When you're ready to create a stable version:

```bash
# Create a new version
npm run clasp:version "Description of changes"

# Create a deployment from that version
npx clasp deploy --description "Production v2" --versionNumber 2
```

## 13. Troubleshooting CLI-Specific Issues

### Issue: "ENOENT: no such file or directory" When Deploying

**Problem:** clasp can't find the files to deploy.

**Solution:**
1. Check that `scripts/.clasp.json` exists
2. Verify that `rootDir` in `scripts/.clasp.json` is set to `"."`
3. Make sure you're running commands from the project root directory (npm scripts handle the `scripts/` directory automatically)

### Issue: "Not logged in" Error

**Problem:** clasp doesn't recognize your authentication.

**Solution:**
```bash
# Login again
npx clasp login

# Verify you're logged in
npx clasp whoami
```

### Issue: clasp Push Fails

**Problem:** `npm run deploy` fails with an error.

**Solution:**
1. Check that you've authenticated: `npx clasp whoami`
2. Verify the script ID in `scripts/.clasp.json` matches your project
3. Try pulling first to sync: `npx clasp pull` (careful: this overwrites local changes)
4. Check the Apps Script API is enabled at [script.google.com/home/usersettings](https://script.google.com/home/usersettings)

### General Troubleshooting

For common sync issues not specific to CLI:
- Events not syncing
- Calendar not found errors
- Authorization issues
- Duplicate events
- Wrong event times
- Triggers not firing
- Quota/rate limits exceeded

**→ See [UI Setup Guide - Troubleshooting](./setup-ui-based.md#troubleshooting) for comprehensive troubleshooting guide.**

## 14. Ongoing Deployments

Once you're set up, future code updates are simple:

```bash
# Make your changes in local files
vim scripts/SyncCalendarsIntoOne.gs

# Deploy to Google Apps Script
npm run deploy

# Check logs if needed
npm run clasp:logs
```

For more details on the deployment workflow, see the [Updating Deployments Guide](./updating-deployments.md).

## 15. Using with AI Coding Assistants

### Cursor AI

If you're using Cursor:

1. Open the project in Cursor
2. The AI has full context of your code
3. Ask questions like:
   - "How does the smart sync work?"
   - "Can you add a feature to filter events by keyword?"
   - "Help me debug why events aren't syncing"
4. Make changes with AI assistance
5. Deploy with `npm run deploy`

### GitHub Copilot

If you're using GitHub Copilot in VS Code:

1. Open `.gs` files in VS Code
2. Copilot provides suggestions based on your code
3. Use comments to guide Copilot:
   ```javascript
   // Create a function to filter events that contain "personal"
   ```
4. Accept suggestions and deploy

## 16. Project Structure

Understanding the file structure helps with development:

```
smart-sync-google-calendars/
├── scripts/
│   ├── SyncCalendarsIntoOne.gs    # Main sync logic
│   ├── BatchRequests.gs            # Batch API handler
│   ├── Config.gs                   # Your private config (git-ignored)
│   ├── Config.gs.example           # Config template (safe to commit)
│   ├── appsscript.json            # Project manifest
│   └── .clasp.json                # Clasp configuration (git-ignored)
├── docs/                           # Documentation
│   ├── setup-ui-based.md          # UI setup guide
│   ├── setup-cli-based.md         # This file
│   └── updating-deployments.md    # Deployment guide
├── .gitignore                      # Git exclusions
├── .nvmrc                          # Node.js version
├── package.json                    # npm dependencies & scripts
├── package-lock.json               # Locked dependency versions
└── README.md                       # Project overview
```

### Key Files

- **`SyncCalendarsIntoOne.gs`** - Contains all sync logic (fetching, comparing, updating events)
- **`BatchRequests.gs`** - Helper class for efficient batch API requests
- **`Config.gs`** - Your calendar IDs and settings (keep private!)
- **`appsscript.json`** - Manifest that configures OAuth scopes and enabled services

## 17. Next Steps

You're all set up for local development! Here's what you can do next:

### Customize the Sync Logic

Edit `scripts/SyncCalendarsIntoOne.gs` to:
- Change what event data gets synced
- Add custom filtering (e.g., skip events with certain keywords)
- Modify event title formatting
- Add new features

### Monitor Your Sync

```bash
# View recent logs
npm run clasp:logs

# Open in browser to see execution history
npm run clasp:open
```

### Share Your Improvements

If you make improvements that others might benefit from:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Questions & Support

- **General Setup:** See [UI Setup Guide](./setup-ui-based.md)
- **Deployment Help:** See [Updating Deployments Guide](./updating-deployments.md)
- **Calendar API:** [Google Calendar API Docs](https://developers.google.com/calendar/api)
- **Apps Script:** [Google Apps Script Docs](https://developers.google.com/apps-script)
- **clasp Documentation:** [GitHub - google/clasp](https://github.com/google/clasp)
- **Project Repository:** [GitHub](https://github.com/saalse/smart-sync-google-calendars)

---

**Happy vibe-coding!** 🚀 You now have a full local development environment for managing your calendar sync script.



