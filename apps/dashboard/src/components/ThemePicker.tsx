import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { THEMES, applyTheme, loadTheme, saveTheme } from "../theme";
import type { ThemeId } from "../theme";

/** Botón de color que abre los colores disponibles. La elección se guarda en este navegador. */
export function ThemePicker({ floating = false }: { floating?: boolean }) {
  const [current, setCurrent] = useState<ThemeId>(loadTheme);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  function pick(id: ThemeId) {
    setCurrent(id);
    applyTheme(id);
    saveTheme(id);
    setOpen(false);
  }

  const now = THEMES.find((t) => t.id === current) ?? THEMES[0];
  return (
    <div className={floating ? "themes floating" : "themes"} ref={box}>
      <button
        type="button"
        className="swatch toggle"
        style={{ "--sw": now.color } as CSSProperties}
        aria-label="Cambiar color del panel"
        aria-haspopup="true"
        aria-expanded={open}
        title="Color del panel"
        onClick={() => setOpen(!open)}
      />
      {open && (
        <div className="theme-pop" role="group" aria-label="Color del panel">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className="swatch"
              style={{ "--sw": t.color } as CSSProperties}
              aria-label={`Color ${t.label.toLowerCase()}`}
              title={t.label}
              aria-pressed={current === t.id}
              onClick={() => pick(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
