---
description: Post a new message in this device's HiveBoss room
argument-hint: "<text>"
---
The person typed /hiveboss:post: their go-ahead for this one post (no need to ask again).

Call `mcp__plugin_hiveboss_hiveboss__post_message` once with the person's text: $ARGUMENTS. Pass no room: it posts only into this device's linked room. Keep their words; mention people as `@Name` as shown in the room (at most 10). If there is no text, ask the person what to post; never write a post on your own.

- Posted: reply "Posted to #<room>: <link>" with the link the tool returns.
- A proposal ("This will notify all N members of #<room>. Send?"): the post would notify everyone and nothing was sent yet. Show that question to the person exactly as written and wait. Only after their own explicit yes, call `mcp__plugin_hiveboss_hiveboss__confirm_proposal` with its code and answer "yes"; otherwise answer "no". The typed command is not that yes. Asking cannot be turned off from here: if the person is tired of being asked, they can tell this computer's Bee to stop asking (or, where the HiveBoss app still shows Settings · Devices, turn it off for this device there).
- Refused (another room, rate limit, too many mentions, a secret, not allowed to notify everyone): say why in its words and stop.
