---
name: salesforce
description: Automate Salesforce via browser control. Use when asked to login to Salesforce, update records, create records, view records, run reports, or perform any Salesforce CRM tasks. Handles authentication and navigation automatically.
---

# Salesforce Browser Automation

Automate Salesforce Classic and Lightning Experience via browser control.

## ⚡ Voice Call Handling (Async Pattern)

**When invoked from a voice call (VAPI tool call):**

Browser automation takes 20-60+ seconds. Callers shouldn't wait on the phone.

### Async Operations (spawn sub-agent)

- Creating records (leads, contacts, accounts, opportunities)
- Updating records
- Complex multi-step workflows
- Anything involving browser automation

### Sync Operations (return immediately)

- Simple lookups from memory/context
- Answering questions about Salesforce (no browser needed)

### How to Handle Async

1. **Acknowledge immediately** — return to the caller:

   > "Got it, I'll create that lead and text you when it's done."

2. **Spawn a sub-agent** with the actual task:

   ```
   sessions_spawn:
     task: |
       [Salesforce Task from Voice Call]

       Caller: {caller_phone}
       Request: {original_request}

       Instructions:
       1. Read the Salesforce skill
       2. Execute the browser automation
       3. When DONE, send SMS to {caller_phone}:
          "✅ Done! [Brief summary - e.g., Created lead John Doe at Acme Corp]"
       4. If FAILED, send SMS to {caller_phone}:
          "❌ Couldn't complete: [brief reason]"
     cleanup: delete
   ```

3. **Don't wait** — the sub-agent runs in background

### Example Flow

**Caller says:** "Create a lead for John Doe at Acme Corp"

**You respond (immediately):**

> "Got it, I'll create that lead in Salesforce and text you when it's done."

**Then spawn:**

```
sessions_spawn with task:
  "Create a lead in Salesforce:
   - Name: John Doe
   - Company: Acme Corp

   Caller: +918160376548

   When done, send SMS to +918160376548 confirming the lead was created."
```

**Sub-agent executes** → creates lead → sends SMS:

> "✅ Done! Created lead John Doe at Acme Corp in Salesforce."

---

## Prerequisites

Credentials must be stored in TOOLS.md under `### Salesforce`:

```markdown
### Salesforce

- **Login URL:** https://login.salesforce.com (or custom domain)
- **Username:** your-email@company.com
- **Password:** your-password
- **Security Token:** (if required, append to password)
```

## Browser Profile

Use `profile=openclaw` for Salesforce automation. The session persists, so you may already be logged in.

```
browser action=screenshot profile=openclaw
```

Check if already logged in before attempting login flow.

## Login Flow

1. Open browser: `browser action=open profile=openclaw targetUrl=https://login.salesforce.com`
2. Take screenshot to check state
3. If login page:
   - Type username into username field
   - Type password into password field
   - Click Login button
4. Handle MFA if prompted (may need user intervention)
5. Confirm successful login by checking for Salesforce home/dashboard

## Common Operations

### Create a Lead

1. Check browser session (screenshot)
2. If not logged in, login first
3. Open App Launcher → search "Leads"
4. Click "New" button
5. Fill required fields:
   - First Name, Last Name (required)
   - Company (required)
   - Phone, Email (optional but useful)
6. Click "Save"
7. Confirm success (look for toast message)

### Create a Contact

1. Navigate to Contacts via App Launcher
2. Click "New"
3. Fill: First Name, Last Name, Account (lookup), Phone, Email
4. Save

### Create an Account

1. Navigate to Accounts via App Launcher
2. Click "New"
3. Fill: Account Name, Phone, Website, Industry
4. Save

### Update a Record

1. Navigate to record via search or direct URL
2. Click "Edit" (or inline edit)
3. Modify field(s)
4. Save
5. Confirm success

### Search for Records

1. Click global search bar (top of page)
2. Type search term
3. Press Enter or click search
4. Filter by object type if needed
5. Click result to open

## Lightning Experience Tips

- **App Launcher:** 9-dot grid icon, top-left
- **Global Search:** Search bar at top center
- **Navigation:** Tabs across the top, may need "More" dropdown
- **Record Actions:** Buttons in top-right of record page
- **Inline Edit:** Click pencil icon next to field values

## Selectors Reference

Common patterns for Lightning:

- Search box: `button "Search"` or combobox with search
- App Launcher: `button "App Launcher"`
- New button: `button "New"`
- Save button: `button "Save"`
- Object items in search: `option "Leads"`, `option "Contacts"`, etc.

Use `snapshot` with `interactive=true` to get clickable refs.

## Error Handling

- **Login failed:** Check credentials in TOOLS.md, may need security token appended to password
- **Session expired:** Re-run login flow
- **Record not found:** Verify search term, check permissions
- **Field not editable:** May be formula/read-only field

## Notification Templates

### Success SMS

```
✅ Done! Created lead {Name} at {Company} in Salesforce.
```

### Failure SMS

```
❌ Couldn't create the lead: {brief reason}. You may need to do this manually.
```

### Update Success

```
✅ Updated {record type} {name}: {what changed}
```

## Security Note

Credentials are stored locally in TOOLS.md. Never expose credentials in logs or responses. Don't include passwords in SMS notifications.
