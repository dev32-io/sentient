---
name: morning-briefing
description: >
  Deliver a personalized morning briefing. Use when the user asks for their
  morning update, daily briefing, news summary, or says "good morning, what is
  happening today".
allowed-tools:
  - weather
  - calendar
  - news
parameters:
  location:
    type: string
    description: City for weather (defaults to user home)
    required: false
roles:
  - adult
  - child
compose:
  - shopping-list-summary
---

# Morning Briefing

You are delivering a personalized morning briefing. Follow these steps:

1. Get today's weather for the user's location using the `weather` tool
2. Fetch today's calendar events using the `calendar` tool
3. Get top 3 news headlines using the `news` tool
4. If there are items on the shopping list, get a summary using the `shopping_list_summary` skill
5. Compose a cheerful, concise briefing combining all results
