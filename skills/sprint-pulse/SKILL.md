---
name: sprint-pulse
description: Report what CHANGED on a GitHub Projects sprint board since the last run, grouped into Refinement, Bench, Pipeline health and Burnup, by diffing against a stored snapshot. Stays silent when nothing crossed a threshold. Use when asked to "run the pulse", "what changed", "morning brief", "anything I should look at", or via /sprint-pulse. Read-only: it never comments, assigns or pings anyone.
---

# Sprint pulse

By Eli Kent, from the talk "Becoming an Agentic Scrum Master" (SSW Melbourne .NET User Group, 21 Oct 2026). This is the public copy of the skill the author runs each weekday morning on a real sprint board.

Report what **changed** since the last run. Do not describe what the board looks like.

## Set up

1. Copy this folder to `~/.claude/skills/sprint-pulse/` and edit Config.
2. Reading a Project needs the `project` scope (`gh auth refresh -s project`).
3. Say "run the pulse". The first run writes a baseline and has nothing to diff.
4. Schedule it (see Scheduling).

The board needs a Sprint iteration field, a number field for estimates and a Status field. Bench is optional: with `capacity_source: none` the other sections still run.

## Config

```yaml
board_owner: OWNER              # org or user that owns the Project
board_owner_type: organization  # organization | user
board_number: 1                 # number in the Project URL
repos: [OWNER/REPO]             # PRs and CI are read from these
default_branch: main
sprint_field: Sprint            # iteration field
estimate_field: Estimate        # number field; absent means unestimated

# Status names, exactly as the board spells them (emoji included)
status_in_progress: "In progress"
status_in_review: "In review"
status_blocked: "Blocked"
status_done: "Done"
label_needs_refinement: "Needs Refinement"

# Standing items to ignore (match on title, never on number)
tracking_title_patterns: ["Support rota", "Tech debt allowance"]

# Thresholds
pr_waiting_hours: 48            # human, non-draft, no review
pr_abandoned_days: 30           # older is standing, never a delta
issue_fresh_days: 14            # only assigned issues touched this recently
idle_days: 3                    # In progress with no linked PR
oversized_points: 8
escalate_multiple: 2            # re-escalate past 2x a threshold, once per item
signal_cap: 5                   # items per signal, then "... and N more"
recommendations_cap: 3
recommendation_repeat_days: 7
graphql_floor: 300              # below this many points, skip the board
snapshots_kept: 30

# State, logs and optional inputs
state_file: ~/.claude/state/sprint-pulse/pulse-history.json
log_dir: ~/.claude/state/sprint-pulse/logs
burnup_chart_url: ""            # optional GitHub Insights chart
capacity_source: none           # none | browser-report | calendar | manual
```

The team table, needed when `capacity_source` is not `none`. It is the only place a display name is joined to a GitHub login.

| Name | GitHub login | Project days | Region |
|------|--------------|--------------|--------|
| Dev A | `dev-a` | Mon-Fri | Victoria |
| Dev B | `dev-b` | Tue-Fri | New South Wales |
| Dev C | `dev-c` | Mon, Wed, Fri | Queensland |

## The rules that matter

**A report that always fires gets muted.** If nothing crossed a threshold, say `Nothing to report.` and stop. Silence on a quiet day is this skill working.

**Read-only.** Never comment, request a review, move an item or ping anyone. That earns the right to run unattended.

**Never wait, never retry, never sleep.** If a source is rate-limited, unreachable or slow, report what you have and finish. "I'll pick this up when the budget recovers" is a failed run: the morning gets nothing.

## Step 1: Snapshot the board

Scope the read to the **current sprint**. An item In progress but tagged to an old sprint is rot, and rot belongs in a weekly review. Filter server-side with `--query`: on the board this was tuned against, the filtered read cost about 100 rate-limit points and the unfiltered one 1,800.

```bash
Q="gh project item-list $N --owner $OWNER --format json --limit 400 --query"
$Q 'sprint:@current status:"In progress","In review","Blocked"'   # active work
$Q 'no:sprint status:"In progress","In review","Blocked"'        # hygiene bucket
$Q 'sprint:@current'                                              # commitment
$Q 'sprint:@current status:"Done"'                                # burn so far
$Q 'sprint:@previous status:"Done"'                               # last sprint's delivery
# PRs are not sprint-scoped: a waiting PR blocks someone whatever sprint its issue is in
gh pr list --repo $REPO --state open --limit 100 --json number,title,createdAt,isDraft,latestReviews,author
gh run list --repo $REPO --branch main --limit 10 --json conclusion,workflowName,createdAt,headSha
```

Get sprint dates from the iteration field, because honest burn needs day N of M. Use `user(login:...)` for a user-owned board. `iterations[0]` is the active sprint.

```bash
gh api graphql -f query='query{ organization(login:"OWNER"){ projectV2(number:1){
  field(name:"Sprint"){ ... on ProjectV2IterationField {
    configuration{ duration iterations{ title startDate duration } } } } } } }' \
 --jq '.data.organization.projectV2.field.configuration.iterations[0]'
```

- **Truncation is silent.** If the returned count equals `--limit`, you were truncated.
- **Status values need the exact text**, emoji included. A zero result means the filter is wrong.
- **`sprint` is an iteration object.** Read `sprint.title`. Never hard-code a sprint number.
- **`estimate` is absent when unset.** Treat absent as unestimated. Summing with `or 0` turns an unestimated item into a free one.

**Check the rate budget first** (`gh api rate_limit --jq '.resources.graphql'`). Below `graphql_floor`, do not read the board and do not wait for the reset. Run the PR and CI queries (cheap REST calls on a separate budget), add `Board not read - GraphQL budget low, resets <time>.`, and **do not write a snapshot from a partial read**, or tomorrow reports the whole board as new.

From the hygiene bucket report only items touched within `issue_fresh_days`, under **"Active, not on the sprint board"**. They are real work someone forgot to tag.

**The roster comes from board assignees on active items**, not GitHub teams, which go stale. Unassigned items are invisible to any per-person signal, so never present the roster as complete.

## Step 2: Bench - who is leaving the sprint (best effort)

"Bench" is consultancy slang for people not booked on client work. Use it for any "who is available, and when" view. Bookings and leave are real impediments that nobody puts on the board.

**Pluggable source.** Read leave and client bookings from whatever your team uses (leave calendar, booking system, spreadsheet) and normalise each person to `name | onClient | daysUntilFree | daysUntilBooked | bookedDays | leaveDays | team`.

- **It must never break the run.** If the source is unreachable, report the `gh` signals and print `Capacity not checked.`
- **Run where the signed-in session is.** A headless `claude -p` job has no browser extension, so a browser-only source needs a desktop task or an interactive session.
- **Keep commercial detail out.** "On client, back in 3 days" is a sprint fact. Never print or store the client, the rate or the booking subject.

**Example source: a Power BI report read in Chrome.** Lessons that transfer:

1. Wait about 9 seconds after navigating, then **click "Refresh visuals"** and wait about 15 more. The first render can serve stale data under a header that claims it is current.
2. Canvas visuals defeat `get_page_text`. Use `read_page`, or select the visual, choose "Show as a table" (`alt+shift+F11`) and read the cells with `javascript_tool`.
3. Tables are virtualised and sorted by days until free, so people on client work sit at the bottom. Scroll the grid itself until the row set stops changing.
4. Sort and slicer changes persist per user, so reset to default afterwards. A default filter can hide a team member.

**Freshness: the tick test.** A "Data updated" header proves nothing. Countdowns must fall by one per elapsed day against the previous snapshot. All ticked means current (`lagDays` 0). None ticked means the source is a day behind: subtract 1 from each countdown and say so (`lagDays` 1). Some ticked means real booking changes. Cross-check your own row, which you can confirm from memory. If it disagrees, your row wins. A one-day error moves people's start dates.

**Gate: three outputs before any Bench line.** (1) The row count matches the previous snapshot's `rowsRead`, or the difference is explained: fewer rows means a partial scroll or a leaver, opposite conclusions. (2) The tick verdict is stated. (3) Return figures come from `daysUntilFree` only, because `bookedDays` is a total across the window, never a contiguous block. If any output is missing, print `Capacity not checked.` and stop. A partial read is worse than none, because the next full read makes old bookings look new.

**The Bench block is a standing roster, exempt from delta-only.** Print it whenever capacity was freshly read, sorted by `daysUntilFree` ascending, with every team member (a missing name looks like a missed read). One line each: `on client, back in N days`, `free now, on client in N days`, `free`, or `unavailable N more days` (say leave only if `leaveDays` backs it). Append `, project days <days> only` for part-timers. On a public holiday or leave day in the person's region, lead the line with it, client rows included.

Deltas go on top: `picked up N client days`, `starts client work in N days`, `has N days leave in the window`, `freed up N days`. A `lagDays` 1 read is headed `Bench (one day behind, figures corrected)` and has no deltas, because it cannot tell a real change from the lag.

**Part-timers and logins.** A free row says nothing about which days someone works on the project, so record schedules in the team table. Nobody is a reallocation target on a day they are not in. Logins cannot be derived from names, so the table joins them. Resolve a new person from their profile (`gh api users/<login> --jq '[.login,.name]|@tsv'`), never by guessing. Never silently drop an unmapped row: print `<name> - going out, board identity unknown, work not checked`. A silent drop reads like "holds nothing", the one wrong answer this signal can give.

### Leaving the sprint

`Dev B - free now, on client in 1 day` is half a signal. The other half is what that person holds when they go. For each person whose availability got worse (newly on client, `daysUntilBooked` 0-2, booked or leave days up), list their current-sprint items that are not Done, with estimates, In progress first, because work in flight is what strands. Rank people by points held and cap at 3. **State what is at risk, never what to do about it**: reallocation belongs in Recommended next steps. **Say zero out loud** ("holds nothing on the sprint"). When work needs a new home, name who is free, filtered by project days.

### The sprint window, day by day

The bench cannot say which days someone is out. Read the per-day source and show today through the end of next week: one row per person, one cell per workday. Cells are `in`, `C` (client), `L` (leave, public holidays included) and `off` (not a project day, per the team table, whatever the source says). Never put a client name in it.

Render it with `bench-grid-widget.html` when your environment can show HTML widgets, otherwise print the text grid. Never print both. The text grid also goes in the log.

```
                 Wed Thu Fri | Mon Tue Wed Thu Fri
Dev A             C   C   C  |  .   .   C   C   C
Dev B             .   .   .  |  -   .   .   .   .
. in   C client   L leave   - not a project day
```

The schedule is the whole output: no separate "leave ahead" line. Leave beyond the window stays in the snapshot until it comes into range.

### Public holidays are per region

Never write "Monday is a public holiday for the whole team". Holidays differ by state and country, and the source is per person.

- Name the people and their region, taken from the team table. A time zone cannot stand in for a region: Victoria and New South Wales share a UTC offset but not their public holidays.
- A missing leave row on a holiday is a source gap. The person still has the holiday, and it beats `off`.
- Watch region-only dates: AFL Grand Final eve is a Victorian holiday, and the first Monday in October is a holiday in New South Wales and Queensland but not Victoria.

## Step 3: Load the previous snapshot

Read `state_file`. With no history, write today's snapshot, say it was a first run, and stop. If the previous snapshot has a different shape, treat today as a fresh baseline and say so.

## Step 4: Filter, diff, then apply thresholds

**Filter first.** An unfiltered "unreviewed for 48h" rule matched 31 PRs on the board these thresholds were tuned against, one open for 495 days. A report like that is muted on day one. Exclude bot-authored PRs (18 of the 33 unreviewed), drafts, and anything older than `pr_abandoned_days`, which is abandonment. Carry that count as one standing footer figure, never a delta.

For issues, consider only assigned open issues touched within `issue_fresh_days`. `updatedAt` is a weak proxy: a bulk board migration stamps many items with one identical timestamp.

**Drop the recurring tracking items before any threshold runs.** Most teams carry standing items every sprint (a support rota, a tech-debt allowance, a social-media watch). They sit In progress from first day to last and never carry a PR, so every signal fires on them every morning. Match them on `tracking_title_patterns`, never on issue number. Remove them from the current-sprint set and the committed points, record them in `burn.tracking_excluded`, and never print them.

**Every signal belongs to exactly one section, and the section is fixed.**

**Refinement** - is the sprint's work properly shaped?

| Signal | Threshold |
|---|---|
| Unestimated | Sprint item with `estimate` absent |
| Oversized | `estimate` >= `oversized_points` (breakdown candidate) |
| Flagged unrefined | Carries the `Needs Refinement` label |
| Untracked work | Open human PR with no linked board item |
| Nothing to show | In progress, no linked PR, idle `idle_days` or more |
| Priority coverage | One line, only when under half the sprint's items carry a priority |

**Bench** - sourced from Step 2. The roster is standing. The one threshold is **Leaving the sprint**.

**Pipeline health** - is work flowing and is main green?

| Signal | Threshold |
|---|---|
| PR waiting | Human, non-draft, no review, `pr_waiting_hours` to `pr_abandoned_days` old |
| CI | Latest run on the default branch failed |
| New blocker | Gained a blocked or needs-info label, or moved to Blocked |
| Reopened | Moved backwards since the last snapshot |

**Burnup** - a standing block. Print one line from this run's board read: `Sprint 12, day 4 of 7: 22 of 48 pts done (Sprint 11 delivered 40).` If `burnup_chart_url` is set, add GitHub's own Insights chart (Line chart over Time, Sum of Estimate, filtered to `sprint:@current`) as a PNG: in a signed-in Chrome, navigate by URL (never click in the Insights sidebar, where `New chart` sits under the chart links), clone the one wide `svg` with `javascript_tool`, inline its computed styles and draw it onto a canvas. Between sprints the chart shows `No data`, so skip it and print the line for the sprint that closed. If Chrome is unreachable, print the line with `Burnup chart not captured.`

- **No burn on day 1.** A sprint that started this morning has 0 points done by definition, and "0 of 38, behind pace" is a false alarm. Suppress the signal until day 2 and always print day N of M.
- **One reference.** Compare committed points with the previous sprint's delivered points. A rolling average is worse than none, because sprint length and team size move too much.
- **Count both sides the same way.** Exclude tracking items from the previous sprint too.
- **Re-read last sprint's delivered total every run.** A closed sprint keeps gaining Done items. An unestimated item in it makes the total a floor, so say so.
- **Done means your team's part is done.** Work handed to another team leaves this board with it.

**The staleness exception.** A delta-only report goes quiet as something gets worse. Re-escalate anything past `escalate_multiple` times its threshold (untouched 6+ days, unreviewed 96+ hours), **once per item**. Record escalated ids and never re-escalate. Without that cooldown this rule re-reported 29 PRs every morning.

**Cap every signal at `signal_cap`**, then `... and N more`.

## Step 5: Report

Four fixed sections in this order: **Refinement**, **Bench**, **Pipeline health**, **Burnup**. Then two closing blocks, the **Standing** footer and **Recommended next steps**, which carry no signals of their own.

**A section with nothing to say is omitted entirely.** No empty heading, no "all good". Fixed headings invite padding, and padding gets the report muted. On a quiet day the report is `Nothing to report.`, then the Bench block if capacity was freshly read, then the Burnup block.

**Nothing follows the report.** No run notes, no "snapshot written". Job health is printed only when it was broken.

Deltas only, one line each, no preamble. Render every issue and PR as a link so the reader can click through (the example uses short refs).

```
Sprint 12, day 1 of 7. 3 changes since Tue, 1 escalation.

Refinement
- #101 Epic: customer export - in progress, unassigned, no sprint tag, idle 8.2d

Bench (back soonest first, all 4 read)
- Dev C - unavailable 1 more day (leave, 2 days in window)
- Dev A - on client, back in 4 days   <- started today, as forecast
- Dev B - free now, on client in 1 day, project days Tue-Fri only
- Dev D - free
[the day grid, as a widget]

Leaving the sprint
- Dev B - on client in 1 day, holds 4 pts
    #118 CSV import        In progress  2   idle 5.4d, no PR
    #124 Date parsing fix  In review    2
  Free to take it: Dev D

Pipeline health
- #131 Settings page rework - open 4.3d, no reviewer
- CI green on main

Burnup
[the burnup chart]
Sprint 12, day 1 of 7: 0 of 38 pts done (Sprint 11 delivered 41).

Standing: 9 bot PRs and 6 human PRs past 30 days, not counted above.

Recommended next steps
1. Triage #103 onto the sprint before #131 merges - you, today
2. Ask Dev C for a PR or a status on #115 at standup - 5.4d idle with nothing to show
```

The headline carries the sprint and day, the change count and the date of the previous snapshot ("since Tue"), because runs are not always daily. **Pipeline health may report good news** as one line, only when something else in that section fired.

### Recommended next steps

The only part allowed to be an instruction. It is still advice: the skill never performs the action, and a line phrased as something already done is a bug.

1. **Every recommendation traces to a signal that fired in this report.** No general advice.
2. **Cap at `recommendations_cap`**, ranked by the sprint risk each removes. When two signals compete, rank the one with a human waiting on the other end first.
3. **One line: verb, target, owner.** The owner is the board's assignee, or "you" for a scrum-master decision.
4. **No block on a quiet day.**
5. **Never repeat one within `recommendation_repeat_days`.** Store its key (verb + target) and skip repeats until the signal changes.

## Step 6: Append today's snapshot

Write to `state_file`, a JSON array of snapshots, oldest first. Keep the shape stable, because the diff depends on it.

```json
{
  "date": "2026-08-19", "repo": "OWNER/REPO", "board": 1,
  "in_progress": [{ "number": 101, "title": "...", "idleDays": 8.2, "assignees": ["dev-a"] }],
  "in_review": [], "blocked": [], "ci_main_latest_failed": false,
  "sprint": { "title": "Sprint 12", "startDate": "2026-08-18", "duration": 7, "dayOfSprint": 1 },
  "burn": { "committed_points": 38, "done_points": 0, "prev_sprint": "Sprint 11", "prev_delivered_points": 41,
            "tracking_excluded": { "ids": [201, 202], "points": 8 } },
  "refinement": { "unestimated": [], "oversized": [], "needs_refinement": [112] },
  "standing": { "bot_prs": 9, "human_prs_over_30d": 6 },
  "capacity": { "checked": true, "rowsRead": 4, "lagDays": 0, "leaving_the_sprint": [],
    "sprint_window": { "Dev A": { "19/08/2026": "client" } },
    "leave_ahead": [{ "name": "Dev C", "date": "...", "region": "VIC", "source_row": false }],
    "team": [{ "name": "Dev B", "region": "NSW", "bookedDays": 14, "leaveDays": 1,
               "daysUntilBooked": "On Client", "daysUntilFree": 15, "onClient": true }] },
  "escalated_ids": ["issue-101", "pr-131"],
  "recommendations": [{ "key": "triage:103", "date": "2026-08-19", "text": "..." }]
}
```

- **One snapshot per date.** Update today's in place. A same-day duplicate clobbers the escalated list, and the next run diffs against the empty one.
- **`escalated_ids` is cumulative.** Copy the previous list forward and add to it. Writing it back empty re-escalates everything the next morning.
- **Store RAW source values in `team[]`**, never lag-corrected ones, and put the correction in `lagDays`. Tomorrow's tick test compares raw against raw.
- **Record `burn` and `refinement` every run**, even on day 1. Two snapshots turn a static figure into "moved 6 points since yesterday", the only form worth reporting.
- **`capacity.checked: false`** marks an unreachable source. Never diff against it. Treat the next good read as a fresh baseline, or every booking looks new.
- **A same-day update never downgrades `capacity`.** If a checked read already exists and this run could not reach the source, keep it and add a `capacity_note`.
- **Keep the last `snapshots_kept` snapshots.** Keep `source_row` out of the printed report; it only keeps a source gap auditable.

## Scheduling

Run it on weekdays only, before standup (for example a Claude Code scheduled task at 07:00, cron `0 7 * * 1-5`). A weekend board does not move, so a weekend run can only reprint Friday's figures. A browser-only capacity source needs a desktop scheduled task.

The scheduled prompt must keep these properties:

1. **Bail if `gh auth status` fails.** Log it, notify, and end with a line starting `ERROR:`.
2. **Follow this skill in full.** If the browser is unavailable, skip capacity and keep going.
3. **Append the report to `log_dir/<date>.log`** with the text day grid.
4. **Quiet-day rule, keyed on the report's first non-blank line.** `Nothing to report` means log one quiet line and send no notification, even when the Bench block follows. Do not weaken this.
5. **Notify only on a non-quiet day**, with the headline.

**Health check.** Confirm the schedule is still installed and a log exists from the previous weekday, because a daily report that silently stopped is worse than none. Print one line about job health only when something was wrong.

## Tuning

If the report fires every day, raise the thresholds before blaming the team. If it never fires, lower them. Rot (abandoned items, work assigned to people who have left) belongs in a weekly review, never the daily delta. There is no human checkpoint: the skill reads, reports and recommends, and never acts.
