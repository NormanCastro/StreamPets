import { useState } from "react";
import type { FormEvent } from "react";
import { Logo } from "./Logo";
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
      <form onSubmit={(e) => void submit(e)} className="card">
        <h1 className="brand">
          <Logo />
          StreamPets
        </h1>
        <p className="muted">Panel de administración</p>
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
  );
}
