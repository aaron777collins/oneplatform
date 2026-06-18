# Community and Getting Help

## Discussion categories

OnePlatform uses [GitHub Discussions](https://github.com/aaron777collins/oneplatform/discussions)
as its community forum. Four categories are configured:

| Category | Purpose | Who starts them |
|----------|---------|-----------------|
| [Q&A](https://github.com/aaron777collins/oneplatform/discussions/new?category=q-a) | Questions about setup, connectors, pipelines, the SDK, CLI, or any other usage question | Anyone |
| [Ideas](https://github.com/aaron777collins/oneplatform/discussions/new?category=ideas) | Early-stage feature proposals that need community feedback before a formal issue | Anyone |
| [Show & Tell](https://github.com/aaron777collins/oneplatform/discussions/new?category=show-and-tell) | Plugins, apps, integrations, and deployment setups built with OnePlatform | Anyone |
| Announcements | Release notes, breaking changes, and project updates | Maintainers only |

Subscribe to the Announcements category to receive notifications about new releases and
important changes.

## Where to go for what

### "I have a question"

Open a [Q&A discussion](https://github.com/aaron777collins/oneplatform/discussions/new?category=q-a).
Use the template — it prompts for the version, deployment method, and what you already tried.
This context lets the community answer without a round-trip.

Search existing discussions first. Your question may already be answered.

### "I found a bug"

Open a [Bug Report issue](https://github.com/aaron777collins/oneplatform/issues/new?template=bug_report.md).
Include exact steps to reproduce, expected vs. actual behavior, and your environment.

If you are not sure whether something is a bug or a misconfiguration, start with a Q&A
discussion. The maintainers will convert it to a bug report if needed.

### "I have an idea for a feature"

Open an [Ideas discussion](https://github.com/aaron777collins/oneplatform/discussions/new?category=ideas).
Describe the problem first, then your proposed solution. Community discussion happens before
a formal Feature Request issue is opened — this prevents large pull requests being blocked
on architectural feedback late in the process.

For changes that affect a public API, database schema, or cross-service contract, propose
an Architecture Decision Record (ADR) update in the discussion before writing code.

### "I built something"

Open a [Show & Tell discussion](https://github.com/aaron777collins/oneplatform/discussions/new?category=show-and-tell)
and share what you built, how it works, and any links to code or demos. No project is too
small.

### "I found a security vulnerability"

Use [GitHub's private security advisory workflow](https://github.com/aaron777collins/oneplatform/security/advisories/new).
Do not open a public issue — the vulnerability needs to be assessed and patched before
public disclosure.

## Contributing

See [CONTRIBUTING.md](https://github.com/aaron777collins/oneplatform/blob/main/CONTRIBUTING.md)
for the development setup, coding standards, and the pull request process.

The short version:

1. Fork the repo, branch from `main` using the `feat/`, `fix/`, or `docs/` prefix.
2. Follow the [development pipeline](./development-process.md) for non-trivial changes.
3. Open a PR against `main` using the PR template; CI must be green before requesting review.
4. For significant changes, discuss the design in Discussions or a draft PR **before** writing
   implementation code.
