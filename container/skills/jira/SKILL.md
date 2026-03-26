---
name: jira
description: Manage Jira issues via the Atlassian MCP server. Search, create, update, comment on, and transition issues. Used when Steffen asks about Jira or when the daily digest task fires.
allowed-tools: mcp__jira__*
---

# Jira

Jira tools are available as `mcp__jira__*` via the mcp-atlassian server. Use them directly — no curl, no manual auth.

## Key tools

| Tool | When to use |
|------|-------------|
| `mcp__jira__search_jira_issues` | Search by JQL — use this for digests and open-ended queries |
| `mcp__jira__read_jira_issue` | Fetch a single issue by key (e.g. `PROJ-123`) |
| `mcp__jira__create_jira_issue` | Create a new issue |
| `mcp__jira__add_jira_comment` | Add a comment to an issue |
| `mcp__jira__list_jira_projects` | List all visible projects |
| `mcp__jira__get_my_unresolved_issues` | Quick shortcut — Steffen's open issues |
| `mcp__jira__transition_jira_issue` | Move issue to a new status by name. Names are localized (German: "Fertig" = Done, "In Arbeit" = In Progress, "Zu erledigen" = To Do). If unsure, use `read_jira_issue` first — it lists available transitions. |
| `mcp__jira__get_jira_current_user` | Get current user details |

## JQL patterns

```
# Open issues assigned to Steffen
assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC

# Recently updated issues in a project
project = PROJ AND updated >= -7d ORDER BY updated DESC

# Issues by status
project = PROJ AND status = "In Progress"
```

## Daily digest format

Group issues by project, then by priority within each project. For each issue show: key, summary, status, and last updated. Keep it brief — Steffen wants a quick overview, not full descriptions.

## First-time setup

Check `/workspace/ipc/current_tasks.json` — if a task with id `jira-daily-digest` already exists, skip. Otherwise, create it via IPC `schedule_task`:
```json
{
  "type": "schedule_task",
  "taskId": "jira-daily-digest",
  "targetJid": "<this group's chat JID>",
  "prompt": "Jira daily digest. Search for open issues assigned to Steffen using JQL: assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC. Format a brief summary grouped by project. Send it to Steffen. If there are no open issues, send: 'No open Jira issues.'",
  "schedule_type": "cron",
  "schedule_value": "30 7 * * 1-5",
  "context_mode": "group"
}
```
