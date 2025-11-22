# Ongoing Deployment Workflow

This guide covers routine deployments after your environment is set up.

## 🔀 Which Guide Do I Need?

```
├─ Never deployed this project before?
│  └─→ Read: setup-cli-based.md
│
├─ Already have a deployment running?
│  └─→ You're in the right place! Continue below.
│
└─ Not sure if you have a deployment?
   └─→ Run: npx clasp deployments
       ├─ See a deployment listed? Continue below.
       └─ See "No deployments"? Read: setup-cli-based.md
```

For complete initial setup (Node.js, nvm, clasp, authentication, triggers), see [`setup-cli-based.md`](./setup-cli-based.md).

## Before You Start
- Open a terminal in the project directory.
- **Activate the project Node.js version:**
  ```bash
  nvm use
  ```
  If you see "command not found: npx" or similar errors, see the [CLI Setup Guide](./setup-cli-based.md#1-prerequisites) for troubleshooting.
- If dependencies were updated, rerun `npm install`.

## First Deployment

If this is your first deployment, **stop here** and follow the complete setup guide:

👉 **[CLI Setup Guide](./setup-cli-based.md)**

That guide covers:
- Creating your initial deployment
- Setting up calendar triggers
- Finding calendar IDs
- Initial authorization and testing

Once you've completed the first-time setup, return here for all future deployments.

---

## Step 1 · Push Code Changes to Apps Script
This command pushes your local files (`scripts/SyncCalendarsIntoOne.gs`, `scripts/BatchRequests.gs`, `scripts/appsscript.json`) to Google Apps Script, updating the "HEAD" (draft) version of your project.

```bash
npm run deploy
```

**Note:** The project files are located in the `scripts/` directory to avoid scanning `node_modules` and other unnecessary files.

## Step 2 · Create a New Version
Create a new, immutable version of your script. This provides a stable snapshot that you can deploy.

1.  **Draft a version description.** Keep it short and descriptive (e.g., "Fix sync logic for all-day events").
2.  **Run the versioning command:**
    ```bash
    npm run clasp:version "<your description>"
    ```
    This command will output a new version number. Note it for the next step.

## Step 3 · Deploy the New Version
Update the production deployment to use the new version you just created.

1.  **Find your Deployment ID.** If you don't have it handy, run:
    ```bash
    npx clasp deployments
    ```
    You will see a list of deployments. The one you want is likely the only one listed.

2.  **Deploy the new version:** Replace `{DEPLOYMENT_ID}` and `{VERSION_NUMBER}` with the values from the previous steps.
    ```bash
    npx clasp deploy --deploymentId {DEPLOYMENT_ID} --versionNumber {VERSION_NUMBER}
    ```

Your new code is now live and stable. Your triggers will run against this newly deployed version.

## Monitoring & Troubleshooting

### View Execution Logs
See what the script is doing and any errors:
```bash
npm run clasp:logs
```
Or in the Apps Script UI: **View → Logs** or **Execution log**.

### Common Issues

**Issue: "Push failed" or `npm run deploy` hangs**
- **Solution 1:** Check you're logged in: `npx clasp login`.
- **Solution 2:** Verify `scripts/.clasp.json` has the correct `scriptId` and `"rootDir": "."`.
- **Solution 3:** Ensure you have write access to the Apps Script project.
- **Solution 4:** Check your network connection and try again. Sometimes Google's API can be slow or timeout.

**Issue: Changes Not Appearing After Deployment**
- **Solution:** Make sure you completed all three steps: `push`, `version`, and `deploy`. Simply pushing the code does not make it live in a versioned deployment.

---

## Reference Information

### Script Location
- **Quick access:** `npm run clasp:open`
- **Find your Script ID** in `scripts/.clasp.json`.

### npm Scripts Reference
| Command | Description |
|---|---|
| `npm run deploy` | Push local code to update the HEAD deployment on Apps Script. |
| `npm run clasp:create` | Create a new Apps Script project (first-time only). |
| `npm run clasp:open` | Open the project in the browser. |
| `npm run clasp:logs` | View recent execution logs. |
| `npm run clasp:pull` | Pull changes from Apps Script to your local files. |
| `npm run clasp:version` | Create a new numbered version of the script. |
| `npm run clasp:deploy` | Deploy a specific version to a deployment ID. |

