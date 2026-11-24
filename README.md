# School Science Day Quiz

A real-time multiplayer quiz for a school event. It uses Express and Socket.IO, plain HTML/JavaScript pages, and `questions.json` for persistent question storage. Active rooms and scores live in server memory; restarting the server ends games in progress.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open [http://localhost:3000/](http://localhost:3000/) for the public homepage, where visitors can choose Log in or Register or enter a six-digit game PIN. Players who need to sign in first are sent back to their pending game after authentication. Registration is at [http://localhost:3000/register.html](http://localhost:3000/register.html) and sign-in is at [http://localhost:3000/login.html](http://localhost:3000/login.html). Administrators create games and receive the PIN on the host screen; the admin panel is for managing users, questions, and ongoing games. The host screen uses a LAN address for its QR code when opened through `localhost`; player devices must be on the same local network. The server also prints the LAN URL at startup.

For development with automatic restarts, run `npm run dev`.

To create a distributable npm tarball containing the app files, run `npm run pack:app`. This produces a `science-day-quiz-1.0.0.tgz` file in the current directory; install dependencies separately on the target machine with `npm install`.

Accounts are stored in the ignored `users.json` file (or at the optional `USER_STORE_FILE` path). Game history and final rankings are stored in the ignored `games.json` file (or at the optional `GAMES_FILE` path). Login sessions are stored as hashed session IDs in the ignored `sessions.json` file (or at the optional `SESSION_STORE_FILE` path), so users stay signed in across page changes and server restarts until their 12-hour session expires or they log out. The browser keeps only non-sensitive profile and pending-PIN data in `localStorage`; authentication remains protected by an HTTP-only cookie, and passwords/session tokens are never stored in `localStorage`. Passwords are stored as salted scrypt hashes, and each user receives the regular `user` role at registration. Public registration cannot create administrator accounts. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` before starting the server to provision the administrator account; that environment password is applied whenever the server starts. Production requires both settings and an administrator password of at least 12 bytes. For example:

```sh
# Linux/macOS
ADMIN_EMAIL='organizer@example.com' ADMIN_PASSWORD='use-a-long-private-password' npm start

# PowerShell
$env:ADMIN_EMAIL = 'organizer@example.com'
$env:ADMIN_PASSWORD = 'use-a-long-private-password'
npm start
```

Sign-in uses an HTTP-only, SameSite session cookie. Sessions expire after 12 hours or when the server restarts. Admin pages, Socket.IO host actions, and question-management APIs enforce the admin role on the server. Failed login and registration attempts are rate-limited. Use HTTPS for public hosting; the deployment example below terminates TLS at Nginx.

## Questions and rounds

The Admin Panel keeps three question banks separate:

- **Quiz** questions are stored in `questions.json`. Each has a unique `id`, question text, four options, a zero-based `correctIndex`, a `timeLimit` from 5 to 120 seconds, and a maximum correct-answer `points` value. An optional image can be a served file path (for example `/images/diagram.png`) or an HTTPS URL.
- **Rapid Fire** common questions and announcer prompts, plus all **Practical Quiz** themes are stored in `round-question-banks.json`. Each Practical theme has a private question and answer, an optional video, and a shared buzzer question and answer. Edit them in the Admin Panel under “Rapid Fire and Practical Quiz question banks.” The Rapid Fire setup screen lets the Host choose which common multiple-choice question to use for a game.

Leave an optional image or video URL blank when no media is needed. Keep local media organized in `public/images/` and `public/videos/`, then enter its served path in the Admin Panel (for example, `public/images/diagram.png` is `/images/diagram.png`, and `public/videos/space.mp4` is `/videos/space.mp4`). HTTPS media URLs are also supported. Exactly ten uniquely named Practical Quiz themes are required. Games snapshot their selected Rapid Fire question, announcer prompts, and Practical themes when created; later bank edits apply only to new games.

When creating a game, the Admin chooses the order of the three required rounds using the up/down controls on the Host setup screen and can edit the rules text shown to Host and Players at the start of each round. Practical Quiz must remain after Rapid Fire because its individual calling order comes from the Rapid Fire leaderboard. Paper Marks are always the final scoring step. The default order is:

1. **Rapid Fire:** all players answer the selected Rapid Fire common question at once. Correctness and response time establish the calling order. The Host screen shows the timer large for projection and highlights the final 10 seconds in red. On the Host screen, set a turn duration and click the next participant's name in the calling order to start their turn. When time expires, enter that participant's total marks in the Host screen or Admin Panel and click **Insert marks**. This records the marks without advancing. After all participants are scored, the Admin clicks **Next** to continue to the next round.
2. **Quiz:** each question has its own time and maximum points. A correct answer scores `max(1, question points - elapsed active seconds + 1)`, so a 20-point question awards 20 in the first second, 19 in the second, and so on. Wrong answers and timeouts use the same fixed game penalty (`n2`), clamped so a score never falls below zero. Paused time is excluded.
3. **Practical Quiz:** the top ten participants in Rapid Fire leaderboard order each choose one different, unused theme. Everyone sees the selected theme's video; only the chooser receives its private question. The Admin records **Correct** (+10), **Wrong** (−5), or **Not Answered** (0). Then all participants can ring for that theme's shared buzzer question; the first two presses, in order, may answer. The first chance scores +10 for correct and −5 for wrong; if only one person has rung and misses, the buzzer reopens for another participant. The second chance scores +5 for correct, −3 for wrong, and 0 if unanswered. The Admin records each result and clicks **Next** after the theme to continue.
After the last theme, **Next** advances to any remaining scheduled round or opens **Final Paper Marks**. The Admin enters one nonnegative whole-number mark value for every participant in current leaderboard order; the fields are only in the Admin Panel and are not shown to players. Submitting the marks adds each value to that participant's cumulative score once. The Admin can then publish the final ranked leaderboard and view the full game report.

The Practical Quiz video stage advances after about 30 seconds, or the active player can advance it when playback ends. The buzzer sound is played from `public/Buzzer/wrong-answer-sound-effect (1).mp3` on Host and Player screens. The `round-question-banks.json` file is the starter/configuration data for the separate round question banks and can be backed up or edited directly; the Admin Panel is the recommended editor.

Three per-game Admin Panel permissions update Host and Player screens live:

- **Show quiz leaderboard and ranks** controls the Main Quiz ranking at review: ranks 1–3 and every remaining rank appear when enabled.
- **Show cumulative totals to players** controls public score totals and awarded-point details; scoring always continues in the background, and Admin can always inspect the complete breakdown privately.
- **Show player final report** unlocks the Player final report. The Host final leaderboard and Admin report remain available regardless.

Players join with the six-digit PIN or QR code and select a 1–30 character nickname/team identifier. Their account ID keeps that team/user identity stable across all rounds. The homepage lists the available competition stages and polls `/api/events` for active games, including each game's selected round order; a PIN is publicly included only while its game is still in the lobby. The Admin Panel keeps live standings, mark entry, and turn controls available during the competition and archives the final round-by-round report after it finishes. If the server restarts during a game, that game is marked interrupted in saved history; active gameplay is held in memory and does not resume.

## Deploy on a VPS

Install Node.js 20+, Nginx, and PM2 on the VPS. Upload this project, then install and start it with the administrator account configured in the PM2 environment:

```sh
cd /var/www/science-day-quiz
npm install --omit=dev
ADMIN_EMAIL='organizer@example.com' ADMIN_PASSWORD='use-a-long-private-password' NODE_ENV=production pm2 start server.js --name science-quiz
pm2 save
pm2 startup
```

For persistent environment configuration, set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NODE_ENV=production`, and any custom `USER_STORE_FILE`/`GAMES_FILE`/`SESSION_STORE_FILE` paths in your process manager's ecosystem file instead of relying on the one-time shell environment. Keep `users.json`, `games.json`, and `sessions.json` private; they are excluded from Git and npm packages.

Example Nginx site configuration (replace the hostname):

```nginx
server {
    listen 80;
    server_name quiz.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

Then validate/reload Nginx and use Certbot to enable HTTPS. The QR code on the host screen points to the current site origin, so use the public HTTPS address on event day.

## Event-day checks

- Add and verify the Rapid Fire common question and announcer prompts, Quiz questions, all ten Practical themes/video URLs, and buzzer questions in their separate Admin Panel sections.
- On the Host setup screen, select the Rapid Fire common question and use the round-order controls to set the required round order. Practical Quiz cannot be moved ahead of Rapid Fire.
- Test a non-default legal order (for example Quiz → Rapid Fire → Practical Quiz), confirm each rules screen appears only after the previous round completes, and verify Practical still follows the Rapid Fire calling order.
- Put practical theme video files under `public/` and add their served paths or HTTPS URLs in the Practical Quiz question bank. Verify the buzzer sound at `public/Buzzer/wrong-answer-sound-effect (1).mp3`.
- Test PIN and QR joining, Rapid Fire rules/order/turn scoring, Quiz speed scoring and fixed penalties, ten unique Practical theme selections, private-question adjudication, first/second buzzer scoring and re-open flow, private Paper Marks, final rankings, and the full report with several devices.
- Toggle each visibility permission during a live game and verify Host and Player screens update immediately. Check that Admin standings and the archived report still contain full totals.
- Open the host screen on the projector computer and check the PIN and QR code are readable.
- Keep the server running for the duration of the event; active game rooms are not persisted across restarts, although their interrupted status and results up to the restart are saved.

For PM2, deploy the updated files and restart with the existing environment:

```sh
pm2 restart science-quiz --update-env
pm2 logs science-quiz
```

Run the same event-day checks against the deployed URL, using separate devices/accounts for Host and Players.
