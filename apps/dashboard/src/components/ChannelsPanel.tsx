import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "../api";
import type { ChannelItem } from "../api";

/** Quién puede entrar con Twitch. Solo lo ve quien administra. */
export function ChannelsPanel() {
  const [items, setItems] = useState<ChannelItem[]>([]);
  const [login, setLogin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api.channels()).items);
      setLoaded(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const clean = login.trim().replace(/^@/, "").toLowerCase();
  const valid = /^[a-z0-9_]{1,25}$/.test(clean);

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    void run(async () => {
      await api.addChannel(clean);
      setLogin("");
    });
  };

  const remove = (c: ChannelItem) => {
    if (
      !window.confirm(
        `¿Quitar a @${c.login}? Se cierra su sesión y dejamos de leer su chat. Sus enlaces de OBS ya creados seguirán funcionando.`,
      )
    )
      return;
    void run(() => api.removeChannel(c.login));
  };

  return (
    <section>
      <p className="muted">
        Solo los canales de esta lista pueden entrar con Twitch. Escribe el usuario de Twitch de quien quieras invitar; cada persona
        administra sus propias mascotas y su propio enlace de OBS.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      <form className="toolbar" onSubmit={add}>
        <input
          placeholder="Usuario de Twitch (ej. pepito_tv)"
          aria-label="Usuario de Twitch a autorizar"
          maxLength={26}
          value={login}
          onChange={(e) => setLogin(e.target.value)}
        />
        <button type="submit" disabled={busy || !valid}>
          Autorizar canal
        </button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Canal</th>
              <th>Estado</th>
              <th>Último ingreso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.login}>
                <td>
                  <strong>@{c.login}</strong>
                  {c.owner && <span className="pill sub">TÚ</span>}
                </td>
                <td className={c.linked ? "ok" : "muted"}>{c.linked ? "Ya entró" : "Esperando su primer ingreso"}</td>
                <td className="muted">{c.lastLoginAt ? new Date(c.lastLoginAt).toLocaleString("es-CL") : "—"}</td>
                <td className="actions">
                  {!c.owner && (
                    <button className="danger" disabled={busy} onClick={() => remove(c)}>
                      Quitar
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {loaded && items.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">Aún no hay canales autorizados.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
