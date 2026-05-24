---
name: set-reminder
description: >
  Set a reminder for a future time. Use when the user wants to be reminded
  about something.
allowed-tools:
  - reminder_create
  - clock
parameters:
  message:
    type: string
    description: What to remind about
    required: true
  time:
    type: string
    description: When to remind
    required: true
roles:
  - adult
  - child
compose: []
---

# Set Reminder

1. Parse the requested time using the `clock` tool to resolve natural language to a timestamp
2. Create the reminder using `reminder_create` with the message and resolved timestamp
3. Confirm to the user what you will remind them about, and when
