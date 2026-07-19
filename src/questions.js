// Screening-question helpers shared by the apply worker, the REST API and the
// Telegram bot. A question is:
//   { id, label, type: 'text'|'number'|'select'|'radio'|'checkbox'|'file',
//     options: [..]|null, required: bool, answer: string|null,
//     answeredVia: 'library'|'gui'|'telegram'|null }
// questions_json on the applications row is the JSON array of these.

// Normalized form of a question label — the answer_library key. Same question,
// differently punctuated across postings, must map to the same key.
export function normalizeQuestionKey(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[?!.:,;()"'´`’*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseQuestions(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function unansweredRequired(questions) {
  return questions.filter(q => q.required && (q.answer == null || String(q.answer).trim() === ''));
}

// Write an answer onto a question (by id). Select-type answers must match one
// of the options. Returns true when applied.
export function applyAnswer(questions, questionId, value, via) {
  const q = questions.find(x => x.id === questionId);
  if (!q) return false;
  const v = String(value).trim();
  if ((q.type === 'select' || q.type === 'radio') && Array.isArray(q.options) && q.options.length) {
    const match = q.options.find(o => String(o).trim().toLowerCase() === v.toLowerCase());
    if (!match) return false;
    q.answer = match;
  } else {
    q.answer = v;
  }
  q.answeredVia = via;
  return true;
}

// Pre-fill questions from answer_library rows. Library answers for select-type
// questions are only used when still a valid option. Answers are suggestions —
// the user always sees them before anything is submitted.
export function prefillFromLibrary(questions, libraryRows) {
  const byKey = new Map(libraryRows.map(r => [r.question_key, r]));
  let filled = 0;
  for (const q of questions) {
    if (q.answer != null && String(q.answer).trim() !== '') continue;
    const hit = byKey.get(normalizeQuestionKey(q.label));
    if (!hit || hit.answer == null || String(hit.answer).trim() === '') continue;
    if ((q.type === 'select' || q.type === 'radio') && Array.isArray(q.options) && q.options.length) {
      const match = q.options.find(o => String(o).trim().toLowerCase() === String(hit.answer).trim().toLowerCase());
      if (!match) continue;
      q.answer = match;
    } else {
      q.answer = hit.answer;
    }
    q.answeredVia = 'library';
    filled++;
  }
  return filled;
}

// Rows to upsert into answer_library after a submit — every question the user
// actually answered (library-prefills count too: re-upserting bumps use_count).
export function libraryRowsFromQuestions(questions) {
  return questions
    .filter(q => q.label && q.answer != null && String(q.answer).trim() !== '')
    .map(q => ({
      question_key: normalizeQuestionKey(q.label),
      label: q.label,
      type: q.type || 'text',
      options_json: Array.isArray(q.options) && q.options.length ? JSON.stringify(q.options) : null,
      answer: String(q.answer),
    }));
}
