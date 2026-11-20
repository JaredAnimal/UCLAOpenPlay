# UCLA Pickleball Open Play

The public calendar covers select Tuesday–Friday nights from 6–8 PM Pacific. Court Rules explains rotation, and **Pickleball Rules** opens the rules of the game.

## Proposals, approvals, and sign-ups

- **Log in** with a ChatGPT account that uses your UCLA email address. Both `@ucla.edu` and the corresponding `@g.ucla.edu` address work.
- Select **Propose a night** to add a tentative date. The calendar shows when to check back for confirmation, three days before play.
- Admins use **Session approvals** to approve a tentative night with its reserved facility and court, or decline the proposal.
- After approval, UCLA users can sign up or cancel their own sign-up from the selected date. The public calendar shows the number of sign-ups.

## Hosting and development

The Site uses dispatch-owned ChatGPT sign-in and a D1 database. Set the `OPEN_PLAY_ADMINS` Site environment variable to a comma-separated list of UCLA email addresses. The application enforces the list on the server. Keep real admin addresses out of source control.

With Node.js 24 or later, run `npm ci` and `npm test`. The build writes the Worker and its deployment metadata to `dist/`. The tests use a disposable SQLite database and simulated identities. Hosted migrations are tracked under `migrations/`.

The banner uses [Frank Schrader’s outdoor pickleball court photo](https://www.pexels.com/photo/empty-pickleball-court-with-net-in-summer-sun-29820786/) under the [Pexels License](https://www.pexels.com/license/). The blue background remains visible if the photo cannot load.
