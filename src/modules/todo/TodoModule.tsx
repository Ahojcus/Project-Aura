import { useMemo, useState } from "react";
import { useTodo, isOverdue } from "../../store/todo";
import type { Priority, Task } from "../../store/todo";
import { useSettings, useModuleWindow } from "../../store/settings";
import { dragHandle } from "../../lib/drag";

const DUE_MS = { high: "var(--danger)", medium: "var(--warn)", low: "var(--ok)" } as const;

export function TodoModule() {
  const { tasks, add, toggle, remove, clearDone } = useTodo();
  const categories = useSettings((s) => s.settings.todo.categories);
  const sortMode = useSettings((s) => s.settings.todo.sort);
  const draggable = useSettings((s) => s.settings.todo.win.draggable);
  const winStyle = useModuleWindow("todo");
  const noBg = !useSettings((s) => s.settings.todo.background);
  const [text, setText] = useState("");
  const [category, setCategory] = useState(categories[0] ?? "Personal");
  const [priority, setPriority] = useState<Priority>("medium");
  const [due, setDue] = useState("");
  const [filter, setFilter] = useState<string>("all");

  const visible = useMemo(() => {
    const list = filter === "all" ? tasks : tasks.filter((t) => t.category === filter);
    if (sortMode === "created") {
      // Newest first; finished tasks sink to the bottom of the list.
      return [...list].sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
    }
    // "smart": the store already sorts by priority / due date.
    return list;
  }, [tasks, filter, sortMode]);
  const openCount = tasks.filter((t) => !t.done).length;

  return (
    <div className={`widget glass${noBg ? " no-bg" : ""}`} style={winStyle}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: draggable ? "grab" : undefined }}
        {...(draggable ? { onPointerDown: dragHandle } : undefined)}
        title={draggable ? "Drag to move the widget" : undefined}
      >
        <div style={{ fontWeight: 600, fontSize: 14 }}>To-Do</div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>{openCount} open</div>
      </div>

      <div className="todo-filters" style={{ marginTop: 8 }}>
        {["all", ...categories].map((c) => (
          <button key={c} className={`chip ${filter === c ? "active" : ""}`} onClick={() => setFilter(c)}>
            {c === "all" ? "All" : c}
          </button>
        ))}
      </div>

      <div className="todo-list">
        {visible.length === 0 && (
          <div className="todo-empty">Nothing here.</div>
        )}
        {visible.map((t) => (
          <TaskRow key={t.id} task={t} onToggle={toggle} onRemove={remove} />
        ))}
      </div>

      <div className="todo-add">
        <input
          placeholder="Add a task…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              add(text, category, priority, due || undefined);
              setText("");
              setDue("");
            }
          }}
        />
        <select className="mini" value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select className="mini" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
          <option value="low">Low</option>
          <option value="medium">Med</option>
          <option value="high">High</option>
        </select>
        <input
          type="date"
          className="mini"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          title="Due date"
        />
        <button
          className="todo-add-btn"
          aria-label="Add task"
          onClick={() => {
            add(text, category, priority, due || undefined);
            setText("");
            setDue("");
          }}
        >
          <svg viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4} fill="none" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      {tasks.some((t) => t.done) && (
        <button className="todo-clear" onClick={clearDone}>
          Clear {tasks.filter((t) => t.done).length} done
        </button>
      )}
    </div>
  );
}

function TaskRow({
  task,
  onToggle,
  onRemove,
}: {
  task: Task;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className={`todo-row ${task.done ? "done" : ""}`}>
      <button
        className={`todo-check ${task.done ? "checked" : ""}`}
        aria-label={task.done ? "Mark undone" : "Mark done"}
        onClick={() => onToggle(task.id)}
      />
      <span className="todo-text">{task.text}</span>
      <span className="todo-meta">
        {task.due && (
          <span className={`pill due ${isOverdue(task) ? "overdue" : ""}`}>
            {isOverdue(task) ? "!! " : "~ "}
            {task.due.slice(5)}
          </span>
        )}
        <span className={`pill ${task.priority}`}>{task.priority}</span>
        <span className="pill">{task.category}</span>
      </span>
      <button className="todo-del" aria-label="Delete" onClick={() => onRemove(task.id)}>
        ✕
      </button>
    </div>
  );
}

export { DUE_MS };
