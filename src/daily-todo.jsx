import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── Supabase ─────────────────────────────────────────────────────────────────

const SUPABASE_URL  = "https://ubqagpwrxcnwfegijnqz.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVicWFncHdyeGNud2ZlZ2lqbnF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2ODg0NjUsImV4cCI6MjA4ODI2NDQ2NX0.zC67TTH17hQmwzzFWmy61Kju4nvBtC2KCDKq5LwgRoo";
const sb = createClient(SUPABASE_URL, SUPABASE_ANON);

// ─── User ID (no login — persisted in localStorage per device) ────────────────

const USER_ID_KEY = "taskly:userId";
const OLD_NS      = "taskly:";

function getOrCreateUserId() {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = "usr_" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

// Read all legacy localStorage task keys for migration
function readLocalStorageTasks() {
  const result = [];
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith(OLD_NS)) continue;
    const suffix = k.slice(OLD_NS.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(suffix)) continue;
    try {
      const tasks = JSON.parse(localStorage.getItem(k)) || [];
      if (tasks.length) result.push({ dateKey: suffix, tasks });
    } catch {}
  }
  return result;
}

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
  const d   = new Date(key + "T00:00:00");
  const tk  = todayKey();
  const yk  = addDays(tk, -1);
  const tmk = addDays(tk, 1);
  if (key === tk)  return { label: "Today",     sub: d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" }) };
  if (key === yk)  return { label: "Yesterday", sub: d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" }) };
  if (key === tmk) return { label: "Tomorrow",  sub: d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" }) };
  return {
    label: d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" }),
    sub:   d.toLocaleDateString("en-US", { year:"numeric" }),
  };
};

// ─── Supabase helpers ─────────────────────────────────────────────────────────

// Row shape: { id, user_id, date_key, text, status, priority, rolled_from, created_at }

const dbToTask = (row) => ({
  id:         row.id,
  text:       row.text,
  status:     row.status,
  priority:   row.priority,
  rolledFrom: row.rolled_from || null,
  createdAt:  row.created_at,
});

const taskToDb = (task, dateKey, userId) => ({
  id:          task.id,
  user_id:     userId,
  date_key:    dateKey,
  text:        task.text,
  status:      task.status,
  priority:    task.priority || "medium",
  rolled_from: task.rolledFrom || null,
  created_at:  task.createdAt,
});

async function fetchDay(dateKey, userId) {
  const { data, error } = await sb
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("date_key", dateKey)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(dbToTask);
}

async function fetchAllDateKeys(userId) {
  const { data, error } = await sb
    .from("tasks")
    .select("date_key")
    .eq("user_id", userId);
  if (error) throw error;
  const unique = [...new Set((data || []).map(r => r.date_key))].sort().reverse();
  return unique;
}

async function upsertTask(task, dateKey, userId) {
  const { error } = await sb.from("tasks").upsert(taskToDb(task, dateKey, userId));
  if (error) throw error;
}

async function deleteTask(id, userId) {
  const { error } = await sb.from("tasks").delete().eq("id", id).eq("user_id", userId);
  if (error) throw error;
}

async function upsertMany(tasks, dateKey, userId) {
  if (!tasks.length) return;
  const { error } = await sb.from("tasks").upsert(tasks.map(t => taskToDb(t, dateKey, userId)));
  if (error) throw error;
}

// ─── ID gen ───────────────────────────────────────────────────────────────────

const uid = () => `t${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [userId, setUserId]           = useState(getOrCreateUserId);
  const [theme, setTheme]             = useState(() => localStorage.getItem('taskly:theme') || 'dark');

  useEffect(() => { localStorage.setItem('taskly:theme', theme); }, [theme]);
  const [dateKey, setDateKey]         = useState(todayKey);
  const [tasks, setTasks]             = useState([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
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
  const [historyKeys, setHistoryKeys] = useState([]);
  const [error, setError]             = useState(null);
  // Change user ID modal
  const [showChangeId, setShowChangeId] = useState(false);
  const [sidebarOpen, setSidebarOpen]   = useState(false);
  const [idInput, setIdInput]           = useState("");
  const [idError, setIdError]           = useState("");
  // Migration state
  const [migrating, setMigrating]       = useState(false);
  const [migrateResult, setMigrateResult] = useState(null);
  const inputRef = useRef();

  // Load tasks when date changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFilter("all");
    setSearch("");
    setEditId(null);
    setConfirmId(null);
    setShowEndDay(false);

    fetchDay(dateKey, userId)
      .then(t => { if (!cancelled) { setTasks(t); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });

    return () => { cancelled = true; };
  }, [dateKey, userId]);

  // Load history keys on mount and after end day
  const refreshHistory = useCallback(() => {
    fetchAllDateKeys(userId).then(setHistoryKeys).catch(() => {});
  }, [userId]);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const isToday    = dateKey === todayKey();
  const isPast     = dateKey < todayKey();
  const isReadOnly = isPast;

  // ── CRUD ──
  const add = async () => {
    const text = input.trim();
    if (!text || isReadOnly) { inputRef.current?.focus(); return; }
    const task = { id: uid(), text, status: "todo", priority, createdAt: Date.now() };
    setTasks(p => [task, ...p]);
    setInput("");
    setPriority("medium");
    setSaving(true);
    try {
      await upsertTask(task, dateKey, userId);
      refreshHistory();
    } catch (e) {
      setError(e.message);
      setTasks(p => p.filter(t => t.id !== task.id)); // rollback
    } finally { setSaving(false); }
  };

  const setStatus = async (id, status) => {
    setTasks(p => p.map(t => t.id === id ? { ...t, status } : t));
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    try { await upsertTask({ ...task, status }, dateKey, userId); }
    catch (e) {
      setError(e.message);
      setTasks(p => p.map(t => t.id === id ? { ...t, status: task.status } : t)); // rollback
    }
  };

  const setPrio = async (id, prio) => {
    setTasks(p => p.map(t => t.id === id ? { ...t, priority: prio } : t));
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    try { await upsertTask({ ...task, priority: prio }, dateKey, userId); }
    catch (e) { setError(e.message); setTasks(p => p.map(t => t.id === id ? { ...t, priority: task.priority } : t)); }
  };

  const del = async (id) => {
    const task = tasks.find(t => t.id === id);
    setTasks(p => p.filter(t => t.id !== id));
    setConfirmId(null);
    try { await deleteTask(id, userId); }
    catch (e) {
      setError(e.message);
      setTasks(p => [task, ...p]); // rollback
    }
  };

  const commitEdit = async (id) => {
    const text = editText.trim();
    if (!text) { setEditId(null); return; }
    const task = tasks.find(t => t.id === id);
    setTasks(p => p.map(t => t.id === id ? { ...t, text } : t));
    setEditId(null);
    try { await upsertTask({ ...task, text }, dateKey, userId); }
    catch (e) {
      setError(e.message);
      setTasks(p => p.map(t => t.id === id ? { ...t, text: task.text } : t));
    }
  };

  // ── END DAY ──
  const endDay = async () => {
    const unfinished = tasks.filter(t => t.status !== "done");
    const tomorrow   = addDays(dateKey, 1);

    setSaving(true);
    try {
      if (unfinished.length) {
        // Fetch tomorrow's existing tasks to avoid duplicates
        const existing = await fetchDay(tomorrow, userId);
        const existIds = new Set(existing.map(t => t.id));
        const toRoll   = unfinished
          .filter(t => !existIds.has(t.id))
          .map(t => ({ ...t, status: t.status === "blocked" ? "blocked" : "todo", rolledFrom: dateKey }));
        if (toRoll.length) await upsertMany(toRoll, tomorrow, userId);
      }
      setShowEndDay(false);
      refreshHistory();
      setDateKey(tomorrow);
    } catch (e) {
      setError(e.message);
    } finally { setSaving(false); }
  };

  // ── CHANGE USER ID ──
  const applyChangeId = () => {
    const newId = idInput.trim();
    if (!newId) { setIdError("Please enter a user ID."); return; }
    if (newId === userId) { setIdError("That's already your current ID."); return; }
    localStorage.setItem(USER_ID_KEY, newId);
    setUserId(newId);
    setShowChangeId(false);
    setIdInput("");
    setIdError("");
    setMigrateResult(null);
  };

  // ── MIGRATE LOCALSTORAGE → SUPABASE ──
  const migrateFromLocalStorage = async () => {
    const days = readLocalStorageTasks();
    if (!days.length) { setMigrateResult({ count: 0 }); return; }
    setMigrating(true);
    setMigrateResult(null);
    let total = 0;
    try {
      for (const { dateKey: dk, tasks: ts } of days) {
        await upsertMany(ts, dk, userId);
        total += ts.length;
      }
      setMigrateResult({ count: total, days: days.length });
      refreshHistory();
      // Reload current day
      const fresh = await fetchDay(dateKey, userId);
      setTasks(fresh);
    } catch (e) {
      setError(e.message);
    } finally { setMigrating(false); }
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
  const sidebarHistoryKeys = historyKeys.filter(k => k !== dateKey);

  return (
    <div data-theme={theme} style={{ width:"100vw", height:"100vh", display:"flex", flexDirection:"column", background:"var(--bg)", overflow:"hidden", fontFamily:"'Plus Jakarta Sans', sans-serif", color:"var(--text)" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&family=Fraunces:opsz,wght@9..144,700&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }

        /* ── THEME VARIABLES ── */
        [data-theme="dark"] {
          /* Backgrounds — stepped so each layer is visibly distinct */
          --bg:              #0f1117;
          --bg-sidebar:      #161b27;
          --bg-card:         #1c2333;
          --bg-card-hover:   #222b3d;
          --bg-input:        #1c2333;
          --bg-chip:         #222b3d;
          --bg-chip2:        #2a3550;
          --bg-modal:        #161b27;
          --edit-bg:         #0f1117;
          --confirm-no-bg:   #222b3d;
          --modal-confirm-cancel-bg: #222b3d;
          /* Borders — clearly visible against backgrounds */
          --border:          #2a3550;
          --border2:         #344060;
          --border3:         #4a5880;
          /* Text — high contrast hierarchy */
          --text:            #f0f4ff;
          --text2:           #c8d3ea;
          --text3:           #8899bb;
          --text4:           #6677aa;
          --text5:           #4a5880;
          --text-title:      #ffffff;
          --section-lbl:     #5566aa;
          --footer-txt:      #3a4a70;
          --loading-txt:     #4a5880;
          --scroll-thumb:    #2a3550;
          --date-scheme:     dark;
        }
        [data-theme="light"] {
          /* Backgrounds — warm white base, clearly differentiated layers */
          --bg:              #eef1f7;
          --bg-sidebar:      #ffffff;
          --bg-card:         #ffffff;
          --bg-card-hover:   #f5f7fc;
          --bg-input:        #ffffff;
          --bg-chip:         #eef1f7;
          --bg-chip2:        #e0e5f0;
          --bg-modal:        #ffffff;
          --edit-bg:         #f5f7fc;
          --confirm-no-bg:   #eef1f7;
          --modal-confirm-cancel-bg: #eef1f7;
          /* Borders — clearly visible */
          --border:          #d0d8e8;
          --border2:         #b8c4d8;
          --border3:         #8899bb;
          /* Text — dark, clearly readable hierarchy */
          --text:            #0d1117;
          --text2:           #1e2a3a;
          --text3:           #3a4a6a;
          --text4:           #4a5a7a;
          --text5:           #6677aa;
          --text-title:      #0d1117;
          --section-lbl:     #6677aa;
          --footer-txt:      #8899bb;
          --loading-txt:     #8899bb;
          --scroll-thumb:    #d0d8e8;
          --date-scheme:     light;
        }

        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:var(--scroll-thumb); border-radius:4px; }

        .layout { display:flex; flex:1; overflow:hidden; height:100%; }

        /* ── SIDEBAR ── */
        .sidebar {
          width:248px; min-width:248px; background:var(--bg-sidebar);
          border-right:1px solid var(--border2); display:flex; flex-direction:column;
          padding:28px 20px 20px; overflow-y:auto;
          animation:fadeSlide 0.4s ease both;
        }
        @keyframes fadeSlide { from { opacity:0; transform:translateX(-12px); } to { opacity:1; transform:translateX(0); } }

        .brand { margin-bottom:24px; }
        .brand-name { font-family:'Fraunces',Georgia,serif; font-size:22px; font-weight:700; color:var(--text-title); letter-spacing:-0.5px; line-height:1; }
        .brand-sub  { font-size:11px; color:var(--text3); letter-spacing:0.06em; text-transform:uppercase; margin-top:5px; }

        .user-chip { display:flex; align-items:center; gap:6px; background:var(--bg-chip); border-radius:6px; padding:6px 10px; margin-bottom:20px; }
        .user-dot  { width:6px; height:6px; border-radius:50%; background:#86efac; flex-shrink:0; }
        .user-id   { font-size:10px; color:var(--text4); letter-spacing:0.04em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

        .progress-section { margin-bottom:24px; }
        .progress-label { display:flex; justify-content:space-between; font-size:11px; color:var(--text3); text-transform:uppercase; letter-spacing:0.07em; margin-bottom:8px; }
        .progress-track { height:5px; background:var(--border2); border-radius:10px; overflow:hidden; }
        .progress-fill  { height:100%; background:linear-gradient(90deg,#7dd3fc,#86efac); border-radius:10px; transition:width 0.5s cubic-bezier(.4,0,.2,1); }

        .section-label { font-size:10px; color:var(--text4); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:6px; padding-left:4px; margin-top:4px; font-weight:600; }

        .filter-list { display:flex; flex-direction:column; gap:2px; margin-bottom:16px; }
        .filter-item {
          display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:7px;
          font-size:13px; color:var(--text2); cursor:pointer; border:none; background:none;
          text-align:left; transition:all 0.15s; width:100%; font-family:inherit;
        }
        .filter-item:hover  { color:var(--text); background:var(--bg-chip); }
        .filter-item.active { color:var(--text); background:var(--bg-chip2); border-left:2px solid #7dd3fc; }
        .filter-dot   { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
        .filter-count { margin-left:auto; font-size:11px; background:var(--bg-chip2); padding:1px 7px; border-radius:20px; color:var(--text3); }

        .sort-toggle {
          display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:7px;
          font-size:13px; color:var(--text2); cursor:pointer; border:1px solid transparent; background:none;
          text-align:left; transition:all 0.15s; width:100%; font-family:inherit; margin-bottom:16px;
        }
        .sort-toggle:hover  { color:var(--text); background:var(--bg-chip); }
        .sort-toggle.active { color:#fbbf24; background:var(--bg-chip); border-color:#2a2010; }

        .end-day-btn {
          display:flex; align-items:center; gap:8px; padding:10px 14px; border-radius:8px;
          font-size:13px; font-weight:600; cursor:pointer; border:1px solid rgba(251,191,36,0.25);
          background:rgba(251,191,36,0.06); color:#fbbf24; font-family:inherit;
          transition:all 0.15s; width:100%; margin-bottom:8px;
        }
        .end-day-btn:hover    { background:rgba(251,191,36,0.12); border-color:rgba(251,191,36,0.4); }
        .end-day-btn:disabled { opacity:0.3; cursor:not-allowed; }

        .history-toggle {
          display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:7px;
          font-size:12px; color:var(--text3); cursor:pointer; border:none; background:none;
          text-align:left; transition:all 0.15s; width:100%; font-family:inherit;
        }
        .history-toggle:hover { color:var(--text); background:var(--bg-chip); }
        .history-list { display:flex; flex-direction:column; gap:2px; margin-top:4px; max-height:180px; overflow-y:auto; }
        .history-item {
          display:flex; align-items:center; justify-content:space-between; padding:6px 10px; border-radius:6px;
          font-size:12px; color:var(--text3); cursor:pointer; border:none; background:none;
          text-align:left; transition:all 0.15s; width:100%; font-family:inherit;
        }
        .history-item:hover  { color:var(--text); background:var(--bg-chip); }
        .history-item.active { color:#7dd3fc; background:var(--bg-chip); }
        .history-badge { font-size:10px; color:var(--text4); background:var(--bg-chip2); padding:1px 6px; border-radius:10px; }

        .sidebar-footer { margin-top:auto; padding-top:16px; border-top:1px solid var(--border2); font-size:11px; color:var(--text4); text-align:center; letter-spacing:0.04em; }

        /* ── MAIN ── */
        .main { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }

        .topbar { padding:24px 36px 18px; border-bottom:1px solid var(--border2); flex-shrink:0; animation:fadeDown 0.4s ease both; }
        @keyframes fadeDown { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
        .topbar-row { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; flex-wrap:wrap; }
        .page-title { font-family:'Fraunces',Georgia,serif; font-size:28px; font-weight:700; color:var(--text-title); letter-spacing:-0.8px; line-height:1; }
        .page-sub   { font-size:12px; color:var(--text3); margin-top:4px; }

        .date-nav { display:flex; align-items:center; gap:8px; }
        .date-picker {
          background:var(--bg-input); border:1px solid var(--border2); border-radius:8px;
          padding:8px 12px; color:var(--text); font-family:inherit; font-size:13px;
          outline:none; cursor:pointer; transition:border-color 0.15s; color-scheme:var(--date-scheme);
        }
        .date-picker:focus { border-color:#7dd3fc; }
        .nav-btn {
          background:var(--bg-input); border:1px solid var(--border2); border-radius:6px;
          padding:7px 12px; color:var(--text3); font-family:inherit; font-size:12px;
          cursor:pointer; transition:all 0.15s; line-height:1; white-space:nowrap;
        }
        .nav-btn:hover      { color:var(--text); border-color:var(--border3); }
        .nav-btn.today-btn  { color:#7dd3fc; border-color:rgba(125,211,252,0.25); background:rgba(125,211,252,0.06); }
        .nav-btn.today-btn:hover { background:rgba(125,211,252,0.12); }

        .search-wrap { position:relative; }
        .search-input {
          background:var(--bg-input); border:1px solid var(--border2); border-radius:8px;
          padding:9px 14px 9px 34px; color:var(--text); font-family:inherit; font-size:13px;
          outline:none; width:200px; transition:border-color 0.15s;
        }
        .search-input:focus { border-color:#7dd3fc; }
        .search-input::placeholder { color:var(--text5); }
        .search-icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color:var(--text5); font-size:14px; pointer-events:none; }

        .saving-indicator { font-size:11px; color:var(--text3); display:flex; align-items:center; gap:5px; }
        .saving-dot { width:5px; height:5px; border-radius:50%; background:#fbbf24; animation:pulse 1s infinite; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }

        /* ── ADD FORM ── */
        .input-row { display:flex; gap:10px; padding:12px 36px; border-bottom:1px solid var(--border2); flex-shrink:0; align-items:center; }
        .task-input {
          flex:1; background:var(--bg-input); border:1px solid var(--border2); border-radius:8px;
          padding:10px 16px; color:var(--text); font-family:inherit; font-size:14px;
          outline:none; transition:border-color 0.15s; min-width:0;
        }
        .task-input:focus    { border-color:#7dd3fc; }
        .task-input::placeholder { color:var(--text5); }
        .task-input:disabled { opacity:0.4; cursor:not-allowed; }

        .prio-select {
          appearance:none; -webkit-appearance:none;
          background:var(--bg-input); border:1px solid var(--border2); border-radius:8px;
          padding:10px 14px; font-family:inherit; font-size:13px;
          outline:none; cursor:pointer; transition:all 0.15s; flex-shrink:0;
        }
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

        .error-banner {
          display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 36px;
          background:rgba(248,113,113,0.08); border-bottom:1px solid rgba(248,113,113,0.15);
          font-size:12px; color:#f87171; flex-shrink:0;
        }
        .error-dismiss { background:none; border:none; color:#f87171; cursor:pointer; font-size:14px; padding:0; }

        /* ── TASK LIST ── */
        .task-area { flex:1; overflow-y:auto; padding:16px 36px 28px; }

        .loading-state { text-align:center; padding:56px 20px; color:var(--loading-txt); font-size:13px; }
        .loading-spin  { display:inline-block; width:20px; height:20px; border:2px solid var(--border2); border-top-color:#7dd3fc; border-radius:50%; animation:spin 0.7s linear infinite; margin-bottom:12px; }
        @keyframes spin { to { transform:rotate(360deg); } }

        .group-label {
          font-size:10px; text-transform:uppercase; letter-spacing:0.1em;
          padding-bottom:8px; margin-top:10px; display:flex; align-items:center; gap:8px;
        }
        .group-label:first-child { margin-top:0; }
        .group-line { flex:1; height:1px; background:var(--border); }

        .task-card {
          display:flex; align-items:center; gap:12px;
          padding:11px 16px; border-radius:10px; border:1px solid var(--border2);
          background:var(--bg-card); margin-bottom:6px;
          transition:all 0.18s; animation:taskIn 0.2s ease both; position:relative;
        }
        @keyframes taskIn { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }
        .task-card:hover      { border-color:var(--border2); background:var(--bg-card-hover); transform:translateX(2px); }
        .task-card.is-done    { opacity:0.42; }
        .task-card.confirming { border-color:rgba(248,113,113,0.35) !important; background:rgba(248,113,113,0.04) !important; transform:none !important; }
        .task-card.rolled     { border-left:2px solid rgba(251,191,36,0.4); }

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
          padding:3px 8px; border-radius:20px; background:var(--bg-chip); border:1px solid var(--border2);
          flex-shrink:0; cursor:pointer; font-family:inherit; outline:none; transition:all 0.15s;
        }
        .p-badge-select:disabled { cursor:default; }

        .task-text      { flex:1; font-size:13px; color:var(--text2); line-height:1.45; min-width:0; }
        .task-text.done { text-decoration:line-through; color:var(--text5); }

        .edit-in {
          flex:1; background:var(--edit-bg); border:1px solid #7dd3fc; border-radius:6px;
          padding:4px 10px; color:var(--text); font-family:inherit; font-size:13px; outline:none; min-width:0;
        }

        .icon-btn {
          background:none; border:none; cursor:pointer; color:var(--text4); font-size:13px;
          padding:4px; border-radius:5px; transition:all 0.12s; line-height:1; flex-shrink:0; font-family:inherit;
        }
        .icon-btn:hover     { color:var(--text); background:var(--bg-chip); }
        .icon-btn.del:hover { color:#f87171; background:rgba(248,113,113,0.08); }
        .icon-btn:disabled  { opacity:0.2; cursor:not-allowed; }

        .confirm-row   { display:flex; align-items:center; gap:8px; margin-left:auto; flex-shrink:0; animation:fadeIn 0.15s ease; }
        @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
        .confirm-label { font-size:11px; color:#f87171; white-space:nowrap; }
        .confirm-yes   { background:rgba(248,113,113,0.15); border:1px solid rgba(248,113,113,0.35); border-radius:5px; padding:3px 10px; color:#f87171; font-family:inherit; font-size:11px; font-weight:600; cursor:pointer; transition:all 0.12s; }
        .confirm-yes:hover { background:rgba(248,113,113,0.28); }
        .confirm-no    { background:var(--confirm-no-bg); border:1px solid var(--border2); border-radius:5px; padding:3px 10px; color:var(--text2); font-family:inherit; font-size:11px; cursor:pointer; transition:all 0.12s; }
        .confirm-no:hover { color:var(--text); }

        /* ── END DAY MODAL ── */
        .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:100; animation:fadeIn 0.2s ease; }
        .modal { background:var(--bg-modal); border:1px solid var(--border2); border-radius:14px; padding:32px 36px; max-width:420px; width:90%; animation:modalIn 0.2s ease; }
        @keyframes modalIn { from { opacity:0; transform:translateY(12px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
        .modal-title { font-family:'Fraunces',Georgia,serif; font-size:22px; font-weight:700; color:var(--text-title); margin-bottom:8px; }
        .modal-sub   { font-size:13px; color:var(--text3); margin-bottom:24px; line-height:1.6; }
        .modal-stat  { display:flex; gap:16px; margin-bottom:24px; }
        .modal-stat-item { flex:1; background:var(--bg-chip); border-radius:8px; padding:12px; text-align:center; }
        .modal-stat-num  { font-family:'Fraunces',Georgia,serif; font-size:26px; font-weight:700; line-height:1; }
        .modal-stat-lbl  { font-size:10px; color:var(--text3); text-transform:uppercase; letter-spacing:0.07em; margin-top:4px; }
        .modal-actions   { display:flex; gap:10px; }
        .modal-confirm   { flex:1; background:linear-gradient(135deg,#fbbf24,#f59e0b); border:none; border-radius:8px; padding:12px; color:#0c1220; font-family:inherit; font-size:14px; font-weight:600; cursor:pointer; transition:all 0.15s; }
        .modal-confirm:hover    { transform:translateY(-1px); box-shadow:0 4px 14px rgba(251,191,36,0.3); }
        .modal-confirm:disabled { opacity:0.5; cursor:not-allowed; transform:none; }
        .modal-cancel    { background:var(--modal-confirm-cancel-bg); border:1px solid var(--border2); border-radius:8px; padding:12px 20px; color:var(--text2); font-family:inherit; font-size:14px; cursor:pointer; transition:all 0.15s; }
        .modal-cancel:hover { color:var(--text); }

        .empty-state { text-align:center; padding:56px 20px; color:var(--text4); font-size:13px; letter-spacing:0.04em; }
        .empty-icon  { font-size:30px; display:block; margin-bottom:12px; opacity:0.35; }

        /* ── USER CHIP ── */
        .user-chip { display:flex; align-items:center; gap:6px; background:var(--bg-chip); border-radius:6px; padding:6px 10px; margin-bottom:16px; border:1px solid var(--border); }
        .user-dot  { width:6px; height:6px; border-radius:50%; background:#86efac; flex-shrink:0; }
        .user-id   { font-size:10px; color:var(--text3); letter-spacing:0.04em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
        .user-change-btn { background:none; border:none; color:var(--text4); cursor:pointer; font-size:11px; padding:0 2px; transition:color 0.12s; flex-shrink:0; }
        .user-change-btn:hover { color:#7dd3fc; }

        /* ── MIGRATION ── */
        .migrate-banner { background:rgba(125,211,252,0.06); border:1px solid rgba(125,211,252,0.15); border-radius:8px; padding:12px; margin-bottom:16px; }
        .migrate-title  { font-size:12px; font-weight:600; color:#7dd3fc; margin-bottom:4px; }
        .migrate-sub    { font-size:11px; color:var(--text4); line-height:1.5; margin-bottom:10px; }
        .migrate-btn    { width:100%; background:rgba(125,211,252,0.1); border:1px solid rgba(125,211,252,0.25); border-radius:6px; padding:7px; color:#7dd3fc; font-family:inherit; font-size:12px; font-weight:600; cursor:pointer; transition:all 0.15s; }
        .migrate-btn:hover    { background:rgba(125,211,252,0.18); }
        .migrate-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .migrate-success { font-size:11px; color:#86efac; background:rgba(134,239,172,0.06); border:1px solid rgba(134,239,172,0.15); border-radius:6px; padding:8px 10px; margin-bottom:16px; }

        /* ── CHANGE ID MODAL ── */
        .id-display { display:flex; align-items:center; gap:10px; background:var(--bg-chip); border-radius:8px; padding:12px 14px; margin-bottom:4px; }
        .id-code    { flex:1; font-family:'DM Mono',monospace; font-size:13px; color:#7dd3fc; word-break:break-all; }
        .copy-btn   { background:rgba(125,211,252,0.1); border:1px solid rgba(125,211,252,0.25); border-radius:6px; padding:5px 12px; color:#7dd3fc; font-family:inherit; font-size:12px; cursor:pointer; white-space:nowrap; transition:all 0.12s; }
        .copy-btn:hover { background:rgba(125,211,252,0.2); }
        .id-input   { flex:1; background:var(--bg-chip); border:1px solid var(--border2); border-radius:8px; padding:10px 14px; color:var(--text); font-family:inherit; font-size:13px; outline:none; transition:border-color 0.15s; }
        .id-input:focus { border-color:#7dd3fc; }
        .id-input::placeholder { color:var(--text5); }
        /* ── THEME TOGGLE ── */
        .theme-toggle {
          background:var(--bg-chip); border:1px solid var(--border2); border-radius:8px;
          padding:7px 11px; color:var(--text3); font-size:14px; cursor:pointer;
          transition:all 0.15s; line-height:1; flex-shrink:0;
        }
        .theme-toggle:hover { color:var(--text); border-color:var(--border3); background:var(--bg-chip2); }

        /* ── HAMBURGER ── */
        .hamburger {
          display:none; background:var(--bg-chip); border:1px solid var(--border2); border-radius:8px;
          padding:7px 11px; color:var(--text3); font-size:16px; cursor:pointer;
          transition:all 0.15s; line-height:1; flex-shrink:0;
        }
        .hamburger:hover { color:var(--text); }
        .sidebar-close-row { display:none; justify-content:flex-end; margin-bottom:12px; }
        .sidebar-close {
          background:none; border:none; color:var(--text3); font-size:16px;
          cursor:pointer; padding:4px 8px; border-radius:6px; transition:all 0.12s;
        }
        .sidebar-close:hover { color:var(--text); background:var(--bg-chip); }
        .sidebar-overlay {
          position:fixed; inset:0; background:rgba(0,0,0,0.5);
          z-index:49; animation:fadeIn 0.2s ease;
        }

        /* ── MOBILE BREAKPOINT ── */
        @media (max-width: 768px) {
          .hamburger { display:flex; }
          .sidebar-close-row { display:flex; }
          .sidebar {
            position:fixed; top:0; left:0; bottom:0; z-index:50;
            transform:translateX(-100%);
            transition:transform 0.28s cubic-bezier(.4,0,.2,1);
            width:280px; min-width:unset;
            box-shadow:4px 0 24px rgba(0,0,0,0.3);
            animation:none;
          }
          .sidebar-visible { transform:translateX(0) !important; }
          .main { width:100%; }
          .topbar { padding:14px 16px 12px; }
          .page-title { font-size:22px; }
          .topbar-row { gap:8px; }
          .search-input { width:130px; }
          .date-picker  { font-size:12px; padding:7px 10px; }
          .input-row { flex-wrap:wrap; padding:10px 14px; gap:8px; }
          .task-input { width:100%; }
          .prio-select { flex:1; }
          .add-btn { flex:1; }
          .task-area { padding:12px 14px 24px; }
          .task-card { padding:10px 12px; gap:8px; }
          .status-pill { min-width:76px; font-size:9px; padding:3px 8px; }
          .readonly-banner, .error-banner { padding:8px 14px; }
          .modal { padding:24px 20px; }
        }
        @media (max-width: 420px) {
          .search-wrap { display:none; }
          .page-title  { font-size:18px; }
          .date-picker { width:120px; }
        }
      `}</style>

      {/* ── END DAY MODAL ── */}
      {/* ── CHANGE USER ID MODAL ── */}
      {showChangeId && (
        <div className="modal-backdrop" onClick={() => setShowChangeId(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Your User ID</div>
            <div className="modal-sub">
              Your ID links you to your data in Supabase. Copy it somewhere safe — if you switch browsers or devices, enter it here to recover all your tasks.
            </div>
            <div className="id-display">
              <code className="id-code">{userId}</code>
              <button className="copy-btn" onClick={() => navigator.clipboard?.writeText(userId)}>Copy</button>
            </div>
            <div style={{ borderTop:"1px solid var(--border2)", margin:"20px 0" }} />
            <div style={{ fontSize:13, color:"#64748b", marginBottom:12 }}>Enter a different ID to switch accounts:</div>
            <div style={{ display:"flex", gap:8, marginBottom:8 }}>
              <input
                className="id-input"
                placeholder="usr_xxxxxxxx"
                value={idInput}
                onChange={e => { setIdInput(e.target.value); setIdError(""); }}
                onKeyDown={e => e.key === "Enter" && applyChangeId()}
              />
              <button className="modal-confirm" style={{ flex:"none", padding:"10px 16px", fontSize:13 }} onClick={applyChangeId}>
                Switch
              </button>
            </div>
            {idError && <div style={{ fontSize:12, color:"#f87171", marginBottom:8 }}>{idError}</div>}
            <button className="modal-cancel" style={{ width:"100%", marginTop:4 }} onClick={() => setShowChangeId(false)}>Close</button>
          </div>
        </div>
      )}

      {showEndDay && (
        <div className="modal-backdrop" onClick={() => setShowEndDay(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">End Your Day</div>
            <div className="modal-sub">
              {unfinishedCount > 0
                ? `You have ${unfinishedCount} unfinished task${unfinishedCount > 1 ? "s" : ""}. They'll be rolled over to tomorrow — Blocked tasks stay blocked, others reset to To Do.`
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
              <button className="modal-confirm" disabled={saving} onClick={endDay}>
                {saving ? "Saving..." : unfinishedCount > 0 ? "Roll Over & Go to Tomorrow →" : "Go to Tomorrow →"}
              </button>
              <button className="modal-cancel" onClick={() => setShowEndDay(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className={`layout ${sidebarOpen ? "sidebar-open" : ""}`}>
        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}

        {/* ── SIDEBAR ── */}
        <aside className={`sidebar ${sidebarOpen ? "sidebar-visible" : ""}`}>
          <div className="sidebar-close-row">
            <button className="sidebar-close" onClick={() => setSidebarOpen(false)}>✕</button>
          </div>
          <div className="brand">
            <div className="brand-name">Taskly</div>
            <div className="brand-sub">Daily Planner</div>
          </div>

          {/* User ID chip */}
          <div className="user-chip">
            <span className="user-dot" />
            <span className="user-id" title={userId}>{userId}</span>
            <button className="user-change-btn" onClick={() => { setShowChangeId(true); setIdInput(""); setIdError(""); }} title="Change or recover user ID">✎</button>
          </div>

          {/* Migration banner — only if localStorage has old data */}
          {readLocalStorageTasks().length > 0 && !migrateResult && (
            <div className="migrate-banner">
              <div className="migrate-title">📦 Local data found</div>
              <div className="migrate-sub">You have tasks in your old browser storage. Import them to Supabase so they're saved permanently.</div>
              <button className="migrate-btn" disabled={migrating} onClick={migrateFromLocalStorage}>
                {migrating ? "Importing..." : "Import to Database"}
              </button>
            </div>
          )}
          {migrateResult && (
            <div className="migrate-success">
              ✓ Imported {migrateResult.count} task{migrateResult.count !== 1 ? "s" : ""} from {migrateResult.days} day{migrateResult.days !== 1 ? "s" : ""}
            </div>
          )}
          {migrateResult && migrateResult.count === 0 && (
            <div className="migrate-success" style={{ color:"#475569" }}>No local tasks found to import.</div>
          )}

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
              <span className="filter-dot" style={{ background:"var(--text4)" }} />
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

          {isToday && (
            <>
              <div className="section-label">Day Actions</div>
              <button className="end-day-btn" disabled={saving} onClick={() => setShowEndDay(true)}>
                ✦ End My Day
              </button>
            </>
          )}

          {sidebarHistoryKeys.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop:8 }}>History</div>
              <button className="history-toggle" onClick={() => setShowHistory(v => !v)}>
                {showHistory ? "▾" : "▸"} Past Days ({sidebarHistoryKeys.length})
              </button>
              {showHistory && (
                <div className="history-list">
                  {!isToday && (
                    <button className="history-item" onClick={() => setDateKey(todayKey())}>
                      Today <span className="history-badge">now</span>
                    </button>
                  )}
                  {sidebarHistoryKeys.map(k => (
                    <button key={k} className={`history-item ${dateKey === k ? "active" : ""}`} onClick={() => setDateKey(k)}>
                      {new Date(k + "T00:00:00").toLocaleDateString("en-US", { month:"short", day:"numeric" })}
                      <span className="history-badge">{k}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="sidebar-footer">
            {loading ? "Loading..." : tasks.length === 0 ? "Add your first task →" : `${counts.done} of ${tasks.length} complete`}
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
                {saving && (
                  <div className="saving-indicator">
                    <span className="saving-dot" /> Saving...
                  </div>
                )}
                <button className="hamburger" onClick={() => setSidebarOpen(v => !v)} title="Menu">
                  ☰
                </button>
                <button
                  className="theme-toggle"
                  onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
                  title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                >
                  {theme === "dark" ? "☀" : "☾"}
                </button>
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

          {error && (
            <div className="error-banner">
              ⚠ {error}
              <button className="error-dismiss" onClick={() => setError(null)}>✕</button>
            </div>
          )}

          {isReadOnly && (
            <div className="readonly-banner">
              ⚠ Past day — view only. Navigate to today to add tasks.
            </div>
          )}

          <div className="input-row">
            <input
              ref={inputRef}
              className="task-input"
              placeholder={isReadOnly ? "Past day — read only" : "What needs to be done today?"}
              value={input}
              disabled={isReadOnly || loading}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && add()}
            />
            <select
              className="prio-select"
              value={priority}
              disabled={isReadOnly || loading}
              onChange={e => setPriority(e.target.value)}
              style={{ color: PRIORITY_MAP[priority].color }}
            >
              {PRIORITY.map(p => (
                <option key={p.key} value={p.key} style={{ color:p.color }}>{p.label} Priority</option>
              ))}
            </select>
            <button className="add-btn" disabled={isReadOnly || loading} onClick={add}>+ Add Task</button>
          </div>

          <div className="task-area">
            {loading ? (
              <div className="loading-state">
                <div className="loading-spin" />
                <div>Loading tasks...</div>
              </div>
            ) : visible.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">✦</span>
                {search ? "No tasks match your search."
                  : filter === "all"
                    ? isReadOnly ? "No tasks recorded for this day." : "No tasks yet — add one above!"
                    : `No ${STATUS_MAP[filter]?.label} tasks.`}
              </div>
            ) : filter === "all" && !search && !sortByPriority
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
  const s         = STATUS_MAP[task.status];
  const p         = PRIORITY_MAP[task.priority || "medium"];
  const isEditing = editId === task.id;
  const isConfirm = confirmId === task.id;

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
