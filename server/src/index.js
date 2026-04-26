import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import multer from "multer";
import { all, get, initDb, run } from "./db.js";
import { createQuestionTemplateBuffer, createResultsWorkbookBuffer, parseQuestionWorkbook } from "./excel.js";
import {
  answerLabelToIndex,
  getWindowOpenTime,
  isTestLive,
  makeTeacherToken,
  makeTestCode,
  nowIso,
  safeJsonParse,
  shuffleArray
} from "./utils.js";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
const upload = multer();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

function normalizeQuestions(questions = []) {
  return questions.map((q, idx) => ({
    idx,
    type: q.type || "single_mcq",
    prompt: q.prompt,
    options: q.options || [],
    answer: (Array.isArray(q.answer) ? q.answer : [q.answer]).map((a) =>
      typeof a === "number" ? a : answerLabelToIndex(a)
    ),
    marks: Number(q.marks || 1)
  }));
}

async function getTestByCode(code) {
  return get("SELECT * FROM tests WHERE code = ?", [code]);
}

async function getAttempt(testId, rollNumber) {
  return get(
    `
    SELECT a.*, p.roll_number, p.name
    FROM attempts a
    JOIN participants p ON p.id = a.participant_id
    WHERE a.test_id = ? AND p.roll_number = ?
  `,
    [testId, rollNumber]
  );
}

function requireTeacher(req, res, next) {
  const teacherToken = req.header("x-teacher-token") || req.query.teacherToken;
  if (!teacherToken) {
    return res.status(401).json({ message: "Teacher token required" });
  }
  req.teacherToken = teacherToken;
  return next();
}

async function hasTeacherAccess(test, teacherToken) {
  return Boolean(test && test.teacher_token && teacherToken && test.teacher_token === teacherToken);
}

function buildAttemptPaper(test, allQuestions) {
  const settings = safeJsonParse(test.settings_json, {});
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
    const options = safeJsonParse(q.options_json, []);
    const indices = options.map((_, idx) => idx);
    optionOrders[q.id] = settings.randomizeOptions ? shuffleArray(indices) : indices;
  }

  return {
    paper: selected.map((q) => q.id),
    optionOrders
  };
}

function computeScore(questionsById, answersJson) {
  const answers = safeJsonParse(answersJson, {});
  let score = 0;

  questionsById.forEach((q) => {
    const key = String(q.id);
    const selected = answers[key];
    const expected = safeJsonParse(q.answer_json, []);

    const s = Array.isArray(selected) ? selected : selected === 0 || selected ? [selected] : [];
    const isCorrect =
      s.length === expected.length &&
      [...s].map(Number).sort((a, b) => a - b).join("|") ===
        [...expected].map(Number).sort((a, b) => a - b).join("|");

    if (isCorrect) {
      score += Number(q.marks || 1);
    }
  });

  return score;
}

function indexToLabel(i) {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Number(i)] || "";
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

async function buildParticipantReportByRoll(test, rollNumber) {
  const participant = await get(
    "SELECT * FROM participants WHERE test_id = ? AND roll_number = ?",
    [test.id, String(rollNumber).trim()]
  );
  if (!participant) return null;

  const attempt = await get(
    "SELECT * FROM attempts WHERE test_id = ? AND participant_id = ?",
    [test.id, participant.id]
  );

  const questionRows = await all(
    "SELECT id, idx, type, prompt, options_json, answer_json, marks, topic FROM questions WHERE test_id = ? ORDER BY idx",
    [test.id]
  );

  const questionsById = new Map(questionRows.map((q) => [q.id, q]));
  const answers = safeJsonParse(attempt?.answers_json || "{}", {});
  const answerTimes = safeJsonParse(attempt?.answer_timestamps_json || "{}", {});
  const paper = safeJsonParse(attempt?.paper_json || "[]", []);

  const selectedQuestions = (Array.isArray(paper) && paper.length > 0 ? paper : questionRows.map((q) => q.id))
    .map((id) => questionsById.get(id))
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx);

  const reportQuestions = selectedQuestions.map((q) => {
    const opts = safeJsonParse(q.options_json, []);
    const expected = safeJsonParse(q.answer_json, []);
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
      topic: q.topic || "",
      selected_option: selected === 0 || selected ? indexToLabel(selected) : "",
      answered_at: answerTimes[String(q.id)] || ""
    };
  });

  return {
    test_title: test.title,
    roll_number: participant.roll_number,
    name: participant.name,
    score: attempt?.score ?? "",
    status: attempt?.status || "waiting",
    submitted_at: attempt?.submitted_at || "",
    report: {
      sheetName: safeSheetName(`R-${participant.roll_number}`),
      questions: reportQuestions,
      proctoring: {
        tab_switch_count: Number(attempt?.tab_switch_count || 0),
        fullscreen_exit_count: Number(attempt?.fullscreen_exit_count || 0),
        warning_count: Number(attempt?.warning_count || 0)
      }
    }
  };
}

async function startTest(test) {
  const startedAt = nowIso();
  await run("UPDATE tests SET status = 'live', started_at = COALESCE(started_at, ?) WHERE id = ?", [startedAt, test.id]);
  await run(
    "UPDATE attempts SET status = CASE WHEN submitted_at IS NULL THEN 'in_progress' ELSE status END WHERE test_id = ?",
    [test.id]
  );

  const refreshed = await getTestByCode(test.code);
  io.to(`test:${test.code}`).emit("test:started", {
    startedAt: refreshed.started_at,
    durationMinutes: refreshed.duration_minutes
  });
  io.to(`teacher:${test.code}`).emit("dashboard:update");
  return refreshed;
}

async function ensureScheduledStarts() {
  const now = Date.now();
  const scheduledTests = await all("SELECT * FROM tests WHERE status = 'scheduled' AND start_at IS NOT NULL");

  for (const test of scheduledTests) {
    const startAtMs = new Date(test.start_at).getTime();
    if (now >= startAtMs) {
      await startTest(test);
    }
  }
}

async function ensureAlwaysOnTest() {
  const code = "TEST";
  const teacherToken = "TEST_TEACHER_TOKEN";
  let test = await getTestByCode(code);

  if (!test) {
    const insert = await run(
      `
      INSERT INTO tests (code, teacher_token, title, start_at, duration_minutes, status, settings_json, created_at, started_at)
      VALUES (?, ?, ?, NULL, ?, 'live', ?, ?, ?)
    `,
      [
        code,
        teacherToken,
        "UI Sandbox Test",
        525600,
        JSON.stringify({
          randomizeQuestions: false,
          randomizeOptions: false,
          randomPaperSize: null,
          allowBack: true
        }),
        nowIso(),
        nowIso()
      ]
    );

    const testId = insert.lastID;
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

    for (const q of demoQuestions) {
      await run(
        `
        INSERT INTO questions (test_id, idx, type, prompt, options_json, answer_json, marks, topic)
        VALUES (?, ?, 'single_mcq', ?, ?, ?, 1, 'Demo')
      `,
        [testId, q.idx, q.prompt, JSON.stringify(q.options), JSON.stringify(q.answer)]
      );
    }
  } else {
    await run(
      "UPDATE tests SET teacher_token = ?, status = 'live', started_at = ?, duration_minutes = ? WHERE id = ?",
      [teacherToken, nowIso(), 525600, test.id]
    );
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/templates/questions.xlsx", async (req, res) => {
  const buffer = await createQuestionTemplateBuffer();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=question-template.xlsx");
  res.send(Buffer.from(buffer));
});

app.post("/api/tests/parse-questions", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Excel file is required" });
  }
  const questions = await parseQuestionWorkbook(req.file.buffer);
  return res.json({ questions });
});

app.post("/api/tests", async (req, res) => {
  const { title, startAt, durationMinutes, settings, questions } = req.body;

  if (!title || !durationMinutes || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  let code = makeTestCode();
  let exists = await getTestByCode(code);
  while (exists) {
    code = makeTestCode();
    exists = await getTestByCode(code);
  }

  const teacherToken = makeTeacherToken();
  const createdAt = nowIso();
  const testInsert = await run(
    `
    INSERT INTO tests (code, teacher_token, title, start_at, duration_minutes, status, settings_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)
  `,
    [code, teacherToken, title, startAt || null, Number(durationMinutes), JSON.stringify(settings || {}), createdAt]
  );

  const testId = testInsert.lastID;
  const rows = normalizeQuestions(questions);

  for (const q of rows) {
    await run(
      `
      INSERT INTO questions (test_id, idx, type, prompt, options_json, answer_json, marks, topic)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        testId,
        q.idx,
        q.type,
        q.prompt,
        JSON.stringify(q.options),
        JSON.stringify(q.answer),
        q.marks,
        q.topic
      ]
    );
  }

  return res.status(201).json({ code, testId, teacherToken });
});

app.get("/api/tests/:code/status", async (req, res) => {
  await ensureScheduledStarts();
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });

  const now = new Date();
  const startAt = test.start_at ? new Date(test.start_at) : null;
  const windowOpen = getWindowOpenTime(test);

  return res.json({
    title: test.title,
    status: test.status,
    startAt: test.start_at,
    canEnterIdentity: windowOpen ? now >= windowOpen : true,
    isLive: isTestLive(test),
    secondsToStart: startAt ? Math.max(0, Math.floor((startAt.getTime() - now.getTime()) / 1000)) : 0
  });
});

app.post("/api/tests/:code/register", async (req, res) => {
  await ensureScheduledStarts();
  const { rollNumber, name } = req.body;
  const code = req.params.code;
  if (!rollNumber) return res.status(400).json({ message: "Roll number is required" });

  const test = await getTestByCode(code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  const normalizedRoll = String(rollNumber).trim();
  const normalizedName = String(name || "").trim();
  const existingParticipant = await get(
    "SELECT * FROM participants WHERE test_id = ? AND roll_number = ?",
    [test.id, normalizedRoll]
  );
  if (!existingParticipant && !normalizedName) {
    return res.status(400).json({ message: "Name is required for new registration" });
  }

  const now = new Date();
  const windowOpen = getWindowOpenTime(test);
  if (windowOpen && now < windowOpen && test.status !== "live") {
    return res.status(400).json({ message: "Roll number entry opens 2 minutes before start" });
  }

  await run(
    `
      INSERT INTO participants (test_id, roll_number, name, joined_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(test_id, roll_number) DO UPDATE SET name=excluded.name
    `,
    [test.id, normalizedRoll, normalizedName || existingParticipant?.name || "", nowIso()]
  );

  const participant = await get(
    "SELECT * FROM participants WHERE test_id = ? AND roll_number = ?",
    [test.id, normalizedRoll]
  );

  await run(
    `
      INSERT INTO attempts (test_id, participant_id, status)
      VALUES (?, ?, ?)
      ON CONFLICT(test_id, participant_id) DO NOTHING
    `,
    [test.id, participant.id, test.status === "live" ? "in_progress" : "waiting"]
  );

  io.to(`teacher:${code}`).emit("dashboard:update");
  return res.json({ ok: true, mode: existingParticipant ? "rejoin" : "register" });
});

app.get("/api/tests/:code/participant-state", async (req, res) => {
  const { rollNumber } = req.query;
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!rollNumber) return res.json({ exists: false });

  const participant = await get(
    "SELECT * FROM participants WHERE test_id = ? AND roll_number = ?",
    [test.id, String(rollNumber).trim()]
  );
  if (!participant) return res.json({ exists: false });

  const attempt = await get(
    "SELECT status, submitted_at FROM attempts WHERE test_id = ? AND participant_id = ?",
    [test.id, participant.id]
  );

  return res.json({
    exists: true,
    name: participant.name,
    attemptStatus: attempt?.status || "waiting",
    submitted: Boolean(attempt?.submitted_at)
  });
});

app.post("/api/tests/:code/start", requireTeacher, async (req, res) => {
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!(await hasTeacherAccess(test, req.teacherToken))) {
    return res.status(403).json({ message: "Only teacher can start this test" });
  }

  const started = await startTest(test);
  res.json({ ok: true, startedAt: started.started_at });
});

app.get("/api/tests/:code/questions", async (req, res) => {
  await ensureScheduledStarts();
  const { rollNumber } = req.query;
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!rollNumber) return res.status(400).json({ message: "rollNumber required" });
  if (test.status !== "live" && test.status !== "completed") {
    return res.status(400).json({ message: "Test has not started yet" });
  }

  const attempt = await getAttempt(test.id, String(rollNumber));
  if (!attempt) return res.status(404).json({ message: "Attempt not found" });

  const allQuestions = await all(
    "SELECT id, idx, type, prompt, options_json, answer_json, marks FROM questions WHERE test_id = ? ORDER BY idx",
    [test.id]
  );

  let paper = safeJsonParse(attempt.paper_json, null);
  let optionOrders = safeJsonParse(attempt.option_orders_json, null);

  if (!Array.isArray(paper) || !optionOrders) {
    const built = buildAttemptPaper(test, allQuestions);
    paper = built.paper;
    optionOrders = built.optionOrders;
    await run("UPDATE attempts SET paper_json = ?, option_orders_json = ? WHERE id = ?", [
      JSON.stringify(paper),
      JSON.stringify(optionOrders),
      attempt.id
    ]);
  }

  const byId = new Map(allQuestions.map((q) => [q.id, q]));
  const orderedQuestions = paper
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((q, displayIdx) => {
      const sourceOptions = safeJsonParse(q.options_json, []);
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
      durationMinutes: test.duration_minutes,
      status: test.status,
      startedAt: test.started_at,
      settings: safeJsonParse(test.settings_json, {})
    },
    attempt: {
      currentIndex: attempt.current_index,
      answers: safeJsonParse(attempt.answers_json, {}),
      answerTimestamps: safeJsonParse(attempt.answer_timestamps_json || "{}", {}),
      status: attempt.status,
      tabSwitchCount: Number(attempt.tab_switch_count || 0),
      fullscreenExitCount: Number(attempt.fullscreen_exit_count || 0),
      warningCount: Number(attempt.warning_count || 0)
    },
    questions: orderedQuestions
  });
});

app.post("/api/tests/:code/attempt/save", async (req, res) => {
  const { rollNumber, currentIndex, answers, answerTimestamps } = req.body;
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });

  const attempt = await getAttempt(test.id, String(rollNumber));
  if (!attempt) return res.status(404).json({ message: "Attempt not found" });
  const settings = safeJsonParse(test.settings_json, {});
  const nextIndex = Number(currentIndex ?? 0);

  if (settings.allowBack === false && nextIndex < Number(attempt.current_index)) {
    return res.status(400).json({ message: "Back navigation is disabled for this test" });
  }

  await run(
    "UPDATE attempts SET current_index = ?, answers_json = ?, answer_timestamps_json = ?, status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ?",
    [nextIndex, JSON.stringify(answers || {}), JSON.stringify(answerTimestamps || {}), nowIso(), attempt.id]
  );

  io.to(`teacher:${test.code}`).emit("dashboard:update");
  res.json({ ok: true });
});

app.post("/api/tests/:code/submit", async (req, res) => {
  const { rollNumber } = req.body;
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });

  const attempt = await getAttempt(test.id, String(rollNumber));
  if (!attempt) return res.status(404).json({ message: "Attempt not found" });

  const questionsById = await all("SELECT id, answer_json, marks FROM questions WHERE test_id = ?", [test.id]);
  const score = computeScore(questionsById, attempt.answers_json);

  await run(
    "UPDATE attempts SET submitted_at = ?, status = 'submitted', score = ? WHERE id = ?",
    [nowIso(), score, attempt.id]
  );

  io.to(`teacher:${test.code}`).emit("dashboard:update");
  res.json({ ok: true, score });
});

app.post("/api/tests/:code/proctor-event", async (req, res) => {
  const { rollNumber, eventType } = req.body;
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!rollNumber || !eventType) return res.status(400).json({ message: "rollNumber and eventType are required" });

  const attempt = await getAttempt(test.id, String(rollNumber));
  if (!attempt) return res.status(404).json({ message: "Attempt not found" });

  let tabInc = 0;
  let fsInc = 0;
  let warnInc = 1;
  if (eventType === "tab_hidden" || eventType === "window_blur") {
    tabInc = 1;
  }
  if (eventType === "fullscreen_exit") {
    fsInc = 1;
  }

  await run(
    `
      UPDATE attempts
      SET tab_switch_count = tab_switch_count + ?,
          fullscreen_exit_count = fullscreen_exit_count + ?,
          warning_count = warning_count + ?
      WHERE id = ?
    `,
    [tabInc, fsInc, warnInc, attempt.id]
  );

  io.to(`teacher:${test.code}`).emit("dashboard:update");
  return res.json({ ok: true });
});

app.get("/api/tests/:code/dashboard", requireTeacher, async (req, res) => {
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!(await hasTeacherAccess(test, req.teacherToken))) {
    return res.status(403).json({ message: "Only teacher can view dashboard" });
  }

  const joined = await get("SELECT COUNT(*) AS c FROM participants WHERE test_id = ?", [test.id]);
  const submitted = await get("SELECT COUNT(*) AS c FROM attempts WHERE test_id = ? AND status = 'submitted'", [test.id]);
  const inProgress = await get("SELECT COUNT(*) AS c FROM attempts WHERE test_id = ? AND status = 'in_progress'", [test.id]);
  const participants = await all(
    `
      SELECT p.roll_number, p.name, a.status, a.current_index, a.score, a.tab_switch_count, a.fullscreen_exit_count, a.warning_count
      FROM participants p
      LEFT JOIN attempts a ON a.participant_id = p.id
      WHERE p.test_id = ?
      ORDER BY p.roll_number
    `,
    [test.id]
  );
  participants.sort(naturalRollSort);

  res.json({
    test: {
      title: test.title,
      code: test.code,
      status: test.status,
      startAt: test.start_at,
      startedAt: test.started_at,
      durationMinutes: test.duration_minutes
    },
    counts: {
      joined: joined.c,
      submitted: submitted.c,
      inProgress: inProgress.c
    },
    participants
  });
});

app.get("/api/tests/:code/participants/:rollNumber/report", requireTeacher, async (req, res) => {
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!(await hasTeacherAccess(test, req.teacherToken))) {
    return res.status(403).json({ message: "Only teacher can view report" });
  }

  const report = await buildParticipantReportByRoll(test, req.params.rollNumber);
  if (!report) return res.status(404).json({ message: "Participant not found" });
  return res.json(report);
});

app.get("/api/tests/:code/results.xlsx", requireTeacher, async (req, res) => {
  const test = await getTestByCode(req.params.code);
  if (!test) return res.status(404).json({ message: "Test not found" });
  if (!(await hasTeacherAccess(test, req.teacherToken))) {
    return res.status(403).json({ message: "Only teacher can download results" });
  }

  const results = await all(
    `
      SELECT p.roll_number, p.name, a.score, a.submitted_at, a.status
      FROM participants p
      LEFT JOIN attempts a ON a.participant_id = p.id
      WHERE p.test_id = ?
      ORDER BY p.roll_number
    `,
    [test.id]
  );
  results.sort(naturalRollSort);
  const enriched = [];
  for (const r of results) {
    const report = await buildParticipantReportByRoll(test, r.roll_number);
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

io.on("connection", (socket) => {
  socket.on("room:join", ({ testCode, role }) => {
    if (!testCode || !role) return;
    const room = role === "teacher" ? `teacher:${testCode}` : `test:${testCode}`;
    socket.join(room);
  });
});

const PORT = process.env.PORT || 4000;

async function autoSubmitExpiredTests() {
  await ensureScheduledStarts();
  const liveTests = await all("SELECT * FROM tests WHERE status = 'live'");
  const now = Date.now();

  for (const test of liveTests) {
    if (!test.started_at) continue;
    const endTs = new Date(test.started_at).getTime() + Number(test.duration_minutes) * 60 * 1000;
    if (now < endTs) continue;

    const openAttempts = await all(
      "SELECT * FROM attempts WHERE test_id = ? AND status != 'submitted'",
      [test.id]
    );
    const questionsById = await all("SELECT id, answer_json, marks FROM questions WHERE test_id = ?", [test.id]);

    for (const attempt of openAttempts) {
      const score = computeScore(questionsById, attempt.answers_json);
      await run(
        "UPDATE attempts SET submitted_at = ?, status = 'submitted', score = ? WHERE id = ?",
        [nowIso(), score, attempt.id]
      );
    }

    await run("UPDATE tests SET status = 'completed' WHERE id = ?", [test.id]);
    io.to(`teacher:${test.code}`).emit("dashboard:update");
  }
}

initDb().then(async () => {
  await ensureAlwaysOnTest();
  httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  setInterval(() => {
    autoSubmitExpiredTests().catch((err) => console.error("Auto-submit failure:", err.message));
  }, 1000);
}).catch((err) => {
  console.error("Startup failure:", err.message);
});
