# School Science Day Quiz

A real-time multiplayer quiz for a school event. It uses Express and Socket.IO, plain HTML/JavaScript pages, and `questions.json` for persistent question storage. Active rooms and scores live in server memory; restarting the server ends games in progress.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open [http://localhost:3000/](http://localhost:3000/) for the public homepage, where visitors can choose Log in or Register or enter a six-digit game PIN. Players who need to sign in first are sent back to their pending game after authentication. Registration is at [http://localhost:3000/register.html](http://localhost:3000/register.html) and sign-in is at [http://localhost:3000/login.html](http://localhost:3000/login.html). Administrators create games and receive the PIN on the host screen; the admin panel is for managing users, questions, and ongoing games. On a local network, use the LAN URL printed by the server.

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

## Questions

The admin panel supports adding, editing, reordering, and deleting questions. Changes are saved to `questions.json`. Each question has a unique `id`, a `question`, four `options`, a zero-based `correctIndex`, and a `timeLimit` from 5 to 120 seconds. On the host screen, admins choose a set of questions for a game, set its title and scoring values, create the game, and receive its PIN in the live lobby. The admin panel manages player/admin roles and lists only ongoing games, with controls to start, pause, resume, or advance them. Games snapshot their selected questions when created.

Players must be signed in to join with a PIN. They choose a 1–30 character nickname shown in the lobby and rankings; nicknames must be unique within each game. The browser remembers the last nickname to make rejoining easier. Each game has a configurable starting score, `n1`, and `n2`. A correct answer earns `n1 × elapsed active seconds` (rounded up to the current second, with a minimum of one second); an incorrect answer deducts `n2`, clamped so scores never fall below zero. An unanswered question does not change the score. Time spent paused is excluded from scoring and the question timer. Rankings include every participant and remain available in the admin panel after a game ends. If the server restarts during a game, that game is marked interrupted in the saved history; active gameplay itself is held in memory and does not resume.

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

- Add and verify the final questions in the admin panel.
- Test joining, answer lock-in, scoring, review, and final podium with several devices.
- Open the host screen on the projector computer and check the PIN and QR code are readable.
- Keep the server running for the duration of the event; active game rooms are not persisted across restarts, although their interrupted status and results up to the restart are saved.
