# Security reporting

## Report privately

Email **[patchsentry@gmail.com](mailto:patchsentry@gmail.com)** with the subject
`Patchsentry security report` and the affected repository/commit. Do not open a
public issue with a working exploit, credentials, private source, or customer data.
This documented email route does not depend on GitHub private reporting being enabled.

Please include:

- The affected component and exact commit/version, if known.
- A brief impact description and expected versus observed behavior.
- Minimal steps using synthetic data in a local/disposable environment you are
  authorized to test.
- Redacted evidence and any mitigation you have identified.

Do not send live tokens, passwords, customer records or unredacted production
screenshots. If you suspect a credential was exposed, tell the account owner through
an authorized private channel so they can assess revocation; do not test its access.

## Handling and scope

Reports are handled by the project maintainer as availability permits. No response
time, managed disclosure service, security certification or historical-release
backport commitment is promised. Include current `main` when a reproduction is
possible; maintainers will assess older versions case by case. Coordinate public
disclosure and a minimal reproduction privately while a reported issue is assessed.

The project uses explicit authorization boundaries and retained evidence, but
passing automated checks is not an independent security assessment. Use only
systems and data you have permission to test. Ordinary contribution/testing should
not enable production schedules, send real notifications or create paid model or
device sessions.

## Related policies

See [CONTRIBUTING.md](CONTRIBUTING.md) for safe local development and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for conduct concerns.

## Engine-specific concerns

Relevant boundaries include trusted runner allowlists, untrusted source and model
input, offline container execution, browser-origin/network restrictions, source
read-only mounts, token redaction, revision/artifact binding and truthful result
classification. Include whether a finding requires a locally enrolled runner or
applies to hosted execution. Never use another organization's private source for a
public reproduction.
