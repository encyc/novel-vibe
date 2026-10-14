# Contributing to Novel Vibe

Thanks for your interest in Novel Vibe. This document covers the contribution
process and, importantly, the licensing terms that apply to your
contributions.

## Before you start

- Read [`AGENTS.md`](AGENTS.md) for architecture, commands, service ports, and
  ownership boundaries. It is the single source of truth for how this codebase
  is organized.
- Read [`docs/development-workflow.md`](docs/development-workflow.md) for the
  default change order and the per-area ownership guide.

## Scope of this repository

This repository is the public source tree and the development repository for
Novel Vibe: community pull requests land here. It contains everything needed to
reproduce, build, run and test the product — the application packages and their
tests, the application database schema and its migrations, the architecture
documentation and decision records, the CI workflows, and the public-repository
hygiene check.

Some material is deliberately not published:

- production identifiers and credentials — server addresses, deployment
  secrets, certificates and private keys — which must never be in a public tree;
- deployment, hosting and release operations — the production compose setup,
  TLS and server lifecycle, desktop signing/notarization and release promotion,
  search-console submission;
- internal design, planning and commercial material.

Hosted operations are maintained in a separate, private operations repository,
and nothing here depends on it: self-hosting needs only this repository plus the
public InsForge fork that `make setup` clones. The self-hosting walkthrough is
[`docs/self-hosting.md`](docs/self-hosting.md).

Please keep contributions inside the published surface: do not add references to
private material, production identifiers or credentials. If a change also needs
an unpublished step (a deployment or infrastructure change, for example),
describe it in the issue or pull request and leave that part to the maintainer.

## Development workflow

1. Open an issue or start a discussion before large changes, so the design can
   be agreed on first.
2. Keep changes scoped to the package that owns the behavior. Do not add
   product business logic to `packages/novel-desktop`, and do not bypass the
   Web BFF / Agent Server boundary.
3. Add focused tests at the boundary you changed.
4. Run the package check, then the full production check:

   ```bash
   npm run check:agents
   npm run check:web
   npm run check:webui
   npm run check
   ```

   CI order is typecheck first, then tests; both must pass.
5. `webui-dist/` is generated build output, not source: it is not part of the
   published source tree, and a contribution never needs it. Build it locally
   with `make build-webui-dist` only if you want to run the prebuilt UI. See
   "WebUI Build and Deployment Boundary" in [`AGENTS.md`](AGENTS.md) for how the
   artifact is produced and served.
6. Update current documentation when APIs, deployment, or ownership boundaries
   change.

Do not commit build artifacts — `webui-dist/` is generated output that the
published tree does not carry; build it locally when needed (see step 5) — and
do not commit secrets (`.env*` files are gitignored on purpose).

## Sign-off (DCO)

This project uses the [Developer Certificate of Origin (DCO) 1.1][dco] instead
of a Contributor License Agreement. There is nothing to sign and no form to
submit: sign off your commits with `git commit -s` (or add the trailer
manually), which appends a line like:

```
Signed-off-by: Your Real Name <your.email@example.com>
```

Use your real name and an email address you can be reached at. The sign-off
must be present on every commit in a pull request. To sign off a commit you
already made, use `git commit --amend -s` (or `git rebase --signoff` for a
branch).

By signing off, you certify the following:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license file, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

[dco]: https://developercertificate.org/

## Licensing of contributions

Novel Vibe is licensed under the [Apache License, Version 2.0](LICENSE). There
is no separate CLA.

By submitting a contribution (for example, a pull request, patch, or any other
form of change) to this project, you represent that:

1. You have the right to submit the contribution, and you are legally entitled
   to grant the rights described here — either because you authored it, or
   because you received it under terms that permit it (see the DCO above).
2. You agree that your contribution is licensed to the project and to everyone
   who receives it under the **Apache License, Version 2.0**, the same license
   that covers the project (inbound = outbound). No additional terms are
   imposed on your contribution.
3. You agree that your contribution is provided **on an "AS IS" basis, without
   warranties or conditions of any kind**, as described in Sections 7 and 8 of
   the Apache License, Version 2.0.
4. You understand and agree that a record of your contribution — including the
   sign-off name, email address, and commit metadata — is maintained
   indefinitely and may be redistributed consistent with the Apache License,
   Version 2.0.
5. You retain copyright on your contribution. You are not assigning copyright
   to the project; you are licensing it under Apache-2.0.

Contributions that add or modify third-party code must keep that code's
original license headers and attribution intact, and must be clearly identified
in the pull request. Do not paste code whose license is incompatible with
Apache-2.0.

## License

Novel Vibe is licensed under the [Apache License, Version 2.0](LICENSE). The
license permits commercial use, modification, redistribution, and self-hosting,
**including running the software as a hosted service for others**. In return it
requires that you keep the copyright notices and the [`NOTICE`](NOTICE) file
with redistributions, and that you state significant changes you made.

The license grants rights; it does not impose any obligation to publish your
changes or to fund the project. Running a hosted instance of Novel Vibe, with
or without modifications, is permitted and does not require permission,
payment, or an agreement with the maintainers.

`lingqiai.art` (and `app.lingqiai.art`) is a hosted instance operated by the
project author. It is a convenience offering, not a licensing condition: the
rights the Apache-2.0 license grants you are independent of that service, and
you may self-host the software instead. Nothing about using, forking, or
self-hosting Novel Vibe requires using the author's hosted instance.

Third-party dependencies included in or referenced by this repository keep
their own licenses; see [`NOTICE`](NOTICE) for how this project's own license
relates to separately managed dependencies such as InsForge.
