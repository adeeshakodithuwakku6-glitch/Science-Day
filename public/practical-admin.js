// Shared Practical Quiz control panel for the Host screen.
// Renders the Admin-only Correct / Wrong / Not Answered buttons and the expected answers,
// which must never be visible on the projected host screen until the Admin presses "Show details".
(function (global) {
  const PRACTICAL_STATUSES = [
    "practical-rules", "practical-theme", "practical-video", "practical-question", "practical-question-review",
    "buzzer-ready", "buzzer", "buzzer-review", "buzzer-results"
  ];

  const panel = document.getElementById("practical-admin");
  const spot = document.getElementById("practical-spotlight");
  const timingField = document.getElementById("practical-timing");
  const timingStatus = document.getElementById("practical-timing-status");
  const outcomes = document.getElementById("practical-outcomes");
  const chanceField = document.getElementById("practical-chance");
  const chanceCount = document.getElementById("practical-chance-count");
  const chanceList = document.getElementById("practical-chance-list");
  const expected = document.getElementById("practical-expected");
  const revealToggle = document.getElementById("practical-reveal");
  const nextButton = document.getElementById("practical-admin-next");
  const chooserLine = document.getElementById("round-chooser");
  const spotlightLine = document.getElementById("round-spot");

  let state = null;
  let detailsVisible = false;

  function post(action, body = {}) {
    return global.quizAdminAction(action, body).catch((error) => {
      global.quizAdminError?.(error.message);
      throw error;
    });
  }

  function durationValue(field) {
    const value = Number(field.value);
    return Number.isInteger(value) ? value : NaN;
  }

  function addButton(container, label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", () => {
      button.disabled = true;
      if (timingStatus) {
        timingStatus.textContent = label === "Stop timer" ? "Stopping timer…" : "";
        timingStatus.classList.remove("text-red-700");
        timingStatus.classList.add("text-emerald-800");
        timingStatus.classList.toggle("hidden", !timingStatus.textContent);
      }
      Promise.resolve()
        .then(onClick)
        .then(() => {
          if (timingStatus && label === "Stop timer") {
            timingStatus.textContent = "Timer stopped. Record the answer below.";
            timingStatus.classList.remove("hidden");
          }
        })
        .catch((error) => {
          if (timingStatus) {
            timingStatus.textContent = error.message || "Could not stop the timer.";
            timingStatus.classList.remove("hidden");
            timingStatus.classList.remove("text-emerald-800");
            timingStatus.classList.add("text-red-700");
          }
        })
        .finally(() => {
          button.disabled = false;
        });
    });
    container.append(button);
    return button;
  }

  const successClass = "rounded-xl bg-emerald-700 px-4 py-3 text-sm font-extrabold text-white hover:bg-emerald-800 disabled:opacity-50";
  const dangerClass = "rounded-xl bg-red-700 px-4 py-3 text-sm font-extrabold text-white hover:bg-red-800 disabled:opacity-50";
  const neutralClass = "rounded-xl bg-slate-200 px-4 py-3 text-sm font-extrabold text-slate-900 hover:bg-slate-300 disabled:opacity-50";
  const primaryClass = "rounded-xl bg-purple-700 px-4 py-3 text-sm font-extrabold text-white hover:bg-purple-800 disabled:opacity-50";

  function renderSpotlight(current) {
    spot.replaceChildren();
    const rows = [];
    const queue = current.practicalQueue || [];
    if (queue.length) {
      rows.push(["Chooser", queue.map((player) => player.nickname).join(", ")]);
    }
    if (current.theme?.name) rows.push(["Theme", current.theme.name]);
    const turnsLeft = Math.max(0, (current.practicalOrder || []).length - (current.practicalIndex || 0));
    if (turnsLeft) rows.push(["Themes remaining", String(turnsLeft)]);
    if ((current.usedThemes || []).length) rows.push(["Locked themes", current.usedThemes.join(" · ")]);
    for (const [label, value] of rows) {
      const row = document.createElement("p");
      row.className = "text-sm";
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      const span = document.createElement("span");
      span.textContent = value;
      row.append(strong, span);
      spot.append(row);
    }
    spot.classList.toggle("hidden", !rows.length);
  }

  function renderTiming(current) {
    timingField.replaceChildren();
    const usages = [];
    if (current.status === "practical-rules") {
      usages.push(["practical-start", "Start Practical Quiz", "Question time (seconds)"]);
    } else if (current.status === "practical-question") {
      usages.push(["practical-stop-timer", "Stop timer", ""]);
    } else if (current.status === "buzzer-ready" && current.buzzer?.status === "chance") {
      usages.push(["buzzer-stop-timer", "Stop timer · record answer", ""]);
    } else if (current.status === "buzzer-ready" && current.buzzer?.canReopen &&
      ["waiting", "closed", "ready"].includes(current.buzzer.status)) {
      usages.push(["buzzer-start", current.buzzer.queue?.length ? "Open buzzer again" : "Open buzzer", "Buzz window (seconds)"]);
    } else if (current.status === "buzzer-ready" && ["closed", "ready"].includes(current.buzzer.status) &&
      (current.buzzer.queue?.length || 0) > (current.buzzer.chanceIndex + 1) && current.buzzer.chanceIndex < 1) {
      const nextChance = current.buzzer.chanceIndex + 2;
      usages.push(["buzzer-chance", `Give ${nextChance}${nextChance === 1 ? "st" : "nd"} chance`, "Chance time (seconds)"]);
    } else if (current.status === "practical-video") {
      usages.push(["practical-video-next", "Skip video and ask question", ""]);
    } else if (current.status === "buzzer") {
      usages.push(["buzzer-close", "Stop timer · close buzzer", ""]);
    }
    for (const [action, label, fieldLabel] of usages) {
      const wrap = document.createElement("div");
      wrap.className = "flex flex-wrap items-end gap-2";
      let input = null;
      if (fieldLabel) {
        const field = document.createElement("label");
        field.className = "text-xs font-bold text-slate-600";
        field.textContent = fieldLabel;
        input = document.createElement("input");
        input.type = "number";
        input.min = "5";
        input.max = action === "buzzer-start" ? "120" : "120";
        input.step = "1";
        input.value = String(action === "practical-start"
          ? current.practicalTimeLimit || 20
          : current.buzzer?.windowSeconds || 20);
        input.className = "mt-1 block w-24 rounded-lg border border-slate-300 px-2 py-2 text-sm";
        field.append(input);
        wrap.append(field);
      }
      addButton(wrap, label, primaryClass, () => post(action, input ? { duration: durationValue(input), timeLimit: durationValue(input) } : {}));
      timingField.append(wrap);
    }
    timingField.classList.toggle("hidden", !usages.length);
  }

  function renderOutcomes(current) {
    outcomes.replaceChildren();
    let body = null;
    let points = null;
    if (["practical-question", "practical-question-review"].includes(current.status)) {
      body = { action: "practical-resolve", correct: "Correct (+10)", wrong: "Wrong (−5)", unanswered: "Not Answered (0)" };
      points = "The chooser's question · correct +10, wrong −5, not answered 0";
    } else if (current.status === "buzzer-review" ||
      (current.status === "buzzer-ready" && current.buzzer?.status === "chance")) {
      const first = current.buzzer.chanceIndex === 0;
      body = {
        action: "buzzer-resolve",
        correct: `Correct (+${first ? 10 : 5})`,
        wrong: `Wrong (−${first ? 5 : 3})`,
        unanswered: "Not Answered (0)"
      };
      points = `Buzzer chance ${current.buzzer.chanceIndex + 1} · correct +${first ? 10 : 5}, wrong −${first ? 5 : 3}, not answered 0`;
    } else if (current.status === "buzzer-ready" && current.buzzer?.queue?.length === 0 && current.buzzer.status === "closed") {
      body = { action: "buzzer-finish", unanswered: "Finish: nobody buzzed" };
      points = "Nobody pressed the buzzer within the window";
    } else if (current.status === "buzzer-ready" && current.buzzer.chanceIndex === 0 &&
      current.buzzer.queue?.length === 1 && (current.buzzer.status === "closed" || !current.buzzer.canReopen)) {
      body = { action: "buzzer-finish", unanswered: "Finish: no second participant" };
      points = "Only one participant rang; the second chance cannot be given";
    }
    if (!body) {
      outcomes.classList.add("hidden");
      expected.textContent = "";
      return;
    }
    const legend = document.createElement("div");
    legend.className = "w-full";
    const title = document.createElement("p");
    title.className = "text-sm font-black text-purple-900";
    title.textContent = "Record the result";
    const note = document.createElement("p");
    note.className = "text-xs font-semibold text-slate-600";
    note.textContent = `${points}. Choose an outcome after hearing the spoken answer. Question details stay hidden from the Host screen until you press "Show details".`;
    legend.append(title, note);
    outcomes.append(legend);
    for (const outcome of ["correct", "wrong", "unanswered"]) {
      if (!body[outcome]) continue;
      addButton(
        outcomes,
        body[outcome],
        outcome === "correct" ? successClass : outcome === "wrong" ? dangerClass : neutralClass,
        () => post(body.action, { outcome })
      );
    }
    outcomes.classList.remove("hidden");
    const reveal = ["practical-question", "practical-question-review"].includes(current.status)
      ? { label: "Question", value: current.selectedTheme?.question, answer: current.selectedTheme?.answer }
      : ["buzzer-review", "buzzer-ready"].includes(current.status) && current.buzzer?.status !== "open" && current.buzzer?.status !== "closed"
        ? { label: "Buzzer question", value: current.buzzer.question, answer: current.selectedTheme?.buzzerAnswer }
        : null;
    expected.textContent = reveal
      ? (detailsVisible
        ? `${reveal.label}: ${reveal.value || "—"} · Expected answer: ${reveal.answer || "Not set"}`
        : "Details hidden. Press Show details to check the expected answer on this screen.")
      : "";
  }

  function render(current) {
    state = current;
    const visible = current && PRACTICAL_STATUSES.includes(current.status);
    panel.classList.toggle("hidden", !visible);
    if (!visible) return;
    renderSpotlight(current);
    renderTiming(current);
    renderOutcomes(current);
    revealToggle.textContent = detailsVisible ? "Hide details" : "Show details";
    revealToggle.classList.toggle("hidden", !["practical-question", "practical-question-review", "buzzer-ready", "buzzer-review"].includes(current.status));
    if (chooserLine) chooserLine.classList.add("hidden");
    if (spotlightLine) spotlightLine.classList.add("hidden");
    chanceField.classList.toggle("hidden", !["buzzer-ready", "buzzer", "buzzer-review"].includes(current.status));
    const queue = current.buzzer?.queue || [];
    chanceCount.textContent = String(queue.length);
    chanceList.replaceChildren();
    queue.forEach((nickname, index) => {
      const row = document.createElement("li");
      const placed = index <= (current.buzzer?.chanceIndex || 0) && current.buzzer?.status !== "open";
      row.className = placed ? "font-bold text-slate-900" : "text-slate-600";
      row.textContent = `${index === 0 ? "1st" : "2nd"} ring: ${nickname}${placed ? " (already answered)" : " (waiting for a chance)"}`;
      chanceList.append(row);
    });
    if (!queue.length) chanceList.textContent = "No buzzer places taken yet.";
    const canNext = current.status === "buzzer-results";
    nextButton.classList.toggle("hidden", !canNext);
    if (canNext) {
      const nextParticipant = current.practicalOrder?.[current.practicalIndex + 1];
      nextButton.textContent = nextParticipant
        ? `Next: ${nextParticipant.nickname} chooses a theme`
        : current.nextRound
          ? `Next: continue to ${current.nextRound === "main-quiz" ? "Quiz" : "Rapid Fire"}`
          : "Next: Game Over";
    }
  }

  revealToggle?.addEventListener("click", () => {
    detailsVisible = !detailsVisible;
    if (state) render(state);
  });
  nextButton?.addEventListener("click", () => {
    nextButton.disabled = true;
    post("practical-next").finally(() => {
      nextButton.disabled = false;
    });
  });

  global.quizPracticalAdmin = { render, reset() { detailsVisible = false; } };
})(window);
