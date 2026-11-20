# UCLA Pickleball Open Play

A standalone calendar for select Tuesday–Friday nights from 6–8 PM Pacific. The calendar layout draws from [UCLA Club Pickleball](https://github.com/JaredAnimal/UCLAPickleball). The Court Rules section describes open-play rotation, and its **Pickleball Rules** button opens the rules of the game.

## Update the schedule

Edit [`dist/schedule.json`](dist/schedule.json). Enter one record per planned date using `YYYY-MM-DD` in Pacific time. Each session uses the same 6–8 PM slot. For example, a tentative night looks like this:

```json
[
  {
    "date": "2026-12-01",
    "status": "pending"
  }
]
```

- Use `pending` for a night you plan to reserve. The calendar displays the date to check back, three calendar days before play.
- Change the status to `confirmed` when the tennis court is booked and add `location` with the facility and court number. Use the optional `note` field for instructions such as where to enter.
- Change the status to `cancelled` when the night will not run. A `note` can explain the cancellation. Pending nights that pass 8 PM Pacific display as “Not confirmed.”

The example is for editing reference. The schedule starts empty. Validate changes with `node --test scripts/schedule.test.mjs`, then publish the updated `dist/` directory to the host. The calendar reads this file on load and when a visitor returns to the tab.

## Preview

Run `python3 -m http.server 8080 --directory dist` and open `http://localhost:8080`. There is no build step. `dist/` contains the complete static site and works at either a domain root or a repository subpath.
