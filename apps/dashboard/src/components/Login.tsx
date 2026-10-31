import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { LogoFull } from "./Logo";
import { ThemePicker } from "./ThemePicker";
import { api, describeError, setToken } from "../api";

const LOGIN_ERRORS: Record<string, string> = {
  denied: "Cancelaste el acceso en Twitch.",
  state: "El inicio de sesión expiró o se interrumpió. Inténtalo de nuevo.",
  twitch: "Twitch no pudo confirmar tu cuenta. Inténtalo de nuevo en un momento.",
  not_allowed: "Tu canal todavía no está autorizado. Pídele acceso a quien administra StreamPets.",
  conflict: "Hay un problema con el nombre de tu cuenta. Avisa a quien administra StreamPets.",
  disabled: "El acceso con Twitch aún no está disponible.",
};

export function loginErrorMessage(code: string | null): string {
  if (!code) return "";
  return LOGIN_ERRORS[code] ?? "No se pudo iniciar sesión.";
}

export function Login({ onLogin, notice }: { onLogin: () => void; notice?: string }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [twitch, setTwitch] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .authStatus()
      .then((s) => !cancelled && setTwitch(s.twitch))
      .catch(() => !cancelled && setTwitch(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError("");
    setToken(token);
    try {
      await api.me();
      onLogin();
    } catch (err) {
      setToken(null);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <ThemePicker floating />
      <div className="login-box">
        <LogoFull />
        <div className="card login-card">
          <h1 className="sr-only">StreamPets</h1>
          <p className="muted center">Panel de tu canal</p>
          {notice && <p className="error" role="alert">{notice}</p>}

          {twitch ? (
            <a className="btn twitch" href="/auth/twitch/login">
              Entrar con Twitch
            </a>
          ) : (
            <p className="muted center small">
              {twitch === null ? "Cargando…" : "El acceso con Twitch aún no está configurado en este servidor."}
            </p>
          )}

          <div className="divider" role="separator">
            <span>o con la clave de administración</span>
          </div>

          <form onSubmit={(e) => void submit(e)} className="login-key">
            <label>
              Clave de administración
              <input
                type="password"
                autoComplete="current-password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button type="submit" className="ghost" disabled={busy || value.trim() === ""}>
              {busy ? "Entrando…" : "Entrar"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
