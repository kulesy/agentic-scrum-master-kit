# Backlog Refinery

A small local web app for refining a GitHub Projects v2 backlog. It deals the cards in your Needs Triage column one at a time. Each card answers one question: is this item ready to build?

Readiness uses four checks from a Definition of Ready: Detail (acceptance criteria), Priority, Effort (an estimate) and Approved (your click). Under each unmet check, an agent's draft waits for you to accept, edit or skip.

## The rule

The app never writes to GitHub. It records your decisions in `data/` and writes `data/plan.json` and `data/PLAN.md`. A Claude session reads the plan, applies it to the board, and shows you any text before it posts. Nothing in this repo applies the plan.

## Run it

You need Node 20 or later and the GitHub CLI, signed in with the `project` scope (`gh auth refresh -s project`).

    cp config.example.json config.json    # then edit it
    node server.mjs                       # or npm start, or bin/refinery

Open http://localhost:4380. `bin/refinery` starts the server in the background and opens the page.

## Fill in config.json

Set `owner` and `projectNumber` (`gh project list --owner <owner>` shows the number). Set `statuses` to the columns to read. Spell each one exactly as the board does, emoji included, because `gh` returns nothing for a name that does not match.

The ids below are for the Claude session that applies your plan. The server does not read them.

    gh project view <number> --owner <owner> --format json --jq .id
    gh project field-list <number> --owner <owner> --format json \
      --jq '.fields[] | select(.name=="Status" or .name=="Estimate") | {name, id, options}'

The first command gives `projectId`. The second gives `fields.status` and `fields.estimate`, and each `statusOptions` entry is an option id from the Status field.

`dor.gitmoji` (titles lead with a type emoji) and `dor.evidence` (usage and error data) switch on two optional checks. Both start off.

## Where the drafts come from

The app shows drafts and does not make them. It reads JSON files that an agent writes into `data/`. With an empty folder, each card says no agent pass has run.

- `suggestions.json`: per card (`repo#number`), an `action` (`set-estimate`, `rewrite-body`, `rewrite-and-estimate`, `close-not-planned`, `close-superseded`, `needs-decision`, `split`, `leave-as-is` or `verify-first`) plus `estimate`, `body`, `title`, `rationale` and `needs_info`. `BLANK` in `server.mjs` shows the main fields. `needs-decision` and `split` also use `recommended_decision`.
- `priorities.json`: per card, `suggested` (Urgent, High, Medium or Low), `confidence` and `reason`.
- `evidence.json`, `types.json`, `dupes.json`, `carry-drafts.json`: optional.

Two scripts fill the first file. `scripts/verify-ids.js` is a Claude Code workflow script. Pass `owner`, `ids` and optionally `clones` as args. One agent per card reads the issue and the code, and a skeptic tries to refute every "already fixed" claim. Then load the result:

    node scripts/load-verify.mjs results.json my-repo#12,my-repo#15 first-run

For priorities and the rest, give Claude a prompt like this:

> Read `data/board-snapshot.json`, which the server writes after its first fetch. For each card, read the issue, then draft a priority, an estimate and acceptance criteria. Write `data/priorities.json` and `data/suggestions.json` in the shapes the README describes. Write nothing to GitHub.

`node scripts/check-dor.mjs` prints how the cards fall into piles.

## From a phone over Tailscale

If the Tailscale CLI is installed and connected, the server also listens on this machine's tailnet address. From any device on your tailnet, open `http://<tailnet address>:4380`. `/healthz` answers `ok`. `tailscale serve` can mount the app under `/backlog-refinery/`, a prefix the server accepts. The server binds loopback and the tailnet address only, so other networks cannot reach it.

## Limits

- There is no login. Anyone who can reach the port can record decisions. Use loopback or a tailnet you trust.
- It reads at most 600 items per column and caches the board for 10 minutes. When a fetch fails, it serves the last snapshot.
- The code matches status names by pattern: `Triage`, `Backlog`, `Backlog - Ready` and `In progress`.
- Drafts made from issue text alone are a starting point. A code check often changes the answer.
- `?stage` deals only cards from the repos named in `stage.repos`, in larger type. It shows nothing until you set them.
- Built and used on macOS only.

Written by Eli Kent (SSW) for the talk "Becoming an Agentic Scrum Master".
