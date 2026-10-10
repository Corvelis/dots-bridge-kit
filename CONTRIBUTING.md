# Development

Use Node.js 24 LTS and npm ci. Before submitting a change, run npm run typecheck, npm test, npm run build, and npm run release:check.
New source files must be reviewed and added explicitly to release-files.json. An unlisted file fails the release check; it is never included automatically.
Tests use local mock servers and synthetic audio. Do not make automated tests send messages to a real Dot or start a real call.
On macOS, run npm run build:native when changing the Swift audio/ASR helpers. See [the build and release guide](docs/publishing.md) for packaging commands.

Keep settings and output under ignored directories. Do not add personal IPs, Dot identifiers, machine paths, credentials, conversation history or raw recordings.
Do not include personal names, email addresses or local project identifiers. Privacy-test samples must be synthetic and constructed at runtime. Check errors must not print the matched value.
Update the corresponding setup/control/protocol documentation when behavior changes.
