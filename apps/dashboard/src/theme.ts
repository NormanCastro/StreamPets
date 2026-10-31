export const THEMES = [
  { id: "morado", label: "Morado", color: "#a855f7" },
  { id: "verde", label: "Verde", color: "#22c55e" },
  { id: "azul", label: "Azul", color: "#3b82f6" },
  { id: "rojo", label: "Rojo", color: "#ef4444" },
  { id: "dorado", label: "Dorado", color: "#f5b301" },
  { id: "rosado", label: "Rosado", color: "#ec4899" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const DEFAULT_THEME: ThemeId = "morado";
const KEY = "streampets.theme";

export function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

/** Color guardado en este navegador (morado si no hay o el almacenamiento no está disponible). */
export function loadTheme(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    return isThemeId(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset["theme"] = id;
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (meta && bg) meta.setAttribute("content", bg);
}

export function saveTheme(id: ThemeId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* sin almacenamiento: el color vale hasta recargar */
  }
}
