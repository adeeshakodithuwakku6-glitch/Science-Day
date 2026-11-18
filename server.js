const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const QUESTIONS_FILE = path.join(__dirname, "questions.json");
const USERS_FILE = path.resolve(process.env.USER_STORE_FILE || path.join(__dirname, "users.json"));
const GAMES_FILE = path.resolve(process.env.GAMES_FILE || path.join(__dirname, "games.json"));
const SESSIONS_FILE = path.resolve(process.env.SESSION_STORE_FILE || path.join(__dirname, "sessions.json"));
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const SESSION_COOKIE = "science_quiz_session";

function getLanAddresses() {
  return [...new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter((address) => address && address.family === "IPv4" && !address.internal)
      .map((address) => address.address)
  )];
}

function getLanOrigin() {
  const address = getLanAddresses()[0];
  return address ? `http://${address}:${PORT}` : null;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();
const sessions = new Map();
const loginAttempts = new Map();

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}
app.use(express.json({ limit: "256kb" }));
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

let questions = [];
let users = [];
let gameHistory = [];
let userWriteQueue = Promise.resolve();
let userMutationQueue = Promise.resolve();
let gameWriteQueue = Promise.resolve();
let sessionWriteQueue = Promise.resolve();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, derivedKey) => {
      if (error) return reject(error);
      resolve({ salt, hash: derivedKey.toString("hex") });
    });
  });
}

function verifyPassword(password, user) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, user.passwordSalt, 64, { N: 16384, r: 8, p: 1 }, (error, derivedKey) => {
      if (error) return reject(error);
      const expected = Buffer.from(user.passwordHash, "hex");
      resolve(expected.length === derivedKey.length && crypto.timingSafeEqual(derivedKey, expected));
    });
  });
}

function persistUsers(nextUsers) {
  const content = `${JSON.stringify(nextUsers, null, 2)}\n`;
  const write = userWriteQueue.then(async () => {
    const temporaryFile = `${USERS_FILE}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryFile, content, { encoding: "utf8", flag: "wx" });
    try {
      await fs.rename(temporaryFile, USERS_FILE);
    } catch (error) {
      await fs.rm(temporaryFile, { force: true });
      throw error;
    }
  });
  userWriteQueue = write.catch(() => {});
  return write;
}

function addUser(user) {
  const operation = userMutationQueue.then(async () => {
    if (users.some((existing) => existing.email === user.email)) return false;
    const nextUsers = [...users, user];
    await persistUsers(nextUsers);
    users = nextUsers;
    return true;
  });
  userMutationQueue = operation.catch(() => {});
  return operation;
}

function replaceUser(id, update) {
  const operation = userMutationQueue.then(async () => {
    const nextUsers = users.map((user) => user.id === id ? update(user) : user);
    await persistUsers(nextUsers);
    users = nextUsers;
  });
  userMutationQueue = operation.catch(() => {});
  return operation;
}

function persistJsonFile(file, content) {
  const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
  return fs.writeFile(temporaryFile, content, { encoding: "utf8", flag: "wx" }).then(async () => {
    try {
      await fs.rename(temporaryFile, file);
    } catch (error) {
      await fs.rm(temporaryFile, { force: true });
      throw error;
    }
  });
}

function persistGameHistory() {
  const content = `${JSON.stringify(gameHistory, null, 2)}\n`;
  const write = gameWriteQueue.then(() => persistJsonFile(GAMES_FILE, content));
  gameWriteQueue = write.catch(() => {});
  return write;
}

function sessionKey(sessionId) {
  return crypto.createHash("sha256").update(sessionId).digest("hex");
}

function persistSessions() {
  const write = sessionWriteQueue.then(() => {
    const activeSessions = [...sessions.entries()].map(([key, session]) => ({ key, ...session }));
    return persistJsonFile(SESSIONS_FILE, `${JSON.stringify(activeSessions, null, 2)}\n`);
  });
  sessionWriteQueue = write.catch(() => {});
  return write;
}

async function loadSessions() {
  try {
    const content = await fs.readFile(SESSIONS_FILE, "utf8");
    const parsed = JSON.parse(content);
    if (
      !Array.isArray(parsed) ||
      parsed.some((session) =>
        !session ||
        typeof session.key !== "string" ||
        !/^[a-f0-9]{64}$/.test(session.key) ||
        typeof session.userId !== "string" ||
        !Number.isSafeInteger(session.expiresAt)
      )
    ) {
      throw new Error("sessions.json contains invalid session data.");
    }
    sessions.clear();
    for (const { key, userId, expiresAt } of parsed) {
      if (expiresAt > Date.now() && users.some((user) => user.id === userId)) {
        sessions.set(key, { userId, expiresAt });
      }
    }
    if (sessions.size !== parsed.length) await persistSessions();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sessions.clear();
    await persistSessions();
  }
}

async function createSession(userId) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionKey(sessionId), { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  try {
    await persistSessions();
  } catch (error) {
    sessions.delete(sessionKey(sessionId));
    throw error;
  }
  return sessionId;
}

function recordGame(room) {
  const rankings = leaderboard(room);
  const record = {
    id: room.id,
    pin: room.pin,
    title: room.title,
    adminId: room.adminId,
    status: room.status,
    settings: { ...room.settings },
    questionCount: room.questions.length,
    currentQuestion: room.currentIndex + 1,
    createdAt: room.createdAt,
    startedAt: room.startedAt || null,
    endedAt: room.endedAt || null,
    players: rankings,
    leaderboard: rankings
  };
  const existingIndex = gameHistory.findIndex((game) => game.id === room.id);
  if (existingIndex < 0) gameHistory.unshift(record);
  else gameHistory[existingIndex] = record;
  return persistGameHistory();
}

function saveGame(room) {
  recordGame(room).catch((error) => console.error("Could not save game history:", error));
}

async function loadGameHistory() {
  try {
    const content = await fs.readFile(GAMES_FILE, "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error("games.json must contain an array.");
    gameHistory = parsed;
    let interrupted = false;
    for (const game of gameHistory) {
      if (["lobby", "question", "paused", "review"].includes(game.status)) {
        game.status = "interrupted";
        game.endedAt = new Date().toISOString();
        interrupted = true;
      }
    }
    if (interrupted) await persistGameHistory();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    gameHistory = [];
    await persistGameHistory();
  }
}

async function loadUsers() {
  try {
    const content = await fs.readFile(USERS_FILE, "utf8");
    const parsed = JSON.parse(content);
    if (
      !Array.isArray(parsed) ||
      new Set(parsed.map((user) => user?.email)).size !== parsed.length ||
      parsed.some((user) =>
        !user ||
        typeof user.id !== "string" ||
        typeof user.name !== "string" ||
        typeof user.email !== "string" ||
        !["user", "admin"].includes(user.role) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) ||
        typeof user.passwordSalt !== "string" ||
        !/^[a-f0-9]{32}$/.test(user.passwordSalt) ||
        typeof user.passwordHash !== "string" ||
        !/^[a-f0-9]{128}$/.test(user.passwordHash)
      )
    ) {
      throw new Error("users.json contains invalid account data.");
    }
    users = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    users = [];
    await persistUsers(users);
  }
}

function getSessionId(req) {
  const cookies = req.headers.cookie || "";
  const entry = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : "";
}

function currentUser(sessionId) {
  const key = sessionKey(sessionId);
  const session = sessions.get(key);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) {
      sessions.delete(key);
      persistSessions().catch((error) => console.error("Could not save expired session cleanup:", error));
    }
    return null;
  }
  return users.find((user) => user.id === session.userId) || null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function setSessionCookie(res, sessionId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function requireAdmin(req, res, next) {
  const user = currentUser(getSessionId(req));
  if (!user) return res.status(401).json({ error: "Please sign in first." });
  if (user.role !== "admin") return res.status(403).json({ error: "Admin access is required." });
  req.user = user;
  next();
}

function requireAdminPage(req, res, next) {
  const user = currentUser(getSessionId(req));
  if (!user) return res.redirect("/login.html");
  if (user.role !== "admin") return res.redirect("/play.html");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", path.basename(req.path)));
}

function requirePlayerPage(req, res, next) {
  const user = currentUser(getSessionId(req));
  if (!user) return res.redirect("/login.html");
  if (user.role === "admin") return res.redirect("/admin.html");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "play.html"));
}

function loginRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const attempts = (loginAttempts.get(key) || []).filter((time) => now - time < LOGIN_WINDOW_MS);
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(key, attempts);
    return res.status(429).json({ error: "Too many sign-in attempts. Try again later." });
  }
  req.recordFailedLogin = () => {
    attempts.push(Date.now());
    loginAttempts.set(key, attempts);
  };
  req.clearFailedLogins = () => loginAttempts.delete(key);
  next();
}

function validateQuestions(value) {
  if (!Array.isArray(value) || value.length > 500) {
    return "Questions must be an array containing no more than 500 items.";
  }

  const ids = new Set();
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return `Question ${index + 1} must be an object.`;
    }
    if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 80 || ids.has(item.id)) {
      return `Question ${index + 1} must have a unique ID of 1–80 characters.`;
    }
    if (typeof item.question !== "string" || !item.question.trim() || item.question.length > 500) {
      return `Question ${index + 1} must have text of 1–500 characters.`;
    }
    if (
      !Array.isArray(item.options) ||
      item.options.length !== 4 ||
      item.options.some((option) => typeof option !== "string" || !option.trim() || option.length > 200)
    ) {
      return `Question ${index + 1} must have four non-empty options of at most 200 characters.`;
    }
    if (!Number.isInteger(item.correctIndex) || item.correctIndex < 0 || item.correctIndex > 3) {
      return `Question ${index + 1} must have a correct option from 0 to 3.`;
    }
    if (!Number.isInteger(item.timeLimit) || item.timeLimit < 5 || item.timeLimit > 120) {
      return `Question ${index + 1} must have a time limit from 5 to 120 seconds.`;
    }
    ids.add(item.id);
  }
  return null;
}

async function loadQuestions() {
  const content = await fs.readFile(QUESTIONS_FILE, "utf8");
  const parsed = JSON.parse(content);
  const error = validateQuestions(parsed);
  if (error) {
    throw new Error(`Invalid questions.json: ${error}`);
  }
  return parsed;
}

async function persistQuestions(nextQuestions) {
  const temporaryFile = `${QUESTIONS_FILE}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(nextQuestions, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  try {
    await fs.rename(temporaryFile, QUESTIONS_FILE);
  } catch (error) {
    await fs.rm(temporaryFile, { force: true });
    throw error;
  }
}

app.post("/api/auth/register", loginRateLimit, async (req, res, next) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!name || name.length > 30) return res.status(400).json({ error: "Name must be 1–30 characters." });
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 128) {
    return res.status(400).json({ error: "Password must be 8–128 bytes long." });
  }
  if (users.some((user) => user.email === email)) {
    req.recordFailedLogin();
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  try {
    const { salt, hash } = await hashPassword(password);
    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      passwordSalt: salt,
      passwordHash: hash,
      role: "user",
      createdAt: new Date().toISOString()
    };
    const added = await addUser(user);
    if (!added) {
      req.recordFailedLogin();
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    req.clearFailedLogins();
    const sessionId = await createSession(user.id);
    setSessionCookie(res, sessionId);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", loginRateLimit, async (req, res, next) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (Buffer.byteLength(password, "utf8") > 128) {
    req.recordFailedLogin();
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  const user = users.find((item) => item.email === email);
  try {
    const passwordMatches = user ? await verifyPassword(password, user) : false;
    if (!passwordMatches) {
      req.recordFailedLogin();
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    req.clearFailedLogins();
    const sessionId = await createSession(user.id);
    setSessionCookie(res, sessionId);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", (req, res) => {
  const user = currentUser(getSessionId(req));
  if (!user) return res.status(401).json({ error: "Please sign in first." });
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", async (req, res, next) => {
  const sessionId = getSessionId(req);
  if (sessionId) {
    sessions.delete(sessionKey(sessionId));
    try {
      await persistSessions();
    } catch (error) {
      next(error);
      return;
    }
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.sessionId === sessionId) socket.disconnect(true);
    }
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/admin.html", requireAdminPage);
app.get("/host.html", requireAdminPage);
app.get("/play.html", requirePlayerPage);

app.get("/api/questions", requireAdmin, (req, res) => {
  res.json(questions);
});

app.post("/api/questions", requireAdmin, async (req, res, next) => {
  const error = validateQuestions(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  try {
    await persistQuestions(req.body);
    questions = req.body;
    res.json({ saved: questions.length });
  } catch (saveError) {
    next(saveError);
  }
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json(users.map(publicUser).sort((a, b) => a.name.localeCompare(b.name)));
});

app.patch("/api/admin/users/:id/role", requireAdmin, async (req, res, next) => {
  const { id } = req.params;
  const role = req.body?.role;
  const target = users.find((user) => user.id === id);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (role !== "admin" && role !== "user") return res.status(400).json({ error: "Role must be user or admin." });
  if (req.user.id === id && role !== "admin") {
    return res.status(400).json({ error: "You cannot remove your own administrator access." });
  }
  if (target.role === "admin" && role === "user" && users.filter((user) => user.role === "admin").length <= 1) {
    return res.status(400).json({ error: "At least one administrator account must remain." });
  }
  try {
    await replaceUser(id, (user) => ({ ...user, role }));
    res.json({ user: publicUser(users.find((user) => user.id === id)) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/games", requireAdmin, (req, res) => {
  const ongoingStatuses = new Set(["lobby", "question", "paused", "review"]);
  res.json(
    [...rooms.values()]
      .filter((room) => ongoingStatuses.has(room.status))
      .map((room) => ({ ...gameSummary(room), live: true }))
  );
});

app.delete("/api/admin/games/:pin", requireAdmin, async (req, res, next) => {
  const room = rooms.get(req.params.pin);
  if (!room) return res.status(404).json({ error: "Game not found." });

  clearRoomTimer(room);
  clearTimeout(room.cleanupTimer);
  io.to(room.pin).emit("game:deleted");
  io.in(room.pin).socketsLeave(room.pin);
  rooms.delete(room.pin);
  gameHistory = gameHistory.filter((game) => game.id !== room.id);

  try {
    await persistGameHistory();
    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/games", requireAdmin, async (req, res, next) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const questionIds = req.body?.questionIds;
  const settings = req.body?.settings;
  if (!title || title.length > 80) return res.status(400).json({ error: "Game name must be 1–80 characters." });
  if (!Array.isArray(questionIds) || !questionIds.length || questionIds.length > 100) {
    return res.status(400).json({ error: "Select between 1 and 100 questions." });
  }
  if (new Set(questionIds).size !== questionIds.length || questionIds.some((id) => typeof id !== "string")) {
    return res.status(400).json({ error: "Selected question list is invalid." });
  }
  const selectedQuestions = questionIds.map((id) => questions.find((question) => question.id === id));
  if (selectedQuestions.some((question) => !question)) {
    return res.status(400).json({ error: "One or more selected questions no longer exist. Refresh and try again." });
  }
  if (
    !settings ||
    !Number.isSafeInteger(settings.startingScore) ||
    settings.startingScore < 0 ||
    settings.startingScore > 1000000 ||
    !Number.isSafeInteger(settings.n1) ||
    settings.n1 < 0 ||
    settings.n1 > 1000000 ||
    !Number.isSafeInteger(settings.n2) ||
    settings.n2 < 0 ||
    settings.n2 > 1000000
  ) {
    return res.status(400).json({ error: "Starting score, n1, and n2 must be whole numbers from 0 to 1,000,000." });
  }
  if (rooms.size >= 100) return res.status(503).json({ error: "The server is at its room limit." });
  try {
    const room = createGameRoom({
      adminId: req.user.id,
      title,
      questions: selectedQuestions,
      settings
    });
    await recordGame(room);
    res.status(201).json(gameSummary(room));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/games/:pin/:action", requireAdmin, (req, res) => {
  const room = rooms.get(req.params.pin);
  if (!room) return res.status(404).json({ error: "Game not found." });
  const action = req.params.action;
  if (action === "start") {
    const error = startGame(room);
    if (error) return res.status(400).json({ error });
  } else if (action === "pause") {
    const error = pauseGame(room);
    if (error) return res.status(400).json({ error });
  } else if (action === "resume") {
    const error = resumeGame(room);
    if (error) return res.status(400).json({ error });
  } else if (action === "next") {
    const error = nextGameQuestion(room);
    if (error) return res.status(400).json({ error });
  } else {
    return res.status(404).json({ error: "Game action not found." });
  }
  res.json(gameSummary(room));
});

app.use("/api", (err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("API request failed:", err);
  res.status(500).json({ error: "The request could not be completed." });
});

app.use(express.static(path.join(__dirname, "public")));

function createPin() {
  let pin;
  do {
    pin = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  } while (rooms.has(pin));
  return pin;
}

function publicPlayer(player) {
  return { id: player.userId, nickname: player.nickname, score: player.score, connected: player.connected };
}

function leaderboard(room) {
  return [...room.players.values()]
    .map(publicPlayer)
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname))
    .map((player, index) => ({ ...player, rank: index + 1 }));
}

function hostRoomState(room) {
  return {
    id: room.id,
    pin: room.pin,
    title: room.title,
    status: room.status,
    players: [...room.players.values()].map(publicPlayer),
    questionCount: room.questions.length,
    currentQuestion: room.currentIndex + 1,
    settings: { ...room.settings }
  };
}

function gameSummary(room) {
  const record = {
    ...hostRoomState(room),
    createdAt: room.createdAt,
    startedAt: room.startedAt || null,
    endedAt: room.endedAt || null,
    leaderboard: leaderboard(room)
  };
  return record;
}

function createGameRoom({ adminId, title, questions: selectedQuestions, settings }) {
  const pin = createPin();
  const room = {
    id: crypto.randomUUID(),
    pin,
    adminId,
    title,
    status: "lobby",
    players: new Map(),
    questions: selectedQuestions.map((question) => ({ ...question, options: [...question.options] })),
    createdAt: new Date().toISOString(),
    settings: {
      startingScore: settings.startingScore,
      n1: settings.n1,
      n2: settings.n2
    },
    currentIndex: -1,
    questionStartedAt: 0,
    questionEndsAt: 0,
    pausedAt: 0,
    pausedDurationMs: 0,
    remainingMs: 0,
    startedAt: null,
    endedAt: null,
    hostSocketId: null,
    timer: null,
    cleanupTimer: setTimeout(() => cleanupRoom(room), ROOM_TTL_MS)
  };
  rooms.set(pin, room);
  saveGame(room);
  return room;
}

function emitRoom(room, event, payload) {
  io.to(room.pin).emit(event, payload);
}

function cleanupRoom(room) {
  if (room.timer) clearTimeout(room.timer);
  if (room.status !== "finished") {
    room.status = "interrupted";
    room.endedAt = new Date().toISOString();
    saveGame(room);
  }
  rooms.delete(room.pin);
}

function clearRoomTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function beginReview(room) {
  if (room.status !== "question") return;
  clearRoomTimer(room);
  room.status = "review";
  const question = room.questions[room.currentIndex];
  for (const player of room.players.values()) {
    const rank = leaderboard(room).findIndex((entry) => entry.id === player.userId) + 1;
    io.to(player.socketId).emit("game:feedback", {
      answered: player.answerIndex !== null,
      correct: player.answerIndex === null ? null : player.answerIndex === question.correctIndex,
      points: player.lastPoints || 0,
      score: player.score,
      rank,
      correctAnswer: question.options[question.correctIndex]
    });
  }
  emitRoom(room, "game:review", reviewPayload(room));
  saveGame(room);
}

function reviewPayload(room) {
  const question = room.questions[room.currentIndex];
  const distribution = [0, 0, 0, 0, 0];
  for (const player of room.players.values()) {
    distribution[player.answerIndex === null ? 4 : player.answerIndex] += 1;
  }
  return {
    question: question.question,
    options: question.options,
    correctIndex: question.correctIndex,
    distribution,
    leaderboard: leaderboard(room).slice(0, 5),
    isLastQuestion: room.currentIndex === room.questions.length - 1
  };
}

function startQuestion(room) {
  if (room.status === "finished") return;
  room.currentIndex += 1;
  if (room.currentIndex >= room.questions.length) {
    room.status = "finished";
    room.endedAt = new Date().toISOString();
    const finalLeaderboard = leaderboard(room);
    emitRoom(room, "game:podium", { leaderboard: finalLeaderboard });
    saveGame(room);
    return;
  }

  const question = room.questions[room.currentIndex];
  room.status = "question";
  room.pausedDurationMs = 0;
  room.remainingMs = 0;
  room.questionStartedAt = Date.now();
  room.questionEndsAt = room.questionStartedAt + question.timeLimit * 1000;
  for (const player of room.players.values()) {
    player.answerIndex = null;
    player.lastPoints = 0;
  }
  emitRoom(room, "game:question", {
    index: room.currentIndex + 1,
    total: room.questions.length,
    question: question.question,
    options: question.options,
    timeLimit: question.timeLimit,
    startedAt: room.questionStartedAt,
    deadline: room.questionEndsAt
  });
  emitHostQuestion(room);
  room.timer = setTimeout(() => beginReview(room), question.timeLimit * 1000);
  emitAnswerCount(room);
  saveGame(room);
}

function emitHostQuestion(room) {
  if (!room.hostSocketId) return;
  const question = room.questions[room.currentIndex];
  if (!question) return;
  io.to(room.hostSocketId).emit("game:host-question", {
    ...question,
    index: room.currentIndex + 1,
    total: room.questions.length,
    startedAt: room.questionStartedAt,
    deadline: room.questionEndsAt,
    players: [...room.players.values()].map((player) => ({
      id: player.userId,
      nickname: player.nickname,
      answered: player.answerIndex !== null
    }))
  });
}

function startGame(room) {
  if (room.status !== "lobby") return "This game is not in the lobby.";
  if (!room.questions.length) return "Add at least one question before starting.";
  if (![...room.players.values()].some((player) => player.connected)) return "At least one player must join first.";
  room.startedAt = new Date().toISOString();
  for (const player of room.players.values()) {
    player.score = room.settings.startingScore;
    player.answerIndex = null;
    player.lastPoints = 0;
  }
  startQuestion(room);
  return null;
}

function pauseGame(room) {
  if (room.status !== "question") return "Only an active question can be paused.";
  room.remainingMs = Math.max(0, room.questionEndsAt - Date.now());
  room.pausedAt = Date.now();
  clearRoomTimer(room);
  room.status = "paused";
  emitRoom(room, "game:paused", { remainingMs: room.remainingMs });
  saveGame(room);
  return null;
}

function resumeGame(room) {
  if (room.status !== "paused") return "This game is not paused.";
  const now = Date.now();
  room.pausedDurationMs += now - room.pausedAt;
  room.questionEndsAt = now + room.remainingMs;
  room.status = "question";
  room.timer = setTimeout(() => beginReview(room), room.remainingMs);
  emitRoom(room, "game:resumed", { deadline: room.questionEndsAt });
  emitHostQuestion(room);
  saveGame(room);
  return null;
}

function nextGameQuestion(room) {
  if (room.status !== "review") return "The current question must finish before continuing.";
  startQuestion(room);
  return null;
}

function allConnectedPlayersAnswered(room) {
  const connectedPlayers = [...room.players.values()].filter((player) => player.connected);
  return connectedPlayers.length > 0 && connectedPlayers.every((player) => player.answerIndex !== null);
}

function findRoomPlayer(room, socketId) {
  return [...room.players.values()].find((player) => player.socketId === socketId);
}

function emitAnswerCount(room) {
  const players = [...room.players.values()].filter((player) => player.connected);
  const answered = players.filter((player) => player.answerIndex !== null).length;
  emitRoom(room, "game:answer-count", { answered, total: players.length });
}

function normalizeNickname(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

io.use((socket, next) => {
  const cookies = socket.handshake.headers.cookie || "";
  const entry = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const sessionId = entry ? entry.slice(SESSION_COOKIE.length + 1) : "";
  const user = currentUser(sessionId);
  if (!user) return next(new Error("Authentication required."));
  socket.data.sessionId = sessionId;
  socket.data.user = user;
  next();
});

function getSocketUser(socket) {
  const user = currentUser(socket.data.sessionId);
  if (user) socket.data.user = user;
  else socket.disconnect(true);
  return user;
}

io.on("connection", (socket) => {
  socket.on("host:create-room", (ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (getSocketUser(socket)?.role !== "admin") return ack({ error: "Admin access is required to host a game." });
    ack({ error: "Create games from the host panel." });
  });

  socket.on("host:watch", (payload = {}, ack = () => {}) => {
    payload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    ack = typeof ack === "function" ? ack : () => {};
    const user = getSocketUser(socket);
    if (user?.role !== "admin") return ack({ error: "Admin access is required." });
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin.trim() : "");
    if (!room) return ack({ error: "Game PIN not found. Create a game from the host panel first." });
    room.hostSocketId = socket.id;
    socket.data.hostPin = room.pin;
    socket.join(room.pin);
    ack({ game: gameSummary(room), joinOrigin: getLanOrigin() });
    socket.emit("game:lobby", hostRoomState(room));
    if (room.status === "question" || room.status === "paused") emitHostQuestion(room);
    if (room.status === "paused") socket.emit("game:paused", { remainingMs: room.remainingMs });
    if (room.status === "review") socket.emit("game:review", reviewPayload(room));
    if (room.status === "finished") socket.emit("game:podium", { leaderboard: leaderboard(room) });
  });

  socket.on("player:join", (payload = {}, ack = () => {}) => {
    payload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    ack = typeof ack === "function" ? ack : () => {};
    const user = getSocketUser(socket);
    if (user?.role !== "user") return ack({ error: "A player account is required to join." });
    const pin = typeof payload.pin === "string" ? payload.pin.trim() : "";
    const nickname = normalizeNickname(payload.nickname);
    const room = rooms.get(pin);
    if (!/^\d{6}$/.test(pin) || !room) return ack({ error: "That room PIN was not found." });
    if (!nickname || nickname.length > 30) return ack({ error: "Nickname must be 1–30 characters." });
    const existingPlayer = room.players.get(user.id);
    if (!existingPlayer && room.status !== "lobby") return ack({ error: "This game has already started." });
    if (existingPlayer?.connected && existingPlayer.socketId !== socket.id) {
      return ack({ error: "This account is already connected to the game." });
    }
    if (!existingPlayer && room.players.size >= 500) return ack({ error: "This room has reached its player limit." });
    if ([...room.players.values()].some((player) => player.userId !== user.id && player.nickname.toLowerCase() === nickname.toLowerCase())) {
      return ack({ error: "That nickname is already taken in this game. Choose another one." });
    }

    const player = existingPlayer || {
      userId: user.id,
      nickname,
      score: room.settings.startingScore,
      answerIndex: null,
      lastPoints: 0
    };
    player.socketId = socket.id;
    player.connected = true;
    room.players.set(user.id, player);
    socket.join(pin);
    ack({ pin, playerId: player.userId, nickname: player.nickname });
    if (room.status === "lobby") emitRoom(room, "game:lobby", hostRoomState(room));
    else if ((room.status === "question" || room.status === "paused") && player.answerIndex === null) {
      const question = room.questions[room.currentIndex];
      socket.emit("game:question", {
        index: room.currentIndex + 1,
        total: room.questions.length,
        question: question.question,
        options: question.options,
        timeLimit: question.timeLimit,
        startedAt: room.questionStartedAt,
        deadline: room.questionEndsAt
      });
      if (room.status === "paused") socket.emit("game:paused", { remainingMs: room.remainingMs });
    } else if (room.status === "review") {
      socket.emit("game:feedback", {
        answered: player.answerIndex !== null,
        correct: player.answerIndex === null ? null : player.answerIndex === room.questions[room.currentIndex].correctIndex,
        points: player.lastPoints,
        score: player.score,
        rank: leaderboard(room).findIndex((entry) => entry.id === player.userId) + 1
      });
    } else if (room.status === "finished") {
      socket.emit("game:podium", { leaderboard: leaderboard(room) });
    }
    saveGame(room);
  });

  socket.on("host:start", (ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (getSocketUser(socket)?.role !== "admin") return ack({ error: "Admin access is required." });
    const room = [...rooms.values()].find((item) => item.hostSocketId === socket.id);
    if (!room) return ack({ error: "Create a room before starting the game." });
    const error = startGame(room);
    if (error) return ack({ error });
    ack({ ok: true });
  });

  socket.on("player:answer", (payload = {}, ack = () => {}) => {
    payload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    ack = typeof ack === "function" ? ack : () => {};
    if (getSocketUser(socket)?.role !== "user") return ack({ error: "A player account is required." });
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin : "");
    const player = room && findRoomPlayer(room, socket.id);
    if (!room || !player || room.status !== "question") {
      return ack({ error: "There is no active question to answer." });
    }
    if (!Number.isInteger(payload.answerIndex) || payload.answerIndex < 0 || payload.answerIndex > 3) {
      return ack({ error: "Choose one of the four answers." });
    }
    if (player.answerIndex !== null) return ack({ error: "Your answer has already been recorded." });
    if (Date.now() >= room.questionEndsAt) {
      beginReview(room);
      return ack({ error: "Time is up for this question." });
    }

    const question = room.questions[room.currentIndex];
    player.answerIndex = payload.answerIndex;
    const elapsedMs = Math.max(0, Date.now() - room.questionStartedAt - room.pausedDurationMs);
    const elapsedSeconds = Math.max(1, Math.ceil(elapsedMs / 1000));
    if (payload.answerIndex === question.correctIndex) {
      player.lastPoints = Math.max(0, room.settings.n1 - elapsedSeconds + 1);
      player.score += player.lastPoints;
    } else {
      player.lastPoints = -Math.min(player.score, room.settings.n2);
      player.score += player.lastPoints;
    }
    ack({ accepted: true });
    emitAnswerCount(room);
    saveGame(room);
    if (allConnectedPlayersAnswered(room)) beginReview(room);
  });

  socket.on("host:next", (ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (getSocketUser(socket)?.role !== "admin") return ack({ error: "Admin access is required." });
    const room = [...rooms.values()].find((item) => item.hostSocketId === socket.id);
    if (!room || room.status !== "review") return ack({ error: "The game is not ready for the next question." });
    const error = nextGameQuestion(room);
    if (error) return ack({ error });
    ack({ ok: true });
  });

  socket.on("host:pause", (ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (getSocketUser(socket)?.role !== "admin") return ack({ error: "Admin access is required." });
    const room = [...rooms.values()].find((item) => item.hostSocketId === socket.id);
    if (!room) return ack({ error: "Open a game before pausing." });
    const error = pauseGame(room);
    if (error) return ack({ error });
    ack({ ok: true });
  });

  socket.on("host:resume", (ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    if (getSocketUser(socket)?.role !== "admin") return ack({ error: "Admin access is required." });
    const room = [...rooms.values()].find((item) => item.hostSocketId === socket.id);
    if (!room) return ack({ error: "Open a game before resuming." });
    const error = resumeGame(room);
    if (error) return ack({ error });
    ack({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = findRoomPlayer(room, socket.id);
      if (player) {
        player.connected = false;
        if (room.status === "question") {
          emitAnswerCount(room);
          if (allConnectedPlayersAnswered(room)) beginReview(room);
        }
      }
      if (room.hostSocketId === socket.id) {
        room.hostSocketId = null;
      }
      if (player) saveGame(room);
    }
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("Request failed:", err);
  res.status(500).send("An unexpected server error occurred.");
});

async function startServer() {
  questions = await loadQuestions();
  await loadUsers();
  await loadGameHistory();
  await loadSessions();

  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (Boolean(adminEmail) !== Boolean(adminPassword)) {
    throw new Error("Set both ADMIN_EMAIL and ADMIN_PASSWORD to provision the administrator account.");
  }
  if (process.env.NODE_ENV === "production" && (!adminEmail || Buffer.byteLength(adminPassword, "utf8") < 12)) {
    throw new Error("Production requires ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 bytes.");
  }
  if (adminEmail) {
    const adminPasswordLength = Buffer.byteLength(adminPassword, "utf8");
    if (
      adminEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) ||
      adminPasswordLength < 8 ||
      adminPasswordLength > 128
    ) {
      throw new Error("ADMIN_EMAIL must be valid and ADMIN_PASSWORD must be 8–128 bytes.");
    }
    const existingAdmin = users.find((user) => user.email === adminEmail);
    if (existingAdmin && existingAdmin.role !== "admin") {
      throw new Error("ADMIN_EMAIL belongs to a regular user; choose another admin email.");
    }
    if (!existingAdmin) {
      const { salt, hash } = await hashPassword(adminPassword);
      const admin = {
        id: crypto.randomUUID(),
        name: "Administrator",
        email: adminEmail,
        passwordSalt: salt,
        passwordHash: hash,
        role: "admin",
        createdAt: new Date().toISOString()
      };
      if (!await addUser(admin)) {
        throw new Error("Unable to create the configured administrator account.");
      }
      console.log(`Administrator account provisioned: ${adminEmail}`);
    } else {
      const { salt, hash } = await hashPassword(adminPassword);
      await replaceUser(existingAdmin.id, (user) => ({
        ...user,
        passwordSalt: salt,
        passwordHash: hash
      }));
      console.log(`Administrator account loaded: ${adminEmail}`);
    }
  } else {
    console.warn("ADMIN_EMAIL and ADMIN_PASSWORD are not set; no administrator account is provisioned.");
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Science Day Quiz is listening on port ${PORT}`);
    for (const address of getLanAddresses()) console.log(`LAN access: http://${address}:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Unable to start the quiz server:", error);
  process.exitCode = 1;
});
