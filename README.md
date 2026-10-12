# Agentic Scrum Master kit

The skills and the app from my talk "Becoming an Agentic Scrum Master" at the SSW Melbourne .NET User Group on 21 October 2026. I use them to hand the glue-work of a Scrum Master to agents, and I keep the calls that matter for myself.

The slides are in [docs/becoming-an-agentic-scrum-master.pdf](docs/becoming-an-agentic-scrum-master.pdf).

## The rule

The more an agent can change, the closer I watch it.

- An agent that only reads can run alone, on a schedule.
- An agent that writes gets a draft, and I approve it before anything changes.

Every piece below follows that rule.

## What is here

| Demo in the talk | When it runs | What it does | Where I sit | In this repo |
|---|---|---|---|---|
| 1. Sprint Readiness | Before planning | Drafts each backlog item against the Definition of Ready | I accept or skip every item | [backlog-refinery/](backlog-refinery/) and [skills/sprint-readiness/](skills/sprint-readiness/) |
| 2. Sprint Pulse | Every weekday morning | Reads the board and who is on the project, and tells me what changed | Asleep. It only reads | [skills/sprint-pulse/](skills/sprint-pulse/) |
| 3. Sprint Review | End of sprint | Drafts the review and the forecast into a TinaCMS site | I edit it in TinaCMS and send it | The site starter: https://github.com/tinacms/sprint-review-starter |

### Backlog Refinery

A small Node app that shows a GitHub Projects board's triage column one card at a time. Each card carries an agent's draft: an estimate, a priority, acceptance criteria and a better title. I edit the draft, then accept or skip it. The app writes decisions to disk and never touches GitHub. A Claude session applies the plan afterwards, with me watching. See [backlog-refinery/README.md](backlog-refinery/README.md).

### Sprint Readiness skill

Audits the items your team has already marked ready and reports which ones are missing an estimate, acceptance criteria or a named dependency. It writes one report and changes nothing.

### Sprint Pulse skill

The morning check. It compares the board with yesterday and stays quiet when nothing changed. When something did, it sends one report covering refinement, who is on the project day by day, the burnup and the next steps, each with an owner.

### The sprint review site

A Next.js and TinaCMS starter where each sprint's review and forecast is a page you edit in the visual editor. The page is also the email: Copy for Email puts it on the clipboard with the layout intact. The routine that drafts into it belongs to SSW's internal skills, so it is not in this repo.

## Start on Monday

1. Pick the most boring thing you do.
2. Write down the steps you already follow.
3. Save it as a skill, and run it read-only first.
4. Give it a schedule. Let it write last, behind a review.

To try a skill from here, copy its folder into `~/.claude/skills/`, fill in the settings at the top of its `SKILL.md`, and ask Claude Code to run it.

## About

Eli Kent, Scrum Master for TinaCMS and TinaCloud at [SSW](https://www.ssw.com.au).
