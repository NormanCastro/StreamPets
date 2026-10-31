import { useCallback, useEffect, useState } from "react";
import { api, describeError, setToken, setUnauthorizedHandler } from "./api";
import type { Me, Species } from "./api";
import { ChannelsPanel } from "./components/ChannelsPanel";
import { Login, loginErrorMessage } from "./components/Login";
import { Logo } from "./components/Logo";
import { ThemePicker } from "./components/ThemePicker";
import { OverlaysPanel } from "./components/OverlaysPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ViewersPanel } from "./components/ViewersPanel";

type Tab = "viewers" | "settings" | "overlays" | "channels";
const BASE_TABS: Array<{ id: Tab; label: string }> = [
  { id: "viewers", label: "Mascotas" },
  { id: "settings", label: "Ajustes" },
  { id: "overlays", label: "Overlay para OBS" },
];

/** Si volvemos de Twitch con un error, lo leemos una vez y limpiamos la dirección. */
function takeLoginError(): string {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("login_error");
    if (code === null) return "";
    url.searchParams.delete("login_error");
    window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
    return loginErrorMessage(code);
  } catch {
    return "";
  }
}

export function App() {
  // undefined = comprobando si ya hay sesión (cookie de Twitch o clave guardada); null = sin sesión.
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [notice] = useState(takeLoginError);
  const [tab, setTab] = useState<Tab>("viewers");
  const [species, setSpecies] = useState<Species[]>([]);
  const [loadError, setLoadError] = useState("");

  const signedOut = useCallback(() => {
    setToken(null);
    setMe(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(signedOut);
  }, [signedOut]);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const authed = me !== null && me !== undefined;
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

  async function logout() {
    try {
      await api.logout(); // cierra la sesión de Twitch en el servidor (con la clave no hay nada que cerrar)
    } catch {
      /* igual se sale de este navegador */
    }
    signedOut();
    setTab("viewers");
  }

  if (me === undefined) return <div className="login"><p className="muted">Cargando…</p></div>;
  if (me === null) return <Login onLogin={() => void loadMe()} {...(notice ? { notice } : {})} />;

  const tabs = me.role === "admin" ? [...BASE_TABS, { id: "channels" as const, label: "Canales" }] : BASE_TABS;
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "viewers";

  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="brand">
          <Logo />
        </h1>
        <nav role="tablist" aria-label="Secciones">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              className={activeTab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <ThemePicker />
        {me.streamer && (
          <span className="who" title={me.role === "admin" ? "Administración" : "Sesión de Twitch"}>
            @{me.streamer.login}
            {me.role === "streamer" && me.plan === "premium" && <span className="pill sub">PREMIUM</span>}
          </span>
        )}
        <button className="ghost" onClick={() => void logout()}>
          Salir
        </button>
      </header>
      <main>
        {loadError && <p className="error" role="alert">{loadError}</p>}
        {activeTab === "viewers" && <ViewersPanel species={species} />}
        {activeTab === "settings" && <SettingsPanel species={species} />}
        {activeTab === "overlays" && <OverlaysPanel />}
        {activeTab === "channels" && me.role === "admin" && <ChannelsPanel species={species} />}
      </main>
    </div>
  );
}
