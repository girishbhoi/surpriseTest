export function makeTestCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function makeTeacherToken() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let token = "";
  for (let i = 0; i < 24; i += 1) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

export function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function isTestLive(test) {
  return test.status === "live";
}

export function getWindowOpenTime(test) {
  if (!test.start_at) return null;
  const d = new Date(test.start_at);
  d.setMinutes(d.getMinutes() - 2);
  return d;
}

export function shuffleArray(values) {
  const arr = [...values];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function answerLabelToIndex(label) {
  const v = String(label || "").trim().toUpperCase();
  return Math.max(0, "ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(v));
}
