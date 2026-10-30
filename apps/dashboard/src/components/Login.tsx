import { useState } from "react";
import type { FormEvent } from "react";
import { LogoFull } from "./Logo";
import { api, describeError, setToken } from "../api";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      <div className="login-box">
        <LogoFull />
        <form onSubmit={(e) => void submit(e)} className="card">
          <h1 className="sr-only">StreamPets</h1>
          <p className="muted center">Panel de administración</p>
          <label>
            Clave de administración
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" disabled={busy || value.trim() === ""}>
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>
      </div>
    </div>
  );
}
