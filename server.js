const crypto = require("node:crypto");
const fsStream = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const PORT_WAS_CONFIGURED = Boolean(process.env.PORT);
const QUESTIONS_FILE = path.join(__dirname, "questions.json");
const ROUND_QUESTION_BANKS_FILE = path.join(__dirname, "round-question-banks.json");
const USERS_FILE = path.resolve(process.env.USER_STORE_FILE || path.join(__dirname, "users.json"));
const GAMES_FILE = path.resolve(process.env.GAMES_FILE || path.join(__dirname, "games.json"));
const SESSIONS_FILE = path.resolve(process.env.SESSION_STORE_FILE || path.join(__dirname, "sessions.json"));
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;
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
  practical: "The top ten Rapid Fire participants choose different themes in order. Each theme has a private question and a shared buzzer question. The Admin records Correct, Wrong, or Not Answered for each answer."
});
const DEFAULT_PERMISSIONS = Object.freeze({
  showQuizLeaderboardAndRanks: true,
  showTeamTotalToPlayers: true,
  showUserFinalReport: true
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
  const addressInfo = server.address();
  const port = addressInfo && typeof addressInfo === "object" ? addressInfo.port : PORT;
  return address ? `http://${address}:${port}` : null;
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
  if (room.reportDeleted) return Promise.resolve();
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
        "practical-theme", "practical-video", "practical-question", "practical-question-review",
        "buzzer", "buzzer-ready", "buzzer-review", "buzzer-results", "paper-marks", "paper-results"
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
        !["user", "shower", "admin"].includes(user.role) ||
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
  if (user.role === "shower") {
    const pin = typeof req.query.pin === "string" && /^\d{6}$/.test(req.query.pin) ? `?pin=${req.query.pin}` : "";
    return res.redirect(`/display.html${pin}`);
  }
  if (user.role !== "admin") return res.redirect("/play.html");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", path.basename(req.path)));
}

function requirePlayerPage(req, res, next) {
  const user = currentUser(getSessionId(req));
  if (!user) return res.redirect("/login.html");
  if (user.role === "admin") return res.redirect("/admin.html");
  if (user.role === "shower") {
    const pin = typeof req.query.pin === "string" && /^\d{6}$/.test(req.query.pin) ? `?pin=${req.query.pin}` : "";
    return res.redirect(`/display.html${pin}`);
  }
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "play.html"));
}

function requireDisplayPage(req, res, next) {
  const user = currentUser(getSessionId(req));
  if (!user) return res.redirect("/login.html");
  if (user.role !== "admin" && user.role !== "shower") return res.redirect("/play.html");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "host.html"));
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
        typeof theme.buzzerQuestion !== "string" || !theme.buzzerQuestion.trim() || theme.buzzerQuestion.length > 500 ||
        typeof theme.buzzerAnswer !== "string" || !theme.buzzerAnswer.trim() || theme.buzzerAnswer.length > 200 ||
        (theme.videoUrl !== undefined && theme.videoUrl !== "" &&
          (typeof theme.videoUrl !== "string" || theme.videoUrl.length > 2048 || !isSafeMediaUrl(theme.videoUrl)))) {
      return `Practical Quiz theme ${index + 1} needs a unique name, both questions and answers, and a valid optional video URL.`;
    }
    themeNames.add(theme.name.trim().toLowerCase());
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
app.get("/display.html", requireDisplayPage);

app.get("/api/questions", requireAdmin, (req, res) => {
  res.json(questions);
});

app.get("/api/round-question-banks", requireAdmin, (_req, res) => {
  res.json(roundQuestionBanks);
});

app.post("/api/admin/media", requireAdmin, async (req, res, next) => {
  const mediaTypes = {
    jpg: { folder: "images", mime: "image/jpeg" }, jpeg: { folder: "images", mime: "image/jpeg" },
    png: { folder: "images", mime: "image/png" }, gif: { folder: "images", mime: "image/gif" },
    webp: { folder: "images", mime: "image/webp" },
    mp4: { folder: "videos", mime: "video/mp4" }, m4v: { folder: "videos", mime: "video/mp4" },
    webm: { folder: "videos", mime: "video/webm" }, ogg: { folder: "videos", mime: "video/ogg" },
    ogv: { folder: "videos", mime: "video/ogg" }, mov: { folder: "videos", mime: "video/quicktime" },
    qt: { folder: "videos", mime: "video/quicktime" }, avi: { folder: "videos", mime: "video/x-msvideo" },
    mkv: { folder: "videos", mime: "video/x-matroska" }, mpg: { folder: "videos", mime: "video/mpeg" },
    mpeg: { folder: "videos", mime: "video/mpeg" }, "3gp": { folder: "videos", mime: "video/3gpp" },
    ts: { folder: "videos", mime: "video/mp2t" }
  };
  const extension = String(req.headers["x-file-extension"] || "").replace(/^\./, "").toLowerCase();
  const media = /^[a-z0-9]{1,8}$/.test(extension) ? mediaTypes[extension] : null;
  if (!media) return res.status(400).json({ error: "Choose a supported image or video file (MP4, M4V, WebM, MOV, Ogg, AVI, MKV, MPEG, 3GP, or TS)." });

  const directory = path.join(PUBLIC_DIR, media.folder);
  const fileName = `${crypto.randomUUID()}.${extension}`;
  const temporaryPath = path.join(directory, `${fileName}.upload`);
  const finalPath = path.join(directory, fileName);
  let size = 0;
  let header = Buffer.alloc(32);
  let headerLength = 0;
  const sizeLimit = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > MAX_MEDIA_BYTES) {
        const error = new Error("The selected file is larger than the 1 GB upload limit.");
        error.status = 413;
        callback(error);
        return;
      }
      if (headerLength < header.length) {
        const part = chunk.subarray(0, header.length - headerLength);
        part.copy(header, headerLength);
        headerLength += part.length;
      }
      callback(null, chunk);
    }
  });

  try {
    await fs.mkdir(directory, { recursive: true });
    await pipeline(req, sizeLimit, fsStream.createWriteStream(temporaryPath, { flags: "wx" }));
    if (!size) {
      await fs.rm(temporaryPath, { force: true });
      return res.status(400).json({ error: "The selected file is empty." });
    }
    const bytes = header.subarray(0, headerLength);
    const isImage = media.folder === "images";
    const validSignature = extension === "jpg" || extension === "jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : extension === "png"
        ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : extension === "gif"
          ? bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")
          : extension === "webp"
            ? bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
            : extension === "ogg" || extension === "ogv"
              ? bytes.subarray(0, 4).toString("ascii") === "OggS"
              : extension === "avi"
                ? bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "AVI "
                : extension === "mpeg" || extension === "mpg"
                  ? bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0xb3])) || bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0xba]))
                  : extension === "ts"
                    ? bytes[0] === 0x47
                    : !isImage && bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" ||
                      (extension === "webm" || extension === "mkv") && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!validSignature) {
      await fs.rm(temporaryPath, { force: true });
      return res.status(400).json({ error: "The selected file contents do not match its file type." });
    }
    await fs.rename(temporaryPath, finalPath);
    res.status(201).json({ path: `/${media.folder}/${fileName}`, mediaType: media.mime, size });
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    if (error.status === 413) return res.status(413).json({ error: error.message });
    next(error);
  }
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
      practicalThemeCount: roundQuestionBanks.practical.themes.length
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
  if (!["admin", "shower", "user"].includes(role)) return res.status(400).json({ error: "Role must be user, shower, or admin." });
  if (req.user.id === id && role !== "admin") {
    return res.status(400).json({ error: "You cannot remove your own administrator access." });
  }
  if (target.role === "admin" && role !== "admin" && users.filter((user) => user.role === "admin").length <= 1) {
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
    "practical-theme", "practical-video", "practical-question", "practical-question-review", "buzzer",
    "buzzer-ready", "buzzer-review", "buzzer-results", "paper-marks", "paper-results"
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
      practicalThemes: roundQuestionBanks.practical.themes
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
  ensureRoomKeys(room);
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
    error = beginRapidTurn(room, body.duration, body.playerId);
  } else if (action === "rapid-turn-finish") {
    error = finishRapidTurn(room, body.marks);
  } else if (action === "rapid-next") {
    error = continueAfterRapidFire(room);
  } else if (action === "quiz-start") {
    if (room.status !== "quiz-rules") error = "Quiz rules must be shown before starting.";
    else startQuizRound(room);
  } else if (action === "practical-start") {
    if (!Number.isInteger(body.timeLimit) || body.timeLimit < 5 || body.timeLimit > 120) {
      error = "Practical question time must be from 5 to 120 seconds.";
    } else {
      room.practicalTimeLimit = body.timeLimit;
      error = beginPracticalStage(room);
    }
  } else if (action === "practical-resolve") {
    error = resolvePracticalQuestion(room, body.outcome);
  } else if (action === "practical-stop-timer") {
    if (room.status === "practical-question") {
      clearRoomTimer(room);
      room.practicalDeadline = 0;
      room.status = "practical-question-review";
      emitRoundState(room);
    } else if (room.status === "practical-question-review") {
      // The countdown may expire between the Admin click and this request.
      // Treat that race as a successful stop so the control never reports a false failure.
      clearRoomTimer(room);
      room.practicalDeadline = 0;
      emitRoundState(room);
    } else {
      error = "The practical question timer is not active.";
    }
  } else if (action === "practical-timeout") {
    if (!["practical-question", "practical-question-review"].includes(room.status)) {
      error = "The private practical question is not active.";
    } else {
      if (room.status === "practical-question") {
        clearRoomTimer(room);
        room.practicalDeadline = 0;
        room.practicalPendingAnswer = "";
        room.status = "practical-question-review";
      }
      error = resolvePracticalQuestion(room, "unanswered");
    }
  } else if (action === "practical-next") {
    error = continuePracticalTheme(room);
  } else if (action === "practical-video-next") {
    if (room.status !== "practical-video") error = "There is no practical video playing.";
    else startPracticalQuestion(room);
  } else if (action === "practical-theme") {
    error = showPracticalVideo(room, body.theme);
  } else if (action === "buzzer-start") {
    error = startBuzzer(room, body.duration);
  } else if (action === "buzzer-close") {
    if (room.status === "buzzer") {
      clearRoomTimer(room);
      room.buzzer.status = "closed";
      room.buzzer.deadline = 0;
      room.status = "buzzer-ready";
      emitRoundState(room);
    } else if (room.status === "buzzer-ready" && room.buzzer.status === "closed") {
      // The buzz window may expire just as the Admin clicks Stop timer.
      clearRoomTimer(room);
      room.buzzer.deadline = 0;
      emitRoundState(room);
    } else {
      error = "The buzzer is not collecting presses.";
    }
  } else if (action === "buzzer-stop-timer") {
    if (room.status === "buzzer-ready" && room.buzzer.status === "chance") {
      clearRoomTimer(room);
      room.buzzer.deadline = 0;
      room.buzzer.status = "review";
      room.status = "buzzer-review";
      emitRoundState(room);
    } else if (room.status !== "buzzer-review" || room.buzzer.status !== "review") {
      error = "There is no active buzzer answer timer to stop.";
    }
  } else if (action === "buzzer-chance") {
    error = grantBuzzerChance(room, body.duration);
  } else if (action === "buzzer-resolve") {
    error = resolveBuzzerChance(room, body.outcome);
  } else if (action === "buzzer-finish") {
    error = finishBuzzerWithoutSecond(room);
  } else if (action === "round-next") {
    error = continuePracticalTheme(room);
  } else if (action === "paper-submit") {
    error = submitPaperMarks(room, body.marks);
  } else if (action === "paper-add") {
    error = addSingleMark(room, body.playerId, body.marks);
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
    if (key === "showUserFinalReport") continue;
    if (typeof updates[key] === "boolean") room.permissions[key] = updates[key];
  }
  room.permissions.showUserFinalReport = true;
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

app.delete("/api/admin/reports/:id", requireAdmin, async (req, res, next) => {
  const report = gameHistory.find((game) => game.id === req.params.id && game.report);
  if (!report) return res.status(404).json({ error: "Completed report not found." });

  const room = [...rooms.values()].find((item) => item.id === report.id);
  const previousHistory = gameHistory;
  const previousDeleted = room?.reportDeleted;
  gameHistory = gameHistory.filter((game) => game.id !== report.id);
  if (room) room.reportDeleted = true;
  try {
    await persistGameHistory();
    res.json({ deleted: true });
  } catch (error) {
    gameHistory = previousHistory;
    if (room) room.reportDeleted = previousDeleted;
    next(error);
  }
});

app.use("/api", (err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error("API request failed:", err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status === 413
    ? "The selected file is larger than the 1 GB upload limit."
    : status >= 500 && err.message
      ? `Upload failed: ${err.message}`
      : "The request could not be completed.";
  res.status(status).json({ error: message });
});

app.use("/buzzer", express.static(path.join(__dirname, "public", "Buzzer")));
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
    players: [...room.players.values()].map((player) => ({ id: player.userId, nickname: player.nickname })),
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
    practicalOrder: room.practicalOrder.map(({ id, nickname, rank }) => ({ id, nickname, rank })),
    activePlayerId: room.activePlayerId,
    rapidQuestion: { ...room.rapidQuestion, options: [...room.rapidQuestion.options] },
    rapidAnnouncerQuestions: [...room.rapidAnnouncerQuestions],
    practicalThemes: room.practicalThemes.map((theme) => ({ ...theme })),
    usedPracticalThemes: [...room.usedPracticalThemes],
    practicalIndex: room.practicalIndex || 0,
    practicalTurns: room.practicalTurns || 0,
    practicalTimeLimit: room.practicalTimeLimit,
    practicalPendingAnswer: room.practicalPendingAnswer,
    selectedTheme: room.selectedTheme ? { ...room.selectedTheme } : null,
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
      pendingResponse: room.buzzer.pendingResponse || "",
      windowSeconds: room.buzzer.windowSeconds || 20,
      canReopen: room.buzzer.queue.length < 2 && room.buzzer.queue.length < room.players.size
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
    leaderboard: room.status === "finished"
      ? leaderboard(room).map((player) => ({
          ...player,
          paperMarks: room.players.get(player.id)?.paperMarks || 0
        }))
      : [],
    rapidOrder: room.rapidOrder.map(({ id, nickname, rank }) => ({ id, nickname, rank })),
    practicalIndex: room.practicalIndex || 0,
    practicalTurns: room.practicalTurns || 0,
    practicalQueue: room.status === "practical-theme" && room.practicalOrder[room.practicalIndex]
      ? [{ id: room.practicalOrder[room.practicalIndex].id, nickname: room.practicalOrder[room.practicalIndex].nickname, rank: room.practicalIndex + 1 }]
      : [],
    practicalOrder: room.practicalOrder.map(({ id, nickname, rank }) => ({ id, nickname, rank })),
    rapidCompletedCount: room.rapidResults.length,
    rapidTurn: room.rapidTurn ? { nickname: room.rapidTurn.nickname, deadline: room.rapidTurn.deadline } : null,
    activePlayer: room.activePlayerId ? room.players.get(room.activePlayerId)?.nickname || null : null,
    activePlayerId: room.activePlayerId,
    themes: room.status === "practical-theme"
      ? room.practicalThemes.filter(({ name }) => !room.usedPracticalThemes.includes(name)).map(({ name }) => name)
      : [],
    usedThemes: [...room.usedPracticalThemes],
    theme: room.selectedTheme ? { name: room.selectedTheme.name, videoUrl: room.selectedTheme.videoUrl } : null,
    commonQuestion: room.status === "rapid-common" ? room.rapidQuestion.question : "",
    rapidDeadline: room.status === "rapid-common" ? room.rapidDeadline : 0,
    practicalDeadline: room.status === "practical-question" ? room.practicalDeadline : 0,
    ...(room.permissions.showTeamTotalToPlayers && !["paper-marks", "paper-results"].includes(room.status)
      ? { totals: [...room.players.values()].map(({ nickname, score }) => ({ nickname, score })) }
      : {}),
    buzzer: {
      question: "",
      status: room.buzzer.status,
      queue: room.buzzer.queue.map((id) => room.players.get(id)?.nickname || "Participant"),
      chanceIndex: room.buzzer.chanceIndex,
      deadline: room.buzzer.deadline,
      windowSeconds: room.buzzer.windowSeconds || 20,
      canReopen: room.buzzer.queue.length < 2 && room.buzzer.queue.length < room.players.size
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
  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit("game:practical-admin-state", {
      selectedTheme: room.selectedTheme ? {
        name: room.selectedTheme.name,
        question: room.selectedTheme.question,
        answer: room.selectedTheme.answer,
        buzzerQuestion: room.selectedTheme.buzzerQuestion,
        buzzerAnswer: room.selectedTheme.buzzerAnswer
      } : null,
      practicalTimeLimit: room.practicalTimeLimit
    });
  }
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
      practicalThemes: room.practicalThemes.map(({ name, question, answer, buzzerQuestion, buzzerAnswer }) => ({
        name, question, answer, buzzerQuestion, buzzerAnswer
      }))
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
  practicalThemes
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
    usedPracticalThemes: [],
    practicalOrder: [],
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
    practicalPendingAnswer: "",
    paperMarks: [],
    activePlayerId: null,
    practicalIndex: 0,
    practicalTurns: 0,
    selectedTheme: null,
    practicalDeadline: 0,
    practicalTimeLimit: 20,
    rapidTurn: null,
    buzzer: { question: "", status: "waiting", queue: [], chanceIndex: -1, deadline: 0, windowSeconds: 20, results: [] },
    timer: null,
    cleanupTimer: setTimeout(() => cleanupRoom(room), ROOM_TTL_MS)
  };
  rooms.set(pin, room);
  saveGame(room);
  return room;
}

function ensureRoomKeys(room) {
  if (!Number.isInteger(room.practicalIndex)) room.practicalIndex = 0;
  if (!Number.isInteger(room.practicalTurns)) room.practicalTurns = Math.min(room.usedPracticalThemes.length, room.practicalOrder.length);
  if (!Number.isInteger(room.practicalTimeLimit)) room.practicalTimeLimit = 20;
  if (!Array.isArray(room.paperMarks)) room.paperMarks = [];
  if (!Array.isArray(room.rapidResults)) room.rapidResults = [];
  if (!Array.isArray(room.quizResults)) room.quizResults = [];
  if (!Array.isArray(room.practicalResults)) room.practicalResults = [];
  if (!Array.isArray(room.usedPracticalThemes)) room.usedPracticalThemes = [];
  if (!Array.isArray(room.practicalOrder)) room.practicalOrder = [];
  if (!Array.isArray(room.rapidOrder)) room.rapidOrder = [];
  if (!room.buzzer || typeof room.buzzer !== "object") room.buzzer = { question: "", status: "waiting", queue: [], chanceIndex: -1, deadline: 0, windowSeconds: 20, results: [] };
  if (!Array.isArray(room.buzzer.queue)) room.buzzer.queue = [];
  if (!Array.isArray(room.buzzer.results)) room.buzzer.results = [];
  if (!room.roundRules) room.roundRules = { ...DEFAULT_ROUND_RULES };
  if (!room.permissions) room.permissions = { ...DEFAULT_PERMISSIONS };
  if (!room.settings) room.settings = { startingScore: 0, n1: 20, n2: 5 };
}

function emitRoom(room, event, payload) {
  io.to(room.pin).emit(event, payload);
}

function emitTimerEnd(room, round, deadline) {
  emitRoom(room, "game:timer-end", { round, deadline });
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
  room.timer = setTimeout(() => {
    emitTimerEnd(room, "main-quiz", room.questionEndsAt);
    beginReview(room);
  }, question.timeLimit * 1000);
  emitAnswerCount(room);
  saveGame(room);
}

function emitHostQuestion(room) {
  const question = room.questions[room.currentIndex];
  if (!question) return;
  const hostQuestion = {
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
  };
  if (room.hostSocketId) io.to(room.hostSocketId).emit("game:host-question", hostQuestion);
  io.to(`display:${room.pin}`).emit("game:host-question", {
    question: question.question,
    options: question.options,
    image: question.image || "",
    timeLimit: question.timeLimit,
    points: question.points,
    index: room.currentIndex + 1,
    total: room.questions.length,
    startedAt: room.questionStartedAt,
    deadline: room.questionEndsAt
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
  room.timer = setTimeout(() => {
    emitTimerEnd(room, "main-quiz", room.questionEndsAt);
    beginReview(room);
  }, room.remainingMs);
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
  room.timer = setTimeout(() => {
    emitTimerEnd(room, "rapid-fire", room.rapidDeadline);
    finishRapidCommon(room);
  }, question.timeLimit * 1000);
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
  room.status = "rapid-turns";
  emitRoundState(room);
}

function beginRapidTurn(room, duration, playerId) {
  if (room.status !== "rapid-turns") return "The rapid-fire common question is not complete.";
  if (!Number.isInteger(duration) || duration < 5 || duration > 600) return "Turn duration must be from 5 to 600 seconds.";
  const nextIndex = room.rapidResults.length;
  if (nextIndex >= room.rapidOrder.length) return "All Rapid Fire turns are complete. Continue to the next round.";
  const user = room.rapidOrder[nextIndex];
  if (typeof playerId !== "string" || playerId !== user.id) {
    return `Select ${user.nickname} next in the Rapid Fire calling order.`;
  }
  room.rapidTurn = { userId: user.id, nickname: user.nickname, duration, deadline: Date.now() + duration * 1000 };
  room.status = "rapid-turn";
  room.timer = setTimeout(() => {
    if (room.status !== "rapid-turn" || !room.rapidTurn) return;
    emitTimerEnd(room, "rapid-fire", room.rapidTurn.deadline);
    room.timer = null;
    emitRoundState(room);
  }, duration * 1000);
  emitRoom(room, "game:rapid-turn", publicRoundState(room));
  emitRoundState(room);
  return null;
}

function finishRapidTurn(room, marks) {
  if (room.status !== "rapid-turn" || !room.rapidTurn) return "There is no active rapid-fire turn.";
  if (!Number.isSafeInteger(marks) || marks < 0 || marks > 1000000) {
    return "Marks must be a whole number from 0 to 1,000,000.";
  }
  clearRoomTimer(room);
  const points = marks;
  const player = room.players.get(room.rapidTurn.userId);
  if (player) {
    player.score += points;
    player.roundScore = (player.roundScore || 0) + points;
  }
  room.rapidResults.push({
    nickname: room.rapidTurn.nickname,
    marks,
    totalPoints: points
  });
  room.rapidTurn = null;
  room.status = "rapid-turns";
  emitRoom(room, "game:rapid-result", {
    nickname: player?.nickname || "Participant",
    ...(room.permissions.showTeamTotalToPlayers ? { points } : {})
  });
  emitRoundState(room);
  return null;
}

function continueAfterRapidFire(room) {
  if (room.status !== "rapid-turns") return "Rapid Fire turns are not ready to continue.";
  if (room.rapidResults.length < room.rapidOrder.length) {
    return "Record marks for every participant before continuing.";
  }
  advanceAfterRound(room, "rapid-fire");
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
  room.practicalOrder = room.rapidOrder.slice(0, room.practicalThemes.length);
  room.practicalTurns = 0;
  room.round = "practical";
  room.activePlayerId = room.practicalOrder[0]?.id || null;
  room.status = room.activePlayerId ? "practical-theme" : "buzzer-results";
  if (!room.activePlayerId) {
    advanceAfterRound(room, "practical");
    return null;
  }
  emitRoom(room, "game:practical-themes", {
    activePlayerId: room.activePlayerId,
    activePlayer: room.practicalOrder[0].nickname,
    themes: room.practicalThemes.map(({ name }) => name)
  });
  emitRoundState(room);
  return null;
}

function showPracticalVideo(room, theme) {
  if (room.status !== "practical-theme" || !room.activePlayerId) return "No participant is choosing a practical theme.";
  const selected = room.practicalThemes.find((item) => item.name === theme);
  if (!selected || room.usedPracticalThemes.includes(selected.name)) return "Select an available theme that has not already been used.";
  clearRoomTimer(room);
  room.practicalDeadline = 0;
  room.selectedTheme = selected;
  room.usedPracticalThemes.push(selected.name);
  room.status = "practical-video";
  emitRoom(room, "game:practical-video", {
    activePlayerId: room.activePlayerId,
    activePlayer: room.players.get(room.activePlayerId)?.nickname || "",
    theme: { name: selected.name, videoUrl: selected.videoUrl }
  });
  emitRoundState(room);
  return null;
}

function startPracticalQuestion(room) {
  if (room.status !== "practical-video" || !room.selectedTheme) return;
  clearRoomTimer(room);
  room.status = "practical-question";
  room.practicalPendingAnswer = "";
  room.practicalDeadline = Date.now() + room.practicalTimeLimit * 1000;
  const player = room.players.get(room.activePlayerId);
  if (player) io.to(player.socketId).emit("game:practical-question", {
    deadline: room.practicalDeadline
  });
  emitRoundState(room);
  room.timer = setTimeout(() => {
    if (room.status !== "practical-question") return;
    emitTimerEnd(room, "practical", room.practicalDeadline);
    room.timer = null;
    room.practicalDeadline = 0;
    room.status = "practical-question-review";
    emitRoundState(room);
  }, room.practicalTimeLimit * 1000);
}

function resolvePracticalQuestion(room, outcome) {
  if (!["correct", "wrong", "unanswered"].includes(outcome)) return "Choose Correct, Wrong, or Not Answered.";
  if (room.status === "practical-question") {
    clearRoomTimer(room);
    room.practicalDeadline = 0;
    room.status = "practical-question-review";
  }
  if (room.status !== "practical-question-review") {
    return "The private practical question is not ready to score.";
  }
  clearRoomTimer(room);
  const player = room.players.get(room.activePlayerId);
  const points = outcome === "correct" ? 10 : outcome === "wrong" ? -5 : 0;
  if (player) {
    player.score += points;
    player.roundScore = (player.roundScore || 0) + points;
    player.practicalTurns += 1;
  }
  room.practicalResults.push({
    nickname: player?.nickname || "Participant",
    theme: room.selectedTheme.name,
    question: room.selectedTheme.question,
    expectedAnswer: room.selectedTheme.answer,
    answer: room.practicalPendingAnswer,
    outcome,
    points
  });
  if (player) io.to(player.socketId).emit("game:practical-result", {
    outcome,
    ...(room.permissions.showTeamTotalToPlayers ? { points } : {})
  });
  room.practicalPendingAnswer = "";
  room.buzzer = {
    ...room.buzzer,
    question: room.selectedTheme.buzzerQuestion,
    status: "waiting",
    queue: [],
    chanceIndex: -1,
    deadline: 0,
    pendingResponse: "",
    windowSeconds: 20
  };
  room.status = "buzzer-ready";
  emitRoundState(room);
  return null;
}

function startBuzzer(room, duration) {
  if (room.status !== "buzzer-ready" || !room.selectedTheme) return "The shared question is not ready.";
  if (!["waiting", "closed", "ready"].includes(room.buzzer.status)) return "The buzzer cannot be opened in its current state.";
  if (room.buzzer.queue.length >= 2 || room.buzzer.queue.length >= room.players.size) {
    return "There are no more eligible participants to buzz.";
  }
  if (room.buzzer.queue.length > room.buzzer.chanceIndex + 1) {
    return "The granted buzzer chances must be completed before the buzzer reopens.";
  }
  room.buzzer.status = "open";
  room.buzzer.windowSeconds = duration;
  room.buzzer.deadline = Date.now() + duration * 1000;
  room.status = "buzzer";
  room.timer = setTimeout(() => {
    if (room.status === "buzzer" && room.buzzer.status === "open") {
      emitTimerEnd(room, "practical", room.buzzer.deadline);
      room.timer = null;
      room.buzzer.status = "closed";
      room.buzzer.deadline = 0;
      room.status = "buzzer-ready";
      emitRoundState(room);
    }
  }, duration * 1000);
  emitRoom(room, "game:buzzer-start", {
    deadline: room.buzzer.deadline,
    reopening: room.buzzer.queue.length > 0
  });
  emitRoundState(room);
  return null;
}

function grantBuzzerChance(room, duration) {
  if (room.status !== "buzzer-ready" || !["closed", "ready", "open"].includes(room.buzzer.status) || !room.buzzer.queue.length) {
    return "No buzzer participant is waiting for a chance.";
  }
  clearRoomTimer(room);
  const next = room.buzzer.chanceIndex + 1;
  if (next > 1 || next >= room.buzzer.queue.length) return "There is no eligible next buzzer chance.";
  if (!Number.isInteger(duration) || duration < 5 || duration > 120) return "Buzzer chance duration must be from 5 to 120 seconds.";
  room.buzzer.chanceIndex = next;
  room.buzzer.status = "chance";
  room.buzzer.pendingResponse = "";
  room.buzzer.pendingOutcome = "";
  const player = room.players.get(room.buzzer.queue[next]);
  room.buzzer.deadline = Date.now() + duration * 1000;
  if (player) io.to(player.socketId).emit("game:buzzer-chance", {
    deadline: room.buzzer.deadline,
    chance: next + 1
  });
  room.timer = setTimeout(() => {
    emitTimerEnd(room, "practical", room.buzzer.deadline);
    enterBuzzerReview(room, "unanswered");
  }, duration * 1000);
  emitRoundState(room);
  return null;
}

function enterBuzzerReview(room, outcome = "") {
  if (room.status !== "buzzer-ready" || room.buzzer.status !== "chance") return;
  clearRoomTimer(room);
  room.buzzer.pendingOutcome = outcome;
  room.buzzer.status = "review";
  room.status = "buzzer-review";
  emitRoundState(room);
}

function resolveBuzzerChance(room, outcome) {
  if (!["correct", "wrong", "unanswered"].includes(outcome)) return "Choose Correct, Wrong, or Not Answered.";
  if (room.status === "buzzer-ready" && room.buzzer.status === "chance") enterBuzzerReview(room);
  if (room.status !== "buzzer-review" || room.buzzer.status !== "review") return "There is no buzzer answer waiting to be scored.";
  clearRoomTimer(room);
  const player = room.players.get(room.buzzer.queue[room.buzzer.chanceIndex]);
  const firstChance = room.buzzer.chanceIndex === 0;
  const points = outcome === "correct" ? (firstChance ? 10 : 5) :
    outcome === "wrong" ? (firstChance ? -5 : -3) : 0;
  if (player) {
    player.score += points;
    player.roundScore = (player.roundScore || 0) + points;
  }
  room.buzzer.results.push({
    theme: room.selectedTheme.name,
    question: room.buzzer.question,
    expectedAnswer: room.selectedTheme.buzzerAnswer,
    nickname: player?.nickname || "",
    answer: room.buzzer.pendingResponse || "",
    chance: room.buzzer.chanceIndex + 1,
    outcome,
    points
  });
  emitRoom(room, "game:buzzer-result", {
    nickname: player?.nickname || "",
    outcome,
    ...(room.permissions.showTeamTotalToPlayers ? { points } : {})
  });
  room.buzzer.pendingResponse = "";
  room.buzzer.pendingOutcome = "";
  room.buzzer.queue.push(player?.userId || `unanswered-${room.buzzer.chanceIndex}-${room.buzzer.results.length}`);
  if (firstChance && outcome !== "correct") {
    room.buzzer.status = "ready";
    room.status = "buzzer-ready";
    if (room.buzzer.queue.length === 1 && room.buzzer.queue.length < room.players.size) {
      const error = startBuzzer(room, room.buzzer.windowSeconds || 20);
      if (!error) return null;
    }
    emitRoundState(room);
    return null;
  }
  room.buzzer.status = "complete";
  room.status = "buzzer-results";
  emitRoundState(room);
  return null;
}

function finishBuzzerWithoutSecond(room) {
  if (room.status !== "buzzer-ready" || !["waiting", "closed", "ready"].includes(room.buzzer.status)) {
    return "The buzzer cannot be finished while a chance is active.";
  }
  const noFirstBuzzer = room.buzzer.queue.length === 0 && room.buzzer.status === "closed";
  const noSecondParticipant = room.buzzer.chanceIndex === 0 && room.buzzer.queue.length === 1 &&
    (room.buzzer.status === "closed" || room.buzzer.queue.length >= room.players.size);
  if (!noFirstBuzzer && !noSecondParticipant) {
    return "Open the buzzer again or grant the next eligible chance before finishing.";
  }
  room.buzzer.results.push({
    theme: room.selectedTheme.name,
    question: room.buzzer.question,
    nickname: "",
    answer: "",
    chance: noFirstBuzzer ? 1 : 2,
    outcome: "unanswered",
    points: 0
  });
  room.buzzer.status = "complete";
  room.status = "buzzer-results";
  emitRoundState(room);
  return null;
}

function continuePracticalTheme(room) {
  if (room.status !== "buzzer-results") return "Complete the current theme's buzzer question before continuing.";
  room.practicalIndex += 1;
  room.practicalTurns += 1;
  room.selectedTheme = null;
  room.activePlayerId = room.practicalOrder[room.practicalIndex]?.id || null;
  room.buzzer = {
    ...room.buzzer,
    question: "",
    status: "waiting",
    queue: [],
    chanceIndex: -1,
    deadline: 0,
    pendingResponse: "",
    pendingOutcome: ""
  };
  if (room.activePlayerId) {
    room.status = "practical-theme";
    emitRoom(room, "game:practical-next", {
      activePlayerId: room.activePlayerId,
      activePlayer: room.players.get(room.activePlayerId)?.nickname || null
    });
    emitRoundState(room);
    return null;
  }
  advanceAfterRound(room, "practical");
  return null;
}

function addSingleMark(room, playerId, marks) {
  if (room.status === "finished") return "This game is finished.";
  if (typeof playerId !== "string" || !room.players.has(playerId)) return "Select a participant from this game.";
  if (!Number.isSafeInteger(marks) || marks < 0 || marks > 1000000) return "Marks must be a whole number from 0 to 1,000,000.";
  const player = room.players.get(playerId);
  player.score += marks;
  room.paperMarks.push({ playerId, nickname: player.nickname, marks, addedAt: new Date().toISOString(), phase: room.status });
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
    leaderboard: leaderboard(room).map((player) => ({
      ...player,
      paperMarks: room.players.get(player.id)?.paperMarks || 0
    })),
    showPlayerReport: true,
    showScores: true
  };
  if (room.hostSocketId) io.to(room.hostSocketId).emit("game:podium", hostPayload);
  io.to(room.pin).except(room.hostSocketId).emit("game:podium", hostPayload);
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
    socket.emit("game:practical-admin-state", {
      selectedTheme: room.selectedTheme ? {
        name: room.selectedTheme.name,
        question: room.selectedTheme.question,
        answer: room.selectedTheme.answer,
        buzzerQuestion: room.selectedTheme.buzzerQuestion,
        buzzerAnswer: room.selectedTheme.buzzerAnswer
      } : null,
      practicalTimeLimit: room.practicalTimeLimit
    });
    if (room.status === "question" || room.status === "paused") emitHostQuestion(room);
    if (room.status === "paused") socket.emit("game:paused", { remainingMs: room.remainingMs });
    if (room.status === "review") socket.emit("game:review", reviewPayload(room));
    if (room.status === "rapid-common") socket.emit("game:rapid-common", {
      question: room.rapidQuestion.question, image: room.rapidQuestion.image || "",
      options: room.rapidQuestion.options, timeLimit: room.rapidQuestion.timeLimit, deadline: room.rapidDeadline
    });
    if (room.status === "practical-video" && room.selectedTheme) socket.emit("game:practical-video", {
      activePlayerId: room.activePlayerId, activePlayer: room.players.get(room.activePlayerId)?.nickname || "",
      theme: { name: room.selectedTheme.name, videoUrl: room.selectedTheme.videoUrl }
    });
    if (room.status === "finished") socket.emit("game:podium", {
      leaderboard: leaderboard(room).map((player) => ({
        ...player,
        paperMarks: room.players.get(player.id)?.paperMarks || 0
      })),
      showScores: true,
      showPlayerReport: true
    });
  });

  socket.on("display:watch", (payload = {}, ack = () => {}) => {
    payload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    ack = typeof ack === "function" ? ack : () => {};
    const user = getSocketUser(socket);
    if (user?.role !== "admin" && user?.role !== "shower") return ack({ error: "Display screen access is required." });
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin.trim() : "");
    if (!room) return ack({ error: "Game PIN not found. Open the display link provided by the administrator." });
    socket.data.displayPin = room.pin;
    socket.join(room.pin);
    socket.join(`display:${room.pin}`);
    ack({
      game: { pin: room.pin, title: room.title, players: [...room.players.values()].map(({ userId, nickname }) => ({ id: userId, nickname })) },
      joinOrigin: getLanOrigin()
    });
    socket.emit("game:lobby", hostRoomState(room));
    socket.emit("game:round-state", publicRoundState(room));
    if (room.status === "question" || room.status === "paused") emitHostQuestion(room);
    if (room.status === "paused") socket.emit("game:paused", { remainingMs: room.remainingMs });
    if (room.status === "review") socket.emit("game:review", reviewPayload(room));
    if (room.status === "rapid-common") socket.emit("game:rapid-common", {
      question: room.rapidQuestion.question, image: room.rapidQuestion.image || "",
      options: room.rapidQuestion.options, timeLimit: room.rapidQuestion.timeLimit, deadline: room.rapidDeadline
    });
    if (room.status === "finished") socket.emit("game:podium", {
      leaderboard: leaderboard(room).map((player) => ({ ...player, paperMarks: room.players.get(player.id)?.paperMarks || 0 })),
      showPlayerReport: true, showScores: true
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
    } else if (room.status === "practical-question" && player.userId === room.activePlayerId) {
      socket.emit("game:practical-question", {
        deadline: room.practicalDeadline
      });
    } else if (room.status === "buzzer-ready" && room.buzzer.status === "chance" &&
        room.buzzer.queue[room.buzzer.chanceIndex] === player.userId) {
      socket.emit("game:buzzer-chance", {
        deadline: room.buzzer.deadline,
        chance: room.buzzer.chanceIndex + 1
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
      socket.emit("game:podium", {
        leaderboard: leaderboard(room).map((entry) => ({
          ...entry,
          paperMarks: room.players.get(entry.id)?.paperMarks || 0
        })),
        showScores: true,
        showPlayerReport: true
      });
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

  socket.on("player:practical-answer", (payload = {}, ack = () => {}) => {
    ack = typeof ack === "function" ? ack : () => {};
    const room = rooms.get(typeof payload.pin === "string" ? payload.pin : "");
    const player = room && findRoomPlayer(room, socket.id);
    if (!room || !player || player.userId !== room.activePlayerId || room.status !== "practical-question") {
      return ack({ error: "There is no practical question for you to answer." });
    }
    if (typeof payload.answer !== "string" || !payload.answer.trim() || payload.answer.trim().length > 500) {
      return ack({ error: "Enter an answer of 1–500 characters." });
    }
    if (Date.now() >= room.practicalDeadline) {
      clearRoomTimer(room);
      room.practicalDeadline = 0;
      room.practicalPendingAnswer = "";
      room.status = "practical-question-review";
    } else {
      clearRoomTimer(room);
      room.practicalDeadline = 0;
      room.practicalPendingAnswer = payload.answer.trim();
      room.status = "practical-question-review";
    }
    emitRoundState(room);
    ack({ accepted: true });
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
    if (!room.players.has(player.userId)) return ack({ error: "The buzzer is not open." });
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
    if (Date.now() >= room.buzzer.deadline) {
      enterBuzzerReview(room, "unanswered");
      return ack({ accepted: true });
    }
    clearRoomTimer(room);
    room.buzzer.pendingResponse = payload.answer.trim();
    room.buzzer.pendingOutcome = "";
    room.buzzer.status = "review";
    room.status = "buzzer-review";
    if (room.hostSocketId) io.to(room.hostSocketId).emit("game:buzzer-answer", {
      nickname: player.nickname,
      answer: room.buzzer.pendingResponse
    });
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
    enterBuzzerReview(room, "unanswered");
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
  const maxPort = PORT_WAS_CONFIGURED ? PORT : Math.min(PORT + 10, 65535);
  for (let port = PORT; port <= maxPort; port += 1) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "0.0.0.0");
      });
      const actualPort = server.address().port;
      console.log(`Science Day Quiz is listening on port ${actualPort}`);
      if (port !== PORT) console.warn(`Port ${PORT} was busy; using port ${actualPort}.`);
      for (const address of getLanAddresses()) console.log(`LAN access: http://${address}:${actualPort}`);
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      if (PORT_WAS_CONFIGURED || port === maxPort) {
        throw new Error(`Port ${port} is already in use. Stop the process using it or set PORT to another available port.`, { cause: error });
      }
    }
  }
}

startServer().catch((error) => {
  console.error("Unable to start the quiz server:", error);
  process.exitCode = 1;
});
