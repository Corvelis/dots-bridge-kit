# Changes

## 0.1.0 public release kit

- Configurable Dot URL and Mac host, one public bridge port and one start/stop command.
- Authenticated WebSocket APIs for custom apps and devices; the included Even G2 app uses the same text, ASR and voice-call interfaces.
- Installable shared Chrome extension ZIP, with the selected Dot URL read from saved Mac settings and native-host authorization preserved during upgrades.
- Runtime phone pairing, with no token embedded in the G2 package.
- Standalone Dots ASR/text service with transcript review and displayed Dot replies.
- Call recovery and bounded PCM audio queues.
- Dots Phone G2 0.2.25 with saved connection, input-mode, temple-role, character, history-limit and display settings.
- Voice-to-text input, a fixed character and 30-second display timeout on first launch.
- Right-temple double tap to end an owned active call while the display is awake.
- Dot and user messages in the actual Chrome conversation order, without duplicate ASR drafts.
- History browsing while waiting for a Dot reply, with the selected message and page preserved.
- While an ASR draft is displayed for confirmation, hold either G2 temple or R1 to send; double tap to discard and keep the display awake. Other states retain their usual controls.
- Chrome extension ZIP, source ZIP, compiled Apple Silicon Mac runtime ZIP and checksums; G2 packages are generated for each user's Mac endpoint.
- Setup, controls and API documentation, with G2 and phone screen examples.
- Guided setup, connection diagnostics and background start/stop commands.
- Tailscale/VPN setup for access away from home, including the Mac endpoint, G2 package updates and a mobile-data connection check.
