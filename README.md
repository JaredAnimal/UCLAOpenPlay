# UCLA Pickleball Open Play

The public calendar shows Monday through Sunday. Mondays, Wednesdays, Fridays, and Saturdays are reserved for tennis. Open play runs on select Tuesdays and Thursdays from 6–8 PM Pacific. Unscheduled Tuesdays and Thursdays more than three days out appear tentative. Court Rules explains rotation, and **Pickleball Rules** opens the rules of the game.

## Proposals, approvals, and sign-ups

- **Log in** with Google once OAuth is configured. Both `@ucla.edu` and the corresponding `@g.ucla.edu` address work. During setup, the existing UCLA email sign-in remains available.
- Select **Propose a night** to add a tentative date. The calendar shows when to check back for confirmation, three days before play.
- Admins use **Session approvals** to approve a tentative night with its reserved facility and court, or decline the proposal.
- Admins can add another UCLA email address from the **Admins** list. The list is visible to admins only.
- After approval, UCLA users can sign up or cancel their own sign-up from the selected date. The public calendar shows the number of sign-ups.

## Hosting and development

GitHub Pages serves the static frontend from the root of `gh-pages`. To publish frontend changes from `main`, run `npm run publish:pages`. The frontend uses the existing Site Worker for the calendar API, Google sign-in, and the D1 database. Deploy Worker changes through Sites before publishing frontend changes that depend on them.

Set the `OPEN_PLAY_ADMINS` Site environment variable to a comma-separated list of initial UCLA admin emails. Additional admins are managed on the site and stored in D1. Keep real admin addresses out of source control.

Create or reuse a Google OAuth Web application client. Add `https://ucla-open-play.jaredashman0209.chatgpt.site/auth/google/callback` as an authorized redirect URI. In the Site's environment settings, set `GOOGLE_CLIENT_ID` and store `GOOGLE_CLIENT_SECRET` as a secret. Publish with the updated settings to activate direct Google sign-in. The same callback serves both the Site and GitHub Pages. Use a consent-screen audience that includes the UCLA accounts that need to sign in.

With Node.js 24 or later, run `npm ci` and `npm test`. The build writes the Worker and its deployment metadata to `dist/`. The tests use a disposable SQLite database and simulated identities. Hosted migrations are tracked under `migrations/`.

The banner uses [Frank Schrader’s outdoor pickleball court photo](https://www.pexels.com/photo/empty-pickleball-court-with-net-in-summer-sun-29820786/) under the [Pexels License](https://www.pexels.com/license/). The blue background remains visible if the photo cannot load.
