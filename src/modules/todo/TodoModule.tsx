import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { isOverdue, useTodo, type Priority, type Task } from "../../store/todo";
import { moduleBackground, useModuleWindow, useSettings } from "../../store/settings";
import { dragHandle } from "../../lib/drag";
import { useHitRegion } from "../../lib/hitRegion";

type StatusFilter = "all" | "open" | "done";

interface EditPatch {
  text: string;
  category: string;
  priority: Priority;
  due?: string;
}

export function TodoModule() {
  const { tasks, add, toggle, remove, clearDone, edit } = useTodo();
  const categories = useSettings((s) => s.settings.todo.categories);
  const sortMode = useSettings((s) => s.settings.todo.sort);
  const defaultPriority = useSettings((s) => s.settings.todo.defaultPriority);
  const draggable = useSettings((s) => s.settings.todo.win.draggable);
  const bgTransparency = useSettings((s) => s.settings.todo.bgTransparency);

  // `user-select: none` stops a selection from starting on the card, but a drag
  // that begins in the search field can still run into the list, and pressing
  // plain text afterwards does not collapse that range. Clear it on press so a
  // stray selection never stays stuck over the widget.
  const clearSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']"))
      return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  };
  useModuleWindow("todo");
  useHitRegion(".todo-root", 15, 6);

  const [text, setText] = useState("");
  const [category, setCategory] = useState(categories[0] ?? "");
  const [priority, setPriority] = useState<Priority>(defaultPriority);
  const [due, setDue] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  // Settings can remove a category while the widget is open.
  useEffect(() => {
    if (!categories.includes(category)) setCategory(categories[0] ?? "");
  }, [categories, category]);

  useEffect(() => {
    if (categoryFilter !== "all" && !categories.includes(categoryFilter)) setCategoryFilter("all");
  }, [categories, categoryFilter]);

  const visible = useMemo(() => {
    const byCategory =
      categoryFilter === "all" ? tasks : tasks.filter((t) => t.category === categoryFilter);
    const byStatus = byCategory.filter((t) =>
      status === "all" ? true : status === "done" ? t.done : !t.done,
    );
    const q = query.trim().toLowerCase();
    const byQuery = !q
      ? byStatus
      : byStatus.filter(
          (t) => t.text.toLowerCase().includes(q) || t.category.toLowerCase().includes(q),
        );
    if (sortMode === "created") {
      return [...byQuery].sort(
        (a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt,
      );
    }
    // "smart": the store already keeps priority / due-date order.
    return byQuery;
  }, [tasks, categoryFilter, status, query, sortMode]);

  const openCount = tasks.filter((t) => !t.done).length;
  const doneCount = tasks.length - openCount;

  const submit = () => {
    add(text, category, priority, due || undefined);
    setText("");
    setDue("");
    setPriority(defaultPriority);
  };

  return (
    <div
      className="todo-root"
      style={moduleBackground(bgTransparency)}
      onPointerDown={clearSelection}
      onPointerUp={clearSelection}
    >
      <div
        className="todo-head"
        onPointerDown={draggable ? dragHandle : undefined}
        title={draggable ? "Drag to move" : undefined}
      >
        <strong>To-Do</strong>
        <span className="todo-meta">
          {openCount} open · {doneCount} done
        </span>
      </div>

      <div className="todo-filters">
        {(
          [
            ["all", "All"],
            ["open", "Open"],
            ["done", "Done"],
          ] as [StatusFilter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`todo-filter${status === key ? " active" : ""}`}
            onClick={() => setStatus(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="todo-filters">
        {["all", ...categories].map((c) => (
          <button
            key={c}
            className={`todo-filter${categoryFilter === c ? " active" : ""}`}
            onClick={() => setCategoryFilter(c)}
          >
            {c === "all" ? "All categories" : c}
          </button>
        ))}
      </div>

      <input
        type="search"
        className="todo-search"
        placeholder="Search tasks…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="todo-list">
        {visible.length === 0 && (
          <div className="todo-empty">
            {query.trim() ? `No tasks match “${query.trim()}”.` : "Nothing here."}
          </div>
        )}
        {visible.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            categories={categories}
            onToggle={toggle}
            onRemove={remove}
            onSave={edit}
          />
        ))}
      </div>

      <div className="todo-add">
        <input
          type="text"
          placeholder="Add a task…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} title="Category">
          {categories.length === 0 && <option value="">Uncategorised</option>}
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
          title="Priority"
        >
          <option value="low">Low</option>
          <option value="medium">Med</option>
          <option value="high">High</option>
        </select>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} title="Due date" />
        <button onClick={submit} aria-label="Add task">
          +
        </button>
      </div>
      {doneCount > 0 && (
        <button className="todo-clear" onClick={clearDone}>
          Clear {doneCount} done
        </button>
      )}
    </div>
  );
}

function TaskRow({
  task,
  categories,
  onToggle,
  onRemove,
  onSave,
}: {
  task: Task;
  categories: string[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onSave: (id: string, patch: EditPatch) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.text);
  const [category, setCategory] = useState(task.category);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [due, setDue] = useState(task.due ?? "");

  const begin = () => {
    setText(task.text);
    setCategory(task.category);
    setPriority(task.priority);
    setDue(task.due ?? "");
    setEditing(true);
  };

  const save = () => {
    const next = text.trim();
    if (!next) return;
    onSave(task.id, { text: next, category, priority, due: due || undefined });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="todo-row editing">
        <input
          type="text"
          autoFocus
          value={text}
          aria-label="Task text"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            else if (e.key === "Escape") setEditing(false);
          }}
        />
        <select value={category} aria-label="Category" onChange={(e) => setCategory(e.target.value)}>
          {categories.length === 0 && <option value="">Uncategorised</option>}
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          value={priority}
          aria-label="Priority"
          onChange={(e) => setPriority(e.target.value as Priority)}
        >
          <option value="low">Low</option>
          <option value="medium">Med</option>
          <option value="high">High</option>
        </select>
        <input type="date" value={due} aria-label="Due date" onChange={(e) => setDue(e.target.value)} />
        <button onClick={save}>Save</button>
        <button onClick={() => setEditing(false)}>Cancel</button>
      </div>
    );
  }

  return (
    <div className={`todo-row${task.done ? " done" : ""}`}>
      <input
        type="checkbox"
        className="todo-check"
        checked={task.done}
        onChange={() => onToggle(task.id)}
        aria-label={task.done ? "Mark undone" : "Mark done"}
      />
      <span className="todo-text" title="Double-click to edit" onDoubleClick={begin}>
        {task.text}
      </span>
      <span className="todo-meta">
        {task.due && (
          <span className={`todo-pill${isOverdue(task) ? " overdue" : ""}`} title="Due date">
            {isOverdue(task) ? "overdue " : ""}
            {task.due}
          </span>
        )}
        <span className={`todo-pill ${task.priority}`}>{task.priority}</span>
        <span className="todo-pill">{task.category}</span>
      </span>
      <button className="todo-edit" aria-label="Edit task" onClick={begin}>
        ✎
      </button>
      <button className="todo-delete" aria-label="Delete task" onClick={() => onRemove(task.id)}>
        ✕
      </button>
    </div>
  );
}
