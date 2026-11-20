# Status trackers

A tracker is a live reading shown under the project's name in the sidebar: one or more meters, each a number against an allowance (Android 1/15) or a state in words (In review). A tracker belongs to one project, or to every project (global, like a GitHub account's allowance). Bars stay grey and turn amber (warn) or red (bad) as a meter fills. Click one for its dialog: the meters, when it resets, the trend of its readings, the last error, and Refresh, Record, Edit or Delete. The gauge button next to the project's name adds one.

It gets its reading one of three ways:

- **By hand:** you record it in the dialog, with `wb track`, or an agent does (`record_tracker`).
- **A shell command** the board runs on the tracker's interval, in the project's folder (home for a global one), with your shell's PATH. What it prints is the reading: `12/15` · one meter per line (`Android 12/15`, `iOS: 3 of 15 builds`, `1,240 / 2,000 min`) · a state (`Status: In review`) · or JSON: a number, `{ value, max, unit, label, text, level }` (`used`/`total`/`limit`/`left` work too), a list of those, or `{ meters: [...], note, resets_at, url }`. A non-zero exit or 60 s without an answer counts as a failed read; the last good reading stays and the error shows next to it. Don't put secrets in the command: use the tool's own login (gh, eas) or an env var your shell sets.
- **Built in:** `eas-builds` (EAS builds used this billing period against the Expo plan, Android and iOS, from `eas account:usage`; needs `eas login`) and `github-actions` (the month's free Actions compute on your GitHub account, as Linux-minute equivalents of the $12 that GitHub Free includes; private repos only, since public ones are free; needs gh's `user` scope: `gh auth refresh -h github.com -s user`).

```bash
wb tracker add eas-builds --preset eas-builds                     # in the project's folder, or --project isokratis
wb tracker add gh-actions --global --preset github-actions --every 6h
wb tracker add play-review "Play review" --url https://play.google.com/console   # by hand
wb track play-review "Status: In review" --note "submitted Nov 4"
wb tracker add disk "Disk" --global --command "df -BG --output=used,size / | tail -1 | tr -d G | awk '{print \$1 \"/\" \$2}'" --unit GB
wb trackers                      # this project's and the global ones, with readings
wb tracker eas-builds            # one, how it reads, its history; --json for scripts
wb tracker edit eas-builds --every 15m --warn 60% --bad 90%
wb tracker refresh               # read every self-reading one here now (or name one)
wb untrack disk                  # delete it and its history
```

- **Refresh interval:** `--every 15m|1h|6h|1d|off` (default 1 hour, at least 1 minute; `off` reads only when asked). The board checks every 30 s which ones are due; the dialog's Refresh, `wb tracker refresh` and agents read one at once. Two readers never run the same tracker together.
- **Levels:** a meter with a max warns at 75% and is bad at 90% unless `--warn`/`--bad` say otherwise: a share of max (`80%`) or a number (`14`). When low is bad (minutes left, coverage), put bad below warn (`--warn 20% --bad 10%`) or prefix `<`. A command's JSON can set a meter's `level` itself. `--max` and `--unit` fill in what a reading leaves out.
- **Names:** lowercase with dashes, unique in the project. Commands and agents take `name` (the current project's first, then the global one) or `project/name`.
- **History:** every reading that differs from the one before is kept (the last 2,000), for the trend in the dialog. Desktop notifications (the bell) also say when a tracker starts to warn, turns bad, or stops reading.
- **Who can set a command:** a command runs on this computer, so the board accepts one only from its own page here (like data sources), never from the phone under `--lan`; `wb tracker` and the MCP server run as you anyway.
