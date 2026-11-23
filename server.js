const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const QUESTIONS_FILE = path.join(__dirname, "questions.json");
const ROUND_QUESTION_BANKS_FILE = path.join(__dirname, "round-question-banks.json");
const USERS_FILE = path.resolve(process.env.USER_STORE_FILE || path.join(__dirname, "users.json"));
const GAMES_FILE = path.resolve(process.env.GAMES_FILE || path.join(__dirname, "games.json"));
const SESSIONS_FILE = path.resolve(process.env.SESSION_STORE_FILE || path.join(__dirname, "sessions.json"));
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const SESSION_COOKIE = "science_quiz_session";
const DEFAULT_ROUND_ORDER = Object.freeze(["rapid-fire", "main-quiz", "practical"]);
const ROUND_RULES_STATUS = Object.freeze({
  "rapid-fire": "rapid-rules",
  "main-quiz": "quiz-rules",
  practical: "practical-rules"
});
const ROUND_LABELS = Object.freeze({
  "rapid-fire": "Rapid Fire",
  "main-quiz": "Quiz",
  practical: "Practical Quiz"
});
const DEFAULT_ROUND_RULES = Object.freeze({
  "rapid-fire": "Everyone answers the common question together. Fastest correct answers set the calling order. The announcer asks questions verbally during each timed turn; the Admin records answered questions, points per question, and any manual bonus.",
  "main-quiz": "Each question has its own point value and time limit. Correct answers earn fewer points as time passes, with a minimum of one point. Wrong answers and timeouts apply the same fixed penalty.",
  practical: "Participants choose a theme in Rapid Fire order, watch its video, then answer individually. After that, everyone competes in a common buzzer question; only the first two presses are eligible."
});
const DEFAULT_PERMISSIONS = Object.freeze({
  showQuizLeaderboardAndRanks: true,
  showTeamTotalToPlayers: false,
  showUserFinalReport: false
});
// Rapid Fire and Practical Quiz content is managed in round-question-banks.json and the Admin Panel.

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
let roundQuestionBanks = null;
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
    round: room.round,
    settings: { ...room.settings },
    permissions: { ...room.permissions },
    questionCount: room.questions.length,
    currentQuestion: room.currentIndex + 1,
    createdAt: room.createdAt,
    startedAt: room.startedAt || null,
    endedAt: room.endedAt || null,
    players: rankings,
    leaderboard: rankings,
    report: room.status === "finished" ? buildReport(room) : null,
    rapidResults: room.rapidResults.map((item) => ({ ...item })),
    quizResults: room.quizResults.map((item) => ({ ...item })),
    practicalResults: room.practicalResults.map((item) => ({ ...item })),
    buzzerResults: room.buzzer.results.map((item) => ({ ...item }))
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
      if ([
        "lobby", "rapid-rules", "rapid-common", "rapid-turns", "rapid-turn",
        "quiz-rules", "question", "paused", "review", "practical-rules",
        "practical-theme", "practical-video", "practical-question", "buzzer",
        "buzzer-ready", "buzzer-results", "paper-marks", "paper-results"
      ].includes(game.status)) {
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
    if (item.points !== undefined && (!Number.isInteger(item.points) || item.points < 1 || item.points > 1000000)) {
      return `Question ${index + 1} points must be a whole number from 1 to 1,000,000.`;
    }
    if (item.image !== undefined && item.image !== "" &&
        (typeof item.image !== "string" || item.image.length > 2048 || !isSafeMediaUrl(item.image))) {
      return `Question ${index + 1} image must be an HTTPS URL or a local path.`;
    }
    ids.add(item.id);
  }
  return null;
}

function validateRoundQuestionBanks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Round question banks must be an object.";
  }
  const rapidFire = value.rapidFire;
  if (!rapidFire || typeof rapidFire !== "object" || Array.isArray(rapidFire)) {
    return "Rapid Fire questions are missing.";
  }
  const rapidError = validateQuestions(rapidFire.commonQuestions);
  if (rapidError) return `Rapid Fire common questions: ${rapidError}`;
  if (!rapidFire.commonQuestions.length || rapidFire.commonQuestions.length > 100) {
    return "Rapid Fire needs 1–100 common questions.";
  }
  if (!Array.isArray(rapidFire.announcerQuestions) || rapidFire.announcerQuestions.length > 100 ||
      rapidFire.announcerQuestions.some((question) => typeof question !== "string" || !question.trim() || question.length > 500)) {
    return "Rapid Fire announcer questions must be 1–500 characters each, with no more than 100 questions.";
  }

  const practical = value.practical;
  if (!practical || typeof practical !== "object" || Array.isArray(practical)) {
    return "Practical Quiz questions are missing.";
  }
  if (!Array.isArray(practical.themes) || practical.themes.length !== 10) {
    return "Practical Quiz must have exactly ten theme questions.";
  }
  const themeNames = new Set();
  for (const [index, theme] of practical.themes.entries()) {
    if (!theme || typeof theme !== "object" || Array.isArray(theme) ||
        typeof theme.name !== "string" || !theme.name.trim() || theme.name.length > 60 ||
        themeNames.has(theme.name.trim().toLowerCase()) ||
        typeof theme.question !== "string" || !theme.question.trim() || theme.question.length > 500 ||
        typeof theme.answer !== "string" || !theme.answer.trim() || theme.answer.length > 200 ||
        (theme.videoUrl !== undefined && theme.videoUrl !== "" &&
          (typeof theme.videoUrl !== "string" || theme.videoUrl.length > 2048 || !isSafeMediaUrl(theme.videoUrl)))) {
      return `Practical Quiz theme ${index + 1} needs a unique name, question, answer, and a valid optional video URL.`;
    }
    themeNames.add(theme.name.trim().toLowerCase());
  }
  if (!Array.isArray(practical.buzzerQuestions) || practical.buzzerQuestions.length < 1 ||
      practical.buzzerQuestions.length > 100 ||
      practical.buzzerQuestions.some((question) => typeof question !== "string" || !question.trim() || question.length > 500)) {
    return "Practical Quiz needs 1–100 buzzer questions of at most 500 characters each.";
  }
  return null;
}

function isSafeMediaUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.startsWith("//")) return false;
  if (value.startsWith("/") && !value.startsWith("/\\")) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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

async function loadRoundQuestionBanks() {
  const content = await fs.readFile(ROUND_QUESTION_BANKS_FILE, "utf8");
  const parsed = JSON.parse(content);
  const error = validateRoundQuestionBanks(parsed);
  if (error) throw new Error(`Invalid round-question-banks.json: ${error}`);
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

async function persistRoundQuestionBanks(nextBanks) {
  const temporaryFile = `${ROUND_QUESTION_BANKS_FILE}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(nextBanks, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  try {
    await fs.rename(temporaryFile, ROUND_QUESTION_BANKS_FILE);
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

app.get("/api/round-question-banks", requireAdmin, (_req, res) => {
  res.json(roundQuestionBanks);
});

app.post("/api/round-question-banks", requireAdmin, async (req, res, next) => {
  const error = validateRoundQuestionBanks(req.body);
  if (error) return res.status(400).json({ error });
  try {
    await persistRoundQuestionBanks(req.body);
    roundQuestionBanks = req.body;
    res.json({
      rapidCommonCount: roundQuestionBanks.rapidFire.commonQuestions.length,
      rapidAnnouncerCount: roundQuestionBanks.rapidFire.announcerQuestions.length,
      practicalThemeCount: roundQuestionBanks.practical.themes.length,
      practicalBuzzerCount: roundQuestionBanks.practical.buzzerQuestions.length
    });
  } catch (saveError) {
    next(saveError);
  }
});

app.get("/api/admin/round-rules", requireAdmin, (_req, res) => {
  res.json(DEFAULT_ROUND_RULES);
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
  const ongoingStatuses = new Set([
    "lobby", "rapid-rules", "rapid-common", "rapid-turns", "rapid-turn",
    "quiz-rules", "question", "paused", "review", "practical-rules",
    "practical-theme", "practical-video", "practical-question", "buzzer",
    "buzzer-ready", "buzzer-results", "paper-marks", "paper-results"
  ]);
  res.json(
    [...rooms.values()]
      .filter((room) => ongoingStatuses.has(room.status))
      .map((room) => ({ ...gameSummary(room), live: true }))
  );
});

app.get("/api/events", (_req, res) => {
  const stages = {
    lobby: ["Joining", "Open lobby"],
    "rapid-rules": ["Rapid Fire", "Rules"],
    "rapid-common": ["Rapid Fire", "Common question"],
    "rapid-turns": ["Rapid Fire", "Leaderboard turns"],
    "rapid-turn": ["Rapid Fire", "Live turn"],
    "quiz-rules": ["Quiz", "Rules"],
    question: ["Quiz", "Question in progress"],
    paused: ["Quiz", "Paused"],
    review: ["Quiz", "Reviewing answers"],
    "practical-rules": ["Practical Quiz", "Rules"],
    "practical-theme": ["Practical Quiz", "Theme selection"],
    "practical-video": ["Practical Quiz", "Video stage"],
    "practical-question": ["Practical Quiz", "Individual question"],
    buzzer: ["Practical Quiz", "Buzzer is open"],
    "buzzer-ready": ["Practical Quiz", "Buzzer round"],
    "buzzer-results": ["Practical Quiz", "Buzzer results"],
    "paper-marks": ["Final Paper Marks", "Admin entry in progress"],
    "paper-results": ["Final Paper Marks", "Marks added; final standings pending"]
  };
  const events = [...rooms.values()]
    .filter((room) => stages[room.status])
    .map((room) => {
      const [round, status] = stages[room.status];
      return {
        title: room.title,
        round,
        status,
        playerCount: [...room.players.values()].filter((player) => player.connected).length,
        questionCount: room.questions.length,
        roundOrder: [...room.roundOrder.map((roundName) => ROUND_LABELS[roundName]), "Final Paper Marks"],
        joinPin: room.status === "lobby" ? room.pin : null
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
  res.json(events);
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
  const roundOrder = req.body?.roundOrder === undefined ? [...DEFAULT_ROUND_ORDER] : req.body.roundOrder;
  const rapidQuestionId = req.body?.rapidQuestionId === undefined
    ? roundQuestionBanks.rapidFire.commonQuestions[0]?.id
    : req.body.rapidQuestionId;
  const submittedRules = req.body?.roundRules === undefined ? DEFAULT_ROUND_RULES : req.body.roundRules;
  const roundRules = {};
  if (!title || title.length > 80) return res.status(400).json({ error: "Game name must be 1–80 characters." });
  if (!submittedRules || typeof submittedRules !== "object" || Array.isArray(submittedRules)) {
    return res.status(400).json({ error: "Enter the rules for each competition round." });
  }
  for (const round of DEFAULT_ROUND_ORDER) {
    const text = submittedRules[round];
    if (typeof text !== "string" || !text.trim() || text.trim().length > 1000) {
      return res.status(400).json({ error: `Rules for ${ROUND_LABELS[round]} must be 1–1,000 characters.` });
    }
    roundRules[round] = text.trim();
  }
  if (
    !Array.isArray(roundOrder) ||
    roundOrder.length !== DEFAULT_ROUND_ORDER.length ||
    new Set(roundOrder).size !== DEFAULT_ROUND_ORDER.length ||
    roundOrder.some((round) => !DEFAULT_ROUND_ORDER.includes(round))
  ) {
    return res.status(400).json({ error: "Select Rapid Fire, Quiz, and Practical Quiz exactly once." });
  }
  if (roundOrder.indexOf("rapid-fire") > roundOrder.indexOf("practical")) {
    return res.status(400).json({ error: "Rapid Fire must come before Practical Quiz because Practical uses its leaderboard order." });
  }
  const rapidQuestion = roundQuestionBanks.rapidFire.commonQuestions.find((question) => question.id === rapidQuestionId);
  if (!rapidQuestion) return res.status(400).json({ error: "Select a Rapid Fire common question before creating the game." });
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
      settings,
      roundOrder,
      roundRules,
      rapidQuestion,
      rapidAnnouncerQuestions: roundQuestionBanks.rapidFire.announcerQuestions,
      practicalThemes: roundQuestionBanks.practical.themes,
      buzzerQuestions: roundQuestionBanks.practical.buzzerQuestions
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
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  let error = null;
  if (action === "start") {
    error = startGame(room);
  } else if (action === "pause") {
    error = pauseGame(room);
  } else if (action === "resume") {
    error = resumeGame(room);
  } else if (action === "next") {
    error = nextGameQuestion(room);
  } else if (action === "rapid-common") {
    if (room.status !== "rapid-rules") error = "Rapid Fire rules must be shown before starting.";
    else startRapidCommon(room);
  } else if (action === "rapid-turn") {
    error = beginRapidTurn(room, body.duration);
  } else if (action === "rapid-turn-finish") {
    error = finishRapidTurn(room, body.answeredCount, body.pointsPerQuestion, body.manualPoints);
  } else if (action === "quiz-start") {
    if (room.status !== "quiz-rules") error = "Quiz rules must be shown before starting.";
    else startQuizRound(room);
  } else if (action === "practical-start") {
    if (!Number.isInteger(body.points) || body.points < 1 || body.points > 1000000) {
      error = "Practical points must be a whole number from 1 to 1,000,000.";
    } else if (!Number.isInteger(body.timeLimit) || body.timeLimit < 5 || body.timeLimit > 120) {
      error = "Practical question time must be from 5 to 120 seconds.";
    } else {
      room.practicalPoints = body.points;
      room.practicalTimeLimit = body.timeLimit;
      error = beginPracticalStage(room);
    }
  } else if (action === "practical-video-next") {
    if (room.status !== "practical-video") error = "There is no practical video playing.";
    else startPracticalQuestion(room);
  } else if (action === "buzzer-start") {
    error = startBuzzer(room, body.question, body.duration);
  } else if (action === "buzzer-close") {
    if (room.status !== "buzzer") error = "The buzzer is not collecting presses.";
    else {
      clearRoomTimer(room);
      room.buzzer.status = "ready";
      room.status = "buzzer-ready";
      emitRoundState(room);
    }
  } else if (action === "buzzer-chance") {
    error = grantBuzzerChance(room, body.duration);
  } else if (action === "buzzer-resolve") {
    if (typeof body.correct !== "boolean" || !Number.isInteger(body.points) || body.points < 0 || body.points > 1000000) {
      error = "Set whether the answer is correct and a point value from 0 to 1,000,000.";
    } else {
      error = resolveBuzzerChance(room, body.correct, body.points, body.correct ? "correct" : "wrong");
    }
  } else if (action === "round-next") {
    error = continueAfterPractical(room);
  } else if (action === "paper-start") {
    error = startPaperMarks(room);
  } else if (action === "paper-submit") {
    error = submitPaperMarks(room, body.marks);
  } else if (action === "finish") {
    error = finishCompetition(room);
  } else {
    return res.status(404).json({ error: "Game action not found." });
  }
  if (error) return res.status(400).json({ error });
  res.json(gameSummary(room));
});

app.patch("/api/admin/games/:pin/permissions", requireAdmin, (req, res) => {
  const room = rooms.get(req.params.pin);
  if (!room) return res.status(404).json({ error: "Game not found." });
  const updates = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  for (const key of Object.keys(DEFAULT_PERMISSIONS)) {
    if (typeof updates[key] === "boolean") room.permissions[key] = updates[key];
  }
  if (room.status === "review") {
    emitRoom(room, "game:review", reviewPayload(room));
    emitPlayerFeedback(room);
  }
  if (room.status === "finished") emitFinalResults(room);
  emitRoundState(room);
  res.json(gameSummary(room));
});

app.get("/api/admin/reports", requireAdmin, (req, res) => {
  res.json(gameHistory.map((game) => ({
    id: game.id, title: game.title, pin: game.pin, status: game.status,
    endedAt: game.endedAt, report: game.report || null
  })).filter((game) => game.report));
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

function leaderboard(room, includeScores = true) {
  return [...room.players.values()]
    .map(publicPlayer)
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname))
    .map((player, index) => {
      const entry = { ...player, rank: index + 1 };
      if (!includeScores) delete entry.score;
      return entry;
    });
}

function getRoundNumber(room, round = room.round) {
  if (round === "paper-marks") return room.roundOrder.length + 1;
  const index = room.roundOrder.indexOf(round);
  return index < 0 ? room.roundOrder.length + 1 : index + 1;
}

function nextScheduledRound(room, completedRound) {
  const index = room.roundOrder.indexOf(completedRound);
  return index < 0 ? null : room.roundOrder[index + 1] || null;
}

function advanceAfterRound(room, completedRound) {
  const nextRound = nextScheduledRound(room, completedRound);
  if (nextRound) {
    room.round = nextRound;
    room.status = ROUND_RULES_STATUS[nextRound];
  } else {
    room.round = "paper-marks";
    room.status = "paper-marks";
  }
  emitRoundState(room);
}

function hostRoomState(room) {
  return {
    id: room.id,
    pin: room.pin,
    title: room.title,
    status: room.status,
    players: [...room.players.values()].map((player) => {
      const entry = publicPlayer(player);
      if (!room.permissions.showTeamTotalToPlayers) delete entry.score;
      return entry;
    }),
    questionCount: room.questions.length,
    currentQuestion: room.currentIndex + 1,
    round: room.round,
    roundOrder: [...room.roundOrder],
    roundNumber: getRoundNumber(room),
    settings: { ...room.settings },
    permissions: { ...room.permissions }
  };
}

function gameSummary(room) {
  const record = {
    ...hostRoomState(room),
    createdAt: room.createdAt,
    startedAt: room.startedAt || null,
    endedAt: room.endedAt || null,
    roundRules: { ...room.roundRules },
    leaderboard: leaderboard(room),
    permissions: { ...room.permissions },
    round: room.round,
    rapidOrder: room.rapidOrder.map(({ id, nickname, rank }) => ({ id, nickname, rank })),
    rapidQuestion: { ...room.rapidQuestion, options: [...room.rapidQuestion.options] },
    rapidAnnouncerQuestions: [...room.rapidAnnouncerQuestions],
    practicalThemes: room.practicalThemes.map((theme) => ({ ...theme })),
    buzzerQuestions: [...room.buzzerQuestions],
    practicalIndex: room.practicalIndex || 0,
    practicalPoints: room.practicalPoints,
    practicalTimeLimit: room.practicalTimeLimit,
    quizResults: room.quizResults.map((item) => ({ ...item })),
    rapidTurn: room.rapidTurn ? { ...room.rapidTurn } : null,
    rapidResults: room.rapidResults.map((item) => ({ ...item })),
    practicalResults: room.practicalResults.map((item) => ({ ...item })),
    paperMarks: room.paperMarks.map((item) => ({ ...item })),
    buzzer: {
      question: room.buzzer.question,
      status: room.buzzer.status,
      queue: room.buzzer.queue.map((id) => room.players.get(id)?.nickname || "Participant"),
      chanceIndex: room.buzzer.chanceIndex,
      pendingResponse: room.buzzer.pendingResponse || ""
    },
    report: room.status === "finished" ? buildReport(room) : null
  };
  return record;
}

function publicLeaderboard(room) {
  return leaderboard(room, room.permissions.showTeamTotalToPlayers);
}

function publicRoundState(room) {
  const state = {
    status: room.status,
    round: room.round,
    roundOrder: [...room.roundOrder],
    rulesText: ROUND_RULES_STATUS[room.round] === room.status ? room.roundRules[room.round] : "",
    roundNumber: getRoundNumber(room),
    nextRound: nextScheduledRound(room, room.round),
    permissions: { ...room.permissions },
    leaderboard: room.status === "buzzer-results" ||
      (room.status === "finished" && room.permissions.showUserFinalReport)
      ? publicLeaderboard(room)
      : [],
    rapidOrder: room.rapidOrder.map(({ id, nickname, rank }) => ({ id, nickname, rank })),
    rapidTurn: room.rapidTurn ? { nickname: room.rapidTurn.nickname, deadline: room.rapidTurn.deadline } : null,
    activePlayer: room.activePlayerId ? room.players.get(room.activePlayerId)?.nickname || null : null,
    activePlayerId: room.activePlayerId,
    themes: room.status === "practical-theme" ? room.practicalThemes.map(({ name }) => name) : [],
    theme: room.selectedTheme ? { name: room.selectedTheme.name, videoUrl: room.selectedTheme.videoUrl } : null,
    commonQuestion: room.status === "rapid-common" ? room.rapidQuestion.question : "",
    rapidDeadline: room.status === "rapid-common" ? room.rapidDeadline : 0,
    practicalDeadline: room.status === "practical-question" ? room.practicalDeadline : 0,
    videoDeadline: room.status === "practical-video" ? room.videoDeadline : 0,
    ...(room.permissions.showTeamTotalToPlayers
      ? { totals: [...room.players.values()].map(({ nickname, score }) => ({ nickname, score })) }
      : {}),
    buzzer: {
      question: room.buzzer.question,
      status: room.buzzer.status,
      queue: room.buzzer.queue.map((id) => room.players.get(id)?.nickname || "Participant"),
      chanceIndex: room.buzzer.chanceIndex,
      deadline: room.buzzer.deadline
    }
  };
  if (room.status === "practical-question" && room.activePlayerId) {
    state.practicalQuestion = {
      deadline: room.practicalDeadline,
      activePlayerId: room.activePlayerId
    };
  }
  return state;
}

function emitRoundState(room) {
  emitRoom(room, "game:round-state", publicRoundState(room));
  saveGame(room);
}

function buildReport(room) {
  return {
    title: room.title,
    roundOrder: [...room.roundOrder],
    roundRules: { ...room.roundRules },
    questions: {
      rapidFireCommon: room.rapidQuestion.question,
      rapidFireAnnouncer: [...room.rapidAnnouncerQuestions],
      quiz: room.questions.map(({ question }) => question),
      practicalThemes: room.practicalThemes.map(({ name, question }) => ({ name, question })),
      buzzer: [...room.buzzerQuestions]
    },
    rounds: {
      rapidFire: room.rapidResults.map((item) => ({ ...item })),
      mainQuiz: room.quizResults.map((item) => ({ ...item })),
      practical: room.practicalResults.map((item) => ({ ...item })),
      buzzer: room.buzzer.results.map((item) => ({ ...item })),
      paperMarks: room.paperMarks.map((item) => ({ ...item }))
    },
    finalLeaderboard: leaderboard(room)
  };
}

function createGameRoom({
  adminId,
  title,
  questions: selectedQuestions,
  settings,
  roundOrder,
  roundRules,
  rapidQuestion,
  rapidAnnouncerQuestions,
  practicalThemes,
  buzzerQuestions
}) {
  const pin = createPin();
  const room = {
    id: crypto.randomUUID(),
    pin,
    adminId,
    title,
    roundOrder: [...roundOrder],
    roundRules: { ...roundRules },
    rapidQuestion: { ...rapidQuestion, options: [...rapidQuestion.options] },
    rapidAnnouncerQuestions: [...rapidAnnouncerQuestions],
    practicalThemes: practicalThemes.map((theme) => ({ ...theme })),
    buzzerQuestions: [...buzzerQuestions],
    status: "lobby",
    players: new Map(),
    questions: selectedQuestions.map((question) => ({ ...question, points: question.points || settings.n1, image: question.image || "", options: [...question.options] })),
    createdAt: new Date().toISOString(),
    settings: {
      startingScore: settings.startingScore,
      n1: settings.n1,
      n2: settings.n2
    },
    permissions: { ...DEFAULT_PERMISSIONS },
    round: "lobby",
    currentIndex: -1,
    questionStartedAt: 0,
    questionEndsAt: 0,
    pausedAt: 0,
    pausedDurationMs: 0,
    remainingMs: 0,
    startedAt: null,
    endedAt: null,
    hostSocketId: null,
    rapidOrder: [],
    rapidResults: [],
    quizResults: [],
    practicalResults: [],
    paperMarks: [],
    activePlayerId: null,
    selectedTheme: null,
    practicalPoints: settings.n1,
    practicalDeadline: 0,
    practicalTimeLimit: 20,
    rapidTurn: null,
    buzzer: { question: "", status: "waiting", queue: [], chanceIndex: -1, deadline: 0, results: [] },
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
    if (player.answerIndex === null) {
      player.lastPoints = -Math.min(player.score, room.settings.n2);
      player.score += player.lastPoints;
    }
    room.quizResults.push({
      nickname: player.nickname,
      question: room.currentIndex + 1,
      outcome: player.answerIndex === null ? "timeout" : player.answerIndex === question.correctIndex ? "correct" : "wrong",
      points: player.lastPoints
    });
  }
  emitPlayerFeedback(room);
  emitRoom(room, "game:review", reviewPayload(room));
  emitRoundState(room);
}

function emitPlayerFeedback(room) {
  const question = room.questions[room.currentIndex];
  for (const player of room.players.values()) {
    const rank = leaderboard(room).findIndex((entry) => entry.id === player.userId) + 1;
    io.to(player.socketId).emit("game:feedback", {
      answered: player.answerIndex !== null,
      correct: player.answerIndex === null ? null : player.answerIndex === question.correctIndex,
      ...(room.permissions.showTeamTotalToPlayers ? { points: player.lastPoints || 0 } : {}),
      ...(room.permissions.showTeamTotalToPlayers ? { score: player.score } : {}),
      ...(room.permissions.showQuizLeaderboardAndRanks ? { rank } : {}),
      ...(room.permissions.showQuizLeaderboardAndRanks
        ? { leaderboard: leaderboard(room, room.permissions.showTeamTotalToPlayers) }
        : {}),
      correctAnswer: question.options[question.correctIndex]
    });
  }
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
    leaderboard: room.permissions.showQuizLeaderboardAndRanks
      ? leaderboard(room, room.permissions.showTeamTotalToPlayers)
      : [],
    showLeaderboard: room.permissions.showQuizLeaderboardAndRanks,
    nextRound: nextScheduledRound(room, "main-quiz"),
    isLastQuestion: room.currentIndex === room.questions.length - 1
  };
}

function startQuestion(room) {
  if (room.status === "finished") return;
  room.currentIndex += 1;
  if (room.currentIndex >= room.questions.length) {
    advanceAfterRound(room, "main-quiz");
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
    image: question.image || "",
    timeLimit: question.timeLimit,
    points: question.points,
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
    player.roundScore = 0;
  }
  room.round = room.roundOrder[0];
  room.status = ROUND_RULES_STATUS[room.round];
  emitRoundState(room);
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

function startRapidCommon(room) {
  if (room.status !== "rapid-rules") return "Rapid Fire rules must be shown before starting.";
  const question = room.rapidQuestion;
  room.status = "rapid-common";
  room.rapidStartedAt = Date.now();
  room.rapidDeadline = room.rapidStartedAt + question.timeLimit * 1000;
  for (const player of room.players.values()) {
    player.answerIndex = null;
    player.rapidAnsweredAt = 0;
  }
  emitRoom(room, "game:rapid-common", {
    question: question.question,
    image: question.image || "",
    options: question.options,
    timeLimit: question.timeLimit,
    deadline: room.rapidDeadline
  });
  room.timer = setTimeout(() => finishRapidCommon(room), question.timeLimit * 1000);
  emitRoundState(room);
}

function finishRapidCommon(room) {
  if (room.status !== "rapid-common") return;
  clearRoomTimer(room);
  room.rapidOrder = [...room.players.values()]
    .sort((a, b) => {
      const aCorrect = a.answerIndex === room.rapidQuestion.correctIndex;
      const bCorrect = b.answerIndex === room.rapidQuestion.correctIndex;
      return Number(bCorrect) - Number(aCorrect) ||
        (a.rapidAnsweredAt || Number.MAX_SAFE_INTEGER) - (b.rapidAnsweredAt || Number.MAX_SAFE_INTEGER) ||
        a.nickname.localeCompare(b.nickname);
    })
    .map((player, index) => ({ id: player.userId, nickname: player.nickname, rank: index + 1 }));
  room.rapidTurnIndex = -1;
  room.status = "rapid-turns";
  emitRoundState(room);
}

function beginRapidTurn(room, duration) {
  if (room.status !== "rapid-turns") return "The rapid-fire common question is not complete.";
  if (!Number.isInteger(duration) || duration < 5 || duration > 600) return "Turn duration must be from 5 to 600 seconds.";
  const nextIndex = room.rapidTurnIndex + 1;
  if (nextIndex >= room.rapidOrder.length) {
    room.rapidTurn = null;
    advanceAfterRound(room, "rapid-fire");
    return null;
  }
  room.rapidTurnIndex = nextIndex;
  const user = room.rapidOrder[nextIndex];
  room.rapidTurn = { userId: user.id, nickname: user.nickname, duration, deadline: Date.now() + duration * 1000 };
  room.status = "rapid-turn";
  room.timer = setTimeout(() => finishRapidTurn(room, 0, 0, 0), duration * 1000);
  emitRoom(room, "game:rapid-turn", publicRoundState(room));
  emitRoundState(room);
  return null;
}

function finishRapidTurn(room, answeredCount, pointsPerQuestion, manualPoints) {
  if (room.status !== "rapid-turn" || !room.rapidTurn) return "There is no active rapid-fire turn.";
  clearRoomTimer(room);
  const count = Number.isInteger(answeredCount) ? Math.min(1000, Math.max(0, answeredCount)) : 0;
  const each = Number.isInteger(pointsPerQuestion) ? Math.min(100000, Math.max(0, pointsPerQuestion)) : 0;
  const manual = Number.isInteger(manualPoints) ? Math.min(1000000, Math.max(0, manualPoints)) : 0;
  const points = count * each + manual;
  const player = room.players.get(room.rapidTurn.userId);
  if (player) {
    player.score += points;
    player.roundScore = (player.roundScore || 0) + points;
  }
  room.rapidResults.push({
    nickname: room.rapidTurn.nickname,
    answeredCount: count,
    pointsPerQuestion: each,
    calculatedPoints: count * each,
    manualPoints: manual,
    totalPoints: points
  });
  room.rapidTurn = null;
  const completed = room.rapidTurnIndex >= room.rapidOrder.length - 1;
  room.status = "rapid-turns";
  emitRoom(room, "game:rapid-result", {
    nickname: player?.nickname || "Participant",
    ...(room.permissions.showTeamTotalToPlayers ? { points } : {})
  });
  if (completed) advanceAfterRound(room, "rapid-fire");
  else emitRoundState(room);
  return null;
}

function startQuizRound(room) {
  if (room.status !== "quiz-rules") return "Quiz rules must be shown before starting.";
  room.round = "main-quiz";
  room.currentIndex = -1;
  room.quizResults = [];
  startQuestion(room);
}

function beginPracticalStage(room) {
  if (room.status !== "practical-rules") return "Practical rules must be shown before starting.";
  room.practicalIndex = 0;
  room.status = room.rapidOrder.length ? "practical-theme" : "buzzer-ready";
  room.round = "practical";
  room.activePlayerId = room.rapidOrder[0]?.id || null;
  emitRoom(room, "game:practical-themes", {
    activePlayerId: room.activePlayerId,
    activePlayer: room.rapidOrder[0]?.nickname || null,
    themes: room.practicalThemes.map(({ name }) => name)
  });
  emitRoundState(room);
}

function showPracticalVideo(room, theme) {
  if (room.status !== "practical-theme" || !room.activePlayerId) return "No participant is choosing a practical theme.";
  const selected = room.practicalThemes.find((item) => item.name === theme);
  if (!selected) return "Select one of the available themes.";
  room.selectedTheme = selected;
  room.status = "practical-video";
  room.videoDeadline = Date.now() + 30000;
  emitRoom(room, "game:practical-video", {
    activePlayerId: room.activePlayerId,
    activePlayer: room.players.get(room.activePlayerId)?.nickname || "",
    theme: { name: selected.name, videoUrl: selected.videoUrl },
    duration: 30
  });
  emitRoundState(room);
  room.timer = setTimeout(() => startPracticalQuestion(room), 30000);
  return null;
}

function startPracticalQuestion(room) {
  if (room.status !== "practical-video" || !room.selectedTheme) return;
  clearRoomTimer(room);
  room.status = "practical-question";
  room.practicalDeadline = Date.now() + room.practicalTimeLimit * 1000;
  const player = room.players.get(room.activePlayerId);
  if (player) io.to(player.socketId).emit("game:practical-question", {
    question: room.selectedTheme.question,
    deadline: room.practicalDeadline
  });
  emitRoundState(room);
  room.timer = setTimeout(() => finishPracticalQuestion(room, false), room.practicalTimeLimit * 1000);
}

function finishPracticalQuestion(room, correct) {
  if (room.status !== "practical-question") return;
  clearRoomTimer(room);
  const player = room.players.get(room.activePlayerId);
  const points = correct && player ? room.practicalPoints : 0;
  if (player) {
    player.score += points;
    player.roundScore = (player.roundScore || 0) + points;
  }
  room.practicalResults.push({ nickname: player?.nickname || "Participant", theme: room.selectedTheme.name, correct: Boolean(correct), points });
  if (player) io.to(player.socketId).emit("game:practical-result", {
    correct: Boolean(correct),
    ...(room.permissions.showTeamTotalToPlayers ? { points } : {})
  });
  room.practicalIndex += 1;
  room.activePlayerId = room.rapidOrder[room.practicalIndex]?.id || null;
  room.selectedTheme = null;
  room.status = room.activePlayerId ? "practical-theme" : "buzzer-ready";
  emitRoom(room, "game:practical-next", { activePlayerId: room.activePlayerId, activePlayer: room.players.get(room.activePlayerId)?.nickname || null });
  emitRoundState(room);
}

function startBuzzer(room, question, duration) {
  if (room.status !== "buzzer-ready") return "The individual practical stage is not complete.";
  if (typeof question !== "string" || !question.trim() || question.trim().length > 500) return "Enter a buzzer question of 1–500 characters.";
  if (!room.buzzerQuestions.includes(question.trim())) return "Select a buzzer question from the saved Practical Quiz question bank.";
  if (!Number.isInteger(duration) || duration < 5 || duration > 120) return "Buzzer duration must be from 5 to 120 seconds.";
  room.buzzer = { question: question.trim(), status: "open", queue: [], chanceIndex: -1, deadline: Date.now() + duration * 1000, results: [] };
  room.status = "buzzer";
  room.timer = setTimeout(() => {
    if (room.status === "buzzer" && room.buzzer.status === "open") {
      room.buzzer.status = "closed";
      room.status = "buzzer-ready";
      emitRoundState(room);
    }
  }, duration * 1000);
  emitRoom(room, "game:buzzer-start", { question: room.buzzer.question, deadline: room.buzzer.deadline });
  emitRoundState(room);
  return null;
}

function grantBuzzerChance(room, duration) {
  if (room.status !== "buzzer-ready" || !room.buzzer.queue.length) return "No buzzer participant is waiting for a chance.";
  const next = room.buzzer.chanceIndex + 1;
  if (next > 1 || next >= room.buzzer.queue.length) return "There is no eligible next buzzer chance.";
  if (next === 1 && room.buzzer.results[0]?.correct) return "A correct first answer ends the buzzer round.";
  if (!Number.isInteger(duration) || duration < 5 || duration > 120) return "Buzzer chance duration must be from 5 to 120 seconds.";
  room.buzzer.chanceIndex = next;
  room.buzzer.status = "chance";
  room.buzzer.pendingResponse = "";
  const player = room.players.get(room.buzzer.queue[next]);
  room.buzzer.deadline = Date.now() + duration * 1000;
  if (player) io.to(player.socketId).emit("game:buzzer-chance", {
    question: room.buzzer.question,
    deadline: room.buzzer.deadline,
    chance: next + 1
  });
  room.timer = setTimeout(() => resolveBuzzerChance(room, false, 0, "timeout"), duration * 1000);
  emitRoundState(room);
  return null;
}

function resolveBuzzerChance(room, correct, points, outcome) {
  if (room.status !== "buzzer-ready" || room.buzzer.status !== "chance") return "There is no active buzzer chance.";
  clearRoomTimer(room);
  const player = room.players.get(room.buzzer.queue[room.buzzer.chanceIndex]);
  const awarded = correct && player ? points : 0;
  if (player) {
    player.score += awarded;
    player.roundScore = (player.roundScore || 0) + awarded;
  }
  room.buzzer.results.push({ nickname: player?.nickname || "Participant", outcome, correct: Boolean(correct), points: awarded });
  room.buzzer.status = correct || room.buzzer.chanceIndex >= 1 || room.buzzer.queue.length < 2 ? "complete" : "ready";
  room.status = room.buzzer.status === "complete" ? "buzzer-results" : "buzzer-ready";
  emitRoom(room, "game:buzzer-result", {
    nickname: player?.nickname || "",
    correct: Boolean(correct),
    ...(room.permissions.showTeamTotalToPlayers ? { points: awarded } : {})
  });
  emitRoundState(room);
  return null;
}

function canContinuePractical(room) {
  return room.status === "buzzer-results" ||
    (room.status === "buzzer-ready" && room.buzzer.queue.length === 0 &&
      ["closed", "ready"].includes(room.buzzer.status) && room.buzzer.deadline > 0);
}

function continueAfterPractical(room) {
  if (!nextScheduledRound(room, "practical")) return "There is no scheduled competition round after Practical Quiz.";
  if (!canContinuePractical(room)) return "Resolve eligible buzzer chances before continuing.";
  advanceAfterRound(room, "practical");
  return null;
}

function startPaperMarks(room) {
  if (nextScheduledRound(room, "practical")) return "Complete the scheduled rounds before entering Paper Marks.";
  if (!canContinuePractical(room)) return "Resolve eligible buzzer chances before entering Paper Marks.";
  room.status = "paper-marks";
  room.round = "paper-marks";
  emitRoundState(room);
  return null;
}

function submitPaperMarks(room, entries) {
  if (room.status !== "paper-marks") return "Paper Marks entry is not active.";
  if (!Array.isArray(entries) || entries.length !== room.players.size) {
    return "Enter one Paper Mark value for every participant.";
  }
  const participantIds = new Set([...room.players.keys()]);
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.playerId !== "string" || !participantIds.has(entry.playerId) ||
        seen.has(entry.playerId) || !Number.isSafeInteger(entry.marks) || entry.marks < 0 || entry.marks > 1000000) {
      return "Paper Marks must contain one whole-number value from 0 to 1,000,000 for each participant.";
    }
    seen.add(entry.playerId);
  }
  if (seen.size !== participantIds.size) return "Enter a Paper Mark value for every participant.";

  room.paperMarks = entries.map(({ playerId, marks }) => {
    const player = room.players.get(playerId);
    player.score += marks;
    player.paperMarks = marks;
    return { playerId, nickname: player.nickname, marks };
  });
  room.status = "paper-results";
  emitRoundState(room);
  return null;
}

function emitFinalResults(room) {
  const hostPayload = {
    leaderboard: publicLeaderboard(room),
    showPlayerReport: true,
    showScores: room.permissions.showTeamTotalToPlayers
  };
  if (room.hostSocketId) io.to(room.hostSocketId).emit("game:podium", hostPayload);
  const players = io.to(room.pin).except(room.hostSocketId);
  if (room.permissions.showUserFinalReport) {
    players.emit("game:podium", {
      leaderboard: leaderboard(room, room.permissions.showTeamTotalToPlayers),
      showPlayerReport: true,
      showScores: room.permissions.showTeamTotalToPlayers
    });
  } else {
    players.emit("game:report-locked");
  }
}

function finishCompetition(room) {
  if (room.status !== "paper-results") return "Enter and add Paper Marks before publishing final results.";
  clearRoomTimer(room);
  room.status = "finished";
  room.round = "final";
  room.endedAt = new Date().toISOString();
  emitFinalResults(room);
  emitRoundState(room);
  saveGame(room);
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
    socket.emit("game:round-state", publicRoundState(room));
    if (room.status === "question" || room.status === "paused") emitHostQuestion(room);
    if (room.status === "paused") socket.emit("game:paused", { remainingMs: room.remainingMs });
    if (room.status === "review") socket.emit("game:review", reviewPayload(room));
    if (room.status === "rapid-common") socket.emit("game:rapid-common", {
      question: room.rapidQuestion.question, image: room.rapidQuestion.image || "",
      options: room.rapidQuestion.options, timeLimit: room.rapidQuestion.timeLimit, deadline: room.rapidDeadline
    });
    if (room.status === "practical-video" && room.selectedTheme) socket.emit("game:practical-video", {
      activePlayerId: room.activePlayerId, activePlayer: room.players.get(room.activePlayerId)?.nickname || "",
      theme: { name: room.selectedTheme.name, videoUrl: room.selectedTheme.videoUrl }, duration: 30
    });
    if (room.status === "finished") socket.emit("game:podium", {
      leaderboard: publicLeaderboard(room),
      showScores: room.permissions.showTeamTotalToPlayers,
      showPlayerReport: true
    });
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
      lastPoints: 0,
      roundScore: 0
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
        image: question.image || "",
        timeLimit: question.timeLimit,
        points: question.points,
        startedAt: room.questionStartedAt,
        deadline: room.questionEndsAt
      });
      if (room.status === "paused") socket.emit("game:paused", { remainingMs: room.remainingMs });
    } else if (room.status === "rapid-common" && player.answerIndex === null) {
      const question = room.rapidQuestion;
      socket.emit("game:rapid-common", {
        question: question.question, image: question.image || "", options: question.options,
        timeLimit: question.timeLimit, deadline: room.rapidDeadline
      });
    } else if (room.status === "review") {
      socket.emit("game:feedback", {
        answered: player.answerIndex !== null,
        correct: player.answerIndex === null ? null : player.answerIndex === room.questions[room.currentIndex].correctIndex,
        ...(room.permissions.showTeamTotalToPlayers ? { points: player.lastPoints } : {}),
        ...(room.permissions.showTeamTotalToPlayers ? { score: player.score } : {}),
        ...(room.permissions.showQuizLeaderboardAndRanks ? {
          rank: leaderboard(room).findIndex((entry) => entry.id === player.userId) + 1,
          leaderboard: leaderboard(room, room.permissions.showTeamTotalToPlayers)
        } : {})
      });
    } else if (room.status === "finished") {
      if (room.permissions.showUserFinalReport) {
        socket.emit("game:podium", {
          leaderboard: leaderboard(room, room.permissions.showTeamTotalToPlayers),
          showScores: room.permissions.showTeamTotalToPlayers,
          showPlayerReport: true
        });
      } else {
        socket.emit("game:report-locked");
      }
    }
    socket.emit("game:round-state", publicRoundState(room));
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
    if (!room || !player || !["question", "rapid-common"].includes(room.status)) return ack({ error: "There is no active question to answer." });
    if (!Number.isInteger(payload.answerIndex) || payload.answerIndex < 0 || payload.answerIndex > 3) {
      return ack({ error: "Choose one of the four answers." });
    }
    if (player.answerIndex !== null) return ack({ error: "Your answer has already been recorded." });
    if (room.status === "rapid-common") {
      if (Date.now() >= room.rapidDeadline) {
        finishRapidCommon(room);
        return ack({ error: "Time is up for this question." });
      }
      player.answerIndex = payload.answerIndex;
      player.rapidAnsweredAt = Date.now();
      ack({ accepted: true });
      if ([...room.players.values()].filter((item) => item.connected).every((item) => item.answerIndex !== null)) finishRapidCommon(room);
      return;
    }
    if (Date.now() >= room.questionEndsAt) {
      beginReview(room);
      return ack({ error: "Time is up for this question." });
    }

    const question = room.questions[room.currentIndex];
    player.answerIndex = payload.answerIndex;
    const elapsedMs = Math.max(0, Date.now() - room.questionStartedAt - room.pausedDurationMs);
    const elapsedSeconds = Math.max(1, Math.ceil(elapsedMs / 1000));
    if (payload.answerIndex === question.correctIndex) {
      player.lastPoints = Math.max(1, question.points - elapsedSeconds + 1);
      player.score += player.lastPoints;
    } else {
      player.lastPoints = -Math.min(player.score, room.settings.n2);
      player.score += player.lastPoints;
    }
    ack({ accepted: true });
    emitAnswerCount(room);
    if (allConnectedPlayersAnswered(room)) beginReview(room);
    else emitRoundState(room);
  });

  socket.on("player:theme", (payload = {}, ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    const user = getSocketUser(socket);
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin : "");
    const player = room && findRoomPlayer(room, socket.id);
    if (user?.role !== "user" || !room || !player || player.userId !== room.activePlayerId) return ack({ error: "Only the active participant may choose a theme." });
    const error = showPracticalVideo(room, payload.theme);
    if (error) return ack({ error });
    ack({ accepted: true });
  });

  socket.on("player:practical-video-ended", (payload = {}, ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin : "");
    const player = room && findRoomPlayer(room, socket.id);
    if (room && player && player.userId === room.activePlayerId && room.status === "practical-question") {
      return ack({ accepted: true });
    }
    if (!room || !player || player.userId !== room.activePlayerId || room.status !== "practical-video") {
      return ack({ error: "There is no practical video to finish." });
    }
    startPracticalQuestion(room);
    ack({ accepted: true });
  });

  socket.on("player:practical-answer", (payload = {}, ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin : "");
    const player = room && findRoomPlayer(room, socket.id);
    if (!room || !player || player.userId !== room.activePlayerId || room.status !== "practical-question") {
      return ack({ error: "There is no practical question for you to answer." });
    }
    if (typeof payload.answer !== "string" || payload.answer.trim().length > 500) return ack({ error: "Enter an answer of at most 500 characters." });
    if (Date.now() >= room.practicalDeadline) {
      finishPracticalQuestion(room, false);
      return ack({ error: "Time is up." });
    }
    const correct = payload.answer.trim().toLocaleLowerCase() === room.selectedTheme.answer.trim().toLocaleLowerCase();
    finishPracticalQuestion(room, correct);
    ack({ accepted: true, correct });
  });

  socket.on("player:buzzer", (payload = {}, ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    const user = getSocketUser(socket);
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin : "");
    const player = room && findRoomPlayer(room, socket.id);
    if (user?.role !== "user" || !room || !player || room.status !== "buzzer" || room.buzzer.status !== "open" || Date.now() >= room.buzzer.deadline) {
      return ack({ error: "The buzzer is not open." });
    }
    if (room.buzzer.queue.includes(player.userId)) return ack({ error: "Your buzzer press is already recorded." });
    if (room.buzzer.queue.length >= 2) return ack({ error: "The first two buzzer places are already taken." });
    room.buzzer.queue.push(player.userId);
    const position = room.buzzer.queue.length;
    emitRoom(room, "game:buzzer-pressed", { nickname: player.nickname, position });
    emitRoundState(room);
    ack({ accepted: true, position });
  });

  socket.on("player:buzzer-answer", (payload = {}, ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin : "");
    const player = room && findRoomPlayer(room, socket.id);
    if (!room || !player || room.status !== "buzzer-ready" || room.buzzer.status !== "chance" ||
        room.buzzer.queue[room.buzzer.chanceIndex] !== player.userId) {
      return ack({ error: "You do not currently have a buzzer chance." });
    }
    if (typeof payload.answer !== "string" || !payload.answer.trim() || payload.answer.length > 500) return ack({ error: "Enter an answer of 1–500 characters." });
    if (room.buzzer.pendingResponse) return ack({ error: "Your buzzer answer has already been sent." });
    room.buzzer.pendingResponse = payload.answer.trim();
    if (room.hostSocketId) io.to(room.hostSocketId).emit("game:buzzer-answer", { nickname: player.nickname, answer: room.buzzer.pendingResponse });
    emitRoundState(room);
    ack({ accepted: true });
  });

  socket.on("player:buzzer-pass", (payload = {}, ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin : "");
    const player = room && findRoomPlayer(room, socket.id);
    if (!room || !player || room.status !== "buzzer-ready" || room.buzzer.status !== "chance" ||
        room.buzzer.queue[room.buzzer.chanceIndex] !== player.userId) {
      return ack({ error: "You do not currently have a buzzer chance." });
    }
    const error = resolveBuzzerChance(room, false, 0, "pass");
    if (error) return ack({ error });
    ack({ accepted: true });
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
  roundQuestionBanks = await loadRoundQuestionBanks();
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
