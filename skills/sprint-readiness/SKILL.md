---
name: sprint-readiness
description: Score backlog items against a Definition of Ready before Sprint Planning and write one readiness report, without touching any of the items. Use when someone says "check the backlog", "are we ready for planning", "is this PBI ready", "run sprint readiness", or invokes /sprint-readiness. It only proposes. It never edits an issue, adds a label, or moves anything into a sprint.
---

# Sprint readiness

Judge whether the work your team calls ready is ready to be planned, and report it as one artifact a person can review.

## Configure it

Edit these before the first run.

| Setting | Example | What it is |
|---|---|---|
| Board owner | `OWNER` | The GitHub org or user that owns the Projects v2 board |
| Project number | `38` | The number in the board's URL |
| Ready status | `Backlog - Ready` | The status your team uses for "ready to plan", exactly as stored, emoji included |
| Triage status | `Needs Triage` | Where new, unsorted issues land |
| Report folder | `~/.claude/state/sprint-readiness/` | Where reports are written |

## The rule that matters

You have write access to these issues. Do not use it.

No edits, no labels, no milestone changes, no closing, no assigning. The only thing you produce is one report. The Product Owner decides what enters the sprint.

This restraint is what makes the skill safe to run unattended.

## Step 1: Get the candidates

Filter on the server so you read the pool and not the whole board:

```bash
gh project item-list <PROJECT_NUMBER> --owner <OWNER> --format json --limit 400 \
  --query 'status:"<READY STATUS>"'
```

Three things trip this up:

1. The `--query` value must match the stored status string exactly. If your statuses carry emoji, the emoji is part of the string, and leaving it out returns zero items. A zero result usually means the filter is wrong.
2. `gh project item-list` truncates without warning. If the number of items returned equals `--limit`, you were cut off. Raise the limit and read again rather than scoring part of the pool.
3. The sprint field is an iteration object. Read `sprint.title`, not `sprint`.

**The default job is to audit the Ready column.** Those are the items the team has already declared ready, so scoring them asks whether that marker is telling the truth. On a real board a large share of "ready" items had no estimate at all.

Other pools:

| Pool | When |
|------|------|
| Ready status | Default. Audits the team's own marker |
| Triage status | Only when asked. It is a triage backlog, not a planning list |
| Named issue numbers | When the user names them. Read each with `gh issue view` for the full body |

## Step 2: Score each item

Every criterion is pass or fail, with no partial credit.

| Criterion | Passes when |
|-----------|-------------|
| **Pain** | The item says who hurts and how, as well as what to build |
| **Approach** | There is a stated approach, not only a desired outcome |
| **Acceptance criteria** | You could tell from the item alone whether it is done |
| **Sized** | The board's estimate field is set. Read the field rather than judging |
| **Sprint-sized** | The estimate is small enough to finish inside one sprint |
| **Dependencies named** | Any blocking work is identified |

An item is **Ready** only when all six pass.

Length is not the test. A short item can pass everything, and a long one can still leave you unable to say when it is done.

## Step 3: Look across items

Scoring one item at a time misses these, so report them separately:

- Two candidates that depend on each other
- An item blocked by work that is not tracked anywhere
- Several items landing on the same file, service or person
- An item that duplicates something already closed

Check closed issues before you call an item Ready. A "Ready" item that shipped two sprints ago does more harm than one marked Not ready.

## Step 4: Write one report

Write `readiness-<repo>-<date>.md` to the report folder:

- A table with the item, Ready or Not ready, and the failing criteria
- A short "across the backlog" section for anything from step 3
- Nothing else. Make no recommendation about what to commit to

```
| #    | Item                     | Status    | Missing              |
|------|--------------------------|-----------|----------------------|
| 1201 | CSV export timeout       | Ready     | -                    |
| 1188 | Settings page cleanup    | Not ready | acceptance criteria  |
```

Offer to open the report as an issue only if the user asks.

## Step 5: Say what you did not check

If an item was unreadable, the board order was unavailable, or you could not tell whether something duplicates closed work, say so in the report rather than scoring around it.

## Human checkpoint

The Product Owner reads the report and decides what enters the sprint. Nothing in this skill changes the backlog.

---

Written by Eli Kent for the talk "Becoming an Agentic Scrum Master". The Definition of Ready it scores against follows SSW's rule: https://www.ssw.com.au/rules/have-a-definition-of-ready
