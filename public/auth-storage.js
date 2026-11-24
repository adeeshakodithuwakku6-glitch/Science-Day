(() => {
  const USER_KEY = "scienceQuizUser";
  const PIN_KEY = "scienceQuizPin";
  const NICKNAME_KEY = "scienceQuizNickname";

  function getUser() {
    const stored = localStorage.getItem(USER_KEY);
    if (!stored) return null;
    try {
      const user = JSON.parse(stored);
      if (
        user &&
        typeof user.id === "string" &&
        typeof user.name === "string" &&
        typeof user.email === "string" &&
        (user.role === "user" || user.role === "shower" || user.role === "admin")
      ) {
        return user;
      }
    } catch {
      localStorage.removeItem(USER_KEY);
    }
    return null;
  }

  function saveUser(user) {
    localStorage.setItem(USER_KEY, JSON.stringify({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    }));
  }

  function getPin() {
    const pin = localStorage.getItem(PIN_KEY);
    return /^\d{6}$/.test(pin || "") ? pin : "";
  }

  function savePin(pin) {
    if (!/^\d{6}$/.test(pin)) throw new Error("Game PIN must contain six digits.");
    localStorage.setItem(PIN_KEY, pin);
  }

  function getNickname() {
    const nickname = localStorage.getItem(NICKNAME_KEY);
    return typeof nickname === "string" ? nickname : "";
  }

  function saveNickname(nickname) {
    localStorage.setItem(NICKNAME_KEY, nickname);
  }

  function clearUser() {
    localStorage.removeItem(USER_KEY);
  }

  function clearPin() {
    localStorage.removeItem(PIN_KEY);
  }

  window.quizAuthStorage = Object.freeze({
    getUser,
    saveUser,
    getPin,
    savePin,
    getNickname,
    saveNickname,
    clearUser,
    clearPin
  });
})();
