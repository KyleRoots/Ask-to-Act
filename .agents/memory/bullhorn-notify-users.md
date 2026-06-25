---
name: Notify users = Task, not the bell
description: Why "notify a Bullhorn user" is implemented as a Task assignment, not the in-app notification feed.
---

# Notifying Bullhorn users

The rule: to alert specific Bullhorn users from the API, assign them a **Task**
(owner = first user, the rest as `secondaryOwners`) with an optional
`notificationMinutes` reminder. There is no API path to the in-app notification
bell.

**Why:** Bullhorn's in-app notification feed (the bell icon) is powered by a
private internal API (`UserMessage` / `bhInternalApi`). Live probes returned
`404` for the `Notification` entity and `403 "feature not enabled"` for
`UserMessage` — that surface is closed to **every** API integration, not just
ours. Faking a bell notification would violate the product's "never silently
substitute a wrong action" principle, so we expose the genuine, supported
equivalent (a Task on the user's list) and say so plainly in the tool copy.

**How to apply:**
- `Task` has `owner` (TO_ONE CorporateUser), `secondaryOwners` (TO_MANY
  CorporateUser), `childTaskOwners` (TO_MANY), and `notificationMinutes`
  (Integer). Multi-user alerts = owner + secondaryOwners.
- TO_MANY associations are set AFTER create via a **bodyless** POST
  `entity/Task/{id}/secondaryOwners/{csvIds}` (same pattern as tearsheet
  membership). They are not reliably accepted inside the create body.
- The create-then-associate sequence is non-atomic: if the association fails the
  Task already exists, so return a partial result (taskId + warning), don't throw
  and hide the created task.
- Validate target IDs by querying the explicit ID set
  (`id IN (...) AND isDeleted=false`), not a capped directory page — a fixed
  `count` page false-negatives valid users in large firms.
- A calendar `Appointment` invite is a second genuine "ping these users" path if
  Tasks aren't the right fit.
