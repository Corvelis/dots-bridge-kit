# Local data and access

The pairing token permits text/call control of the configured Dot. Treat it as a credential.
setup creates a private .dots-bridge directory and owner-readable pairing/native-worker files.
The phone app stores the entered token in its local app storage; it is not built into the distributed source or G2 package.
ChatGPT cookies and login tokens are not read or exported.

Text delivery and notification history contain conversation text and stay under .dots-bridge.
Runtime diagnostics exclude pairing tokens, resume keys, message text and raw audio.
Raw ASR audio is temporarily written for local transcription and removed when transcription finishes.

Use a private LAN/VPN, or an appropriately configured TLS proxy. Plain ws:// has no transport encryption of its own.
Do not expose the public bridge port directly to the Internet. Internal workers listen only on loopback; the native Chrome routes are not forwarded by the public gateway and require their own generated credential.

Before sharing a reproduction, omit .env, .dots-bridge, build/dist directories, paired manifests, .ehpk files and logs.
For distribution, use the [release commands](docs/publishing.md) rather than archiving a configured folder. They use an explicit source inventory and check for credentials and personal information. Review any included documentation images for visible personal information as well.
