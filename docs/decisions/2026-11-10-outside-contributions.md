# Outside contributions arrive as gated pull requests with an automatic first review

Date: 2026-11-10
Owner ruling: approved on 2026-11-10 in a planning task; no issue was created.

Decision: once the repository is public, anyone may open a pull request. Each one passes these gates in order: the maintainer bot fetches the change as text and a model with no tools writes a first review; the owner reads the review and the change; checks run on GitHub's hosted machines only after the owner approves the run; only the owner merges.

Reason: outside contributions are a purpose of opening the repository, and the existing maintainer bot already reviews pull requests this way, so nothing new has to be built first. The gates keep outside code off the owner's machines and out of `main` until the owner decides.

Scope: the automatic review is advice. It never merges, approves a workflow run, or triggers a build, and a passing review does not replace the owner's own reading. Outside code never runs on the owner's computers or on a self-hosted runner. The reviewing model gets no tools, no network and no write access. Contributors accept the contribution rules, the code of conduct and the contributor agreement. Restricting pull requests to collaborators and fetching from forks instead stays a later option. The contributor agreement mechanism (CLA assistant, bot-reported status or DCO) is not decided here.

Replaces: none. See the [contributing guide](../../.github/CONTRIBUTING.md).

Partly replaced on 2026-11-22: for pull requests that meet [scheduled merges](2026-11-22-scheduled-merges.md), the owner's maintainer agent reviews, approves the hosted run and merges.
