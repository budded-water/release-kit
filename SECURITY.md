# Security

Do not include credentials, private application data, screenshots, account configuration or operational journals in public issues or pull requests. Report suspected credential exposure or authorization bypass privately to the repository owner through an existing private channel.

Project modules and build commands are trusted executable input. Never run an untrusted PR on a credential-bearing release machine. This tool's locks coordinate cooperating workers; they do not defend against arbitrary same-user filesystem writes. Unknown provider responses are not permission to repeat publication.

Raw provider/tool diagnostics, where enabled, are private and bounded. Inspect and redact them before sharing. The tests use synthetic accounts and generated test credentials; no live provider acceptance is implied.
