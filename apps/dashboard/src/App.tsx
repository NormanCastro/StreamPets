import { useCallback, useEffect, useState } from "react";
import { api, currentToken, describeError, setToken, setUnauthorizedHandler } from "./api";
import type { Species } from "./api";
import { Login } from "./components/Login";
import { Logo } from "./components/Logo";
import { OverlaysPanel } from "./components/OverlaysPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ViewersPanel } from "./components/ViewersPanel";

type Tab = "viewers" | "settings" | "overlays";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "viewers", label: "Mascotas" },
  { id: "settings", label: "Ajustes" },
  { id: "overlays", label: "Overlay para OBS" },
];

export function App() {
  const [authed, setAuthed] = useState(() => currentToken() !== null);
  const [tab, setTab] = useState<Tab>("viewers");
  const [species, setSpecies] = useState<Species[]>([]);
  const [loadError, setLoadError] = useState("");

  const logout = useCallback(() => {
    setToken(null);
    setAuthed(false);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    api
      .species()
      .then((s) => {
        if (cancelled) return;
        setSpecies(s.species);
        setLoadError("");
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);

  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="brand">
          <Logo />
          StreamPets
        </h1>
        <nav role="tablist" aria-label="Secciones">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button className="ghost" onClick={logout}>
          Salir
        </button>
      </header>
      <main>
        {loadError && <p className="error" role="alert">{loadError}</p>}
        {tab === "viewers" && <ViewersPanel species={species} />}
        {tab === "settings" && <SettingsPanel species={species} />}
        {tab === "overlays" && <OverlaysPanel />}
      </main>
    </div>
  );
}
