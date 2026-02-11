---
name: salesforce
description: Automate Salesforce via browser control. Use when asked to login to Salesforce, update records, create records, view records, run reports, or perform any Salesforce CRM tasks. Handles authentication and navigation automatically.
---

# Salesforce Browser Automation

Automate Salesforce Classic and Lightning Experience via browser control.

## Prerequisites

Credentials must be stored in TOOLS.md under `### Salesforce`:

```markdown
### Salesforce

- **Login URL:** https://login.salesforce.com (or custom domain)
- **Username:** kushbang123764@agentforce.com
- **Password:** Kushbang\*007
- **Security Token:** (if required, append to password)
```

## Login Flow

1. Open managed browser: `browser action=open profile=openclaw targetUrl=https://login.salesforce.com`
2. Take snapshot to see login form
3. Type username into username field (usually `#username`)
4. Type password into password field (usually `#password`)
5. Click Login button
6. Handle MFA if prompted (may need user intervention)
7. Confirm successful login by checking for Salesforce home/dashboard

## Common Operations

### Update a Record

1. Login (if not already logged in)
2. Navigate to record:
   - **By ID:** `https://<instance>.salesforce.com/<recordId>`
   - **By search:** Use global search bar, type record name/identifier
3. Click "Edit" button
4. Find and update the target field(s)
5. Click "Save"
6. Confirm save success (look for toast/confirmation)

### Create a Record

1. Login (if not already logged in)
2. Navigate to object tab (Accounts, Contacts, Opportunities, etc.)
3. Click "New" button
4. Fill required fields
5. Click "Save"

### Search for Records

1. Use global search (magnifying glass icon / search bar)
2. Type search term
3. Filter by object type if needed
4. Click on result to view

### Run a Report

1. Navigate to Reports tab
2. Search or browse for report
3. Click report name to run
4. Use filters/parameters as needed

## Lightning vs Classic Detection

- **Lightning:** URL contains `/lightning/`, modern UI with app launcher
- **Classic:** Traditional Salesforce tabs, different URL structure

Adjust selectors accordingly:

- Lightning uses `lightning-*` components and `[data-*]` attributes
- Classic uses standard HTML elements and Visualforce patterns

## Error Handling

- **Login failed:** Check credentials in TOOLS.md, verify security token
- **Session expired:** Re-run login flow
- **Record not found:** Verify record ID, check permissions
- **Field not editable:** May be formula field, workflow-locked, or permission issue

## Tips

- Take snapshots frequently to understand page state
- Use `refs="aria"` for more stable element references
- Wait for page loads after navigation (check for loading spinners)
- Salesforce pages can be slow - allow time for Lightning components to render

## Security Note

Credentials are stored locally in TOOLS.md. Never expose credentials in logs or responses.
