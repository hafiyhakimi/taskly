import { useState, useEffect, useRef } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUSES = [
  { key: "todo",       label: "To Do",      emoji: "○", color: "#7dd3fc", bg: "rgba(125,211,252,0.08)", border: "rgba(125,211,252,0.2)" },
  { key: "inprogress", label: "In Progress", emoji: "◑", color: "#fbbf24", bg: "rgba(251,191,36,0.08)",  border: "rgba(251,191,36,0.25)" },
  { key: "blocked",    label: "Blocked",     emoji: "✕", color: "#f87171", bg: "rgba(248,113,113,0.08)", border: "rgba(248,113,113,0.2)" },
  { key: "done",       label: "Done",        emoji: "●", color: "#86efac", bg: "rgba(134,239,172,0.08)", border: "rgba(134,239,172,0.2)" },
];
const STATUS_MAP = Object.fromEntries(STATUSES.map(s => [s.key, s]));

const PRIORITY = [
  { key: "high",   label: "High", color: "#ef4444", order: 0 },
  { key: "medium", label: "Med",  color: "#f59e0b", order: 1 },
  { key: "low",    label: "Low",  color: "#64748b", order: 2 },
];
const PRIORITY_MAP = Object.fromEntries(PRIORITY.map(p => [p.key, p]));

const GREETINGS = ["Let's get things done ✦", "Make today count ✦", "You've got this ✦", "Focus mode: on ✦"];

// ─── Date helpers ─────────────────────────────────────────────────────────────

// Use LOCAL date parts to avoid UTC-shift bugs (e.g. UTC+8 rolling back a day)
const toKey = (d) => {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};
const todayKey = () => toKey(new Date());

const addDays = (key, n) => {
  const d = new Date(key + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toKey(d);
};

const formatDisplay = (key) => {
  const d    = new Date(key + "T00:00:00");
  const tk   = todayKey();
  const yk   = addDays(tk, -1);
  const tmk  = addDays(tk, 1);
  if (key === tk)  return { label: "Today",     sub: d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" }) };
  if (key === yk)  return { label: "Yesterday", sub: d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" }) };
  if (key === tmk) return { label: "Tomorrow",  sub: d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" }) };
  return {
    label: d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" }),
    sub:   d.toLocaleDateString("en-US", { year:"numeric" }),
  };
};

// ─── Storage ──────────────────────────────────────────────────────────────────

const NS = "taskly:";

const loadDay  = (key) => { try { return JSON.parse(localStorage.getItem(NS + key)) || []; } catch { return []; } };
const saveDay  = (key, tasks) => { try { localStorage.setItem(NS + key, JSON.stringify(tasks)); } catch {} };
const allKeys  = () => Object.keys(localStorage).filter(k => k.startsWith(NS)).map(k => k.slice(NS.length)).sort().reverse();

// ─── ID gen ───────────────────────────────────────────────────────────────────

let _id = Date.now();
const uid = () => `t${++_id}`;

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [dateKey, setDateKey]         = useState(todayKey);
  const [tasks, setTasksRaw]          = useState(() => loadDay(todayKey()));
  const [input, setInput]             = useState("");
  const [priority, setPriority]       = useState("medium");
  const [filter, setFilter]           = useState("all");
  const [sortByPriority, setSort]     = useState(false);
  const [editId, setEditId]           = useState(null);
  const [editText, setEditText]       = useState("");
  const [search, setSearch]           = useState("");
  const [confirmId, setConfirmId]     = useState(null);
  const [showEndDay, setShowEndDay]   = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef();

  // Persist on every tasks change
  const setTasks = (fn) => {
    setTasksRaw(prev => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      saveDay(dateKey, next);
      return next;
    });
  };

  // Reload when date changes
  useEffect(() => {
    setTasksRaw(loadDay(dateKey));
    setFilter("all");
    setSearch("");
    setEditId(null);
    setConfirmId(null);
    setShowEndDay(false);
  }, [dateKey]);

  const isToday    = dateKey === todayKey();
  const isFuture   = dateKey > todayKey();
  const isPast     = dateKey < todayKey();
  const isReadOnly = isPast;

  // ── CRUD ──
  const add = () => {
    const text = input.trim();
    if (!text || isReadOnly) { inputRef.current?.focus(); return; }
    setTasks(p => [{ id: uid(), text, status: "todo", priority, createdAt: Date.now() }, ...p]);
    setInput("");
    setPriority("medium");
  };

  const setStatus  = (id, status) => setTasks(p => p.map(t => t.id === id ? { ...t, status } : t));
  const setPrio    = (id, prio)   => setTasks(p => p.map(t => t.id === id ? { ...t, priority: prio } : t));
  const del        = (id)         => { setTasks(p => p.filter(t => t.id !== id)); setConfirmId(null); };
  const commitEdit = (id)         => {
    const text = editText.trim();
    if (text) setTasks(p => p.map(t => t.id === id ? { ...t, text } : t));
    setEditId(null);
  };

  // ── END DAY ──
  const endDay = () => {
    const unfinished = tasks.filter(t => t.status !== "done");
    if (!unfinished.length) { setShowEndDay(false); return; }
    const tomorrow  = addDays(dateKey, 1);
    const existing  = loadDay(tomorrow);
    // Avoid duplicates (by id)
    const existIds  = new Set(existing.map(t => t.id));
    const toRoll    = unfinished
      .filter(t => !existIds.has(t.id))
      .map(t => ({ ...t, status: t.status === "blocked" ? "blocked" : "todo", rolledFrom: dateKey }));
    saveDay(tomorrow, [...toRoll, ...existing]);
    setShowEndDay(false);
    setDateKey(tomorrow);
  };

  // ── DERIVED ──
  const counts   = Object.fromEntries(STATUSES.map(s => [s.key, tasks.filter(t => t.status === s.key).length]));
  const progress = tasks.length ? Math.round((counts.done / tasks.length) * 100) : 0;
  const unfinishedCount = tasks.filter(t => t.status !== "done").length;

  let visible = tasks
    .filter(t => filter === "all" || t.status === filter)
    .filter(t => !search || t.text.toLowerCase().includes(search.toLowerCase()));

  if (sortByPriority) {
    visible = [...visible].sort((a, b) =>
      (PRIORITY_MAP[a.priority]?.order ?? 1) - (PRIORITY_MAP[b.priority]?.order ?? 1)
    );
  }

  const { label: dayLabel, sub: daySub } = formatDisplay(dateKey);
  const greeting = GREETINGS[new Date(dateKey + "T00:00:00").getDay() % GREETINGS.length];
  const historyKeys = allKeys().filter(k => k !== dateKey);

  return (
    <div style={{ width:"100vw", height:"100vh", display:"flex", flexDirection:"column", background:"#080c14", overflow:"hidden", fontFamily:"'Plus Jakarta Sans', sans-serif", color:"#e2e8f0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&family=Fraunces:opsz,wght@9..144,700&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:#1e293b; border-radius:4px; }

        .layout { display:flex; flex:1; overflow:hidden; height:100%; }

        /* ── SIDEBAR ── */
        .sidebar {
          width:248px; min-width:248px; background:#0c1220;
          border-right:1px solid #131c2e; display:flex; flex-direction:column;
          padding:28px 20px 20px; overflow-y:auto;
          animation:fadeSlide 0.4s ease both;
        }
        @keyframes fadeSlide { from { opacity:0; transform:translateX(-12px); } to { opacity:1; transform:translateX(0); } }

        .brand { margin-bottom:24px; }
        .brand-name { font-family:'Fraunces',Georgia,serif; font-size:22px; font-weight:700; color:#f8fafc; letter-spacing:-0.5px; line-height:1; }
        .brand-sub  { font-size:11px; color:#334155; letter-spacing:0.06em; text-transform:uppercase; margin-top:5px; }

        .progress-section { margin-bottom:24px; }
        .progress-label { display:flex; justify-content:space-between; font-size:11px; color:#475569; text-transform:uppercase; letter-spacing:0.07em; margin-bottom:8px; }
        .progress-track { height:5px; background:#1e293b; border-radius:10px; overflow:hidden; }
        .progress-fill  { height:100%; background:linear-gradient(90deg,#7dd3fc,#86efac); border-radius:10px; transition:width 0.5s cubic-bezier(.4,0,.2,1); }

        .section-label { font-size:10px; color:#2d4a6b; text-transform:uppercase; letter-spacing:0.1em; margin-bottom:6px; padding-left:4px; margin-top:4px; }

        .filter-list { display:flex; flex-direction:column; gap:2px; margin-bottom:16px; }
        .filter-item {
          display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:7px;
          font-size:13px; color:#64748b; cursor:pointer; border:none; background:none;
          text-align:left; transition:all 0.15s; width:100%; font-family:inherit;
        }
        .filter-item:hover  { color:#e2e8f0; background:#131c2e; }
        .filter-item.active { color:#e2e8f0; background:#131c2e; }
        .filter-dot   { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
        .filter-count { margin-left:auto; font-size:11px; background:#1a2535; padding:1px 7px; border-radius:20px; color:#475569; }

        .sort-toggle {
          display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:7px;
          font-size:13px; color:#64748b; cursor:pointer; border:1px solid transparent; background:none;
          text-align:left; transition:all 0.15s; width:100%; font-family:inherit; margin-bottom:16px;
        }
        .sort-toggle:hover  { color:#e2e8f0; background:#131c2e; }
        .sort-toggle.active { color:#fbbf24; background:#131c2e; border-color:#2a2010; }

        /* ── END DAY BUTTON ── */
        .end-day-btn {
          display:flex; align-items:center; gap:8px; padding:10px 14px; border-radius:8px;
          font-size:13px; font-weight:600; cursor:pointer; border:1px solid rgba(251,191,36,0.25);
          background:rgba(251,191,36,0.06); color:#fbbf24; font-family:inherit;
          transition:all 0.15s; width:100%; margin-bottom:8px;
        }
        .end-day-btn:hover { background:rgba(251,191,36,0.12); border-color:rgba(251,191,36,0.4); }
        .end-day-btn:disabled { opacity:0.3; cursor:not-allowed; }

        /* ── HISTORY ── */
        .history-toggle {
          display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:7px;
          font-size:12px; color:#334155; cursor:pointer; border:none; background:none;
          text-align:left; transition:all 0.15s; width:100%; font-family:inherit;
        }
        .history-toggle:hover { color:#64748b; background:#131c2e; }

        .history-list { display:flex; flex-direction:column; gap:2px; margin-top:4px; max-height:180px; overflow-y:auto; }
        .history-item {
          display:flex; align-items:center; justify-content:space-between; padding:6px 10px; border-radius:6px;
          font-size:12px; color:#475569; cursor:pointer; border:none; background:none;
          text-align:left; transition:all 0.15s; width:100%; font-family:inherit;
        }
        .history-item:hover  { color:#e2e8f0; background:#131c2e; }
        .history-item.active { color:#7dd3fc; background:#131c2e; }
        .history-dot { font-size:9px; color:#334155; }

        .sidebar-footer { margin-top:auto; padding-top:16px; border-top:1px solid #131c2e; font-size:11px; color:#1e3a5f; text-align:center; letter-spacing:0.04em; }

        /* ── MAIN ── */
        .main { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }

        .topbar { padding:24px 36px 18px; border-bottom:1px solid #131c2e; flex-shrink:0; animation:fadeDown 0.4s ease both; }
        @keyframes fadeDown { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
        .topbar-row { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; flex-wrap:wrap; }
        .page-title { font-family:'Fraunces',Georgia,serif; font-size:28px; font-weight:700; color:#f8fafc; letter-spacing:-0.8px; line-height:1; }
        .page-sub   { font-size:12px; color:#334155; margin-top:4px; }

        /* ── DATE NAV ── */
        .date-nav { display:flex; align-items:center; gap:8px; }
        .date-picker {
          background:#0c1220; border:1px solid #1e293b; border-radius:8px;
          padding:8px 12px; color:#e2e8f0; font-family:inherit; font-size:13px;
          outline:none; cursor:pointer; transition:border-color 0.15s;
          color-scheme: dark;
        }
        .date-picker:focus { border-color:#7dd3fc; }
        .nav-btn {
          background:#0c1220; border:1px solid #1e293b; border-radius:6px;
          padding:7px 11px; color:#64748b; font-family:inherit; font-size:12px;
          cursor:pointer; transition:all 0.15s; line-height:1;
        }
        .nav-btn:hover { color:#e2e8f0; border-color:#334155; }
        .nav-btn.today-btn { color:#7dd3fc; border-color:rgba(125,211,252,0.25); background:rgba(125,211,252,0.06); }
        .nav-btn.today-btn:hover { background:rgba(125,211,252,0.12); }

        .search-wrap { position:relative; }
        .search-input {
          background:#0c1220; border:1px solid #1e293b; border-radius:8px;
          padding:9px 14px 9px 34px; color:#e2e8f0; font-family:inherit; font-size:13px;
          outline:none; width:200px; transition:border-color 0.15s;
        }
        .search-input:focus { border-color:#7dd3fc; }
        .search-input::placeholder { color:#2d3f57; }
        .search-icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color:#334155; font-size:14px; pointer-events:none; }

        /* ── ADD FORM ── */
        .input-row { display:flex; gap:10px; padding:12px 36px; border-bottom:1px solid #131c2e; flex-shrink:0; align-items:center; }
        .task-input {
          flex:1; background:#0c1220; border:1px solid #1e293b; border-radius:8px;
          padding:10px 16px; color:#e2e8f0; font-family:inherit; font-size:14px;
          outline:none; transition:border-color 0.15s; min-width:0;
        }
        .task-input:focus   { border-color:#7dd3fc; }
        .task-input::placeholder { color:#2d3f57; }
        .task-input:disabled { opacity:0.4; cursor:not-allowed; }

        .prio-select {
          appearance:none; -webkit-appearance:none;
          background:#0c1220; border:1px solid #1e293b; border-radius:8px;
          padding:10px 14px; color:#e2e8f0; font-family:inherit; font-size:13px;
          outline:none; cursor:pointer; transition:all 0.15s; flex-shrink:0;
        }
        .prio-select:focus   { border-color:#7dd3fc; }
        .prio-select:disabled { opacity:0.4; cursor:not-allowed; }

        .add-btn {
          background:linear-gradient(135deg,#7dd3fc,#60a5fa); border:none; border-radius:8px;
          padding:10px 20px; color:#0c1220; font-family:inherit; font-size:13px; font-weight:600;
          cursor:pointer; transition:all 0.15s; white-space:nowrap;
        }
        .add-btn:hover    { transform:translateY(-1px); box-shadow:0 4px 16px rgba(125,211,252,0.25); }
        .add-btn:active   { transform:translateY(0); }
        .add-btn:disabled { opacity:0.35; cursor:not-allowed; transform:none; box-shadow:none; }

        .readonly-banner {
          display:flex; align-items:center; gap:8px; padding:8px 36px;
          background:rgba(248,113,113,0.06); border-bottom:1px solid rgba(248,113,113,0.12);
          font-size:12px; color:#f87171; flex-shrink:0;
        }

        /* ── TASK LIST ── */
        .task-area { flex:1; overflow-y:auto; padding:16px 36px 28px; }

        .group-label {
          font-size:10px; text-transform:uppercase; letter-spacing:0.1em;
          padding-bottom:8px; margin-top:10px; display:flex; align-items:center; gap:8px;
        }
        .group-label:first-child { margin-top:0; }
        .group-line { flex:1; height:1px; background:#131c2e; }

        .task-card {
          display:flex; align-items:center; gap:12px;
          padding:11px 16px; border-radius:10px; border:1px solid #131c2e;
          background:#0c1220; margin-bottom:6px;
          transition:all 0.18s; animation:taskIn 0.2s ease both; position:relative;
        }
        @keyframes taskIn { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }
        .task-card:hover         { border-color:#1e293b; background:#0f1825; transform:translateX(2px); }
        .task-card.is-done       { opacity:0.42; }
        .task-card.confirming    { border-color:rgba(248,113,113,0.35) !important; background:#110a0a !important; transform:none !important; }
        .task-card.rolled        { border-left:2px solid rgba(251,191,36,0.4); }

        .rolled-tag { font-size:9px; color:#92400e; background:rgba(251,191,36,0.08); border-radius:4px; padding:1px 5px; white-space:nowrap; flex-shrink:0; }

        .status-pill {
          appearance:none; -webkit-appearance:none;
          border-radius:20px; padding:3px 10px; font-family:inherit;
          font-size:10px; font-weight:600; letter-spacing:0.07em; text-transform:uppercase;
          cursor:pointer; outline:none; border:1px solid transparent; white-space:nowrap;
          flex-shrink:0; min-width:94px; text-align:center; transition:all 0.15s;
        }
        .status-pill:disabled { cursor:default; }

        .p-badge-select {
          appearance:none; -webkit-appearance:none;
          font-size:9px; font-weight:600; letter-spacing:0.07em; text-transform:uppercase;
          padding:3px 8px; border-radius:20px; background:#131c2e; border:1px solid #1e293b;
          flex-shrink:0; cursor:pointer; font-family:inherit; outline:none; transition:all 0.15s;
        }
        .p-badge-select:disabled { cursor:default; }

        .task-text { flex:1; font-size:13px; color:#cbd5e1; line-height:1.45; min-width:0; }
        .task-text.done { text-decoration:line-through; color:#334155; }

        .edit-in {
          flex:1; background:#080c14; border:1px solid #7dd3fc; border-radius:6px;
          padding:4px 10px; color:#e2e8f0; font-family:inherit; font-size:13px; outline:none; min-width:0;
        }

        .icon-btn {
          background:none; border:none; cursor:pointer; color:#1e293b; font-size:13px;
          padding:4px; border-radius:5px; transition:all 0.12s; line-height:1; flex-shrink:0; font-family:inherit;
        }
        .icon-btn:hover     { color:#94a3b8; background:#131c2e; }
        .icon-btn.del:hover { color:#f87171; background:rgba(248,113,113,0.08); }
        .icon-btn:disabled  { opacity:0.2; cursor:not-allowed; }

        .confirm-row { display:flex; align-items:center; gap:8px; margin-left:auto; flex-shrink:0; animation:fadeIn 0.15s ease; }
        @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
        .confirm-label { font-size:11px; color:#f87171; white-space:nowrap; }
        .confirm-yes { background:rgba(248,113,113,0.15); border:1px solid rgba(248,113,113,0.35); border-radius:5px; padding:3px 10px; color:#f87171; font-family:inherit; font-size:11px; font-weight:600; cursor:pointer; transition:all 0.12s; }
        .confirm-yes:hover { background:rgba(248,113,113,0.28); }
        .confirm-no  { background:#131c2e; border:1px solid #1e293b; border-radius:5px; padding:3px 10px; color:#64748b; font-family:inherit; font-size:11px; cursor:pointer; transition:all 0.12s; }
        .confirm-no:hover { color:#e2e8f0; }

        /* ── END DAY MODAL ── */
        .modal-backdrop {
          position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex;
          align-items:center; justify-content:center; z-index:100; animation:fadeIn 0.2s ease;
        }
        .modal {
          background:#0c1220; border:1px solid #1e293b; border-radius:14px;
          padding:32px 36px; max-width:420px; width:90%; animation:modalIn 0.2s ease;
        }
        @keyframes modalIn { from { opacity:0; transform:translateY(12px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
        .modal-title { font-family:'Fraunces',Georgia,serif; font-size:22px; font-weight:700; color:#f8fafc; margin-bottom:8px; }
        .modal-sub   { font-size:13px; color:#475569; margin-bottom:24px; line-height:1.6; }
        .modal-stat  { display:flex; gap:16px; margin-bottom:24px; }
        .modal-stat-item { flex:1; background:#131c2e; border-radius:8px; padding:12px; text-align:center; }
        .modal-stat-num  { font-family:'Fraunces',Georgia,serif; font-size:26px; font-weight:700; line-height:1; }
        .modal-stat-lbl  { font-size:10px; color:#475569; text-transform:uppercase; letter-spacing:0.07em; margin-top:4px; }
        .modal-actions { display:flex; gap:10px; }
        .modal-confirm {
          flex:1; background:linear-gradient(135deg,#fbbf24,#f59e0b); border:none; border-radius:8px;
          padding:12px; color:#0c1220; font-family:inherit; font-size:14px; font-weight:600;
          cursor:pointer; transition:all 0.15s;
        }
        .modal-confirm:hover { transform:translateY(-1px); box-shadow:0 4px 14px rgba(251,191,36,0.3); }
        .modal-cancel {
          background:#131c2e; border:1px solid #1e293b; border-radius:8px;
          padding:12px 20px; color:#64748b; font-family:inherit; font-size:14px;
          cursor:pointer; transition:all 0.15s;
        }
        .modal-cancel:hover { color:#e2e8f0; }

        .empty-state { text-align:center; padding:56px 20px; color:#1e293b; font-size:13px; letter-spacing:0.04em; }
        .empty-icon  { font-size:30px; display:block; margin-bottom:12px; opacity:0.35; }
      `}</style>

      {/* ── END DAY MODAL ── */}
      {showEndDay && (
        <div className="modal-backdrop" onClick={() => setShowEndDay(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">End Your Day</div>
            <div className="modal-sub">
              {unfinishedCount > 0
                ? `You have ${unfinishedCount} unfinished task${unfinishedCount > 1 ? "s" : ""}. They'll be rolled over to tomorrow with their current status (Blocked tasks stay blocked, others reset to To Do).`
                : "All tasks are done — amazing work today! 🎉"}
            </div>
            <div className="modal-stat">
              <div className="modal-stat-item">
                <div className="modal-stat-num" style={{ color:"#86efac" }}>{counts.done}</div>
                <div className="modal-stat-lbl">Done</div>
              </div>
              <div className="modal-stat-item">
                <div className="modal-stat-num" style={{ color:"#fbbf24" }}>{unfinishedCount}</div>
                <div className="modal-stat-lbl">Rolling Over</div>
              </div>
              <div className="modal-stat-item">
                <div className="modal-stat-num" style={{ color:"#7dd3fc" }}>{tasks.length}</div>
                <div className="modal-stat-lbl">Total</div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="modal-confirm" onClick={endDay}>
                {unfinishedCount > 0 ? "Roll Over & Go to Tomorrow →" : "Go to Tomorrow →"}
              </button>
              <button className="modal-cancel" onClick={() => setShowEndDay(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="layout">
        {/* ── SIDEBAR ── */}
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-name">Taskly</div>
            <div className="brand-sub">Daily Planner</div>
          </div>

          <div className="progress-section">
            <div className="progress-label">
              <span>Progress</span>
              <span style={{ color:"#7dd3fc" }}>{progress}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width:`${progress}%` }} />
            </div>
          </div>

          <div className="section-label">Filter by Status</div>
          <div className="filter-list">
            <button className={`filter-item ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
              <span className="filter-dot" style={{ background:"#475569" }} />
              All tasks
              <span className="filter-count">{tasks.length}</span>
            </button>
            {STATUSES.map(s => (
              <button key={s.key} className={`filter-item ${filter === s.key ? "active" : ""}`} onClick={() => setFilter(s.key)}>
                <span className="filter-dot" style={{ background:s.color }} />
                {s.label}
                <span className="filter-count">{counts[s.key]}</span>
              </button>
            ))}
          </div>

          <div className="section-label">Sort</div>
          <button className={`sort-toggle ${sortByPriority ? "active" : ""}`} onClick={() => setSort(v => !v)}>
            <span>⇅</span> Sort by Priority
            {sortByPriority && <span style={{ marginLeft:"auto", fontSize:10, color:"#fbbf24" }}>✓</span>}
          </button>

          {/* End Day */}
          {isToday && (
            <>
              <div className="section-label">Day Actions</div>
              <button className="end-day-btn" onClick={() => setShowEndDay(true)}>
                ✦ End My Day
              </button>
            </>
          )}

          {/* History */}
          {historyKeys.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop:8 }}>History</div>
              <button className="history-toggle" onClick={() => setShowHistory(v => !v)}>
                {showHistory ? "▾" : "▸"} Past Days ({historyKeys.length})
              </button>
              {showHistory && (
                <div className="history-list">
                  {!isToday && (
                    <button className={`history-item ${dateKey === todayKey() ? "active" : ""}`} onClick={() => setDateKey(todayKey())}>
                      Today <span className="history-dot">●</span>
                    </button>
                  )}
                  {historyKeys.map(k => (
                    <button key={k} className={`history-item ${dateKey === k ? "active" : ""}`} onClick={() => setDateKey(k)}>
                      {new Date(k + "T00:00:00").toLocaleDateString("en-US", { month:"short", day:"numeric" })}
                      <span className="history-dot">{loadDay(k).filter(t => t.status === "done").length}/{loadDay(k).length}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="sidebar-footer">
            {tasks.length === 0 ? "Add your first task →" : `${counts.done} of ${tasks.length} complete`}
          </div>
        </aside>

        {/* ── MAIN ── */}
        <main className="main">
          <div className="topbar">
            <div className="topbar-row">
              <div>
                <div className="page-title">{dayLabel}</div>
                <div className="page-sub">{isToday ? greeting : daySub}</div>
              </div>
              <div style={{ display:"flex", gap:"10px", alignItems:"center", flexWrap:"wrap" }}>
                <div className="date-nav">
                  <input
                    type="date"
                    className="date-picker"
                    value={dateKey}
                    onChange={e => e.target.value && setDateKey(e.target.value)}
                  />
                  {!isToday && (
                    <button className="nav-btn today-btn" onClick={() => setDateKey(todayKey())}>
                      Back to Today
                    </button>
                  )}
                </div>
                <div className="search-wrap">
                  <span className="search-icon">⌕</span>
                  <input
                    className="search-input"
                    placeholder={`Search ${isToday ? "today" : dayLabel.toLowerCase()}...`}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Read-only banner for past days */}
          {isReadOnly && (
            <div className="readonly-banner">
              ⚠ Past day — view only. Navigate to today to add tasks.
            </div>
          )}

          {/* Add form */}
          <div className="input-row">
            <input
              ref={inputRef}
              className="task-input"
              placeholder={isReadOnly ? "Past day — read only" : "What needs to be done today?"}
              value={input}
              disabled={isReadOnly}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && add()}
            />
            <select
              className="prio-select"
              value={priority}
              disabled={isReadOnly}
              onChange={e => setPriority(e.target.value)}
              style={{ color: PRIORITY_MAP[priority].color }}
            >
              {PRIORITY.map(p => (
                <option key={p.key} value={p.key} style={{ color:p.color }}>{p.label} Priority</option>
              ))}
            </select>
            <button className="add-btn" disabled={isReadOnly} onClick={add}>+ Add Task</button>
          </div>

          {/* Task list */}
          <div className="task-area">
            {visible.length === 0 && (
              <div className="empty-state">
                <span className="empty-icon">✦</span>
                {search ? "No tasks match your search."
                  : filter === "all"
                    ? isReadOnly ? "No tasks recorded for this day." : "No tasks yet — add one above!"
                    : `No ${STATUS_MAP[filter]?.label} tasks.`}
              </div>
            )}

            {filter === "all" && !search && !sortByPriority
              ? STATUSES.map(s => {
                  const group = visible.filter(t => t.status === s.key);
                  if (!group.length) return null;
                  return (
                    <div key={s.key}>
                      <div className="group-label" style={{ color:s.color }}>
                        {s.emoji} {s.label} · {group.length}
                        <span className="group-line" />
                      </div>
                      {group.map((task, i) => (
                        <TaskCard key={task.id} task={task} i={i} readOnly={isReadOnly}
                          setStatus={setStatus} setPrio={setPrio}
                          confirmId={confirmId} setConfirmId={setConfirmId} del={del}
                          editId={editId} setEditId={setEditId}
                          editText={editText} setEditText={setEditText} commitEdit={commitEdit} />
                      ))}
                    </div>
                  );
                })
              : visible.map((task, i) => (
                  <TaskCard key={task.id} task={task} i={i} readOnly={isReadOnly}
                    setStatus={setStatus} setPrio={setPrio}
                    confirmId={confirmId} setConfirmId={setConfirmId} del={del}
                    editId={editId} setEditId={setEditId}
                    editText={editText} setEditText={setEditText} commitEdit={commitEdit} />
                ))
            }
          </div>
        </main>
      </div>
    </div>
  );
}

function TaskCard({ task, i, readOnly, setStatus, setPrio, confirmId, setConfirmId, del, editId, setEditId, editText, setEditText, commitEdit }) {
  const s          = STATUS_MAP[task.status];
  const p          = PRIORITY_MAP[task.priority || "medium"];
  const isEditing  = editId === task.id;
  const isConfirm  = confirmId === task.id;

  return (
    <div
      className={`task-card ${task.status === "done" ? "is-done" : ""} ${isConfirm ? "confirming" : ""} ${task.rolledFrom ? "rolled" : ""}`}
      style={{ animationDelay:`${i * 0.03}s` }}
    >
      <select
        className="status-pill"
        value={task.status}
        disabled={readOnly}
        style={{ background:s.bg, color:s.color, borderColor:s.border }}
        onChange={e => setStatus(task.id, e.target.value)}
      >
        {STATUSES.map(st => <option key={st.key} value={st.key}>{st.label}</option>)}
      </select>

      <select
        className="p-badge-select"
        value={task.priority || "medium"}
        disabled={readOnly}
        style={{ color:p.color }}
        onChange={e => setPrio(task.id, e.target.value)}
      >
        {PRIORITY.map(pr => <option key={pr.key} value={pr.key} style={{ color:pr.color }}>{pr.label}</option>)}
      </select>

      {task.rolledFrom && <span className="rolled-tag">rolled</span>}

      {isEditing ? (
        <input
          className="edit-in" autoFocus value={editText}
          onChange={e => setEditText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") commitEdit(task.id); if (e.key === "Escape") setEditId(null); }}
          onBlur={() => commitEdit(task.id)}
        />
      ) : (
        <span
          className={`task-text ${task.status === "done" ? "done" : ""}`}
          onDoubleClick={() => { if (!readOnly) { setEditId(task.id); setEditText(task.text); } }}
        >
          {task.text}
        </span>
      )}

      {isConfirm ? (
        <div className="confirm-row">
          <span className="confirm-label">Delete?</span>
          <button className="confirm-yes" onClick={() => del(task.id)}>Yes</button>
          <button className="confirm-no"  onClick={() => setConfirmId(null)}>No</button>
        </div>
      ) : (
        <>
          <button className="icon-btn" disabled={readOnly} onClick={() => { setEditId(task.id); setEditText(task.text); }}>✎</button>
          <button className="icon-btn del" disabled={readOnly} onClick={() => setConfirmId(task.id)}>✕</button>
        </>
      )}
    </div>
  );
}
