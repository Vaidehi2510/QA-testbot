# Contributing to the Patchsentry QA engine

Thank you for helping make QA reproducible and accessible. Start with the
[reviewer quick-start](docs/reviewer-quickstart.md) and the [README](README.md).
You can contribute without an AI key or a company repository.

## Find a useful first contribution

Look for a `good first issue` with a small, verifiable outcome. Useful contributions
include clearer setup instructions, a reproduction on another operating system,
a keyboard/accessibility review, a synthetic test case, or a focused bug fix.
If a label is not available, ask about a task in an issue. Explain the environment,
what you tried, and what would make the experience clearer.

## Repository map

- This repository: execution engine, deterministic checks and optional AI review.
- [Website](https://github.com/Vaidehi2510/patchsentry-web): account/project setup,
  model settings, queued work and authenticated reports.
- [Optional Java Ledger](https://github.com/Vaidehi2510/Patchsentry-Ledger-Java):
  separately deployed report/archive service.

## Local setup

Use Node.js 24, npm and Git. From your own clone:

```sh
npm ci --ignore-scripts
npm run demo
npm run demo:ai
```

Both demos use synthetic source and real fixture assertions. AI replies and
external GitHub/Slack/Drive operations in the demos are explicitly mocked. No
account, API key, browser download or Docker service is needed for this path.

For relevant engine changes, run the affected `test/*.test.js` files with
`node --test test/FILE.test.js`. The general suite is `npm test`; it also needs
Python 3 and standard `zip`/`unzip` utilities. Real browser checks and the two
framework-container checks require the explicit flags, browser installs and
prepared Docker image shown in [.github/workflows/check.yml](.github/workflows/check.yml).
Skipped opt-in checks are not successful integration tests. The public image
recipe is in [tools/test-image](tools/test-image); dependency preparation happens
outside the offline product-test runtime.

The disabled QA controller is an operational choice. Do not enable schedules or
change production connections to demonstrate a contribution.

## Propose and submit a change

1. Search this repository's issues for related work. For a substantial change,
   describe the problem and proposed scope in an issue before investing much time.
   Small fixes can go straight to a pull request.
2. Fork the repository, create a focused branch, and keep unrelated changes out.
3. Explain the user-visible problem, the resulting behavior and the checks you
   actually ran. If a check was not run, state that and why.
4. Include reproduction steps and synthetic evidence for a bug. For UI changes,
   check keyboard use and a narrow viewport; include a screenshot when useful.
5. Respond to review questions and credit anyone whose work informed the change.

A maintainer reviews scope, behavior and evidence before merging. Review is
best-effort; there is no promised turnaround. Contributors are not expected to
configure paid services or obtain production credentials to propose a change.

## Choose checks that match the change

For wording or policy edits, check links, commands and formatting; a full
application test run is usually unnecessary. For behavior changes, run the relevant
existing tests and add a regression only when it verifies the behavior at risk.
Run the repository's required CI checks before relying on a release. Passing
fixture tests does not prove live-provider interoperability, whole-product test
coverage or staffing savings.

Use synthetic accounts and disposable environments. Never commit `.env` files,
tokens, private repository content, customer reports, screenshots containing real
user data, or production database exports. Do not start paid model/device sessions,
send notifications, or enable production schedules as part of ordinary testing.
The QA bot's product-source access must remain read-only; proposed fixes and tests
must not silently edit, push to or merge a connected product repository.

If an AI tool assisted, briefly describe its role and how you checked the result.
Label mocked model responses and integrations. You are responsible for reviewing
the submitted code and its claims; an automated agent role is not evidence of
participation by another person.

## Community, security and license

Follow the [code of conduct](CODE_OF_CONDUCT.md). Report possible vulnerabilities
using [SECURITY.md](SECURITY.md), rather than a public issue containing an exploit
or sensitive data. General project questions can use a public issue, or
[patchsentry@gmail.com](mailto:patchsentry@gmail.com) when they need to be private.

Contributions are submitted under this repository's [MIT License](LICENSE).
Keep any third-party copyright and license notices with their material. Identify
external code/assets and their source so a maintainer can review compatibility.
