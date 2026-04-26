import ExcelJS from "exceljs";

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

export async function createQuestionTemplateBuffer() {
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

export async function parseQuestionWorkbook(buffer) {
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

export async function createResultsWorkbookBuffer(results) {
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
