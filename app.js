'use strict';

/* ───────────── 상수 ───────────── */
const WORK = ['D', 'E', 'N'];
const CYCLE = [null, 'D', 'E', 'N', 'OFF'];
const REQ_CYCLE = [null, 'OFF', 'V', 'D', 'E', 'N'];
const LEVEL_LABEL = { senior: '책임', regular: '일반', new: '신규' };
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const STORAGE_KEY = 'nurse-schedule-v1';
const HISTORY_DAYS = 7;
const ATTEMPTS = 400;

/* ───────────── 상태 ───────────── */
function defaultState() {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 2; // 기본은 다음 달
  if (month > 12) { month = 1; year++; }
  return {
    year,
    month,
    nurses: [],
    rules: {
      weekday: { D: 3, E: 3, N: 2 },
      weekend: { D: 2, E: 2, N: 2 },
      maxConsecWork: 5,
      maxConsecNight: 3,
      nightRest: 2,
      minOff: 9,
      seniorEachShift: true,
    },
    months: {},
  };
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const base = defaultState();
      return { ...base, ...parsed, rules: { ...base.rules, ...parsed.rules } };
    }
  } catch (e) { /* 저장소 사용 불가 시 기본값 */ }
  return defaultState();
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 무시 */ }
}

/* ───────────── 날짜 도우미 ───────────── */
const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const daysIn = (y, m) => new Date(y, m, 0).getDate();
const dow = (y, m, d) => new Date(y, m - 1, d + 1).getDay(); // d: 0-based

function prevYM(y, m) { return m === 1 ? [y - 1, 12] : [y, m - 1]; }
function nextYM(y, m) { return m === 12 ? [y + 1, 1] : [y, m + 1]; }

function monthData(y = state.year, m = state.month) {
  const key = monthKey(y, m);
  if (!state.months[key]) state.months[key] = { schedule: {}, requests: {}, holidays: [] };
  return state.months[key];
}

function isWeekendOrHoliday(d) {
  const w = dow(state.year, state.month, d);
  return w === 0 || w === 6 || monthData().holidays.includes(d);
}

function needFor(d) {
  return isWeekendOrHoliday(d) ? state.rules.weekend : state.rules.weekday;
}

/** 지난달 마지막 HISTORY_DAYS일 근무 (연속 근무·금지 패턴 판단용) */
function historyFor(nurseId) {
  const [py, pm] = prevYM(state.year, state.month);
  const prev = state.months[monthKey(py, pm)];
  const arr = prev && prev.schedule[nurseId];
  if (!arr) return Array(HISTORY_DAYS).fill(null);
  const tail = arr.slice(-HISTORY_DAYS);
  while (tail.length < HISTORY_DAYS) tail.unshift(null);
  return tail;
}

/* ───────────── 규칙 판단 ───────────── */
const isWork = (s) => WORK.includes(s);
const isRest = (s) => s === 'OFF' || s === 'V';

function consecBefore(seq, p, pred) {
  let c = 0;
  for (let q = p - 1; q >= 0 && pred(seq[q]); q--) c++;
  return c;
}

/** 마지막 나이트 이후 휴무일 수. 직전 근무가 나이트가 아니면 Infinity */
function offsSinceNight(seq, p) {
  let c = 0;
  let q = p - 1;
  while (q >= 0 && isRest(seq[q])) { c++; q--; }
  return q >= 0 && seq[q] === 'N' ? c : Infinity;
}

function canAssign(seq, p, shift, rules) {
  const prev = seq[p - 1];
  if (prev === 'N' && shift !== 'N') return false;
  if (prev === 'E' && shift === 'D') return false;
  if (consecBefore(seq, p, isWork) >= rules.maxConsecWork) return false;
  if (shift === 'N' && consecBefore(seq, p, (s) => s === 'N') >= rules.maxConsecNight) return false;
  if (prev !== 'N' && offsSinceNight(seq, p) < rules.nightRest) return false;
  const next = seq[p + 1];
  if (next === 'D' && (shift === 'N' || shift === 'E')) return false;
  if (next === 'E' && shift === 'N') return false;
  if (isWork(next) && next !== 'N' && shift === 'N') return false;
  return true;
}

/* ───────────── 자동 생성 ───────────── */
function buildContext() {
  const days = daysIn(state.year, state.month);
  const md = monthData();
  const nurses = state.nurses;
  return {
    days,
    nurses,
    rules: state.rules,
    need: Array.from({ length: days }, (_, d) => needFor(d)),
    weekend: Array.from({ length: days }, (_, d) => isWeekendOrHoliday(d)),
    hist: nurses.map((n) => historyFor(n.id)),
    req: nurses.map((n) => md.requests[n.id] || {}),
  };
}

function buildOnce(ctx) {
  const { days, nurses, rules, need, weekend, hist, req } = ctx;
  const P = HISTORY_DAYS;
  const seqs = nurses.map((_, i) => hist[i].concat(Array(days + 1).fill(null)));
  const fixed = nurses.map(() => new Array(days).fill(false));

  nurses.forEach((_, i) => {
    for (const [d, s] of Object.entries(req[i])) {
      seqs[i][P + Number(d)] = s;
      fixed[i][Number(d)] = true;
    }
  });

  const work = new Array(nurses.length).fill(0);
  const offs = new Array(nurses.length).fill(0);
  const wkWork = new Array(nurses.length).fill(0);
  const cnt = nurses.map(() => ({ D: 0, E: 0, N: 0 }));

  const mustRest = (i, d) => {
    let freeDays = 0;
    let fixedOff = 0;
    for (let k = d; k < days; k++) {
      if (fixed[i][k]) { if (seqs[i][P + k] === 'OFF') fixedOff++; }
      else if (seqs[i][P + k] === null) freeDays++;
    }
    const stillNeed = rules.minOff - offs[i] - fixedOff;
    return stillNeed > 0 && freeDays <= stillNeed;
  };

  for (let d = 0; d < days; d++) {
    const p = P + d;
    const slots = { ...need[d] };
    const senior = { D: false, E: false, N: false };
    const newbie = { D: 0, E: 0, N: 0 };

    nurses.forEach((n, i) => {
      const s = seqs[i][p];
      if (isWork(s)) {
        slots[s]--;
        if (n.level === 'senior') senior[s] = true;
        if (n.level === 'new') newbie[s]++;
      }
    });

    const assignOne = (shift, seniorOnly) => {
      const cands = [];
      nurses.forEach((n, i) => {
        if (seqs[i][p] !== null) return;
        if (seniorOnly && n.level !== 'senior') return;
        if (!canAssign(seqs[i], p, shift, rules)) return;
        if (mustRest(i, d)) return;
        cands.push(i);
      });
      if (!cands.length) return false;

      let best = -1;
      let bestScore = Infinity;
      for (const i of cands) {
        const seq = seqs[i];
        const prev = seq[p - 1];
        let sc = work[i] * 3 + cnt[i][shift] * (shift === 'N' ? 7 : 4);
        sc += consecBefore(seq, p, isWork) * 1.5;
        if (prev === shift) sc -= 7;
        if ((prev === 'D' && shift === 'E') || (prev === 'E' && shift === 'N')) sc -= 2;
        if (isRest(prev) && isWork(seq[p - 2])) sc += 3; // 하루짜리 휴무 지양
        if (weekend[d]) sc += wkWork[i] * 3;
        if (nurses[i].level === 'new' && newbie[shift] > 0) sc += 8;
        // 아직 책임이 필요한 다른 근무가 있으면 책임 간호사는 아껴 둔다
        if (!seniorOnly && rules.seniorEachShift && nurses[i].level === 'senior'
          && WORK.some((w) => w !== shift && !senior[w] && slots[w] > 0)) sc += 10;
        sc += Math.random() * 6;
        if (sc < bestScore) { bestScore = sc; best = i; }
      }

      seqs[best][p] = shift;
      slots[shift]--;
      if (nurses[best].level === 'senior') senior[shift] = true;
      if (nurses[best].level === 'new') newbie[shift]++;
      return true;
    };

    // 1단계: 근무마다 책임 간호사 먼저 배치 (후보가 적은 근무부터)
    if (rules.seniorEachShift) {
      const seniorFree = (shift) => nurses.filter((n, i) => n.level === 'senior' && seqs[i][p] === null
        && canAssign(seqs[i], p, shift, rules) && !mustRest(i, d)).length;
      const order = WORK.filter((w) => slots[w] > 0 && !senior[w]).sort((a, b) => seniorFree(a) - seniorFree(b));
      for (const shift of order) if (!senior[shift]) assignOne(shift, true);
    }
    // 2단계: 나머지 인원 채우기
    for (const shift of ['N', 'E', 'D']) {
      while (slots[shift] > 0 && assignOne(shift, false));
    }

    nurses.forEach((_, i) => {
      if (seqs[i][p] === null) seqs[i][p] = 'OFF';
      const s = seqs[i][p];
      if (isWork(s)) {
        work[i]++;
        cnt[i][s]++;
        if (weekend[d]) wkWork[i]++;
      } else if (s === 'OFF') {
        offs[i]++;
      }
    });
  }

  return nurses.map((_, i) => seqs[i].slice(P, P + days));
}

/* ───────────── 검증 / 평가 ───────────── */
function analyze(ctx, schedule) {
  const { days, nurses, rules, need, weekend, hist } = ctx;
  const P = HISTORY_DAYS;
  const issues = [];
  const bad = new Set();
  let penalty = 0;

  const daily = Array.from({ length: days }, () => ({ D: 0, E: 0, N: 0, OFF: 0, V: 0, senior: { D: false, E: false, N: false } }));
  const stats = nurses.map(() => ({ D: 0, E: 0, N: 0, OFF: 0, V: 0, wkOff: 0 }));

  nurses.forEach((n, i) => {
    const row = schedule[i];
    const seq = hist[i].concat(row);
    for (let d = 0; d < days; d++) {
      const s = row[d];
      if (!s) continue;
      daily[d][s]++;
      stats[i][s]++;
      if (s === 'OFF' && weekend[d]) stats[i].wkOff++;
      if (isWork(s) && n.level === 'senior') daily[d].senior[s] = true;

      const p = P + d;
      const prev = seq[p - 1];
      const mark = (msg, pen) => {
        issues.push(`${n.name} ${d + 1}일: ${msg}`);
        bad.add(`${i}:${d}`);
        penalty += pen;
      };
      if (prev === 'N' && (s === 'D' || s === 'E')) mark(`N 다음 ${s} 근무 금지`, 500);
      if (prev === 'E' && s === 'D') mark('E 다음 D 근무 금지', 500);
      if (isWork(s)) {
        const cw = consecBefore(seq, p, isWork) + 1;
        if (cw > rules.maxConsecWork) mark(`${cw}일 연속 근무 (최대 ${rules.maxConsecWork})`, 300);
        if (s === 'N') {
          const cn = consecBefore(seq, p, (x) => x === 'N') + 1;
          if (cn > rules.maxConsecNight) mark(`${cn}일 연속 나이트 (최대 ${rules.maxConsecNight})`, 300);
        }
        if (prev !== 'N') {
          const r = offsSinceNight(seq, p);
          if (r < rules.nightRest) mark(`나이트 후 휴무 ${r}일 (최소 ${rules.nightRest})`, 200);
        }
        if (isRest(prev) && isRest(seq[p + 1])) penalty += 4; // 고립된 근무일
      }
    }
    const filled = row.filter(Boolean).length;
    if (filled === days && stats[i].OFF < rules.minOff) {
      issues.push(`${n.name}: 휴무 ${stats[i].OFF}일 (최소 ${rules.minOff}일)`);
      penalty += (rules.minOff - stats[i].OFF) * 300;
    }
  });

  const shortDays = [];
  for (let d = 0; d < days; d++) {
    for (const s of WORK) {
      const diff = daily[d][s] - need[d][s];
      if (diff < 0) { shortDays.push(`${d + 1}일 ${s} ${-diff}명 부족`); penalty += -diff * 1000; }
      if (diff > 0) penalty += diff * 40;
      if (rules.seniorEachShift && need[d][s] > 0 && daily[d][s] > 0 && !daily[d].senior[s]) {
        issues.push(`${d + 1}일 ${s}: 책임 간호사 없음`);
        penalty += 200;
      }
    }
  }
  issues.unshift(...shortDays);

  const variance = (arr) => {
    if (!arr.length) return 0;
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length;
  };
  penalty += variance(stats.map((s) => s.N)) * 25;
  penalty += variance(stats.map((s) => s.D)) * 6;
  penalty += variance(stats.map((s) => s.E)) * 6;
  penalty += variance(stats.map((s) => s.OFF)) * 10;
  penalty += variance(stats.map((s) => s.wkOff)) * 12;

  return { penalty, issues, bad, daily, stats };
}

function generate() {
  if (!state.nurses.length) { toast('간호사를 먼저 추가하세요.'); return; }
  const ctx = buildContext();
  let best = null;
  for (let a = 0; a < ATTEMPTS; a++) {
    const sched = buildOnce(ctx);
    const res = analyze(ctx, sched);
    if (!best || res.penalty < best.penalty) best = { sched, penalty: res.penalty };
  }
  const md = monthData();
  state.nurses.forEach((n, i) => { md.schedule[n.id] = best.sched[i]; });
  save();
  render();
  const res = analyze(ctx, best.sched);
  toast(res.issues.length ? `생성 완료 · 확인할 항목 ${res.issues.length}개` : '생성 완료 · 모든 규칙 충족');
}

/* ───────────── 렌더링 ───────────── */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function currentSchedule(ctx) {
  const md = monthData();
  return state.nurses.map((n) => {
    const row = md.schedule[n.id] ? md.schedule[n.id].slice(0, ctx.days) : [];
    while (row.length < ctx.days) row.push(null);
    const req = md.requests[n.id] || {};
    for (const [d, s] of Object.entries(req)) if (!row[d]) row[d] = s;
    return row;
  });
}

function render() {
  $('#monthLabel').textContent = `${state.year}년 ${state.month}월`;
  renderNurses();
  renderLeaves();
  renderRules();
  renderGrid();
}

function renderNurses() {
  $('#nurseCount').textContent = `(${state.nurses.length}명)`;
  const ul = $('#nurseList');
  ul.innerHTML = state.nurses.map((n) => `
    <li data-id="${n.id}">
      <input value="${esc(n.name)}" data-field="name" maxlength="20" aria-label="이름" />
      <select data-field="level" aria-label="등급">
        ${Object.entries(LEVEL_LABEL).map(([v, l]) => `<option value="${v}" ${n.level === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button data-act="up" title="위로">↑</button>
      <button data-act="del" title="삭제">삭제</button>
    </li>`).join('');
}

/* 휴가·근무 신청을 연속된 기간 단위로 묶기 */
function requestRanges() {
  const md = monthData();
  const out = [];
  state.nurses.forEach((n) => {
    const req = md.requests[n.id] || {};
    const days = Object.keys(req).map(Number).sort((a, b) => a - b);
    let cur = null;
    for (const d of days) {
      if (cur && d === cur.end + 1 && req[d] === cur.type) { cur.end = d; continue; }
      if (cur) out.push(cur);
      cur = { nurse: n, type: req[d], start: d, end: d };
    }
    if (cur) out.push(cur);
  });
  return out.sort((a, b) => a.start - b.start || a.nurse.name.localeCompare(b.nurse.name, 'ko'));
}

const REQ_LABEL = { V: '연차', OFF: '휴무', D: 'D 신청', E: 'E 신청', N: 'N 신청' };
const isoDate = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function renderLeaves() {
  const sel = $('#leaveNurse');
  const keep = sel.value;
  sel.innerHTML = state.nurses.length
    ? state.nurses.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join('')
    : '<option value="">간호사를 먼저 추가하세요</option>';
  if (state.nurses.some((n) => n.id === keep)) sel.value = keep;

  // 날짜 칸이 비었거나 다른 달이면 이번 달 1일로 맞춤
  const prefix = isoDate(state.year, state.month, 1).slice(0, 7);
  for (const id of ['#leaveStart', '#leaveEnd']) {
    const el = $(id);
    if (!el.value.startsWith(prefix)) el.value = isoDate(state.year, state.month, 1);
  }

  const ranges = requestRanges();
  $('#leaveCount').textContent = `(${ranges.length}건)`;
  $('#leaveList').innerHTML = ranges.length
    ? ranges.map((r) => {
      const len = r.end - r.start + 1;
      const when = len === 1 ? `${state.month}/${r.start + 1}` : `${state.month}/${r.start + 1}~${state.month}/${r.end + 1} (${len}일)`;
      return `<li data-id="${r.nurse.id}" data-start="${r.start}" data-end="${r.end}">
        <span class="chip ${r.type}">${REQ_LABEL[r.type]}</span>
        <span class="who">${esc(r.nurse.name)} · ${when}</span>
        <button type="button" data-act="del-leave">삭제</button>
      </li>`;
    }).join('')
    : `<li class="empty">${state.month}월 신청 내역이 없습니다.</li>`;
}

function renderRules() {
  document.querySelectorAll('[data-rule]').forEach((el) => {
    const path = el.dataset.rule.split('.');
    let v = state.rules;
    for (const k of path) v = v[k];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  });
}

function renderGrid() {
  const ctx = buildContext();
  const sched = currentSchedule(ctx);
  const res = analyze(ctx, sched);
  const md = monthData();
  const { days } = ctx;

  let html = '<thead><tr><th class="name">이름</th>';
  for (let d = 0; d < days; d++) {
    const w = dow(state.year, state.month, d);
    const cls = ['day', w === 0 ? 'sun' : '', w === 6 ? 'sat' : '', md.holidays.includes(d) ? 'holiday' : ''].join(' ');
    html += `<th class="${cls}" data-day="${d}" title="클릭하여 공휴일 지정/해제">${d + 1}<small>${md.holidays.includes(d) ? '휴' : WEEKDAY[w]}</small></th>`;
  }
  html += '<th class="stat">D</th><th class="stat">E</th><th class="stat">N</th><th class="stat">OFF</th><th class="stat" title="연차·휴가">V</th><th class="stat" title="주말·공휴일 휴무">주휴</th></tr></thead><tbody>';

  state.nurses.forEach((n, i) => {
    const req = md.requests[n.id] || {};
    html += `<tr><td class="name">${esc(n.name)}<span class="lvl ${n.level}">${LEVEL_LABEL[n.level]}</span></td>`;
    for (let d = 0; d < days; d++) {
      const s = sched[i][d];
      const cls = ['cell', s || '', ctx.weekend[d] ? 'weekend' : '', req[d] ? 'req' : '', res.bad.has(`${i}:${d}`) ? 'bad' : ''].join(' ');
      html += `<td class="${cls}" data-n="${i}" data-d="${d}">${s === 'OFF' ? 'O' : s || ''}</td>`;
    }
    const st = res.stats[i];
    html += `<td class="stat">${st.D}</td><td class="stat">${st.E}</td><td class="stat">${st.N}</td><td class="stat">${st.OFF}</td><td class="stat">${st.V}</td><td class="stat">${st.wkOff}</td></tr>`;
  });
  html += '</tbody><tfoot>';

  for (const s of WORK) {
    html += `<tr><td class="name">${s} 인원</td>`;
    for (let d = 0; d < days; d++) {
      const c = res.daily[d][s];
      const n = ctx.need[d][s];
      html += `<td class="${c < n ? 'short' : ''}" title="필요 ${n}명">${c}</td>`;
    }
    html += '<td colspan="6"></td></tr>';
  }
  html += '</tfoot>';
  $('#grid').innerHTML = html;

  const w = $('#warnings');
  const hasData = sched.some((r) => r.some(Boolean));
  if (!state.nurses.length) {
    w.innerHTML = '<p class="hint">왼쪽 ‘간호사 명단’에서 이름을 입력하고 ‘추가’를 눌러 간호사를 등록하세요.</p>';
  } else if (!hasData) {
    w.innerHTML = '<p class="hint">‘자동 생성’을 누르거나 칸을 클릭해 근무를 입력하세요.</p>';
  } else if (!res.issues.length) {
    w.innerHTML = '<p class="ok">✓ 모든 규칙을 충족합니다.</p>';
  } else {
    w.innerHTML = `<h3>확인할 항목 (${res.issues.length})</h3><ul>${res.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }

  const mode = document.querySelector('input[name="mode"]:checked').value;
  $('#modeHint').textContent = mode === 'shift'
    ? '칸을 클릭하면 D → E → N → OFF → 빈칸 순으로 바뀝니다. 날짜 머리글을 클릭하면 공휴일로 지정됩니다.'
    : '휴무·근무 신청: 클릭하면 OFF → V(연차) → D → E → N → 해제 순으로 바뀝니다. 신청한 칸은 자동 생성 때 그대로 유지됩니다.';
}

/* ───────────── 이벤트 ───────────── */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function cycle(list, cur) {
  return list[(list.indexOf(cur ?? null) + 1) % list.length];
}

$('#grid').addEventListener('click', (e) => {
  const th = e.target.closest('th.day');
  if (th) {
    const d = Number(th.dataset.day);
    const md = monthData();
    md.holidays = md.holidays.includes(d) ? md.holidays.filter((x) => x !== d) : [...md.holidays, d];
    save();
    renderGrid();
    return;
  }
  const td = e.target.closest('td.cell');
  if (!td) return;
  const i = Number(td.dataset.n);
  const d = Number(td.dataset.d);
  const nurse = state.nurses[i];
  const md = monthData();
  const days = daysIn(state.year, state.month);
  const row = (md.schedule[nurse.id] ||= Array(days).fill(null));
  const req = (md.requests[nurse.id] ||= {});
  const mode = document.querySelector('input[name="mode"]:checked').value;

  if (mode === 'request') {
    const next = cycle(REQ_CYCLE, req[d]);
    if (next) { req[d] = next; row[d] = next; } else { delete req[d]; row[d] = null; }
  } else {
    if (req[d]) { toast('신청된 칸입니다. ‘근무 신청’ 모드에서 바꾸세요.'); return; }
    row[d] = cycle(CYCLE, row[d]);
  }
  save();
  renderGrid();
  renderLeaves();
});

document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', renderGrid));

$('#addNurseForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#nurseName').value.trim();
  if (!name) return;
  state.nurses.push({ id: uid(), name, level: $('#nurseLevel').value });
  $('#nurseName').value = '';
  save();
  render();
  $('#nurseName').focus();
});

$('#nurseList').addEventListener('change', (e) => {
  const li = e.target.closest('li');
  const n = state.nurses.find((x) => x.id === li.dataset.id);
  const field = e.target.dataset.field;
  if (field === 'name') n.name = e.target.value.trim() || n.name;
  if (field === 'level') n.level = e.target.value;
  save();
  render();
});

$('#nurseList').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const li = btn.closest('li');
  const idx = state.nurses.findIndex((x) => x.id === li.dataset.id);
  if (btn.dataset.act === 'del') {
    if (!confirm(`${state.nurses[idx].name} 간호사를 삭제할까요?`)) return;
    state.nurses.splice(idx, 1);
  }
  if (btn.dataset.act === 'up' && idx > 0) {
    [state.nurses[idx - 1], state.nurses[idx]] = [state.nurses[idx], state.nurses[idx - 1]];
  }
  save();
  render();
});

document.querySelectorAll('[data-rule]').forEach((el) => {
  el.addEventListener('change', () => {
    const path = el.dataset.rule.split('.');
    let obj = state.rules;
    for (const k of path.slice(0, -1)) obj = obj[k];
    const key = path[path.length - 1];
    obj[key] = el.type === 'checkbox' ? el.checked : Math.max(0, parseInt(el.value, 10) || 0);
    save();
    renderGrid();
  });
});

function parseDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

$('#leaveStart').addEventListener('change', () => {
  if ($('#leaveEnd').value < $('#leaveStart').value) $('#leaveEnd').value = $('#leaveStart').value;
});

$('#leaveForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const nurse = state.nurses.find((n) => n.id === $('#leaveNurse').value);
  if (!nurse) { toast('간호사를 먼저 추가하세요.'); return; }
  const type = $('#leaveType').value;
  const start = parseDate($('#leaveStart').value);
  const end = parseDate($('#leaveEnd').value) || start;
  if (!start) { toast('시작일을 입력하세요.'); return; }
  if (end < start) { toast('종료일이 시작일보다 빠릅니다.'); return; }
  const total = Math.round((end - start) / 86400000) + 1;
  if (total > 62) { toast('한 번에 최대 62일까지 신청할 수 있어요.'); return; }

  let touchesGenerated = false;
  for (const t = new Date(start); t <= end; t.setDate(t.getDate() + 1)) {
    const md = monthData(t.getFullYear(), t.getMonth() + 1);
    const d = t.getDate() - 1;
    (md.requests[nurse.id] ||= {})[d] = type;
    const row = md.schedule[nurse.id];
    if (row) { row[d] = type; touchesGenerated = true; }
  }
  save();
  render();
  toast(`${nurse.name} ${REQ_LABEL[type]} ${total}일 추가${touchesGenerated ? ' · 자동 생성을 다시 누르면 반영돼요' : ''}`);
});

$('#leaveList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="del-leave"]');
  if (!btn) return;
  const li = btn.closest('li');
  const md = monthData();
  const id = li.dataset.id;
  const req = md.requests[id] || {};
  for (let d = Number(li.dataset.start); d <= Number(li.dataset.end); d++) {
    delete req[d];
    if (md.schedule[id]) md.schedule[id][d] = null;
  }
  save();
  render();
});

$('#prevMonth').addEventListener('click', () => {
  [state.year, state.month] = prevYM(state.year, state.month);
  save();
  render();
});
$('#nextMonth').addEventListener('click', () => {
  [state.year, state.month] = nextYM(state.year, state.month);
  save();
  render();
});

$('#generateBtn').addEventListener('click', () => {
  const btn = $('#generateBtn');
  btn.disabled = true;
  btn.textContent = '생성 중…';
  setTimeout(() => {
    try { generate(); } finally {
      btn.disabled = false;
      btn.textContent = '자동 생성';
    }
  }, 20);
});

$('#clearBtn').addEventListener('click', () => {
  if (!confirm('이번 달 근무를 지울까요? (신청한 근무는 유지됩니다)')) return;
  monthData().schedule = {};
  save();
  render();
});

$('#printBtn').addEventListener('click', () => window.print());

$('#csvBtn').addEventListener('click', () => {
  const ctx = buildContext();
  const sched = currentSchedule(ctx);
  const res = analyze(ctx, sched);
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const header = ['이름', '등급'];
  for (let d = 0; d < ctx.days; d++) header.push(`${d + 1}(${WEEKDAY[dow(state.year, state.month, d)]})`);
  header.push('D', 'E', 'N', 'OFF', 'V');
  const lines = [header.map(q).join(',')];
  state.nurses.forEach((n, i) => {
    const st = res.stats[i];
    lines.push([n.name, LEVEL_LABEL[n.level], ...sched[i].map((s) => s || ''), st.D, st.E, st.N, st.OFF, st.V].map(q).join(','));
  });
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `근무표_${monthKey(state.year, state.month)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

render();
