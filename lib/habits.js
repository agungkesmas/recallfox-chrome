// lib/habits.js — Ngaji tracker + Exercise reminder logic
// RecallFox v0.7.0

import { getVault, saveSettings } from './storage.js';

const HABITS_KEY = 'recallfox_habits';

// Read habits data from storage.local (separate from vault for performance)
export async function getHabits() {
  const data = await browser.storage.local.get(HABITS_KEY);
  return data[HABITS_KEY] || {
    quranLog: {},        // { "2026-07-05": 3, "2026-07-06": 1, ... }
    exerciseLog: {}      // { "2026-07-05": 2, "2026-07-06": 4, ... }
  };
}

export async function saveHabits(habits) {
  await browser.storage.local.set({ [HABITS_KEY]: habits });
}

// === NGAJI / QURAN TRACKER ===

// Get today's date string (YYYY-MM-DD)
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Check if a date is yesterday relative to another date
function isYesterday(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1 + 'T00:00:00');
  const d2 = new Date(dateStr2 + 'T00:00:00');
  const diff = Math.round((d2 - d1) / (24 * 60 * 60 * 1000));
  return diff === 1;
}

// Get ngaji status for today
export async function getQuranStatus(settings) {
  const today = todayStr();
  const habits = await getHabits();
  const todayPages = habits.quranLog?.[today] || 0;
  const target = settings.quranTargetPages || 1;

  // v0.8.41: Cek apakah hari ini adalah hari ngaji
  const todayDay = new Date().getDay();  // 0=Minggu, 1=Senin, ... 6=Sabtu
  const quranDays = Array.isArray(settings.quranDays) ? settings.quranDays : [0,1,2,3,4,5,6];
  const isNgajiDay = quranDays.includes(todayDay);

  // Calculate streak
  let streak = 0;
  let checkDate = today;
  const quranLog = habits.quranLog || {};
  for (let i = 0; i < 365; i++) {
    if (quranLog[checkDate] && quranLog[checkDate] >= target) {
      streak++;
      // Go to previous day
      const d = new Date(checkDate + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      checkDate = d.toISOString().slice(0, 10);
    } else if (i === 0) {
      // Today not done yet — check yesterday
      const d = new Date(checkDate + 'T00:00:00');
      d.setDate(d.getDate() - 1);
      checkDate = d.toISOString().slice(0, 10);
    } else {
      break;
    }
  }

  return {
    todayPages,
    target,
    streak,
    isComplete: todayPages >= target,
    progress: Math.min(100, Math.round((todayPages / target) * 100)),
    isNgajiDay,        // v0.8.41: true kalau hari ini hari ngaji
    isRestDay: !isNgajiDay  // v0.8.41: true kalau hari istirahat (bukan hari ngaji)
  };
}

// Log ngaji pages for today
export async function logQuranPages(pages, settings) {
  const today = todayStr();
  const habits = await getHabits();
  if (!habits.quranLog) habits.quranLog = {};
  habits.quranLog[today] = Math.max(0, (habits.quranLog[today] || 0) + pages);
  await saveHabits(habits);

  // Check if just completed target
  const target = settings.quranTargetPages || 1;
  const wasComplete = (habits.quranLog[today] - pages) >= target;
  const isNowComplete = habits.quranLog[today] >= target;

  return {
    todayPages: habits.quranLog[today],
    target,
    justCompleted: !wasComplete && isNowComplete
  };
}

// Reset today's ngaji count
export async function resetQuranToday() {
  const today = todayStr();
  const habits = await getHabits();
  if (!habits.quranLog) habits.quranLog = {};
  delete habits.quranLog[today];
  await saveHabits(habits);
}

// === EXERCISE / MOVEMENT REMINDER ===

// Check if it's time for exercise reminder
export function isExerciseTime(settings) {
  if (!settings.exerciseEnabled) return false;

  // v0.8.41: Cek hari olahraga — kalau hari ini bukan hari treadmill, return false
  const todayDay = new Date().getDay();  // 0=Minggu, 1=Senin, ... 6=Sabtu
  const exerciseDays = Array.isArray(settings.exerciseDays) ? settings.exerciseDays : [1,3,5];
  if (!exerciseDays.includes(todayDay)) return false;

  // Check snooze
  if (settings.exerciseSnoozeUntil) {
    if (Date.now() < new Date(settings.exerciseSnoozeUntil).getTime()) {
      return false;  // still snoozed
    }
  }

  // Check interval
  const intervalMs = (settings.exerciseIntervalMinutes || 45) * 60 * 1000;
  const lastReminder = settings.exerciseLastReminderAt
    ? new Date(settings.exerciseLastReminderAt).getTime()
    : 0;

  return (Date.now() - lastReminder) >= intervalMs;
}

// Log exercise done (user clicked "Sudah bergerak")
export async function logExerciseDone(settings) {
  const today = todayStr();
  const habits = await getHabits();
  if (!habits.exerciseLog) habits.exerciseLog = {};
  habits.exerciseLog[today] = (habits.exerciseLog[today] || 0) + 1;
  await saveHabits(habits);

  // Reset snooze + update lastReminder
  await saveSettings({
    exerciseLastReminderAt: new Date().toISOString(),
    exerciseSnoozeUntil: null,
    exerciseTodayCount: (habits.exerciseLog[today] || 0),
    exerciseLastResetDate: today
  });

  return { todayCount: habits.exerciseLog[today] };
}

// Snooze exercise reminder
export async function snoozeExercise(minutes = 5) {
  const snoozeUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  await saveSettings({ exerciseSnoozeUntil: snoozeUntil });
  return { snoozeUntil };
}

// Get exercise status for today
export async function getExerciseStatus(settings) {
  const today = todayStr();
  const habits = await getHabits();
  const todayCount = habits.exerciseLog?.[today] || 0;

  // Check if reminder is due
  const isDue = isExerciseTime(settings);
  const isSnoozed = settings.exerciseSnoozeUntil &&
    Date.now() < new Date(settings.exerciseSnoozeUntil).getTime();

  return {
    todayCount,
    isDue,
    isSnoozed,
    snoozeRemaining: isSnoozed
      ? Math.round((new Date(settings.exerciseSnoozeUntil).getTime() - Date.now()) / 60000)
      : 0
  };
}

// Format ngaji status for sticky bar
export function formatQuranSticky(status) {
  if (!status) return '';
  if (status.isComplete) {
    return `📖 ${status.todayPages}/${status.target} ✓`;
  }
  return `📖 ${status.todayPages}/${status.target}`;
}

// Format exercise status for sticky bar
export function formatExerciseSticky(status) {
  if (!status) return '';
  if (status.isDue) {
    return `🏃 BERDIRI!`;
  }
  if (status.isSnoozed) {
    return `🏃 😴${status.snoozeRemaining}m`;
  }
  return `🏃 ${status.todayCount}x`;
}
