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
  id:          row.id,
  text:        row.text,
  status:      row.status,
  priority:    row.priority,
  rolledFrom:  row.rolled_from || null,
  createdAt:   row.created_at,
  subtasks:    row.subtasks || [],
  remark:      row.remark || null,
  followUpOf:  row.follow_up_of || null,
});

const taskToDb = (task, dateKey, userId) => ({
  id:           task.id,
  user_id:      userId,
  date_key:     dateKey,
  text:         task.text,
  status:       task.status,
  priority:     task.priority || "medium",
  rolled_from:  task.rolledFrom || null,
  created_at:   task.createdAt,
  subtasks:     task.subtasks || [],
  remark:       task.remark || null,
  follow_up_of: task.followUpOf || null,
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

// Fetch all unfinished tasks from days strictly before a given dateKey
async function fetchUnfinishedBefore(beforeKey, userId) {
  const { data, error } = await sb
    .from("tasks")
    .select("*")
    .eq("user_id", userId)
    .lt("date_key", beforeKey)
    .neq("status", "done");
  if (error) throw error;
  return (data || []).map(r => ({ ...dbToTask(r), _dateKey: r.date_key }));
}

// ─── Recurring task helpers ──────────────────────────────────────────────────

async function fetchRecurring(userId) {
  const { data, error } = await sb
    .from("recurring_tasks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(r => ({ id: r.id, text: r.text, priority: r.priority, createdAt: r.created_at, enabled: r.enabled !== false, days: r.days || [0,1,2,3,4,5,6] }));
}

async function upsertRecurring(rec, userId) {
  const { error } = await sb.from("recurring_tasks").upsert({
    id: rec.id, user_id: userId, text: rec.text,
    priority: rec.priority || "medium", created_at: rec.createdAt,
    enabled: rec.enabled !== false,
    days: rec.days || [0,1,2,3,4,5,6],
  });
  if (error) throw error;
}

async function deleteRecurring(id, userId) {
  const { error } = await sb.from("recurring_tasks").delete().eq("id", id).eq("user_id", userId);
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
  // Recurring tasks
  const [recurring, setRecurring]           = useState([]);
  const [showRecurring, setShowRecurring]   = useState(false);
  const [recInput, setRecInput]             = useState("");
  const [recPriority, setRecPriority]       = useState("medium");
  const [recEditId, setRecEditId]           = useState(null);
  const [recEditText, setRecEditText]       = useState("");
  const [recEditPrio, setRecEditPrio]       = useState("medium");
  const [recEditDays, setRecEditDays]       = useState([0,1,2,3,4,5,6]);
  // Done with remark
  const [remarkModal, setRemarkModal]       = useState(null);
  const [remarkText, setRemarkText]         = useState("");
  // Bulk select
  const [selectMode, setSelectMode]   = useState(false);
  const [selected, setSelected]       = useState(new Set());
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

  // Fix iPhone PWA stale cache — silently refetch when app comes back into focus
  useEffect(() => {
    const onFocus = () => {
      fetchDay(dateKey, userId)
        .then(fresh => setTasks(fresh))
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") onFocus();
    });
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [dateKey, userId]);

  // Load history keys on mount and after end day
  const refreshHistory = useCallback(() => {
    fetchAllDateKeys(userId).then(setHistoryKeys).catch(() => {});
  }, [userId]);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const refreshRecurring = useCallback(() => {
    fetchRecurring(userId).then(setRecurring).catch(() => {});
  }, [userId]);

  useEffect(() => { refreshRecurring(); }, [refreshRecurring]);

  // ── AUTO ROLLOVER ON OPEN ──
  // Runs once on mount (and whenever userId changes).
  // Finds all unfinished tasks from past days and rolls them to today
  // if they haven't already been rolled (checked by id).
  useEffect(() => {
    const tk = todayKey();
    async function autoRollover() {
      try {
        const [unfinished, todayTasks] = await Promise.all([
          fetchUnfinishedBefore(tk, userId),
          fetchDay(tk, userId),
        ]);
        if (!unfinished.length) return;

        const existIds = new Set(todayTasks.map(t => t.id));
        const toRoll = unfinished
          .filter(t => !existIds.has(t.id))
          .map(t => ({
            ...t,
            status:     t.status === "blocked" ? "blocked" : "todo",
            rolledFrom: t._dateKey,
            _dateKey:   undefined,
          }));

        if (toRoll.length) await upsertMany(toRoll, tk, userId);
        // If we're already viewing today, reload the task list
        if (dateKey === tk) {
          const fresh = await fetchDay(tk, userId);
          setTasks(fresh);
        }
        refreshHistory();
      } catch (_) {
        // Silent — don't surface auto-rollover errors to the user
      }
    }
    autoRollover();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // ── AUTO-ADD RECURRING TASKS ──
  // Runs on mount. For each recurring template, if today doesn't already
  // have a task with the same recurring_id marker, insert it as To Do.
  useEffect(() => {
    const tk = todayKey();
    async function autoAddRecurring() {
      try {
        const [templates, todayTasks] = await Promise.all([
          fetchRecurring(userId),
          fetchDay(tk, userId),
        ]);
        if (!templates.length) return;
        // Mark tasks that came from a recurring template via their id prefix "rec_"
        const existRecIds = new Set(
          todayTasks.filter(t => t.id.startsWith("rec_")).map(t => t.id.split("__")[0])
        );
        const todayDow = new Date().getDay(); // 0=Sun … 6=Sat
        const toAdd = templates
          .filter(r => r.enabled !== false && (r.days || [0,1,2,3,4,5,6]).includes(todayDow))
          .filter(r => !existRecIds.has("rec_" + r.id))
          .map(r => ({
            id:        `rec_${r.id}__${tk}`,
            text:      r.text,
            status:    "todo",
            priority:  r.priority,
            createdAt: Date.now(),
            rolledFrom: null,
          }));
        if (!toAdd.length) return;
        await upsertMany(toAdd, tk, userId);
        if (dateKey === tk) {
          const fresh = await fetchDay(tk, userId);
          setTasks(fresh);
        }
      } catch (_) { /* silent */ }
    }
    autoAddRecurring();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // ── BULK DELETE ──
  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(tasks.filter(t => filter === 'all' || t.status === filter).map(t => t.id)));
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    const removed = tasks.filter(t => ids.includes(t.id));
    setTasks(p => p.filter(t => !ids.includes(t.id)));
    setSelected(new Set());
    setSelectMode(false);
    try {
      await Promise.all(ids.map(id => deleteTask(id, userId)));
    } catch (e) {
      setError(e.message);
      setTasks(p => [...removed, ...p]);
    }
  };

  // ── SUBTASK CRUD ──
  const updateSubtasks = async (taskId, subtasks) => {
    setTasks(p => p.map(t => t.id === taskId ? { ...t, subtasks } : t));
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    // Auto-set parent status based on subtasks
    let newStatus = task.status;
    if (subtasks.length > 0) {
      if (subtasks.every(s => s.done)) newStatus = "done";
      else if (subtasks.some(s => s.blocked) && newStatus === "done") newStatus = "inprogress";
      else if (task.status === "done" && !subtasks.every(s => s.done)) newStatus = "inprogress";
    }
    const updated = { ...task, subtasks, status: newStatus };
    setTasks(p => p.map(t => t.id === taskId ? updated : t));
    try { await upsertTask(updated, dateKey, userId); }
    catch (e) { setError(e.message); setTasks(p => p.map(t => t.id === taskId ? task : t)); }
  };

  // ── RECURRING CRUD ──
  const addRecurring = async () => {
    const text = recInput.trim();
    if (!text) return;
    const rec = { id: uid(), text, priority: recPriority, createdAt: Date.now(), enabled: true, days: [0,1,2,3,4,5,6] };
    setRecurring(p => [...p, rec]);
    setRecInput(""); setRecPriority("medium");
    try { await upsertRecurring(rec, userId); }
    catch (e) { setError(e.message); setRecurring(p => p.filter(r => r.id !== rec.id)); }
  };

  const saveRecurringEdit = async (id) => {
    const text = recEditText.trim();
    if (!text) { setRecEditId(null); return; }
    const old = recurring.find(r => r.id === id);
    const updated = { ...old, text, priority: recEditPrio, days: recEditDays || old.days || [0,1,2,3,4,5,6] };
    setRecurring(p => p.map(r => r.id === id ? updated : r));
    setRecEditId(null);
    try { await upsertRecurring(updated, userId); }
    catch (e) { setError(e.message); setRecurring(p => p.map(r => r.id === id ? old : r)); }
  };

  const removeRecurring = async (id) => {
    const old = recurring.find(r => r.id === id);
    setRecurring(p => p.filter(r => r.id !== id));
    try { await deleteRecurring(id, userId); }
    catch (e) { setError(e.message); setRecurring(p => [...p, old]); }
  };

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

  const applyStatus = async (id, status, remark) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    const updated = { ...task, status, remark: remark || task.remark || null };
    setTasks(p => p.map(t => t.id === id ? updated : t));
    try { await upsertTask(updated, dateKey, userId); }
    catch (e) {
      setError(e.message);
      setTasks(p => p.map(t => t.id === id ? task : t));
    }
  };

  const setStatus = (id, status) => {
    if (status === "done") {
      setRemarkModal({ taskId: id, status });
      setRemarkText("");
    } else {
      applyStatus(id, status, null);
    }
  };

  const confirmRemark = () => {
    if (!remarkModal) return;
    applyStatus(remarkModal.taskId, remarkModal.status, remarkText.trim() || null);
    setRemarkModal(null);
    setRemarkText("");
  };

  // ── TASK LINKING / SCROLL ──
  const [highlightId, setHighlightId] = useState(null);
  const scrollToTask = (id) => {
    const el = document.querySelector(`[data-taskid="${id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightId(id);
      setTimeout(() => setHighlightId(null), 1800);
    }
  };

  // ── FOLLOW-UP TASK ──
  const createFollowUp = async (parentId, text, prio) => {
    if (!text.trim()) return;
    const parent = tasks.find(t => t.id === parentId);
    const newTask = {
      id: uid(),
      text: text.trim(),
      status: "todo",
      priority: prio || parent?.priority || "medium",
      rolledFrom: null,
      createdAt: Date.now(),
      subtasks: [],
      remark: null,
      followUpOf: parentId,
    };
    setTasks(p => [...p, newTask]);
    try { await upsertTask(newTask, dateKey, userId); }
    catch (e) { setError(e.message); setTasks(p => p.filter(t => t.id !== newTask.id)); }
  };

  const updateRemark = async (id, remark) => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    const updated = { ...task, remark: remark || null };
    setTasks(p => p.map(t => t.id === id ? updated : t));
    try { await upsertTask(updated, dateKey, userId); }
    catch (e) {
      setError(e.message);
      setTasks(p => p.map(t => t.id === id ? task : t));
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
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }

        /* ── THEME VARIABLES ── */
        [data-theme="dark"] {
          --bg:              #0c1021;
          --bg-sidebar:      #111827;
          --bg-card:         #171f2e;
          --bg-card-hover:   #1e2840;
          --bg-input:        #171f2e;
          --bg-chip:         #1e2840;
          --bg-chip2:        #263354;
          --bg-modal:        #111827;
          --edit-bg:         #0c1021;
          --confirm-no-bg:   #1e2840;
          --modal-confirm-cancel-bg: #1e2840;
          --border:          #263354;
          --border2:         #2e3d65;
          --border3:         #3d527a;
          --text:            #eef2ff;
          --text2:           #c4cfeb;
          --text3:           #7d90c0;
          --text4:           #5469a0;
          --text5:           #374880;
          --text-title:      #ffffff;
          --section-lbl:     #4a60a0;
          --footer-txt:      #2e3d65;
          --loading-txt:     #374880;
          --scroll-thumb:    #263354;
          --date-scheme:     dark;
          --accent:          #6ea8fe;
          --accent-glow:     rgba(110,168,254,0.18);
          --sidebar-glow:    radial-gradient(ellipse at top left, rgba(99,102,241,0.12) 0%, transparent 60%);
        }
        [data-theme="light"] {
          --bg:              #f0f4fc;
          --bg-sidebar:      #ffffff;
          --bg-card:         #ffffff;
          --bg-card-hover:   #f6f8ff;
          --bg-input:        #ffffff;
          --bg-chip:         #eef1fa;
          --bg-chip2:        #e2e8f8;
          --bg-modal:        #ffffff;
          --edit-bg:         #f6f8ff;
          --confirm-no-bg:   #eef1fa;
          --modal-confirm-cancel-bg: #eef1fa;
          --border:          #d5ddf0;
          --border2:         #bdc9e4;
          --border3:         #8da0cc;
          --text:            #0f172a;
          --accent:          #4f6ef7;
          --accent-glow:     rgba(79,110,247,0.12);
          --sidebar-glow:    radial-gradient(ellipse at top left, rgba(99,102,241,0.07) 0%, transparent 60%);
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
          width:256px; min-width:256px; background:var(--bg-sidebar);
          border-right:1px solid var(--border); display:flex; flex-direction:column;
          padding:28px 20px 20px; overflow-y:auto;
          animation:fadeSlide 0.4s ease both;
          background-image:var(--sidebar-glow);
        }
        @keyframes fadeSlide { from { opacity:0; transform:translateX(-12px); } to { opacity:1; transform:translateX(0); } }

        .brand { margin-bottom:24px; padding-bottom:20px; border-bottom:1px solid var(--border); }
        .brand-name { font-family:'Fraunces',Georgia,serif; font-size:24px; font-weight:700; color:var(--text-title); letter-spacing:-0.8px; line-height:1; background:linear-gradient(135deg, #a5b4fc, #6ea8fe); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
        .brand-sub  { font-size:10px; color:var(--text4); letter-spacing:0.1em; text-transform:uppercase; margin-top:6px; }

        .user-chip { display:flex; align-items:center; gap:6px; background:var(--bg-chip); border-radius:8px; padding:7px 10px; margin-bottom:20px; border:1px solid var(--border); }
        .user-dot  { width:7px; height:7px; border-radius:50%; background:#4ade80; flex-shrink:0; box-shadow:0 0 6px rgba(74,222,128,0.5); }
        .user-id   { font-size:10px; color:var(--text3); letter-spacing:0.04em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }

        .progress-section { margin-bottom:20px; }
        .progress-label { display:flex; justify-content:space-between; font-size:11px; color:var(--text3); text-transform:uppercase; letter-spacing:0.07em; margin-bottom:8px; font-weight:600; }
        .progress-track { height:6px; background:var(--border2); border-radius:10px; overflow:hidden; }
        .progress-fill  { height:100%; background:linear-gradient(90deg,#6ea8fe,#4ade80); border-radius:10px; transition:width 0.5s cubic-bezier(.4,0,.2,1); box-shadow:0 0 8px rgba(110,168,254,0.4); }

        .section-label { font-size:10px; color:var(--text4); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:6px; padding-left:4px; margin-top:4px; font-weight:600; }

        .filter-list { display:flex; flex-direction:column; gap:2px; margin-bottom:16px; }
        .filter-item {
          display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:7px;
          font-size:13px; color:var(--text2); cursor:pointer; border:none; background:none;
          text-align:left; transition:all 0.15s; width:100%; font-family:inherit;
        }
        .filter-item:hover  { color:var(--text); background:var(--bg-chip); }
        .filter-item.active { color:var(--text); background:var(--accent-glow); border-left:2px solid var(--accent); }
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

        .sidebar-footer { margin-top:auto; padding-top:16px; border-top:1px solid var(--border); font-size:11px; color:var(--text4); text-align:center; letter-spacing:0.04em; }

        /* ── MAIN ── */
        .main { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; }

        .topbar { padding:20px 36px 16px; border-bottom:1px solid var(--border); flex-shrink:0; animation:fadeDown 0.4s ease both; background:var(--bg); }
        @keyframes fadeDown { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
        .topbar-row { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; flex-wrap:wrap; }
        .page-title { font-family:'Fraunces',Georgia,serif; font-size:30px; font-weight:700; color:var(--text-title); letter-spacing:-1px; line-height:1.1; }
        .page-sub   { font-size:12px; color:var(--text3); margin-top:5px; letter-spacing:0.01em; }

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
        .nav-btn.today-btn  { color:var(--accent); border-color:var(--accent-glow); background:var(--accent-glow); }
        .nav-btn.today-btn:hover { background:rgba(110,168,254,0.18); }

        .search-wrap { position:relative; }
        .search-input {
          background:var(--bg-input); border:1px solid var(--border2); border-radius:8px;
          padding:9px 14px 9px 34px; color:var(--text); font-family:inherit; font-size:13px;
          outline:none; width:200px; transition:border-color 0.15s;
        }
        .search-input:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-glow); }
        .search-input::placeholder { color:var(--text5); }
        .search-icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color:var(--text5); font-size:14px; pointer-events:none; }

        .saving-indicator { font-size:11px; color:var(--text3); display:flex; align-items:center; gap:5px; }
        .saving-dot { width:5px; height:5px; border-radius:50%; background:#fbbf24; animation:pulse 1s infinite; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }

        /* ── ADD FORM ── */
        .input-row { display:flex; gap:10px; padding:12px 36px; border-bottom:1px solid var(--border); flex-shrink:0; align-items:center; background:var(--bg); }
        .task-input {
          flex:1; background:var(--bg-input); border:1px solid var(--border2); border-radius:8px;
          padding:10px 16px; color:var(--text); font-family:inherit; font-size:14px;
          outline:none; transition:border-color 0.15s; min-width:0;
        }
        .task-input:focus    { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-glow); }
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
          background:linear-gradient(135deg,#6ea8fe,#818cf8); border:none; border-radius:8px;
          padding:10px 20px; color:#fff; font-family:inherit; font-size:13px; font-weight:600;
          cursor:pointer; transition:all 0.18s; white-space:nowrap;
          box-shadow:0 2px 10px rgba(110,168,254,0.25);
        }
        .add-btn:hover    { transform:translateY(-1px); box-shadow:0 5px 18px rgba(110,168,254,0.4); }
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
          display:flex; flex-direction:column;
          border-radius:12px; border:1px solid var(--border);
          background:var(--bg-card); margin-bottom:7px;
          transition:border-color 0.18s, background 0.18s, box-shadow 0.18s;
          animation:taskIn 0.22s ease both; position:relative;
          overflow:hidden;
        }
        @keyframes taskIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
        .task-card:hover      { border-color:var(--border2); background:var(--bg-card-hover); box-shadow:0 2px 12px rgba(0,0,0,0.08); }
        .task-card.is-done    { opacity:0.4; }
        .task-card.confirming { border-color:rgba(248,113,113,0.4) !important; background:rgba(248,113,113,0.04) !important; }
        .task-card.rolled::after {
          content:""; position:absolute; left:0; top:0; bottom:0; width:3px;
          background:linear-gradient(180deg, rgba(251,191,36,0.7), rgba(251,191,36,0.2));
        }

        .rolled-tag {
          font-size:11px; color:rgba(251,191,36,0.6); flex-shrink:0;
          line-height:1; padding:0 2px; cursor:default;
        }

        .status-pill {
          appearance:none; -webkit-appearance:none;
          border-radius:20px; padding:3px 10px; font-family:inherit;
          font-size:10px; font-weight:600; letter-spacing:0.07em; text-transform:uppercase;
          cursor:pointer; outline:none; border:1px solid transparent; white-space:nowrap;
          flex-shrink:0; min-width:86px; text-align:center; transition:all 0.15s;
        }
        .status-pill:disabled { cursor:default; }

        /* Priority dot — replaces p-badge-select */
        .prio-dot {
          width:8px; height:8px; border-radius:50%; flex-shrink:0;
          border:none; cursor:pointer; padding:0; transition:transform 0.15s, opacity 0.15s;
          margin-right:2px;
        }
        .prio-dot:hover:not(:disabled) { transform:scale(1.5); }
        .prio-dot:disabled { cursor:default; }

        .task-text-wrap { flex:1; display:flex; align-items:center; gap:6px; min-width:0; }
        .task-text      { flex:1; font-size:13px; color:var(--text2); line-height:1.45; min-width:0; }
        .task-text.done { text-decoration:line-through; color:var(--text5); }

        .edit-in {
          flex:1; background:var(--edit-bg); border:1px solid #7dd3fc; border-radius:6px;
          padding:4px 10px; color:var(--text); font-family:inherit; font-size:13px; outline:none; min-width:0;
        }

        .icon-btn {
          background:none; border:none; cursor:pointer; color:var(--text5); font-size:13px;
          padding:5px 6px; border-radius:6px; transition:all 0.12s; line-height:1; flex-shrink:0; font-family:inherit;
          opacity:0; /* hidden by default, shown on card hover */
        }
        .task-main-row:hover .icon-btn,
        .task-main-row:focus-within .icon-btn { opacity:1; }
        .icon-btn:hover     { color:var(--text); background:var(--bg-chip2); }
        .icon-btn.del:hover { color:#f87171; background:rgba(248,113,113,0.08); }
        .icon-btn:disabled  { opacity:0.15 !important; cursor:not-allowed; }
        .icon-btn.sub-toggle-btn { opacity:1; } /* always visible */

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
        .modal-confirm   { flex:1; background:linear-gradient(135deg,#6ea8fe,#818cf8); border:none; border-radius:8px; padding:12px; color:#fff; font-family:inherit; font-size:14px; font-weight:600; cursor:pointer; transition:all 0.18s; }
        .modal-confirm:hover    { transform:translateY(-1px); box-shadow:0 4px 18px rgba(110,168,254,0.45); }
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
          .icon-btn { opacity:1 !important; } /* always visible on touch */
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
        /* ── RECURRING TASKS ── */
        .recurring-panel { display:flex; flex-direction:column; gap:4px; margin-top:6px; margin-bottom:8px; }
        .rec-item {
          display:flex; align-items:center; gap:6px;
          padding:6px 8px; border-radius:7px; background:var(--bg-chip);
          border:1px solid var(--border);
        }
        .rec-dot  { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
        .rec-text { flex:1; font-size:12px; color:var(--text2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .rec-action-btn {
          background:none; border:none; cursor:pointer; font-size:11px; padding:2px 5px;
          border-radius:4px; transition:all 0.12s; line-height:1; flex-shrink:0;
        }
        .rec-action-btn.edit   { color:var(--text4); }
        .rec-action-btn.edit:hover { color:#7dd3fc; background:var(--bg-chip2); }
        .rec-action-btn.del    { color:var(--text4); }
        .rec-action-btn.del:hover  { color:#f87171; background:rgba(248,113,113,0.1); }
        .rec-action-btn.save   { color:#86efac; }
        .rec-action-btn.save:hover { background:rgba(134,239,172,0.1); }
        .rec-action-btn.cancel { color:var(--text4); }
        .rec-action-btn.cancel:hover { color:#f87171; }
        .rec-edit-input {
          flex:1; background:var(--edit-bg); border:1px solid #7dd3fc; border-radius:5px;
          padding:3px 8px; color:var(--text); font-family:inherit; font-size:12px; outline:none; min-width:0;
        }
        .rec-prio-sel {
          appearance:none; -webkit-appearance:none;
          background:var(--bg-chip2); border:1px solid var(--border2); border-radius:5px;
          padding:3px 6px; font-size:10px; font-weight:600; color:var(--text3);
          font-family:inherit; outline:none; cursor:pointer; flex-shrink:0;
        }
        .rec-add-row {
          display:flex; align-items:center; gap:5px; margin-top:4px;
          padding:6px 8px; border-radius:7px; border:1px dashed var(--border2);
        }
        .rec-add-input {
          flex:1; background:transparent; border:none; outline:none;
          font-family:inherit; font-size:12px; color:var(--text); min-width:0;
        }
        .rec-add-input::placeholder { color:var(--text5); }

        /* ── TASK CARD LAYOUT ── */
        .task-main-row {
          display:flex; align-items:center; gap:10px;
          padding:10px 14px;
        }

        /* ── SUBTASK PROGRESS CHIP ── */
        .sub-progress-chip {
          position:relative; overflow:hidden;
          background:var(--bg-chip); border:1px solid var(--border2);
          border-radius:20px; padding:2px 10px; cursor:pointer;
          font-size:10px; font-weight:600; color:var(--text3);
          white-space:nowrap; flex-shrink:0; transition:all 0.15s;
          min-width:42px; text-align:center;
        }
        .sub-progress-chip:hover { border-color:var(--border3); }
        .sub-progress-fill {
          position:absolute; left:0; top:0; bottom:0;
          background:rgba(134,239,172,0.18); transition:width 0.3s ease;
        }
        .sub-progress-label { position:relative; z-index:1; }

        .sub-toggle-btn { font-size:11px !important; }

        /* ── SUBTASK PANEL ── */
        .subtask-panel {
          border-top:1px solid var(--border);
          padding:8px 16px 10px 16px;
          display:flex; flex-direction:column; gap:3px;
        }

        .subtask-row {
          display:flex; align-items:center; gap:8px;
          padding:5px 8px; border-radius:6px;
          transition:background 0.12s;
        }
        .subtask-row:hover { background:var(--bg-chip); }
        .subtask-row.sub-done .sub-text { text-decoration:line-through; color:var(--text5); }
        .subtask-row.sub-blocked .sub-text { color:#f87171; }

        .sub-check {
          background:none; border:none; cursor:pointer;
          font-size:12px; padding:0; line-height:1; flex-shrink:0;
          color:var(--text4); transition:color 0.12s;
        }
        .sub-check.checked { color:#86efac; }
        .sub-check:disabled { cursor:default; opacity:0.4; }

        .sub-text {
          flex:1; font-size:12px; color:var(--text2); line-height:1.4;
          cursor:default; min-width:0;
        }

        .sub-actions {
          display:flex; gap:2px; opacity:0; transition:opacity 0.12s; flex-shrink:0;
        }
        .subtask-row:hover .sub-actions { opacity:1; }

        .sub-action {
          background:none; border:none; cursor:pointer;
          font-size:11px; color:var(--text4); padding:2px 4px;
          border-radius:4px; transition:all 0.12s; line-height:1;
        }
        .sub-action:hover { color:var(--text); background:var(--bg-chip2); }
        .sub-action.is-blocked { color:#f87171; }
        .sub-action.del:hover  { color:#f87171; }

        .sub-edit-input {
          flex:1; background:var(--edit-bg); border:1px solid #7dd3fc;
          border-radius:5px; padding:2px 8px; color:var(--text);
          font-family:inherit; font-size:12px; outline:none; min-width:0;
        }

        .sub-add-row {
          display:flex; align-items:center; gap:6px;
          padding:4px 6px; border-radius:6px; margin-top:2px;
          border:1px dashed var(--border2);
          transition:border-color 0.15s;
        }
        .sub-add-row:focus-within { border-color:#7dd3fc; }
        .sub-add-icon { color:var(--text5); font-size:13px; flex-shrink:0; }
        .sub-add-input {
          flex:1; background:transparent; border:none; outline:none;
          font-family:inherit; font-size:12px; color:var(--text); min-width:0;
        }
        .sub-add-input::placeholder { color:var(--text5); }


        /* ── FOLLOW-UP ── */
        .followup-panel {
          border-top:1px solid var(--border);
          padding:10px 14px 12px;
          background:rgba(110,168,254,0.03);
        }
        .followup-header {
          display:flex; align-items:center; gap:5px;
          font-size:10px; color:var(--accent); text-transform:uppercase;
          letter-spacing:0.08em; font-weight:600; margin-bottom:8px; opacity:0.8;
        }
        .followup-header-icon { font-size:12px; }
        .followup-input-row { display:flex; gap:6px; align-items:center; }
        .followup-input {
          flex:1; background:var(--bg-input); border:1px solid var(--border2);
          border-radius:7px; padding:7px 12px; color:var(--text); font-family:inherit;
          font-size:12px; outline:none; transition:border-color 0.15s; min-width:0;
        }
        .followup-input:focus { border-color:var(--accent); }
        .followup-input::placeholder { color:var(--text5); }
        .followup-add-btn {
          background:var(--accent-glow); border:1px solid rgba(110,168,254,0.3);
          border-radius:6px; padding:5px 12px; color:var(--accent); font-family:inherit;
          font-size:12px; font-weight:600; cursor:pointer; transition:all 0.12s; flex-shrink:0;
        }
        .followup-add-btn:hover:not(:disabled) { background:rgba(110,168,254,0.2); }
        .followup-add-btn:disabled { opacity:0.35; cursor:not-allowed; }
        .parent-link-badge {
          background:none; border:none; cursor:pointer; padding:0 3px;
          color:var(--accent); opacity:0.7; font-size:12px; font-style:normal;
          border-radius:3px; transition:opacity 0.12s, background 0.12s; line-height:1; flex-shrink:0;
        }
        .parent-link-badge:hover { opacity:1; background:var(--accent-glow); }
        .icon-btn.active-followup { color:var(--accent) !important; opacity:1 !important; }

        /* ── LINKED TASKS PANEL ── */
        .linked-panel {
          border-top:1px solid var(--border);
          padding:8px 14px 10px;
          background:rgba(110,168,254,0.02);
          display:flex; flex-direction:column; gap:3px;
        }
        .linked-header {
          display:flex; align-items:center; gap:5px;
          font-size:10px; color:var(--accent); text-transform:uppercase;
          letter-spacing:0.08em; font-weight:600; margin-bottom:6px; opacity:0.8;
        }
        .linked-header-icon { font-size:12px; }
        .linked-item {
          display:flex; align-items:center; gap:8px;
          padding:6px 8px; border-radius:7px;
          background:none; border:1px solid transparent; cursor:pointer;
          width:100%; text-align:left; font-family:inherit; transition:all 0.13s;
        }
        .linked-item:hover { background:var(--bg-chip); border-color:var(--border); }
        .linked-prio-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
        .linked-status-pill {
          font-size:9px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase;
          border:1px solid; border-radius:20px; padding:2px 7px; white-space:nowrap;
          flex-shrink:0;
        }
        .linked-text {
          flex:1; font-size:12px; color:var(--text2); white-space:nowrap;
          overflow:hidden; text-overflow:ellipsis; min-width:0;
        }
        .linked-text.done { text-decoration:line-through; color:var(--text5); }
        .linked-jump { font-size:11px; color:var(--text5); flex-shrink:0; transition:color 0.12s; }
        .linked-item:hover .linked-jump { color:var(--accent); }

        /* ── HIGHLIGHT FLASH ── */
        @keyframes highlightFlash {
          0%   { box-shadow:0 0 0 0 var(--accent-glow), 0 0 18px 4px var(--accent-glow); border-color:var(--accent); }
          60%  { box-shadow:0 0 0 4px var(--accent-glow); border-color:var(--accent); }
          100% { box-shadow:none; border-color:var(--border); }
        }
        .task-card.task-highlight {
          animation:highlightFlash 1.8s ease forwards !important;
        }

        /* followup-count-chip as button */
        .followup-count-chip {
          background:none; border:1px solid rgba(110,168,254,0.2); cursor:pointer;
          border-radius:20px; padding:1px 7px; color:var(--accent);
          font-family:inherit; font-size:10px; font-weight:600; letter-spacing:0.03em;
          flex-shrink:0; transition:all 0.13s; line-height:1.6;
        }
        .followup-count-chip:hover, .followup-count-chip.active {
          background:var(--accent-glow); border-color:rgba(110,168,254,0.4);
        }

        /* ── BULK SELECT ── */
        .bulk-bar {
          display:flex; align-items:center; gap:10px; padding:8px 36px;
          background:rgba(125,211,252,0.05); border-bottom:1px solid rgba(125,211,252,0.12);
          animation:fadeIn 0.15s ease;
        }
        .bulk-info { font-size:12px; color:var(--text3); flex:1; }
        .bulk-btn {
          background:var(--bg-chip); border:1px solid var(--border2); border-radius:6px;
          padding:5px 14px; color:var(--text3); font-family:inherit; font-size:12px;
          cursor:pointer; transition:all 0.15s;
        }
        .bulk-btn:hover { color:var(--text); border-color:var(--border3); }
        .bulk-btn.danger { color:#f87171; border-color:rgba(248,113,113,0.3); }
        .bulk-btn.danger:hover { background:rgba(248,113,113,0.08); }
        .bulk-btn:disabled { opacity:0.4; cursor:not-allowed; }
        .select-mode-btn { background:var(--bg-chip) !important; }
        .select-mode-btn.active { color:#7dd3fc !important; border-color:rgba(125,211,252,0.3) !important; }

        .task-checkbox {
          font-size:14px; color:var(--text4); flex-shrink:0;
          transition:color 0.12s; line-height:1;
        }
        .task-checkbox.checked { color:#7dd3fc; }
        .task-main-row.is-selected { background:rgba(125,211,252,0.06); border-radius:8px; }

        /* ── REMARK ── */
        .task-remark {
          padding:5px 16px 8px; font-size:11px; color:var(--text4);
          border-top:1px solid var(--border); line-height:1.5;
          min-height:28px; display:flex; align-items:center;
        }
        .remark-text {
          flex:1; font-style:italic; cursor:pointer; border-radius:4px;
          padding:2px 4px; transition:background 0.12s, color 0.12s;
          display:flex; align-items:center; gap:4px;
        }
        .remark-text:hover { background:var(--bg-chip); color:var(--text3); }
        .remark-icon { opacity:0.5; font-style:normal; }
        .remark-add-hint { color:var(--text5); font-style:italic; font-size:10px; opacity:0.6; }
        .remark-edit-input {
          flex:1; background:var(--bg-chip); border:1px solid #7dd3fc;
          border-radius:6px; padding:4px 10px; color:var(--text); font-family:inherit;
          font-size:11px; outline:none; transition:border-color 0.15s; width:100%;
        }
        .remark-edit-input::placeholder { color:var(--text5); }
        .remark-input {
          width:100%; background:var(--bg-chip); border:1px solid var(--border2);
          border-radius:8px; padding:10px 14px; color:var(--text); font-family:inherit;
          font-size:13px; outline:none; resize:vertical; transition:border-color 0.15s;
        }
        .remark-input:focus { border-color:#7dd3fc; }
        .remark-input::placeholder { color:var(--text5); }

        /* ── RECURRING DAY PICKER ── */
        .rec-item { flex-direction:column; align-items:stretch; gap:0; padding:0; }
        .rec-edit-block, .rec-view-block { flex:1; display:flex; flex-direction:column; gap:4px; padding:6px 8px; }
        .rec-toggle {
          background:none; border:none; cursor:pointer; font-size:11px;
          padding:6px 6px 0; flex-shrink:0; transition:color 0.12s; align-self:flex-start;
        }
        .rec-toggle.on  { color:#86efac; }
        .rec-toggle.off { color:var(--text5); }
        .rec-disabled { opacity:0.4; text-decoration:line-through; }
        .rec-day-picker {
          display:flex; gap:3px; margin-top:6px;
        }
        .rec-day-btn {
          width:22px; height:22px; border-radius:50%; border:1px solid var(--border2);
          background:var(--bg-chip2); color:var(--text4); font-size:9px; font-weight:700;
          cursor:pointer; transition:all 0.12s; padding:0; font-family:inherit;
        }
        .rec-day-btn.active { background:#7dd3fc; color:#0c1220; border-color:#7dd3fc; }
        .rec-days-display {
          display:flex; gap:3px; margin-top:3px;
        }
        .rec-day-dot {
          width:18px; height:18px; border-radius:50%; display:flex; align-items:center;
          justify-content:center; font-size:8px; font-weight:700;
          color:var(--text5); background:var(--bg-chip);
        }
        .rec-day-dot.active { color:#7dd3fc; background:rgba(125,211,252,0.12); }

        @media (max-width: 768px) {
          .bulk-bar { padding:8px 14px; }
        }
      `}</style>

      {/* ── END DAY MODAL ── */}
      {/* ── REMARK MODAL ── */}
      {remarkModal && (
        <div className="modal-backdrop" onClick={() => { setRemarkModal(null); }}>
          <div className="modal" style={{ maxWidth:420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">Mark as Done</div>
            <div className="modal-sub" style={{ marginBottom:16 }}>
              Add an optional closing remark — what happened, any notes, blockers resolved?
            </div>
            <textarea
              className="remark-input"
              placeholder="e.g. Approved by manager, sent at 3pm... (optional)"
              value={remarkText}
              onChange={e => setRemarkText(e.target.value)}
              rows={3}
              autoFocus
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) confirmRemark(); }}
            />
            <div style={{ display:"flex", gap:10, marginTop:14 }}>
              <button className="modal-confirm" style={{ flex:1 }} onClick={confirmRemark}>
                Mark Done
              </button>
              <button className="modal-cancel" style={{ flex:1 }} onClick={() => setRemarkModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

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

          {/* ── RECURRING TASKS ── */}
          <div className="section-label" style={{ marginTop:8 }}>Recurring Tasks</div>
          <button className="history-toggle" onClick={() => setShowRecurring(v => !v)}>
            {showRecurring ? "▾" : "▸"} Daily Templates ({recurring.length})
          </button>
          {showRecurring && (
            <div className="recurring-panel">
              {recurring.map(r => (
                <div key={r.id} className="rec-item">
                  {/* enabled toggle */}
                  <button
                    className={`rec-toggle ${r.enabled !== false ? "on" : "off"}`}
                    title={r.enabled !== false ? "Enabled" : "Disabled"}
                    onClick={() => {
                      const updated = { ...r, enabled: r.enabled === false ? true : false };
                      setRecurring(p => p.map(x => x.id === r.id ? updated : x));
                      upsertRecurring(updated, userId).catch(e => setError(e.message));
                    }}
                  >{r.enabled !== false ? "●" : "○"}</button>

                  {recEditId === r.id ? (
                    <div className="rec-edit-block">
                      <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                        <input
                          className="rec-edit-input"
                          value={recEditText}
                          onChange={e => setRecEditText(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") saveRecurringEdit(r.id); if (e.key === "Escape") setRecEditId(null); }}
                          autoFocus
                        />
                        <select className="rec-prio-sel" value={recEditPrio} onChange={e => setRecEditPrio(e.target.value)}>
                          {PRIORITY.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                        </select>
                        <button className="rec-action-btn save" onClick={() => saveRecurringEdit(r.id)}>✓</button>
                        <button className="rec-action-btn cancel" onClick={() => setRecEditId(null)}>✕</button>
                      </div>
                      <div className="rec-day-picker">
                        {['S','M','T','W','T','F','S'].map((d, i) => (
                          <button
                            key={i}
                            className={`rec-day-btn ${(recEditDays || r.days || [0,1,2,3,4,5,6]).includes(i) ? "active" : ""}`}
                            onClick={() => {
                              const cur = recEditDays || r.days || [0,1,2,3,4,5,6];
                              setRecEditDays(cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i].sort());
                            }}
                          >{d}</button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="rec-view-block">
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <span className="rec-dot" style={{ background: PRIORITY_MAP[r.priority]?.color || "#64748b" }} />
                        <span className={`rec-text ${r.enabled === false ? "rec-disabled" : ""}`}>{r.text}</span>
                        <button className="rec-action-btn edit" onClick={() => { setRecEditId(r.id); setRecEditText(r.text); setRecEditPrio(r.priority); setRecEditDays(r.days || [0,1,2,3,4,5,6]); }}>✎</button>
                        <button className="rec-action-btn del" onClick={() => removeRecurring(r.id)}>✕</button>
                      </div>
                      <div className="rec-days-display">
                        {['S','M','T','W','T','F','S'].map((d, i) => (
                          <span key={i} className={`rec-day-dot ${(r.days || [0,1,2,3,4,5,6]).includes(i) ? "active" : ""}`}>{d}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div className="rec-add-row">
                <input
                  className="rec-add-input"
                  placeholder="New daily task..."
                  value={recInput}
                  onChange={e => setRecInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addRecurring()}
                />
                <select className="rec-prio-sel" value={recPriority} onChange={e => setRecPriority(e.target.value)}>
                  {PRIORITY.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
                <button className="rec-action-btn save" onClick={addRecurring}>+</button>
              </div>
            </div>
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
                          editText={editText} setEditText={setEditText} commitEdit={commitEdit}
                          updateSubtasks={updateSubtasks} updateRemark={updateRemark}
                          createFollowUp={createFollowUp} allTasks={tasks}
                          scrollToTask={scrollToTask} highlightId={highlightId}
                          selectMode={selectMode} selected={selected} toggleSelect={toggleSelect} />
                      ))}
                    </div>
                  );
                })
              : visible.map((task, i) => (
                  <TaskCard key={task.id} task={task} i={i} readOnly={isReadOnly}
                    setStatus={setStatus} setPrio={setPrio}
                    confirmId={confirmId} setConfirmId={setConfirmId} del={del}
                    editId={editId} setEditId={setEditId}
                    editText={editText} setEditText={setEditText} commitEdit={commitEdit}
                    updateSubtasks={updateSubtasks} updateRemark={updateRemark}
                    createFollowUp={createFollowUp} allTasks={tasks}
                    scrollToTask={scrollToTask} highlightId={highlightId}
                          selectMode={selectMode} selected={selected} toggleSelect={toggleSelect} />
                ))
            }
          </div>
        </main>
      </div>
    </div>
  );
}

function TaskCard({ task, i, readOnly, setStatus, setPrio, confirmId, setConfirmId, del, editId, setEditId, editText, setEditText, commitEdit, updateSubtasks, updateRemark, createFollowUp, allTasks, scrollToTask, highlightId, selectMode, selected, toggleSelect }) {
  const s         = STATUS_MAP[task.status];
  const p         = PRIORITY_MAP[task.priority || "medium"];
  const isEditing = editId === task.id;
  const isConfirm = confirmId === task.id;
  const subtasks  = task.subtasks || [];
  const doneCount = subtasks.filter(s => s.done).length;

  const [showSubs, setShowSubs]               = useState(subtasks.length > 0);
  const [subInput, setSubInput]               = useState("");
  const [subEditId, setSubEditId]             = useState(null);
  const [subEditText, setSubEditText]         = useState("");
  const [editingRemark, setEditingRemark]     = useState(false);
  const [remarkDraft, setRemarkDraft]         = useState("");
  const [showFollowUp, setShowFollowUp]       = useState(false);
  const [followUpText, setFollowUpText]       = useState("");
  const [followUpPrio, setFollowUpPrio]       = useState(task.priority || "medium");
  const [showLinked, setShowLinked]           = useState(false);

  // Find parent task if this is a follow-up
  const parentTask  = task.followUpOf ? allTasks?.find(t => t.id === task.followUpOf) : null;
  // Find all child follow-up tasks
  const childTasks  = allTasks?.filter(t => t.followUpOf === task.id) || [];
  const isHighlight = highlightId === task.id;

  const addSubtask = () => {
    const text = subInput.trim();
    if (!text) return;
    const updated = [...subtasks, { id: `s${Date.now()}`, text, done: false, blocked: false }];
    updateSubtasks(task.id, updated);
    setSubInput("");
  };

  const toggleSubDone = (sid) => {
    const updated = subtasks.map(s => s.id === sid ? { ...s, done: !s.done, blocked: s.done ? s.blocked : false } : s);
    updateSubtasks(task.id, updated);
  };

  const toggleSubBlocked = (sid) => {
    const updated = subtasks.map(s => s.id === sid ? { ...s, blocked: !s.blocked, done: false } : s);
    updateSubtasks(task.id, updated);
  };

  const deleteSubtask = (sid) => {
    updateSubtasks(task.id, subtasks.filter(s => s.id !== sid));
  };

  const commitSubEdit = (sid) => {
    const text = subEditText.trim();
    if (!text) { setSubEditId(null); return; }
    updateSubtasks(task.id, subtasks.map(s => s.id === sid ? { ...s, text } : s));
    setSubEditId(null);
  };

  return (
    <div
      data-taskid={task.id}
      className={`task-card ${task.status === "done" ? "is-done" : ""} ${isConfirm ? "confirming" : ""} ${task.rolledFrom ? "rolled" : ""} ${isHighlight ? "task-highlight" : ""}`}
      style={{ animationDelay:`${i * 0.03}s` }}
    >
      {/* ── Main row ── */}
      <div className={`task-main-row ${selectMode && selected?.has(task.id) ? "is-selected" : ""}`}
        onClick={selectMode ? () => toggleSelect(task.id) : undefined}
        style={selectMode ? { cursor:"pointer" } : {}}
      >
        {selectMode && (
          <span className={`task-checkbox ${selected?.has(task.id) ? "checked" : ""}`}>
            {selected?.has(task.id) ? "■" : "□"}
          </span>
        )}
        <select
          className="status-pill"
          value={task.status}
          disabled={readOnly}
          style={{ background:s.bg, color:s.color, borderColor:s.border }}
          onChange={e => setStatus(task.id, e.target.value)}
        >
          {STATUSES.map(st => <option key={st.key} value={st.key}>{st.label}</option>)}
        </select>

        {task.rolledFrom && (
          <span className="rolled-tag" title={`Rolled from ${task.rolledFrom}`}>↩</span>
        )}

        {isEditing ? (
          <input
            className="edit-in" autoFocus value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commitEdit(task.id); if (e.key === "Escape") setEditId(null); }}
            onBlur={() => commitEdit(task.id)}
          />
        ) : (
          <span className="task-text-wrap">
            <button
              className="prio-dot"
              style={{ background: p.color }}
              disabled={readOnly}
              title={`Priority: ${p.label} — click to change`}
              onClick={() => {
                const order = ["high","medium","low"];
                const next = order[(order.indexOf(task.priority || "medium") + 1) % 3];
                setPrio(task.id, next);
              }}
            />
            <span
              className={`task-text ${task.status === "done" ? "done" : ""}`}
              onDoubleClick={() => { if (!readOnly) { setEditId(task.id); setEditText(task.text); } }}
            >
              {task.followUpOf && parentTask && (
                <button
                  className="parent-link-badge"
                  title={`Follow-up of: ${parentTask.text} — click to jump`}
                  onClick={e => { e.stopPropagation(); scrollToTask(parentTask.id); }}
                >↳</button>
              )}
              {task.text}
            </span>
          </span>
        )}

        {/* Subtask progress chip */}
        {subtasks.length > 0 && (
          <button className="sub-progress-chip" onClick={() => setShowSubs(v => !v)}>
            <span className="sub-progress-fill" style={{ width:`${(doneCount/subtasks.length)*100}%` }} />
            <span className="sub-progress-label">{doneCount}/{subtasks.length}</span>
          </button>
        )}

        {isConfirm ? (
          <div className="confirm-row">
            <span className="confirm-label">Delete?</span>
            <button className="confirm-yes" onClick={() => del(task.id)}>Yes</button>
            <button className="confirm-no"  onClick={() => setConfirmId(null)}>No</button>
          </div>
        ) : (
          <>
            {childTasks.length > 0 && (
              <button
                className={`followup-count-chip ${showLinked ? "active" : ""}`}
                title={`${childTasks.length} follow-up task${childTasks.length > 1 ? "s" : ""} — click to view`}
                onClick={() => setShowLinked(v => !v)}
              >
                ↳{childTasks.length}
              </button>
            )}
            {!readOnly && (
              <button
                className={`icon-btn sub-toggle-btn ${showFollowUp ? "active-followup" : ""}`}
                title="Create follow-up task"
                onClick={() => { setShowFollowUp(v => !v); setFollowUpText(""); }}
              >↳</button>
            )}
            {!readOnly && (
              <button className="icon-btn sub-toggle-btn" title="Subtasks" onClick={() => setShowSubs(v => !v)}>
                {showSubs ? "⌃" : "⌄"}
              </button>
            )}
            <button className="icon-btn" disabled={readOnly} onClick={() => { setEditId(task.id); setEditText(task.text); }}>✎</button>
            <button className="icon-btn del" disabled={readOnly} onClick={() => setConfirmId(task.id)}>✕</button>
          </>
        )}
      </div>

      {/* ── Remark ── */}
      {task.status === "done" && (
        <div className="task-remark">
          {editingRemark ? (
            <div style={{ display:"flex", gap:6, alignItems:"center", padding:"0 2px" }}>
              <input
                className="remark-edit-input"
                autoFocus
                value={remarkDraft}
                placeholder="Add a remark... (optional)"
                onChange={e => setRemarkDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    updateRemark(task.id, remarkDraft.trim() || null);
                    setEditingRemark(false);
                  }
                  if (e.key === "Escape") setEditingRemark(false);
                }}
                onBlur={() => {
                  updateRemark(task.id, remarkDraft.trim() || null);
                  setEditingRemark(false);
                }}
              />
            </div>
          ) : (
            <span
              className="remark-text"
              title={readOnly ? undefined : "Click to edit remark"}
              onClick={() => { if (!readOnly) { setRemarkDraft(task.remark || ""); setEditingRemark(true); } }}
            >
              {task.remark
                ? <><span className="remark-icon">✎</span> {task.remark}</>
                : !readOnly && <span className="remark-add-hint">+ add remark</span>
              }
            </span>
          )}
        </div>
      )}

      {/* ── Linked tasks (child follow-ups list) ── */}
      {showLinked && childTasks.length > 0 && (
        <div className="linked-panel">
          <div className="linked-header">
            <span className="linked-header-icon">↳</span>
            <span>Follow-up tasks</span>
          </div>
          {childTasks.map(child => {
            const cs = STATUS_MAP[child.status];
            const cp = PRIORITY_MAP[child.priority || "medium"];
            return (
              <button
                key={child.id}
                className="linked-item"
                onClick={() => scrollToTask(child.id)}
                title="Jump to this task"
              >
                <span className="linked-prio-dot" style={{ background: cp.color }} />
                <span className="linked-status-pill" style={{ color: cs.color, borderColor: cs.border, background: cs.bg }}>
                  {cs.label}
                </span>
                <span className={`linked-text ${child.status === "done" ? "done" : ""}`}>{child.text}</span>
                <span className="linked-jump">→</span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Follow-up panel ── */}
      {showFollowUp && !readOnly && (
        <div className="followup-panel">
          <div className="followup-header">
            <span className="followup-header-icon">↳</span>
            <span className="followup-header-label">New follow-up task</span>
          </div>
          <div className="followup-input-row">
            <input
              className="followup-input"
              autoFocus
              placeholder={`e.g. Follow up on "${task.text.slice(0, 30)}${task.text.length > 30 ? "…" : ""}"`}
              value={followUpText}
              onChange={e => setFollowUpText(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && followUpText.trim()) {
                  createFollowUp(task.id, followUpText, followUpPrio);
                  setShowFollowUp(false);
                  setFollowUpText("");
                }
                if (e.key === "Escape") { setShowFollowUp(false); setFollowUpText(""); }
              }}
            />
            <select
              className="rec-prio-sel"
              value={followUpPrio}
              onChange={e => setFollowUpPrio(e.target.value)}
              style={{ color: PRIORITY_MAP[followUpPrio]?.color }}
            >
              {PRIORITY.map(p => <option key={p.key} value={p.key} style={{ color:p.color }}>{p.label}</option>)}
            </select>
            <button
              className="followup-add-btn"
              disabled={!followUpText.trim()}
              onClick={() => {
                createFollowUp(task.id, followUpText, followUpPrio);
                setShowFollowUp(false);
                setFollowUpText("");
              }}
            >Add</button>
            <button className="sub-action" style={{ color:"var(--text4)" }} onClick={() => { setShowFollowUp(false); setFollowUpText(""); }}>✕</button>
          </div>
        </div>
      )}

      {/* ── Subtasks panel ── */}
      {showSubs && (
        <div className="subtask-panel">
          {subtasks.map(sub => (
            <div key={sub.id} className={`subtask-row ${sub.done ? "sub-done" : ""} ${sub.blocked ? "sub-blocked" : ""}`}>
              <button
                className={`sub-check ${sub.done ? "checked" : ""}`}
                disabled={readOnly}
                onClick={() => toggleSubDone(sub.id)}
                title="Mark done"
              >
                {sub.done ? "●" : "○"}
              </button>
              {subEditId === sub.id ? (
                <input
                  className="sub-edit-input" autoFocus
                  value={subEditText}
                  onChange={e => setSubEditText(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") commitSubEdit(sub.id); if (e.key === "Escape") setSubEditId(null); }}
                  onBlur={() => commitSubEdit(sub.id)}
                />
              ) : (
                <span className="sub-text" onDoubleClick={() => { if (!readOnly) { setSubEditId(sub.id); setSubEditText(sub.text); } }}>
                  {sub.text}
                </span>
              )}
              {!readOnly && (
                <div className="sub-actions">
                  <button
                    className={`sub-action ${sub.blocked ? "is-blocked" : ""}`}
                    onClick={() => toggleSubBlocked(sub.id)}
                    title={sub.blocked ? "Unblock" : "Mark blocked"}
                  >✕</button>
                  <button className="sub-action" onClick={() => { setSubEditId(sub.id); setSubEditText(sub.text); }} title="Edit">✎</button>
                  <button className="sub-action del" onClick={() => deleteSubtask(sub.id)} title="Delete">🗑</button>
                </div>
              )}
            </div>
          ))}
          {!readOnly && (
            <div className="sub-add-row">
              <span className="sub-add-icon">+</span>
              <input
                className="sub-add-input"
                placeholder="Add a subtask..."
                value={subInput}
                onChange={e => setSubInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addSubtask()}
              />
              {subInput && (
                <button className="sub-action" style={{ color:"#86efac" }} onClick={addSubtask}>↵</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
