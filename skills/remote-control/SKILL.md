---
name: remote-control
description: Enable, show, or stop phone access to the current local Codex chat through the Codex remote bridge.
---

# Remote control

Use the bridge checkout at `~/Developer/codex-remote`, or the path the user configured when installing it. Act on the current `CODEX_THREAD_ID`, never a guessed or most-recent thread.

- Enable: run `node ~/Developer/codex-remote/control.mjs enable`. Check `http://127.0.0.1:8765/health` for `ready` and `wake`. If the installed service is down, start its LaunchAgent and recheck.
- Show link: run `node ~/Developer/codex-remote/control.mjs link "$CODEX_THREAD_ID"`.
- Stop this chat: run `node ~/Developer/codex-remote/control.mjs disable "$CODEX_THREAD_ID"`. Confirm the service releases its wake assertion if no chats remain.

For enable or show, include the full **Phone URL** from the command output as a clickable link in the chat reply. The private Tailscale `/remote` address is one bookmark for all enabled chats; `/remote/<thread-id>` opens one. Both require the Mac owner's Tailscale login. If that route cannot authenticate the phone, share the printed Fallback URL instead, treating it as a secret that rotates after disable or expiry. Never publish a fallback URL or API key. The bridge queues follow-ups and does not yet steer an active Desktop turn or handle approval prompts.
