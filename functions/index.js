import express from "express";
import cors from "cors";
import ExcelJS from "exceljs";
import admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed.private_key) {
      parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
    }
    admin.initializeApp({
      credential: admin.credential.cert(parsed)
    });
  } else {
    admin.initializeApp();
  }
}

setGlobalOptions({ region: "us-central1", maxInstances: 5 });

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "5mb" }));

const TESTS = "tests";
const DEMO_TEST_CODE = "TEST";
const DEMO_TEACHER_TOKEN = "TEST_TEACHER_TOKEN";

function nowIso() {
  return new Date().toISOString();
}

function answerLabelToIndex(label) {
  const v = String(label || "").trim().toUpperCase();
  return Math.max(0, "ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(v));
}

function indexToLabel(i) {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Number(i)] || "";
}

function shuffleArray(values) {
  const arr = [...values];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeTestCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function makeTeacherToken() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let token = "";
  for (let i = 0; i < 24; i += 1) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
}

function normalizeStartAt(input) {
  if (!input) return null;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeQuestions(questions = []) {
  return questions.map((q, idx) => ({
    idx,
    type: q.type || "single_mcq",
    prompt: String(q.prompt || "").trim(),
    options: Array.isArray(q.options) ? q.options.map((x) => String(x || "")) : [],
    answer: (Array.isArray(q.answer) ? q.answer : [q.answer]).map((a) =>
      typeof a === "number" ? a : answerLabelToIndex(a)
    ),
    marks: Number(q.marks || 1)
  }));
}

function naturalRollSort(a, b) {
  return String(a.roll_number || "").localeCompare(String(b.roll_number || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function safeSheetName(base, fallback = "Report") {
  const cleaned = String(base || fallback)
    .replace(/[\\/*?:[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const value = cleaned || fallback;
  return value.slice(0, 31);
}

function requireTeacher(req, res, next) {
  const teacherToken = req.header("x-teacher-token") || req.query.teacherToken;
  if (!teacherToken) {
    return res.status(401).json({ message: "Teacher token required" });
  }
  req.teacherToken = teacherToken;
  return next();
}

async function getTestByCode(code) {
  const ref = db.collection(TESTS).doc(String(code || "").trim().toUpperCase());
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function hasTeacherAccess(test, teacherToken) {
  return Boolean(test && test.teacherToken && teacherToken && test.teacherToken === teacherToken);
}

function isTestLive(test) {
  return test.status === "live";
}

function getWindowOpenTime(test) {
  if (!test.startAt) return null;
  const d = new Date(test.startAt);
  d.setMinutes(d.getMinutes() - 2);
  return d;
}

async function listQuestions(testCode) {
  const snap = await db.collection(TESTS).doc(testCode).collection("questions").orderBy("idx").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getAttempt(testCode, rollNumber) {
  const ref = db.collection(TESTS).doc(testCode).collection("attempts").doc(String(rollNumber).trim());
  const snap = await ref.get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

function buildAttemptPaper(test, allQuestions) {
  const settings = test.settings || {};
  let selected = [...allQuestions];
  const randomPaperSize = Number(settings.randomPaperSize || 0);

  if (randomPaperSize > 0 && randomPaperSize < selected.length) {
    selected = shuffleArray(selected).slice(0, randomPaperSize);
  }

  if (settings.randomizeQuestions) {
    selected = shuffleArray(selected);
  }

  const optionOrders = {};
  for (const q of selected) {
    const indices = (q.options || []).map((_, idx) => idx);
    optionOrders[q.id] = settings.randomizeOptions ? shuffleArray(indices) : indices;
  }

  return {
    paper: selected.map((q) => q.id),
    optionOrders
  };
}

function computeScore(questionsById, answers) {
  let score = 0;

  for (const q of questionsById) {
    const key = String(q.id);
    const selected = answers[key];
    const expected = Array.isArray(q.answer) ? q.answer : [];

    const s = Array.isArray(selected) ? selected : selected === 0 || selected ? [selected] : [];
    const isCorrect =
      s.length === expected.length &&
      [...s].map(Number).sort((a, b) => a - b).join("|") ===
        [...expected].map(Number).sort((a, b) => a - b).join("|");

    if (isCorrect) {
      score += Number(q.marks || 1);
    }
  }

  return score;
}

async function ensureAlwaysOnTest() {
  const testRef = db.collection(TESTS).doc(DEMO_TEST_CODE);
  const snap = await testRef.get();
  const baseData = {
    code: DEMO_TEST_CODE,
    teacherToken: DEMO_TEACHER_TOKEN,
    title: "UI Sandbox Test",
    startAt: null,
    durationMinutes: 525600,
    startedAt: nowIso(),
    status: "live",
    settings: {
      randomizeQuestions: false,
      randomizeOptions: false,
      randomPaperSize: null,
      allowBack: true
    },
    createdAt: nowIso()
  };

  const demoQuestions = [
    {
      idx: 0,
      prompt: "Which data structure uses FIFO order?",
      options: ["Stack", "Queue", "Tree", "Graph"],
      answer: [1]
    },
    {
      idx: 1,
      prompt: "What is 12 x 8?",
      options: ["84", "88", "96", "102"],
      answer: [2]
    },
    {
      idx: 2,
      prompt: "Which one is a JavaScript runtime?",
      options: ["Node.js", "PostgreSQL", "Nginx", "Figma"],
      answer: [0]
    },
    {
      idx: 3,
      prompt: "HTTP status code for 'Not Found' is:",
      options: ["200", "301", "404", "500"],
      answer: [2]
    },
    {
      idx: 4,
      prompt: "Which keyword declares a constant in JavaScript?",
      options: ["let", "var", "const", "static"],
      answer: [2]
    }
  ];

  if (!snap.exists) {
    await testRef.set(baseData);
    const batch = db.batch();
    for (const q of demoQuestions) {
      const qRef = testRef.collection("questions").doc(`demo-${q.idx}`);
      batch.set(qRef, {
        idx: q.idx,
        type: "single_mcq",
        prompt: q.prompt,
        options: q.options,
        answer: q.answer,
        marks: 1
      });
    }
    await batch.commit();
    return;
  }

  const existing = snap.data() || {};
  const patch = {};
  if (existing.teacherToken !== DEMO_TEACHER_TOKEN) patch.teacherToken = DEMO_TEACHER_TOKEN;
  if (existing.status !== "live") patch.status = "live";
  if (Number(existing.durationMinutes || 0) !== 525600) patch.durationMinutes = 525600;
  if (!existing.startedAt) patch.startedAt = nowIso();
  if (typeof existing.startAt === "undefined") patch.startAt = null;
  if (!existing.settings) {
    patch.settings = {
      randomizeQuestions: false,
      randomizeOptions: false,
      randomPaperSize: null,
      allowBack: true
    };
  }
  if (!existing.title) patch.title = "UI Sandbox Test";
  if (!existing.createdAt) patch.createdAt = nowIso();

  if (Object.keys(patch).length > 0) {
    await testRef.set(patch, { merge: true });
  }

  const questionsSnap = await testRef.collection("questions").limit(1).get();
  if (questionsSnap.empty) {
    const batch = db.batch();
    for (const q of demoQuestions) {
      const qRef = testRef.collection("questions").doc(`demo-${q.idx}`);
      batch.set(qRef, {
        idx: q.idx,
        type: "single_mcq",
        prompt: q.prompt,
        options: q.options,
        answer: q.answer,
        marks: 1
      });
    }
    await batch.commit();
  }
}

async function ensureAlwaysOnTestSafe() {
  try {
    await ensureAlwaysOnTest();
  } catch (error) {
    console.error("ensureAlwaysOnTest failed:", error?.message || error);
  }
}

async function ensureLifecycleForTest(code) {
  const testRef = db.collection(TESTS).doc(code);
  const testSnap = await testRef.get();
  if (!testSnap.exists) return null;

  const test = { id: testSnap.id, ...testSnap.data() };
  const now = Date.now();

  if (test.status === "scheduled" && test.startAt) {
    const startMs = new Date(test.startAt).getTime();
    if (now >= startMs) {
      const startedAt = nowIso();
      await testRef.set({ status: "live", startedAt: test.startedAt || startedAt }, { merge: true });
      const attemptsSnap = await testRef.collection("attempts").get();
      const batch = db.batch();
      attemptsSnap.docs.forEach((d) => {
        const data = d.data();
        if (!data.submittedAt) {
          batch.set(d.ref, { status: "in_progress" }, { merge: true });
        }
      });
      await batch.commit();
      const refreshed = await testRef.get();
      return { id: refreshed.id, ...refreshed.data() };
    }
  }

  if (test.status === "live" && test.startedAt) {
    const endTs = new Date(test.startedAt).getTime() + Number(test.durationMinutes || 0) * 60 * 1000;
    if (now >= endTs) {
      const questions = await listQuestions(code);
      const attemptsSnap = await testRef.collection("attempts").get();
      const batch = db.batch();

      for (const d of attemptsSnap.docs) {
        const attempt = d.data();
        if (attempt.status === "submitted") continue;
        const score = computeScore(questions, attempt.answers || {});
        batch.set(
          d.ref,
          {
            submittedAt: nowIso(),
            status: "submitted",
            score
          },
          { merge: true }
        );
      }

      batch.set(testRef, { status: "completed" }, { merge: true });
      await batch.commit();
      const refreshed = await testRef.get();
      return { id: refreshed.id, ...refreshed.data() };
    }
  }

  return test;
}

async function createQuestionTemplateBuffer() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Questions");

  ws.columns = [
    { header: "question_text", key: "question_text", width: 40 },
    { header: "type", key: "type", width: 18 },
    { header: "option_a", key: "option_a", width: 24 },
    { header: "option_b", key: "option_b", width: 24 },
    { header: "option_c", key: "option_c", width: 24 },
    { header: "option_d", key: "option_d", width: 24 },
    { header: "correct_answer", key: "correct_answer", width: 20 },
    { header: "marks", key: "marks", width: 10 }
  ];

  ws.addRow({
    question_text: "2 + 2 = ?",
    type: "single_mcq",
    option_a: "3",
    option_b: "4",
    option_c: "5",
    option_d: "6",
    correct_answer: "B",
    marks: 1
  });

  return wb.xlsx.writeBuffer();
}

async function parseQuestionWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const rows = [];

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const q = String(row.getCell(1).value ?? "").trim();
    if (!q) return;

    const type = String(row.getCell(2).value ?? "single_mcq").trim();
    const options = [3, 4, 5, 6]
      .map((col) => String(row.getCell(col).value ?? "").trim())
      .filter(Boolean);
    const answer = String(row.getCell(7).value ?? "").trim().toUpperCase();
    const marks = Number(row.getCell(8).value ?? 1) || 1;

    rows.push({
      type,
      prompt: q,
      options,
      answer: [answer],
      marks
    });
  });

  return rows;
}

async function createResultsWorkbookBuffer(results) {
  const { testMeta, participants } = results;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Results");
  ws.columns = [
    { key: "rollNumber", width: 18 },
    { key: "name", width: 24 },
    { key: "score", width: 10 },
    { key: "submittedAt", width: 24 },
    { key: "status", width: 14 },
    { key: "reportSheet", width: 20 }
  ];

  ws.mergeCells("A1:F1");
  ws.getCell("A1").value = testMeta.title || "Test Results";
  ws.getCell("A1").font = { bold: true, size: 14 };
  ws.getCell("A2").value = `Date: ${formatDateTime(testMeta.generatedAt)}`;
  ws.getCell("A2").font = { italic: true };

  ws.getRow(4).values = ["Roll Number", "Name", "Score", "Submitted At", "Status", "Student Report"];
  ws.getRow(4).font = { bold: true };

  participants.forEach((p, idx) => {
    const rowNum = 5 + idx;
    const reportSheetName = p.report.sheetName;
    ws.getCell(`A${rowNum}`).value = p.roll_number;
    ws.getCell(`B${rowNum}`).value = p.name;
    ws.getCell(`C${rowNum}`).value = p.score ?? "";
    ws.getCell(`D${rowNum}`).value = formatDateTime(p.submitted_at);
    ws.getCell(`E${rowNum}`).value = p.status || "";
    ws.getCell(`F${rowNum}`).value = {
      text: "Open Report",
      hyperlink: `#'${reportSheetName}'!A1`
    };
    ws.getCell(`F${rowNum}`).font = { color: { argb: "FF1F4AC9" }, underline: true };

    const rs = wb.addWorksheet(reportSheetName);
    rs.columns = [
      { key: "questionText", width: 42 },
      { key: "type", width: 16 },
      { key: "optionA", width: 20 },
      { key: "optionB", width: 20 },
      { key: "optionC", width: 20 },
      { key: "optionD", width: 20 },
      { key: "correctAnswer", width: 18 },
      { key: "marks", width: 10 },
      { key: "selectedOption", width: 18 },
      { key: "answeredAt", width: 24 }
    ];

    rs.getCell("A1").value = `Roll Number: ${p.roll_number}`;
    rs.getCell("A1").font = { bold: true, size: 13 };
    rs.getCell("A2").value = `Name: ${p.name}`;
    rs.getCell("A3").value = `Test: ${testMeta.title}`;
    rs.getCell("A4").value = `Generated: ${formatDateTime(testMeta.generatedAt)}`;

    rs.getRow(6).values = [
      "Question Text",
      "Type",
      "Option A",
      "Option B",
      "Option C",
      "Option D",
      "Correct Answer",
      "Marks",
      "Selected Option",
      "Answered At"
    ];
    rs.getRow(6).font = { bold: true };

    p.report.questions.forEach((q, qIdx) => {
      rs.getRow(7 + qIdx).values = [
        q.question_text,
        q.type,
        q.option_a,
        q.option_b,
        q.option_c,
        q.option_d,
        q.correct_answer,
        q.marks,
        q.selected_option,
        formatDateTime(q.answered_at)
      ];
    });

    const base = 9 + p.report.questions.length;
    rs.getCell(`A${base}`).value = "Proctoring Details";
    rs.getCell(`A${base}`).font = { bold: true };
    rs.getCell(`A${base + 1}`).value = "Tab Switch Count";
    rs.getCell(`B${base + 1}`).value = p.report.proctoring.tab_switch_count;
    rs.getCell(`A${base + 2}`).value = "Fullscreen Exit Count";
    rs.getCell(`B${base + 2}`).value = p.report.proctoring.fullscreen_exit_count;
    rs.getCell(`A${base + 3}`).value = "Warning Count";
    rs.getCell(`B${base + 3}`).value = p.report.proctoring.warning_count;
  });

  return wb.xlsx.writeBuffer();
}

async function buildParticipantReportByRoll(test, rollNumber) {
  const testCode = test.code;
  const roll = String(rollNumber).trim();
  const participantSnap = await db.collection(TESTS).doc(testCode).collection("participants").doc(roll).get();
  if (!participantSnap.exists) return null;

  const participant = participantSnap.data();
  const attemptSnap = await db.collection(TESTS).doc(testCode).collection("attempts").doc(roll).get();
  const attempt = attemptSnap.exists ? attemptSnap.data() : null;

  const questionRows = await listQuestions(testCode);
  const questionsById = new Map(questionRows.map((q) => [q.id, q]));

  const answers = attempt?.answers || {};
  const answerTimes = attempt?.answerTimestamps || {};
  const paper = attempt?.paper || [];

  const selectedQuestions = (Array.isArray(paper) && paper.length > 0 ? paper : questionRows.map((q) => q.id))
    .map((id) => questionsById.get(id))
    .filter(Boolean)
    .sort((a, b) => Number(a.idx || 0) - Number(b.idx || 0));

  const reportQuestions = selectedQuestions.map((q) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    const expected = Array.isArray(q.answer) ? q.answer : [];
    const selected = answers[String(q.id)];
    return {
      questionId: q.id,
      question_text: q.prompt,
      type: q.type,
      option_a: opts[0] || "",
      option_b: opts[1] || "",
      option_c: opts[2] || "",
      option_d: opts[3] || "",
      correct_answer: Array.isArray(expected) && expected.length > 0 ? indexToLabel(expected[0]) : "",
      marks: q.marks,
      selected_option: selected === 0 || selected ? indexToLabel(selected) : "",
      answered_at: answerTimes[String(q.id)] || ""
    };
  });

  return {
    test_title: test.title,
    roll_number: roll,
    name: participant.name,
    score: attempt?.score ?? "",
    status: attempt?.status || "waiting",
    submitted_at: attempt?.submittedAt || "",
    report: {
      sheetName: safeSheetName(`R-${roll}`),
      questions: reportQuestions,
      proctoring: {
        tab_switch_count: Number(attempt?.tabSwitchCount || 0),
        fullscreen_exit_count: Number(attempt?.fullscreenExitCount || 0),
        warning_count: Number(attempt?.warningCount || 0)
      }
    }
  };
}

app.use(async (req, res, next) => {
  await ensureAlwaysOnTestSafe();
  return next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/templates/questions.xlsx", async (req, res) => {
  const buffer = await createQuestionTemplateBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=question-template.xlsx");
  res.send(Buffer.from(buffer));
});

app.post("/api/tests/parse-questions", express.raw({ type: "application/octet-stream", limit: "10mb" }), async (req, res) => {
  const buffer = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ message: "Excel file is required" });
  }
  const questions = await parseQuestionWorkbook(buffer);
  return res.json({ questions });
});

app.post("/api/tests", async (req, res) => {
  const { title, startAt, durationMinutes, settings, questions } = req.body;

  if (!title || !durationMinutes || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ message: "Missing required fields" });
  }
  const normalizedStartAt = normalizeStartAt(startAt);
  if (startAt && !normalizedStartAt) {
    return res.status(400).json({ message: "Invalid start date-time" });
  }

  let code = makeTestCode();
  let exists = await getTestByCode(code);
  while (exists) {
    code = makeTestCode();
    exists = await getTestByCode(code);
  }

  const teacherToken = makeTeacherToken();
  const createdAt = nowIso();

  const testDoc = {
    code,
    teacherToken,
    title,
    startAt: normalizedStartAt,
    durationMinutes: Number(durationMinutes),
    startedAt: null,
    status: "scheduled",
    settings: settings || {},
    createdAt
  };

  const rows = normalizeQuestions(questions);
  const testRef = db.collection(TESTS).doc(code);
  const batch = db.batch();
  batch.set(testRef, testDoc);

  for (const q of rows) {
    const qRef = testRef.collection("questions").doc();
    batch.set(qRef, {
      idx: q.idx,
      type: q.type,
      prompt: q.prompt,
      options: q.options,
      answer: q.answer,
      marks: q.marks
    });
  }

  await batch.commit();

  return res.status(201).json({ code, testId: code, teacherToken });
});

app.get("/api/tests/:code/status", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const test = await ensureLifecycleForTest(code);
  if (!test) return res.status(404).json({ message: "Test not found" });

  const now = new Date();
  const startAt = test.startAt ? new Date(test.startAt) : null;
  const windowOpen = getWindowOpenTime(test);

  return res.json({
    title: test.title,
    status: test.status,
    startAt: test.startAt,
    canEnterIdentity: windowOpen ? now >= windowOpen : true,
    isLive: isTestLive(test),
    secondsToStart: startAt ? Math.max(0, Math.floor((startAt.getTime() - now.getTime()) / 1000)) : 0
  });
});

app.post("/api/tests/:code/register", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const { rollNumber, name } = req.body;
  if (!rollNumber) return res.status(400).json({ message: "Roll number is required" });

  const test = await ensureLifecycleForTest(code);
  if (!test) return res.status(404).json({ message: "Test not found" });

  const roll = String(rollNumber).trim();
  const normalizedName = String(name || "").trim();

  const participantRef = db.collection(TESTS).doc(code).collection("participants").doc(roll);
  const participantSnap = await participantRef.get();
  const existingParticipant = participantSnap.exists ? participantSnap.data() : null;

  if (!existingParticipant && !normalizedName) {
    return res.status(400).json({ message: "Name is required for new registration" });
  }

  const now = new Date();
  const windowOpen = getWindowOpenTime(test);
  if (windowOpen && now < windowOpen && test.status !== "live") {
    return res.status(400).json({ message: "Roll number entry opens 2 minutes before start" });
  }

  await participantRef.set(
    {
      rollNumber: roll,
      name: normalizedName || existingParticipant?.name || "",
      joinedAt: nowIso()
    },
    { merge: true }
  );

  const attemptRef = db.collection(TESTS).doc(code).collection("attempts").doc(roll);
  const attemptSnap = await attemptRef.get();
  if (!attemptSnap.exists) {
    await attemptRef.set({
      rollNumber: roll,
      status: test.status === "live" ? "in_progress" : "waiting",
      currentIndex: 0,
      answers: {},
      answerTimestamps: {},
      tabSwitchCount: 0,
      fullscreenExitCount: 0,
      warningCount: 0,
      startedAt: null,
      submittedAt: null,
      score: null
    });
  }

  return res.json({ ok: true, mode: existingParticipant ? "rejoin" : "register" });
});

app.get("/api/tests/:code/participant-state", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const { rollNumber } = req.query;
  const test = await getTestByCode(code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!rollNumber) return res.json({ exists: false });

  const roll = String(rollNumber).trim();
  const participantRef = db.collection(TESTS).doc(code).collection("participants").doc(roll);
  const participantSnap = await participantRef.get();
  if (!participantSnap.exists) return res.json({ exists: false });

  const attemptSnap = await db.collection(TESTS).doc(code).collection("attempts").doc(roll).get();
  const attempt = attemptSnap.exists ? attemptSnap.data() : null;

  return res.json({
    exists: true,
    name: participantSnap.data().name,
    attemptStatus: attempt?.status || "waiting",
    submitted: Boolean(attempt?.submittedAt)
  });
});

app.post("/api/tests/:code/start", requireTeacher, async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const test = await getTestByCode(code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!(await hasTeacherAccess(test, req.teacherToken))) {
    return res.status(403).json({ message: "Only teacher can start this test" });
  }

  const startedAt = nowIso();
  await db.collection(TESTS).doc(code).set({ status: "live", startedAt: test.startedAt || startedAt }, { merge: true });

  const attemptsSnap = await db.collection(TESTS).doc(code).collection("attempts").get();
  const batch = db.batch();
  attemptsSnap.docs.forEach((d) => {
    if (!d.data().submittedAt) {
      batch.set(d.ref, { status: "in_progress" }, { merge: true });
    }
  });
  await batch.commit();

  res.json({ ok: true, startedAt });
});

app.get("/api/tests/:code/questions", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const { rollNumber } = req.query;

  const test = await ensureLifecycleForTest(code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!rollNumber) return res.status(400).json({ message: "rollNumber required" });
  if (test.status !== "live" && test.status !== "completed") {
    return res.status(400).json({ message: "Test has not started yet" });
  }

  const roll = String(rollNumber).trim();
  const attempt = await getAttempt(code, roll);
  if (!attempt) return res.status(404).json({ message: "Attempt not found" });

  const allQuestions = await listQuestions(code);

  let paper = Array.isArray(attempt.paper) ? attempt.paper : null;
  let optionOrders = attempt.optionOrders || null;

  if (!Array.isArray(paper) || !optionOrders) {
    const built = buildAttemptPaper(test, allQuestions);
    paper = built.paper;
    optionOrders = built.optionOrders;
    await db.collection(TESTS).doc(code).collection("attempts").doc(roll).set(
      {
        paper,
        optionOrders
      },
      { merge: true }
    );
  }

  const byId = new Map(allQuestions.map((q) => [q.id, q]));
  const orderedQuestions = paper
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((q, displayIdx) => {
      const sourceOptions = Array.isArray(q.options) ? q.options : [];
      const order = Array.isArray(optionOrders?.[q.id])
        ? optionOrders[q.id]
        : sourceOptions.map((_, idx) => idx);

      return {
        id: q.id,
        displayIdx,
        type: q.type,
        prompt: q.prompt,
        marks: q.marks,
        options: order.map((originalIndex) => ({
          originalIndex,
          text: sourceOptions[originalIndex]
        }))
      };
    });

  res.json({
    test: {
      title: test.title,
      durationMinutes: test.durationMinutes,
      status: test.status,
      startedAt: test.startedAt,
      settings: test.settings || {}
    },
    attempt: {
      currentIndex: attempt.currentIndex || 0,
      answers: attempt.answers || {},
      answerTimestamps: attempt.answerTimestamps || {},
      status: attempt.status,
      tabSwitchCount: Number(attempt.tabSwitchCount || 0),
      fullscreenExitCount: Number(attempt.fullscreenExitCount || 0),
      warningCount: Number(attempt.warningCount || 0)
    },
    questions: orderedQuestions
  });
});

app.post("/api/tests/:code/attempt/save", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const { rollNumber, currentIndex, answers, answerTimestamps } = req.body;
  const test = await getTestByCode(code);
  if (!test) return res.status(404).json({ message: "Test not found" });

  const roll = String(rollNumber).trim();
  const attempt = await getAttempt(code, roll);
  if (!attempt) return res.status(404).json({ message: "Attempt not found" });
  const settings = test.settings || {};
  const nextIndex = Number(currentIndex ?? 0);

  if (settings.allowBack === false && nextIndex < Number(attempt.currentIndex || 0)) {
    return res.status(400).json({ message: "Back navigation is disabled for this test" });
  }

  await db.collection(TESTS).doc(code).collection("attempts").doc(roll).set(
    {
      currentIndex: nextIndex,
      answers: answers || {},
      answerTimestamps: answerTimestamps || {},
      status: "in_progress",
      startedAt: attempt.startedAt || nowIso()
    },
    { merge: true }
  );

  res.json({ ok: true });
});

app.post("/api/tests/:code/submit", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const { rollNumber } = req.body;
  const test = await getTestByCode(code);
  if (!test) return res.status(404).json({ message: "Test not found" });

  const roll = String(rollNumber).trim();
  const attempt = await getAttempt(code, roll);
  if (!attempt) return res.status(404).json({ message: "Attempt not found" });

  const questionsById = await listQuestions(code);
  const score = computeScore(questionsById, attempt.answers || {});

  await db.collection(TESTS).doc(code).collection("attempts").doc(roll).set(
    {
      submittedAt: nowIso(),
      status: "submitted",
      score
    },
    { merge: true }
  );

  res.json({ ok: true, score });
});

app.post("/api/tests/:code/proctor-event", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const { rollNumber, eventType } = req.body;
  const test = await getTestByCode(code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!rollNumber || !eventType) return res.status(400).json({ message: "rollNumber and eventType are required" });

  const roll = String(rollNumber).trim();
  const attemptRef = db.collection(TESTS).doc(code).collection("attempts").doc(roll);
  const attemptSnap = await attemptRef.get();
  if (!attemptSnap.exists) return res.status(404).json({ message: "Attempt not found" });

  let tabInc = 0;
  let fsInc = 0;
  let warnInc = 1;
  if (eventType === "tab_hidden" || eventType === "window_blur") {
    tabInc = 1;
  }
  if (eventType === "fullscreen_exit") {
    fsInc = 1;
  }

  await attemptRef.set(
    {
      tabSwitchCount: admin.firestore.FieldValue.increment(tabInc),
      fullscreenExitCount: admin.firestore.FieldValue.increment(fsInc),
      warningCount: admin.firestore.FieldValue.increment(warnInc)
    },
    { merge: true }
  );

  return res.json({ ok: true });
});

app.get("/api/tests/:code/dashboard", requireTeacher, async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const test = await ensureLifecycleForTest(code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!(await hasTeacherAccess(test, req.teacherToken))) {
    return res.status(403).json({ message: "Only teacher can view dashboard" });
  }

  const participantsSnap = await db.collection(TESTS).doc(code).collection("participants").get();
  const attemptsSnap = await db.collection(TESTS).doc(code).collection("attempts").get();

  const attemptsByRoll = new Map(attemptsSnap.docs.map((d) => [d.id, d.data()]));

  const participants = participantsSnap.docs.map((d) => {
    const p = d.data();
    const a = attemptsByRoll.get(d.id) || {};
    return {
      roll_number: p.rollNumber,
      name: p.name,
      status: a.status || "waiting",
      current_index: Number(a.currentIndex ?? 0),
      score: a.score ?? null,
      tab_switch_count: Number(a.tabSwitchCount || 0),
      fullscreen_exit_count: Number(a.fullscreenExitCount || 0),
      warning_count: Number(a.warningCount || 0)
    };
  });

  participants.sort(naturalRollSort);

  const counts = {
    joined: participants.length,
    submitted: participants.filter((p) => p.status === "submitted").length,
    inProgress: participants.filter((p) => p.status === "in_progress").length
  };

  res.json({
    test: {
      title: test.title,
      code: test.code,
      status: test.status,
      startAt: test.startAt,
      startedAt: test.startedAt,
      durationMinutes: test.durationMinutes
    },
    counts,
    participants
  });
});

app.get("/api/tests/:code/participants/:rollNumber/report", requireTeacher, async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const test = await getTestByCode(code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!(await hasTeacherAccess(test, req.teacherToken))) {
    return res.status(403).json({ message: "Only teacher can view report" });
  }

  const report = await buildParticipantReportByRoll(test, req.params.rollNumber);
  if (!report) return res.status(404).json({ message: "Participant not found" });
  return res.json(report);
});

app.get("/api/tests/:code/results.xlsx", requireTeacher, async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const test = await getTestByCode(code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!(await hasTeacherAccess(test, req.teacherToken))) {
    return res.status(403).json({ message: "Only teacher can download results" });
  }

  const participantsSnap = await db.collection(TESTS).doc(code).collection("participants").get();
  const participantsBase = participantsSnap.docs
    .map((d) => d.data())
    .map((p) => ({ roll_number: p.rollNumber, name: p.name }));
  participantsBase.sort(naturalRollSort);

  const enriched = [];
  for (const p of participantsBase) {
    const report = await buildParticipantReportByRoll(test, p.roll_number);
    if (report) enriched.push(report);
  }

  const buffer = await createResultsWorkbookBuffer({
    testMeta: { title: test.title, generatedAt: nowIso() },
    participants: enriched
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename=results-${test.code}.xlsx`);
  res.send(Buffer.from(buffer));
});

app.use((err, req, res, next) => {
  console.error(err);
  return res.status(500).json({ message: "Internal server error", detail: err?.message || "Unknown error" });
});

export { app };
export const api = onRequest({ cors: true }, app);
