// Server CHỈ ĐỌC: phục vụ file tĩnh + danh sách quiz mặc định + danh sách nhạc có sẵn.
// Không nhận dữ liệu từ người dùng và không ghi gì xuống ổ đĩa: quiz tự tạo/import và link YouTube
// đều nằm trong localStorage của từng trình duyệt, nên nhiều người truy cập cũng không làm nặng server.
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SAMPLE_DIR = path.join(__dirname, 'quizzes');          // quiz mặc định: thả file .json vào đây
const MUSIC_DIR = path.join(__dirname, 'public', 'music');   // nhạc trong Cài đặt (phát khi làm quiz): thả file âm thanh vào đây
const LOBBY_MUSIC_DIR = path.join(__dirname, 'public', 'lobby', 'music'); // nhạc sảnh (phát khi chưa vào quiz)
const LOBBY_VIDEO_DIR = path.join(__dirname, 'public', 'lobby', 'video'); // video nền ở sảnh
const CONFIG_FILE = 'config.json';                           // tùy chọn cố định cho quiz mặc định
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac', '.opus', '.webm']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogv', '.m4v', '.mov']);
const DEFAULT_OPTIONS = { shuffleQuestions: true, shuffleAnswers: false, instantFeedback: true, limit: 0 };

[SAMPLE_DIR, MUSIC_DIR, LOBBY_MUSIC_DIR, LOBBY_VIDEO_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => {
    if (/\.(html|js|css)$/i.test(p)) res.setHeader('Cache-Control', 'no-cache');            // luôn kiểm tra bản mới
    else if (/[\\/](music|lobby)[\\/]/.test(p)) res.setHeader('Cache-Control', 'public, max-age=3600'); // nhạc/video: cache 1 giờ
  }
}));

// Đọc đĩa tối đa 1 lần / 3 giây dù có bao nhiêu người truy cập
const memo = (fn, ttl = 3000) => { let at = 0, val; return () => { const now = Date.now(); if (now - at > ttl) { val = fn(); at = now; } return val; }; };

/* ================= QUIZ MẶC ĐỊNH ================= */
function cleanOptions(raw) {
  const o = {};
  if (!raw || typeof raw !== 'object') return o;
  for (const k of ['shuffleQuestions', 'shuffleAnswers', 'instantFeedback']) if (typeof raw[k] === 'boolean') o[k] = raw[k];
  if (Number.isInteger(raw.limit) && raw.limit >= 0) o.limit = raw.limit;
  return o;
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Quiz phải là một object JSON.');
  const title = String(raw.title || '').trim();
  if (!title) throw new Error('Thiếu "title".');
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) throw new Error(`Quiz "${title}": thiếu mảng "questions".`);

  const questions = raw.questions.map((q, i) => {
    const n = i + 1;
    if (!q || typeof q !== 'object') throw new Error(`Quiz "${title}", câu ${n}: không hợp lệ.`);
    const text = String(q.question ?? q.q ?? '').trim();
    if (!text) throw new Error(`Quiz "${title}", câu ${n}: thiếu "question".`);
    const options = (q.options ?? q.answers);
    if (!Array.isArray(options) || options.length < 2) throw new Error(`Quiz "${title}", câu ${n}: cần ít nhất 2 "options".`);
    const opts = options.map(String);

    let answer = q.answer ?? q.correct;
    if (typeof answer === 'string') {
      const idx = opts.findIndex(o => o.trim().toLowerCase() === answer.trim().toLowerCase());
      if (idx !== -1) answer = idx;
      else if (/^\d+$/.test(answer.trim())) answer = Number(answer);
      else throw new Error(`Quiz "${title}", câu ${n}: "answer" không khớp đáp án nào.`);
    }
    if (!Number.isInteger(answer) || answer < 0 || answer >= opts.length)
      throw new Error(`Quiz "${title}", câu ${n}: "answer" phải là chỉ số từ 0 đến ${opts.length - 1}.`);

    return { question: text, options: opts, answer, explanation: q.explanation ? String(q.explanation) : '' }; // explanation không bắt buộc
  });

  const options = cleanOptions(raw.options);
  return {
    title,
    description: raw.description ? String(raw.description) : '',
    category: raw.category ? String(raw.category).trim() : 'Khác',
    ...(Object.keys(options).length ? { options } : {}),
    questions
  };
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, CONFIG_FILE), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.warn(`[!] Không đọc được ${CONFIG_FILE}: ${e.message}`); return {}; }
}

const loadSamples = memo(() => {
  const cfg = readConfig();
  const base = { ...DEFAULT_OPTIONS, ...cleanOptions(cfg.default) };
  const per = cfg.quizzes && typeof cfg.quizzes === 'object' ? cfg.quizzes : {};
  let files = [];
  try { files = fs.readdirSync(SAMPLE_DIR).filter(f => f.toLowerCase().endsWith('.json') && f.toLowerCase() !== CONFIG_FILE).sort(); } catch {}
  const out = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, f), 'utf8'));
      const list = Array.isArray(raw) ? raw : [raw]; // 1 file có thể chứa nhiều quiz
      const multi = list.length > 1;
      list.forEach((item, i) => {
        const quiz = normalize(item);
        const key = multi ? `${f}#${i}` : f;
        // Tùy chọn của quiz mặc định lấy từ config.json (cố định, người chơi không đổi được)
        const options = { ...base, ...cleanOptions(per[f]), ...(multi ? cleanOptions(per[key]) : {}) };
        out.push({ ...quiz, id: `sample:${key}`, source: 'sample', locked: true, options });
      });
    } catch (e) { console.warn(`[!] Bỏ qua quizzes/${f}: ${e.message}`); }
  }
  return out;
});

app.get('/api/quizzes', (req, res) => {
  res.json(loadSamples().map(({ questions, ...meta }) => ({ ...meta, count: questions.length })));
});
app.get('/api/quizzes/:id', (req, res) => {
  const quiz = loadSamples().find(q => q.id === req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Không tìm thấy quiz.' });
  res.json(quiz);
});

/* ================= NHẠC & VIDEO CÓ SẴN (đặt cố định trong thư mục website) ================= */
function listFiles(dir, exts, urlBase) {
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => exts.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
  } catch {}
  return files.map(f => ({
    type: 'file', file: f,
    name: path.basename(f, path.extname(f)).replace(/[-_]+/g, ' ').trim(),
    url: urlBase + encodeURIComponent(f)
  }));
}
const listMusic = memo(() => listFiles(MUSIC_DIR, AUDIO_EXT, '/music/'));
// Sảnh: danh sách nhạc (phát lần lượt, lặp lại) + video nền (dùng file đầu tiên, null nếu không có)
const listLobby = memo(() => ({
  music: listFiles(LOBBY_MUSIC_DIR, AUDIO_EXT, '/lobby/music/'),
  video: listFiles(LOBBY_VIDEO_DIR, VIDEO_EXT, '/lobby/video/')[0] || null
}));
app.get('/api/music', (req, res) => res.json(listMusic()));
app.get('/api/lobby', (req, res) => res.json(listLobby()));

app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy.' }));

app.listen(PORT, () => {
  console.log('\n  Quiz Web đang chạy:');
  console.log(`  -> http://localhost:${PORT}\n`);
  console.log('  Nhấn Ctrl+C để dừng.\n');
});
