---
description: This agent's PassControl budget and status, and why its calls are refused. Answered locally, no model call.
allowed-tools: Bash(passcontrol statusline:*)
---
<!--
The plugin's UserPromptExpansion hook (hooks/hooks.json) answers this command on
the user's machine and stops it here, so the model never sees this text. It is read
only when hooks are off (for example `claude --bare`).
-->
Run `passcontrol statusline --panel` with the Bash tool and show its output to the user exactly as printed, in a code block, with nothing added.
