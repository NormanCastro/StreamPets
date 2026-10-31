import { useCallback, useEffect, useState } from "react";
import { api, describeError, setToken, setUnauthorizedHandler } from "./api";
import type { Me, Species } from "./api";
import { ChannelsPanel } from "./components/ChannelsPanel";
import { ModerationPanel } from "./components/ModerationPanel";
import { MyPetsPanel } from "./components/MyPetsPanel";
import { Login, loginErrorMessage } from "./components/Login";
import { Logo } from "./components/Logo";
import { ThemePicker } from "./components/ThemePicker";
import { DEFAULT_THEME, applyTheme, loadTheme } from "./theme";
import { OverlaysPanel } from "./components/OverlaysPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { ViewersPanel } from "./components/ViewersPanel";

/** Primera letra en mayúscula (Twitch entrega el usuario en minúsculas). */
function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

type Tab = "viewers" | "settings" | "overlays" | "channels" | "mypets" | "moderation";
const BASE_TABS: Array<{ id: Tab; label: string }> = [
  { id: "viewers", label: "Mascotas" },
  { id: "settings", label: "Ajustes" },
  { id: "overlays", label: "Overlay para OBS" },
  { id: "mypets", label: "Mis pets" },
];
const MODERATION_TAB = { id: "moderation" as Tab, label: "Moderación" };

const ADMIN_TABS: Array<{ id: Tab; label: string }> = [{ id: "channels", label: "Canales" }, MODERATION_TAB];

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

  // El color elegido solo vale para las sesiones de streamer; la entrada y el panel de administración son siempre morados.
  const role = me?.role;
  useEffect(() => {
    if (me === undefined) return; // aún se está comprobando la sesión
    applyTheme(role === "streamer" ? loadTheme() : DEFAULT_THEME);
  }, [me, role]);

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

  // El administrador solo gestiona canales: las mascotas, ajustes y enlaces de OBS son de cada streamer
  // (el tuyo lo manejas entrando con Twitch).
  const tabs = me.role === "admin" ? ADMIN_TABS : me.moderator ? [...BASE_TABS, MODERATION_TAB] : BASE_TABS;
  const activeTab = tabs.some((t) => t.id === tab) ? tab : (tabs[0] as { id: Tab }).id;

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
        {me.role === "streamer" && <ThemePicker />}
        {me.streamer && (
          <span className="who" title={me.role === "admin" ? "Administración" : "Sesión de Twitch"}>
            {me.role === "admin" ? "Admin" : capitalize(me.streamer.login)}
            {me.role === "streamer" && me.plan === "premium" && (
              <span className="star" role="img" aria-label="Plan premium" title="Plan premium">
                ⭐
              </span>
            )}
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
        {activeTab === "mypets" && me.role === "streamer" && <MyPetsPanel />}
        {activeTab === "moderation" && me.moderator && <ModerationPanel />}
      </main>
    </div>
  );
}
