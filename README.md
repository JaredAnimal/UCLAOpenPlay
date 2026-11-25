# UCLA Pickleball Open Play

The public calendar shows Monday through Sunday. Any day can hold an open play session, usually 6–8 PM Pacific. A night appears once the court is booked, three days before play; proposed nights still need admin approval, and days with nothing scheduled stay blank. Court Rules explains rotation, and **Pickleball Rules** opens the rules of the game.

## Proposals, approvals, and sign-ups

- **Log in** with a Google account that has a verified UCLA email. Both `@ucla.edu` and the corresponding `@g.ucla.edu` address work. Other Google accounts are turned away, and the old ChatGPT sign-in is gone.
- The first time you log in, confirm your name (Google's name is filled in). Other players see your first name and last initial, and you can edit it any time from the name button in the header. Signing up and proposing a night need a confirmed name. Names are saved per UCLA mailbox in the `members` table.
- Select **Propose a night** to add a tentative date. The calendar shows when to check back for confirmation, three days before play.
- Admins use **Session approvals** to approve a tentative night with its reserved facility and court, or decline the proposal.
- Admins can add another UCLA email address from the **Admins** list. The list is visible to admins only.
- After approval, UCLA users can sign up or cancel their own sign-up from the selected date. The public calendar shows the number of sign-ups.

## Hosting and development

GitHub Pages serves the static frontend from the root of `gh-pages`. To publish frontend changes from `main`, run `npm run publish:pages`. The frontend uses the existing Site Worker for the calendar API, Google sign-in, and the D1 database. Deploy Worker changes through Sites before publishing frontend changes that depend on them.

Set the `OPEN_PLAY_ADMINS` Site environment variable to a comma-separated list of initial UCLA admin emails. Additional admins are managed on the site and stored in D1. Keep real admin addresses out of source control.

Sign-in needs no client secret and no Site setting. The Worker uses the public Google client ID in `worker/google-auth.mjs` and asks Google to post a signed ID token back to `/auth/google/callback`. That one callback serves both the Site and GitHub Pages. The `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` Site settings are no longer read, so they can be deleted. In the Google OAuth Web client, `https://ucla-open-play.jaredashman0209.chatgpt.site/auth/google/callback` must be an authorized redirect URI, and `http://localhost:8791/auth/google/callback` is also needed to test locally. Use a consent-screen audience that includes the UCLA accounts that need to sign in. Sign-in lasts 90 days.

Sites applies migration `0004_accounts` itself when the Worker deploys: it adds the `members` table and signs everyone out once (the old ChatGPT sign-ins can't be used anymore). Do not run it by hand. Deploy the Worker before publishing Pages.

## Bot posts

Picklebot (the court-booking script) tells the site about each tennis court it books at 6 PM or 7 PM, so the night shows up as Confirmed at `Sunset Rec Tennis Court 2` with its hours. To turn this on:

1. Make a long random token, for example by running `node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"`.
2. In the Site's environment settings, store it as the secret `OPEN_PLAY_BOT_TOKEN`.
3. Deploy the Worker through Sites. Sites applies migration `0003_bot_hours_names` itself, like 0001 and 0002. Do not apply it by hand: a second run fails on duplicate columns.
4. Then run `npm run publish:pages`. The Worker deploy (with its migration) goes first, the Pages publish second.
5. Give the same token to picklebot with `node picklebot.js save-openplay-token`. Never put the token in a file or in chat.

A bot post always sets that night to Confirmed at `Sunset Rec Tennis Court 2`. It overwrites a location an admin typed, re-confirms a night an admin declined, and sets the hours to the hours the bot booked (a 6 PM booking shows only 6–7 PM until the 7 PM court is booked too).

The endpoint is `POST /api/bot/session` with the header `Authorization: Bearer <token>` and a JSON body like `{ "date": "2026-12-01", "hour": 18 }` (`hour` is the booked hour, 13 to 23). Without the secret set, the endpoint refuses every request.

With Node.js 24 or later, run `npm ci` and `npm test`. The build writes the Worker and its deployment metadata to `dist/`. The tests use a disposable SQLite database and simulated identities. Hosted migrations are tracked under `migrations/`.

The banner uses [Frank Schrader’s outdoor pickleball court photo](https://www.pexels.com/photo/empty-pickleball-court-with-net-in-summer-sun-29820786/) under the [Pexels License](https://www.pexels.com/license/). The blue background remains visible if the photo cannot load.
