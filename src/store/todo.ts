import { create } from "zustand";

export type Priority = "low" | "medium" | "high";

export interface Task {
  id: string;
  text: string;
  category: string;
  priority: Priority;
  due?: string; // yyyy-mm-dd
  done: boolean;
  createdAt: number;
}

const STORAGE_KEY = "aura.todo.v1";

function load(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Task[];
  } catch {
    /* ignore */
  }
  return [];
}

function persist(tasks: Task[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    /* ignore */
  }
}

function sortTasks(tasks: Task[]): Task[] {
  const rank: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.due && b.due) return a.due < b.due ? -1 : 1;
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return rank[a.priority] - rank[b.priority] || b.createdAt - a.createdAt;
  });
}

interface TodoStore {
  tasks: Task[];
  add: (text: string, category: string, priority: Priority, due?: string) => void;
  toggle: (id: string) => void;
  remove: (id: string) => void;
  clearDone: () => void;
}

export const useTodo = create<TodoStore>()((set, get) => ({
  tasks: load(),
  add: (text, category, priority, due) => {
    const t = text.trim();
    if (!t) return;
    const task: Task = {
      id: crypto.randomUUID(),
      text: t,
      category,
      priority,
      due,
      done: false,
      createdAt: Date.now(),
    };
    const tasks = sortTasks([task, ...get().tasks]);
    set({ tasks });
    persist(tasks);
  },
  toggle: (id) => {
    const tasks = sortTasks(
      get().tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    );
    set({ tasks });
    persist(tasks);
  },
  remove: (id) => {
    const tasks = get().tasks.filter((t) => t.id !== id);
    set({ tasks });
    persist(tasks);
  },
  clearDone: () => {
    const tasks = sortTasks(get().tasks.filter((t) => !t.done));
    set({ tasks });
    persist(tasks);
  },
}));

export function isOverdue(task: Task): boolean {
  if (!task.due || task.done) return false;
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  return task.due < `${y}-${m}-${d}`;
}
