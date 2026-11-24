(function () {
  const countdownAudio = new Audio("/buzzer/mixkit-tick-tock-clock-close-up-1059.wav");
  countdownAudio.preload = "auto";
  countdownAudio.loop = true;
  countdownAudio.volume = 0.45;
  let unlocked = false;
  let activeCountdownKey = "";

  function unlock() {
    if (unlocked) return;
    countdownAudio.muted = true;
    countdownAudio.play().then(() => {
      countdownAudio.pause();
      countdownAudio.currentTime = 0;
      countdownAudio.muted = false;
      unlocked = true;
    }).catch(() => {
      countdownAudio.muted = false;
    });
  }

  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    document.addEventListener(eventName, unlock, { once: true, passive: true });
  });

  function tick(round, deadline, seconds) {
    if (!deadline || seconds <= 0) {
      stop();
      return;
    }
    const key = `${round}:${deadline}`;
    if (activeCountdownKey !== key) {
      countdownAudio.pause();
      countdownAudio.currentTime = 0;
      activeCountdownKey = key;
    }
    if (!unlocked || !countdownAudio.paused) return;
    countdownAudio.play().catch(() => {});
  }

  function stop() {
    countdownAudio.pause();
    countdownAudio.currentTime = 0;
    activeCountdownKey = "";
  }

  window.quizTimerSounds = { tick, stop };
})();
