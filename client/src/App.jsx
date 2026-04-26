import { useEffect, useMemo, useRef, useState } from "react";
const host = typeof window !== "undefined" ? window.location.hostname : "localhost";
const API_BASE = import.meta.env.VITE_API_BASE || (host === "localhost" ? "http://localhost:4000/api" : "/api");

const blankQuestion = { prompt: "", type: "single_mcq", options: ["", "", "", ""], answer: "A", marks: 1 };
const defaultSettings = {
  randomizeQuestions: false,
  randomizeOptions: false,
  randomPaperSize: "",
  allowBack: true
};

const initialCreateForm = {
  title: "",
  startAt: "",
  durationMinutes: 10,
  settings: defaultSettings,
  questions: [blankQuestion]
};

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatDuration(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function StatCard({ label, value }) {
  return (
    <div className="statCard">
      <div className="statLabel">{label}</div>
      <div className="statValue">{value}</div>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState("home");
  const [createForm, setCreateForm] = useState(initialCreateForm);
  const [teacherSession, setTeacherSession] = useState(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem("teacherSession") || "null");
      return parsed || { code: "", teacherToken: "" };
    } catch {
      return { code: "", teacherToken: "" };
    }
  });
  const [dashboard, setDashboard] = useState(null);
  const [studentReport, setStudentReport] = useState(null);
  const [studentReportLoading, setStudentReportLoading] = useState(false);
  const [currentTestTitle, setCurrentTestTitle] = useState("");

  const [join, setJoin] = useState({ code: "", rollNumber: "", name: "" });
  const [status, setStatus] = useState(null);
  const [studentRegistered, setStudentRegistered] = useState(false);
  const [participantState, setParticipantState] = useState({ exists: false, attemptStatus: "waiting", submitted: false });
  const [attempt, setAttempt] = useState(null);
  const [submitted, setSubmitted] = useState(null);
  const [testRemainingSeconds, setTestRemainingSeconds] = useState(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [proctorStats, setProctorStats] = useState({ tabSwitchCount: 0, fullscreenExitCount: 0, warningCount: 0 });
  const [proctorWarning, setProctorWarning] = useState("");
  const [proctorWarningStickyFs, setProctorWarningStickyFs] = useState(false);
  const [isFullscreenActive, setIsFullscreenActive] = useState(true);
  const [isPageVisible, setIsPageVisible] = useState(typeof document === "undefined" ? true : !document.hidden);
  const proctorCooldownRef = useRef({});

  const teacherCode = teacherSession.code;
  const teacherToken = teacherSession.teacherToken;

  useEffect(() => {
    if (teacherSession.code && teacherSession.teacherToken) {
      localStorage.setItem("teacherSession", JSON.stringify(teacherSession));
    }
  }, [teacherSession]);

  useEffect(() => {
    if (!teacherCode || !teacherToken) return;
    loadDashboard(teacherCode, teacherToken);
  }, [teacherCode, teacherToken]);

  useEffect(() => {
    if (screen !== "teacher-dashboard" || !teacherCode || !teacherToken) return;
    const id = setInterval(() => loadDashboard(teacherCode, teacherToken), 3000);
    return () => clearInterval(id);
  }, [screen, teacherCode, teacherToken]);

  useEffect(() => {
    if (screen !== "student-wait" || !join.code) return;
    const id = setInterval(() => refreshStatus(true), 1000);
    return () => clearInterval(id);
  }, [screen, join.code, join.rollNumber, studentRegistered]);

  useEffect(() => {
    if (screen !== "student-wait" || !join.code || !join.rollNumber) {
      setParticipantState({ exists: false, attemptStatus: "waiting", submitted: false });
      return;
    }

    const id = setTimeout(async () => {
      try {
        const res = await fetch(
          `${API_BASE}/tests/${join.code}/participant-state?rollNumber=${encodeURIComponent(join.rollNumber)}`
        );
        const data = await res.json();
        if (!res.ok) return;
        setParticipantState({
          exists: Boolean(data.exists),
          attemptStatus: data.attemptStatus || "waiting",
          submitted: Boolean(data.submitted)
        });
      } catch {}
    }, 250);

    return () => clearTimeout(id);
  }, [screen, join.code, join.rollNumber]);

  useEffect(() => {
    if (!attempt || screen !== "student-test") return;
    const startedAt = attempt?.test?.startedAt;
    if (!startedAt) return;

    const endTs = new Date(startedAt).getTime() + Number(attempt.test.durationMinutes) * 60 * 1000;
    const tick = () => {
      const left = Math.max(0, Math.floor((endTs - Date.now()) / 1000));
      setTestRemainingSeconds(left);
      if (left === 0 && screen === "student-test") {
        submitTest({ auto: true });
      }
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [attempt, screen]);

  useEffect(() => {
    if (screen !== "student-test" || !attempt) return;

    const registerProctorEvent = (eventType, message) => {
      const now = Date.now();
      const lastAt = proctorCooldownRef.current[eventType] || 0;
      if (now - lastAt < 1200) return;
      proctorCooldownRef.current[eventType] = now;

      setProctorWarning(message);
      setProctorWarningStickyFs(eventType === "fullscreen_exit");
      setProctorStats((prev) => ({
        tabSwitchCount: prev.tabSwitchCount + (eventType === "tab_hidden" || eventType === "window_blur" ? 1 : 0),
        fullscreenExitCount: prev.fullscreenExitCount + (eventType === "fullscreen_exit" ? 1 : 0),
        warningCount: prev.warningCount + 1
      }));

      fetch(`${API_BASE}/tests/${join.code}/proctor-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rollNumber: join.rollNumber, eventType })
      }).catch(() => {});
    };

    const tryEnterFullscreen = async () => {
      if (!document.documentElement.requestFullscreen) return;
      try {
        await document.documentElement.requestFullscreen();
        setIsFullscreenActive(true);
      } catch {
        setIsFullscreenActive(Boolean(document.fullscreenElement));
        setProctorWarning("Please enable full-screen mode for secure test taking.");
      }
    };

    tryEnterFullscreen();

    const onVisibilityChange = () => {
      setIsPageVisible(!document.hidden);
      if (document.hidden) {
        registerProctorEvent("tab_hidden", "Warning: You switched away from the test tab.");
      }
    };

    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreenActive(active);
      if (!active) {
        registerProctorEvent("fullscreen_exit", "Warning: Full-screen exited. Re-enter immediately.");
      }
    };

    const onContextMenu = (e) => {
      e.preventDefault();
      registerProctorEvent("contextmenu_blocked", "Right-click is disabled during this test.");
    };

    const onCopy = (e) => {
      e.preventDefault();
      registerProctorEvent("copy_blocked", "Copy is disabled during this test.");
    };

    const onPaste = (e) => {
      e.preventDefault();
      registerProctorEvent("paste_blocked", "Paste is disabled during this test.");
    };

    const onKeyDown = (e) => {
      const key = String(e.key || "").toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ["c", "v", "x", "a", "p"].includes(key)) {
        e.preventDefault();
        registerProctorEvent("shortcut_blocked", "Clipboard/print shortcuts are disabled.");
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [screen, attempt, join.code, join.rollNumber]);

  useEffect(() => {
    if (!proctorWarning) return;
    if (!isPageVisible) return;
    if (proctorWarningStickyFs && !isFullscreenActive) return;
    const id = setTimeout(() => {
      setProctorWarning("");
      setProctorWarningStickyFs(false);
    }, 4000);
    return () => clearTimeout(id);
  }, [proctorWarning, proctorWarningStickyFs, isFullscreenActive, isPageVisible]);

  async function createTest() {
    const normalizedStartAt = createForm.startAt ? new Date(createForm.startAt).toISOString() : null;
    const payload = {
      title: createForm.title,
      startAt: normalizedStartAt,
      durationMinutes: Number(createForm.durationMinutes),
      settings: {
        ...createForm.settings,
        randomPaperSize: createForm.settings.randomPaperSize
          ? Number(createForm.settings.randomPaperSize)
          : null
      },
      questions: createForm.questions.map((q) => ({
        prompt: q.prompt,
        type: q.type,
        options: q.options,
        answer: [q.answer],
        marks: Number(q.marks || 1)
      }))
    };

    const res = await fetch(`${API_BASE}/tests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) return alert(data.message || "Failed to create");

    setTeacherSession({ code: data.code, teacherToken: data.teacherToken });
    setScreen("teacher-dashboard");
  }

  function updateQuestion(index, patch) {
    setCreateForm((prev) => {
      const questions = [...prev.questions];
      questions[index] = { ...questions[index], ...patch };
      return { ...prev, questions };
    });
  }

  function updateOption(qIndex, oIndex, value) {
    setCreateForm((prev) => {
      const questions = [...prev.questions];
      const options = [...questions[qIndex].options];
      options[oIndex] = value;
      questions[qIndex] = { ...questions[qIndex], options };
      return { ...prev, questions };
    });
  }

  async function parseExcel(file) {
    const bytes = await file.arrayBuffer();
    const res = await fetch(`${API_BASE}/tests/parse-questions`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes
    });
    const data = await res.json();
    if (!res.ok) return alert(data.message || "Failed to parse file");

    setCreateForm((prev) => ({
      ...prev,
      questions: data.questions.map((q) => ({
        prompt: q.prompt,
        type: q.type,
        options: [...q.options, "", "", "", ""].slice(0, 4),
        answer: q.answer?.[0] || "A",
        marks: q.marks || 1
      }))
    }));
  }

  async function loadDashboard(code, token) {
    const res = await fetch(`${API_BASE}/tests/${code}/dashboard`, {
      headers: { "x-teacher-token": token }
    });

    const data = await res.json();
    if (!res.ok) return alert(data.message || "Dashboard unavailable");
    setDashboard(data);
  }

  async function loadStudentReport(rollNumber) {
    if (!teacherCode || !teacherToken || !rollNumber) return;
    setStudentReportLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/tests/${teacherCode}/participants/${encodeURIComponent(rollNumber)}/report`,
        { headers: { "x-teacher-token": teacherToken } }
      );
      const data = await res.json();
      if (!res.ok) return alert(data.message || "Unable to load report");
      setStudentReport(data);
      setScreen("teacher-student-report");
    } finally {
      setStudentReportLoading(false);
    }
  }

  async function startNow() {
    const res = await fetch(`${API_BASE}/tests/${teacherCode}/start`, {
      method: "POST",
      headers: { "x-teacher-token": teacherToken }
    });
    const data = await res.json();
    if (!res.ok) return alert(data.message || "Failed to start");
    loadDashboard(teacherCode, teacherToken);
  }

  async function refreshStatus(silent = false) {
    try {
      const res = await fetch(`${API_BASE}/tests/${join.code}/status`);
      const data = await res.json();
      if (!res.ok) {
        if (!silent) alert(data.message || "Test not found");
        return;
      }

      setStatus(data);
      if (data?.title) setCurrentTestTitle(data.title);

      if (data.isLive && studentRegistered && join.rollNumber) {
        fetchTestQuestions(true);
      }
    } catch {
      if (!silent) {
        alert("Cannot reach server from this device. Use your laptop IP URL and ensure backend runs on port 4000.");
      }
    }
  }

  async function checkStatus() {
    await refreshStatus(false);
    setScreen("student-wait");
  }

  async function registerStudent() {
    const res = await fetch(`${API_BASE}/tests/${join.code}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rollNumber: join.rollNumber, name: join.name })
    });
    const data = await res.json();
    if (!res.ok) return alert(data.message || "Failed to register");
    setStudentRegistered(true);
    setParticipantState((prev) => ({ ...prev, exists: true }));
    await refreshStatus(true);
    return data;
  }

  async function fetchTestQuestions(silent = false) {
    if (!join.rollNumber) return;
    const res = await fetch(`${API_BASE}/tests/${join.code}/questions?rollNumber=${encodeURIComponent(join.rollNumber)}`);
    const data = await res.json();
    if (!res.ok) {
      if (!silent) alert(data.message || "Cannot enter test yet");
      return;
    }
    setAttempt(data);
    if (data?.test?.title) setCurrentTestTitle(data.test.title);
    setProctorStats({
      tabSwitchCount: Number(data.attempt?.tabSwitchCount || 0),
      fullscreenExitCount: Number(data.attempt?.fullscreenExitCount || 0),
      warningCount: Number(data.attempt?.warningCount || 0)
    });
    setProctorWarning("");
    setIsFullscreenActive(Boolean(document.fullscreenElement));
    setScreen("student-test");
  }

  async function saveProgress(newIndex, newAnswers, newAnswerTimestamps) {
    await fetch(`${API_BASE}/tests/${join.code}/attempt/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rollNumber: join.rollNumber,
        currentIndex: newIndex,
        answers: newAnswers,
        answerTimestamps: newAnswerTimestamps
      })
    });
  }

  async function submitTest({ auto = false } = {}) {
    if (screen === "student-submitted" || isSubmitting) return;
    if (!auto) {
      const ok = window.confirm("Are you sure you want to submit your test now?");
      if (!ok) return;
    }
    setIsSubmitting(true);
    const res = await fetch(`${API_BASE}/tests/${join.code}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rollNumber: join.rollNumber })
    });
    const data = await res.json();
    if (!res.ok) {
      setIsSubmitting(false);
      return alert(data.message || "Submit failed");
    }
    setSubmitted(data);
    setScreen("student-submitted");
    setIsSubmitting(false);
  }

  async function copyTestCode() {
    if (!teacherCode) return;
    try {
      await navigator.clipboard.writeText(teacherCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1200);
    } catch {
      alert("Could not copy test code");
    }
  }

  function resetToHome() {
    setScreen("home");
    setCreateForm(initialCreateForm);
    setJoin({ code: "", rollNumber: "", name: "" });
    setStatus(null);
    setParticipantState({ exists: false, attemptStatus: "waiting", submitted: false });
    setAttempt(null);
    setSubmitted(null);
    setCurrentTestTitle("");
    setStudentRegistered(false);
    setIsSubmitting(false);
    setStudentReport(null);
    setStudentReportLoading(false);
    setProctorStats({ tabSwitchCount: 0, fullscreenExitCount: 0, warningCount: 0 });
    setProctorWarning("");
    setProctorWarningStickyFs(false);
    setIsFullscreenActive(true);
    setIsPageVisible(true);
  }

  const currentQuestion = useMemo(() => {
    if (!attempt) return null;
    return attempt.questions[attempt.attempt.currentIndex] || attempt.questions[0];
  }, [attempt]);

  const waitActionLabel = useMemo(() => {
    if (participantState.submitted) return "Already Submitted";
    if (!studentRegistered) {
      return participantState.exists ? "Rejoin" : "Register";
    }
    return status?.isLive ? "Join Test" : "Join Test";
  }, [participantState.exists, participantState.submitted, status?.isLive, studentRegistered]);

  const waitActionDisabled = useMemo(() => {
    if (!status?.canEnterIdentity) return true;
    if (participantState.submitted) return true;
    if (!join.rollNumber.trim()) return true;
    if (!participantState.exists && !join.name.trim()) return true;
    return false;
  }, [status?.canEnterIdentity, participantState.submitted, participantState.exists, join.rollNumber, join.name]);

  async function handleWaitAction() {
    if (participantState.submitted) return;
    const wasExisting = participantState.exists;

    if (!studentRegistered) {
      await registerStudent();
      if (wasExisting && status?.isLive) {
        await fetchTestQuestions(false);
      }
      return;
    }

    if (status?.isLive) {
      await fetchTestQuestions(false);
    }
  }

  if (screen === "home") {
    return (
      <div className="page shell">
        <div className="hero">
          <h1>Surprise Test</h1>
          <p className="muted">Fast classroom tests with no login, Excel support, and live monitoring.</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setScreen("join")}>Join a Test</button>
          <button className="btn btn-primary" onClick={() => setScreen("create")}>Create a Test</button>
          {teacherCode ? <button className="btn btn-ghost" onClick={() => setScreen("teacher-dashboard")}>Open Teacher Dashboard</button> : null}
        </div>
      </div>
    );
  }

  if (screen === "create") {
    return (
      <div className="page shell wide">
        <div className="sectionHeader">
          <h2>Create Test</h2>
          <button className="btn btn-ghost" onClick={resetToHome}>Cancel</button>
        </div>

        <div className="stack">
          <div className="card formCard grid2">
            <label className="field">Title<input value={createForm.title} onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })} /></label>
            <label className="field">Start Date-Time<input type="datetime-local" value={createForm.startAt} onChange={(e) => setCreateForm({ ...createForm, startAt: e.target.value })} /></label>
            <label className="field">Duration (minutes)<input type="number" value={createForm.durationMinutes} onChange={(e) => setCreateForm({ ...createForm, durationMinutes: e.target.value })} /></label>
            <label className="field">Random Paper Size (blank = full)<input type="number" value={createForm.settings.randomPaperSize} onChange={(e) => setCreateForm({ ...createForm, settings: { ...createForm.settings, randomPaperSize: e.target.value } })} /></label>
          </div>

          <div className="card formCard">
            <div className="checkRow">
              <label className="checkItem"><input type="checkbox" checked={createForm.settings.randomizeQuestions} onChange={(e) => setCreateForm({ ...createForm, settings: { ...createForm.settings, randomizeQuestions: e.target.checked } })} /><span>Randomize Question Sequence</span></label>
              <label className="checkItem"><input type="checkbox" checked={createForm.settings.randomizeOptions} onChange={(e) => setCreateForm({ ...createForm, settings: { ...createForm.settings, randomizeOptions: e.target.checked } })} /><span>Randomize Option Sequence</span></label>
              <label className="checkItem"><input type="checkbox" checked={createForm.settings.allowBack} onChange={(e) => setCreateForm({ ...createForm, settings: { ...createForm.settings, allowBack: e.target.checked } })} /><span>Allow Back Navigation</span></label>
            </div>
          </div>

          <div className="actions">
            <a className="btn btn-primary" href={`${API_BASE}/templates/questions.xlsx`} target="_blank" rel="noreferrer">Download Question Template</a>
            <label className="btn btn-ghost filePicker">Upload Excel<input type="file" accept=".xlsx" onChange={(e) => e.target.files?.[0] && parseExcel(e.target.files[0])} /></label>
          </div>

          <h3>Questions</h3>
          {createForm.questions.map((q, idx) => (
            <div key={idx} className="card formCard">
              <div className="muted">Q{idx + 1}</div>
              <label className="field"><span>Question</span><input placeholder="Enter question" value={q.prompt} onChange={(e) => updateQuestion(idx, { prompt: e.target.value })} /></label>
              <div className="grid2">
                {q.options.map((op, opIdx) => (
                  <label key={opIdx} className="field">
                    <span>Option {String.fromCharCode(65 + opIdx)}</span>
                    <input value={op} onChange={(e) => updateOption(idx, opIdx, e.target.value)} />
                  </label>
                ))}
              </div>
              <div className="grid2">
                <label className="field">Answer
                  <select value={q.answer} onChange={(e) => updateQuestion(idx, { answer: e.target.value })}>
                    <option>A</option><option>B</option><option>C</option><option>D</option>
                  </select>
                </label>
                <label className="field">Marks<input type="number" value={q.marks} onChange={(e) => updateQuestion(idx, { marks: e.target.value })} /></label>
              </div>
            </div>
          ))}

          <div className="actions">
            <button className="btn btn-ghost" onClick={() => setCreateForm({ ...createForm, questions: [...createForm.questions, { ...blankQuestion }] })}>Add Question</button>
            <button className="btn btn-primary" onClick={createTest}>Create Test</button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "teacher-dashboard") {
    return (
      <div className="page shell wide">
        <div className="sectionHeader">
          <div>
            <h2>{dashboard?.test?.title || currentTestTitle || "Teacher Dashboard"}</h2>
            <p className="muted">Teacher Dashboard</p>
          </div>
          <button className="btn btn-ghost" onClick={resetToHome}>Close</button>
        </div>

        <div className="codeRow">
          <div className="codePill"><span className="muted">Test Code</span><strong>{teacherCode}</strong></div>
          <button className="btn btn-ghost" onClick={copyTestCode}>{copiedCode ? "Copied" : "Copy Code"}</button>
        </div>

        <div className="actions">
          <button className="btn btn-primary" onClick={startNow}>Start Test Now</button>
          <button className="btn btn-ghost" onClick={() => loadDashboard(teacherCode, teacherToken)}>Refresh</button>
          <a className="btn btn-primary" href={`${API_BASE}/tests/${teacherCode}/results.xlsx?teacherToken=${encodeURIComponent(teacherToken)}`} target="_blank" rel="noreferrer">Download Results Excel</a>
        </div>

        {dashboard ? (
          <>
            <div className="statsGrid">
              <StatCard label="Status" value={dashboard.test.status} />
              <StatCard label="Joined" value={dashboard.counts.joined} />
              <StatCard label="In Progress" value={dashboard.counts.inProgress} />
              <StatCard label="Submitted" value={dashboard.counts.submitted} />
            </div>
            <div className="metaGrid">
              <div><span className="muted">Scheduled Start:</span> {formatDateTime(dashboard.test.startAt)}</div>
              <div><span className="muted">Actual Start:</span> {formatDateTime(dashboard.test.startedAt)}</div>
              <div><span className="muted">Duration:</span> {dashboard.test.durationMinutes} min</div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Roll Number</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Current Question</th>
                  <th>Score</th>
                  <th>View</th>
                  <th>Tab Switches</th>
                  <th>FS Exits</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.participants.map((p) => (
                  <tr key={p.roll_number}>
                    <td>{p.roll_number}</td>
                    <td>{p.name}</td>
                    <td>{p.status || "waiting"}</td>
                    <td>{Number.isFinite(p.current_index) ? Number(p.current_index) + 1 : "-"}</td>
                    <td>{p.score ?? "-"}</td>
                    <td>
                      <button className="btn btn-ghost btn-small" onClick={() => loadStudentReport(p.roll_number)}>
                        View
                      </button>
                    </td>
                    <td>{p.tab_switch_count ?? 0}</td>
                    <td>{p.fullscreen_exit_count ?? 0}</td>
                    <td>{p.warning_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {studentReportLoading ? <p className="muted">Loading student report...</p> : null}
          </>
        ) : (
          <p className="muted">Loading dashboard...</p>
        )}
      </div>
    );
  }

  if (screen === "teacher-student-report" && studentReport) {
    return (
      <div className="page shell wide">
        <div className="sectionHeader">
          <h2>{studentReport.test_title || currentTestTitle || "Test Report"}</h2>
          <button className="btn btn-ghost" onClick={() => setScreen("teacher-dashboard")}>Back to Dashboard</button>
        </div>

        <div className="metaGrid">
          <div><span className="muted">Roll Number:</span> {studentReport.roll_number}</div>
          <div><span className="muted">Name:</span> {studentReport.name}</div>
          <div><span className="muted">Score:</span> {studentReport.score ?? "-"}</div>
          <div><span className="muted">Status:</span> {studentReport.status || "-"}</div>
        </div>

        {(studentReport.report?.questions || []).map((q, idx) => (
          <div key={`${studentReport.roll_number}-${idx}`} className="card questionCard reportQuestionCard">
            <div className="muted">Question {idx + 1}</div>
            <p className="questionText">{q.question_text}</p>
            {[q.option_a, q.option_b, q.option_c, q.option_d].map((opt, optionIdx) => {
              const label = String.fromCharCode(65 + optionIdx);
              const isSelected = (q.selected_option || "").toUpperCase() === label;
              const isCorrect = (q.correct_answer || "").toUpperCase() === label;
              return (
                <div
                  key={`${studentReport.roll_number}-${idx}-${label}`}
                  className={`optionRow ${isSelected ? "selected" : ""} ${isCorrect ? "correct" : ""}`}
                >
                  <span className="optionLeft">
                    <span className="optionBadge">{label}</span>
                    <span>{opt || "-"}</span>
                  </span>
                  <span className="reportFlags">
                    {isSelected ? <span className="pill selectedPill">Selected</span> : null}
                    {isCorrect ? <span className="pill correctPill">Correct</span> : null}
                  </span>
                </div>
              );
            })}
            <div className="grid2 reportMeta">
              <div><span className="muted">Selected Answer:</span> <strong>{q.selected_option || "-"}</strong></div>
              <div><span className="muted">Correct Answer:</span> <strong>{q.correct_answer || "-"}</strong></div>
              <div><span className="muted">Answered At:</span> <strong>{q.answered_at || "-"}</strong></div>
              <div><span className="muted">Marks:</span> <strong>{q.marks ?? "-"}</strong></div>
            </div>
          </div>
        ))}

        <div className="card reportPanel">
          <h3>Proctoring Details</h3>
          <div className="grid2">
            <div><span className="muted">Tab Switches:</span> {studentReport.report?.proctoring?.tab_switch_count ?? 0}</div>
            <div><span className="muted">Fullscreen Exits:</span> {studentReport.report?.proctoring?.fullscreen_exit_count ?? 0}</div>
            <div><span className="muted">Warnings:</span> {studentReport.report?.proctoring?.warning_count ?? 0}</div>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "join") {
    return (
      <div className="page shell">
        <div className="sectionHeader">
          <h2>Join Test</h2>
          <button className="btn btn-ghost" onClick={resetToHome}>Cancel</button>
        </div>
        <div className="stack compact">
          <label className="field">Test Code<input value={join.code} onChange={(e) => setJoin({ ...join, code: e.target.value.toUpperCase() })} /></label>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={checkStatus}>Continue</button>
        </div>
      </div>
    );
  }

  if (screen === "student-wait") {
    return (
      <div className="page shell">
        <div className="sectionHeader">
          <h2>{status?.title}</h2>
          <button className="btn btn-ghost" onClick={resetToHome}>Cancel</button>
        </div>
        <div className="stack compact">
          <p>{status?.isLive ? "Test is live now" : "Waiting for test start"}</p>
          <p className="muted">Countdown: {status?.secondsToStart ?? "-"}s</p>
        </div>

        {status?.canEnterIdentity ? (
          <>
            <div className="stack compact">
              <label className="field">Roll Number<input value={join.rollNumber} onChange={(e) => setJoin({ ...join, rollNumber: e.target.value })} /></label>
              <label className="field">Name (required)<input value={join.name} onChange={(e) => setJoin({ ...join, name: e.target.value })} /></label>
            </div>
            <div className="actions">
              <button className="btn btn-primary" onClick={handleWaitAction} disabled={waitActionDisabled}>
                {waitActionLabel}
              </button>
            </div>
          </>
        ) : (
          <p>Roll number entry opens 2 minutes before start.</p>
        )}
      </div>
    );
  }

  if (screen === "student-test" && attempt && currentQuestion) {
    const q = currentQuestion;
    const idx = attempt.attempt.currentIndex;
    const selected = attempt.attempt.answers[String(q.id)];
    const allowBack = attempt.test.settings.allowBack !== false;

    return (
      <div className="page shell wide">
        <div className="sectionHeader">
          <h2>{attempt.test.title || currentTestTitle || "Current Test"}</h2>
          <div className="testHeaderActions">
            <div className="timerPill">Time Remaining: {formatDuration(testRemainingSeconds)}</div>
            <button className="btn btn-primary danger" onClick={() => submitTest()} disabled={isSubmitting}>
              {isSubmitting ? "Submitting..." : "Submit"}
            </button>
          </div>
        </div>
        <div className="muted">Question {idx + 1} / {attempt.questions.length}</div>
        <div className="progressBar"><span style={{ width: `${((idx + 1) / attempt.questions.length) * 100}%` }} /></div>

        <div className="proctorBar">
          <div className="proctorStatusBlock">
            <strong>SECURED PROCTORING ON</strong>
          </div>
          {proctorWarning ? <div className="proctorWarningArea active">{proctorWarning}</div> : null}
        </div>

        {!isFullscreenActive ? (
          <div className="fullscreenGate">
            <div className="fullscreenGateInner">
              <h3>Full Screen Required</h3>
              <p className="muted">Questions are hidden until you re-enter full-screen mode.</p>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  try {
                    await document.documentElement.requestFullscreen?.();
                  } catch {}
                }}
              >
                Enter Full Screen Mode to Continue Test
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="card questionCard">
              <p className="questionText">{q.prompt}</p>
              {q.options.map((opt, optionPosition) => {
                const label = String.fromCharCode(65 + optionPosition);
                const value = opt.originalIndex;
                const checked = Number(selected) === Number(value);
                return (
                  <label key={`${q.id}-${value}`} className={`optionRow ${checked ? "selected" : ""}`}>
                    <span className="optionLeft">
                      <span className="optionBadge">{label}</span>
                      <span>{opt.text}</span>
                    </span>
                    <input
                      className="optionRadio"
                      type="radio"
                      checked={checked}
                      onChange={async () => {
                        const newAnswers = { ...attempt.attempt.answers, [String(q.id)]: Number(value) };
                        const newAnswerTimestamps = {
                          ...(attempt.attempt.answerTimestamps || {}),
                          [String(q.id)]: new Date().toISOString()
                        };
                        setAttempt({
                          ...attempt,
                          attempt: { ...attempt.attempt, answers: newAnswers, answerTimestamps: newAnswerTimestamps }
                        });
                        await saveProgress(idx, newAnswers, newAnswerTimestamps);
                      }}
                    />
                  </label>
                );
              })}
            </div>

            <div className="actions">
              <button
                className="btn btn-ghost"
                disabled={!allowBack || idx <= 0}
                onClick={async () => {
                  const next = idx - 1;
                  setAttempt({ ...attempt, attempt: { ...attempt.attempt, currentIndex: next } });
                  await saveProgress(next, attempt.attempt.answers, attempt.attempt.answerTimestamps || {});
                }}
              >Previous</button>
              <button
                className="btn btn-primary"
                disabled={idx >= attempt.questions.length - 1}
                onClick={async () => {
                  const next = idx + 1;
                  setAttempt({ ...attempt, attempt: { ...attempt.attempt, currentIndex: next } });
                  await saveProgress(next, attempt.attempt.answers, attempt.attempt.answerTimestamps || {});
                }}
              >Next</button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (screen === "student-submitted") {
    return (
      <div className="page shell">
        <h2>Submitted</h2>
        {currentTestTitle ? <p className="muted">{currentTestTitle}</p> : null}
        <p>Your test has been submitted successfully.</p>
        <p className="muted">Result visibility is restricted to teachers.</p>
        {submitted ? <p className="muted">Submission has been saved by server.</p> : null}
        <div className="actions">
          <button className="btn btn-ghost" onClick={resetToHome}>Back to Home</button>
        </div>
      </div>
    );
  }

  return <div className="page shell">Loading...</div>;
}
