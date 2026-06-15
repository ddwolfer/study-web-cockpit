#!/bin/bash
# study-coach launcher (macOS / Linux)
#
# macOS equivalent of study-coach.cmd. Launches Claude Code with the study-web
# browser cockpit loaded as a channel. The --dangerously-load-development-channels
# flag is REQUIRED during the channels research preview to load a bare .mcp.json
# server (study-web) as a channel; plain "claude" will NOT push browser messages
# into the session.
#
# First time: make it executable →  chmod +x study-coach.command
# Then double-click in Finder, or run  ./study-coach.command
# After it starts, open http://127.0.0.1:7654 in your browser.
set -e
cd "$(dirname "$0")"
exec claude --resume "system_design_study" --dangerously-load-development-channels server:study-web "$@"
