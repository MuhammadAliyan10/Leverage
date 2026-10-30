# Security policy

Leverage handles private financial information. Please report suspected vulnerabilities responsibly and avoid exposing personal or financial records while investigating.

## Supported versions

Until the project publishes tagged releases, security fixes target the latest code on the `master` branch. Once releases are tagged, this policy will be updated with supported versions.

## Reporting a vulnerability

Please do not report security vulnerabilities in a public issue or pull request. Use GitHub’s **Report a vulnerability** / private security advisory feature for this repository if it is enabled. If it is unavailable, contact the repository owner through a private GitHub channel and request a secure reporting path.

Include a concise description, impact, affected version/commit, and reproducible steps. Use synthetic accounts and data. Do not attach real transaction histories, database dumps, credentials, tokens, or unredacted screenshots. You may encrypt sensitive details using a maintainer-provided channel after contact.

The maintainers will acknowledge reports, investigate, and coordinate a fix and disclosure timeline. Please give users reasonable time to update before publicly disclosing a confirmed issue.

## Credential exposure

If you discover a credential in Git history or a release artifact, treat it as compromised: revoke or rotate it first, then notify the maintainers privately. Removing it from the latest file does not remove it from old Git commits or built apps.
