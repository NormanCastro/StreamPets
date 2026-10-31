import { Fragment, useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "../api";
import type { ChannelItem, Plan, Species } from "../api";

/** Quién puede entrar con Twitch, con qué plan y con qué especies exclusivas. Solo lo ve quien administra. */
export function ChannelsPanel({ species }: { species: Species[] }) {
  const [items, setItems] = useState<ChannelItem[]>([]);
  const [login, setLogin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ login: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const exclusive = species.filter((s) => s.scope === "exclusive" && !s.custom);

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

  const makeKey = (c: ChannelItem) => {
    if (
      c.hasKey &&
      !window.confirm(
        `¿Generar una clave nueva para @${c.login}? La anterior deja de funcionar y se cierran sus sesiones abiertas.`,
      )
    )
      return;
    void run(async () => {
      const r = await api.createChannelKey(c.login);
      setFresh({ login: c.login, key: r.key });
      setCopied(false);
    });
  };

  const revokeKey = (c: ChannelItem) => {
    if (!window.confirm(`¿Quitar la clave de @${c.login}? Dejará de funcionar y se cierran sus sesiones abiertas.`)) return;
    void run(async () => {
      await api.revokeChannelKey(c.login);
      if (fresh?.login === c.login) setFresh(null);
    });
  };

  async function copyKey() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const setPlan = (c: ChannelItem, plan: Plan) => {
    if (plan === c.plan) return;
    if (
      plan === "free" &&
      !window.confirm(
        `¿Pasar a @${c.login} al plan gratis? Las mascotas de sus espectadores que usen especies premium pasarán a otra especie disponible.`,
      )
    )
      return;
    void run(async () => void (await api.patchChannel(c.login, { plan })));
  };

  const toggleSpecies = (c: ChannelItem, id: string, on: boolean) => {
    if (
      !on &&
      !window.confirm(`¿Quitarle esta especie a @${c.login}? Sus espectadores que la usen pasarán a otra especie disponible.`)
    )
      return;
    const next = on ? [...c.species, id] : c.species.filter((x) => x !== id);
    void run(async () => void (await api.patchChannel(c.login, { species: next })));
  };

  return (
    <section>
      <p className="muted">
        Solo los canales de esta lista pueden entrar con Twitch. Escribe el usuario de Twitch de quien quieras invitar; cada persona
        administra sus propias mascotas y su propio enlace de OBS. El plan decide si puede usar las especies <em>premium</em>, y las
        especies <em>exclusivas</em> se le dan canal por canal.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      {fresh && (
        <div className="card notice" role="status">
          <strong>Clave de @{fresh.login}</strong>
          <p className="muted">
            Cópiala y envíasela por un medio privado: por seguridad no se vuelve a mostrar. Con ella entra al panel de su canal (solo
            al suyo) desde «Entrar con clave».
          </p>
          <input readOnly value={fresh.key} aria-label="Clave generada" onFocus={(e) => e.currentTarget.select()} />
          <div className="row end">
            <button className="ghost" onClick={() => setFresh(null)}>
              Ya la copié
            </button>
            <button onClick={() => void copyKey()}>{copied ? "¡Copiada!" : "Copiar clave"}</button>
          </div>
        </div>
      )}

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
              <th>Plan</th>
              <th>Especies exclusivas</th>
              <th>Clave de respaldo</th>
              <th>Último ingreso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <Fragment key={c.login}>
                <tr>
                  <td>
                    <strong>@{c.login}</strong>
                    {c.owner && <span className="pill sub">TÚ</span>}
                  </td>
                  <td className={c.linked ? "ok" : "muted"}>{c.linked ? "Ya entró" : "Esperando su primer ingreso"}</td>
                  <td>
                    {c.owner ? (
                      <span className="muted">Todo incluido</span>
                    ) : (
                      <select
                        aria-label={`Plan de ${c.login}`}
                        value={c.plan}
                        disabled={busy}
                        onChange={(e) => setPlan(c, e.target.value as Plan)}
                      >
                        <option value="free">Gratis</option>
                        <option value="premium">Premium</option>
                      </select>
                    )}
                  </td>
                  <td>
                    {c.owner ? (
                      <span className="muted">Todas</span>
                    ) : exclusive.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <button className="ghost" disabled={busy} onClick={() => setOpen(open === c.login ? null : c.login)}>
                        Especies ({c.species.length}/{exclusive.length})
                      </button>
                    )}
                  </td>
                  <td>
                    {c.owner ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className="keycell">
                        {c.hasKey && <span className="muted mono">{c.keyPrefix}…</span>}
                        <button className="ghost" disabled={busy} onClick={() => makeKey(c)}>
                          {c.hasKey ? "Regenerar" : "Generar clave"}
                        </button>
                        {c.hasKey && (
                          <button className="danger" disabled={busy} onClick={() => revokeKey(c)}>
                            Revocar
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="muted">{c.lastLoginAt ? new Date(c.lastLoginAt).toLocaleString("es-CL") : "—"}</td>
                  <td className="actions">
                    {!c.owner && (
                      <button className="danger" disabled={busy} onClick={() => remove(c)}>
                        Quitar
                      </button>
                    )}
                  </td>
                </tr>
                {open === c.login && !c.owner && (
                  <tr className="subrow">
                    <td colSpan={7}>
                      <div className="grants">
                        {exclusive.map((s) => (
                          <label key={s.id} className="check">
                            <input
                              type="checkbox"
                              aria-label={`${s.name} para ${c.login}`}
                              checked={c.species.includes(s.id)}
                              disabled={busy}
                              onChange={(e) => toggleSpecies(c, s.id, e.target.checked)}
                            />
                            <span>
                              {s.name}
                              {s.tier === "premium" && <small className="muted"> · además necesita plan premium</small>}
                            </span>
                          </label>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {loaded && items.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">Aún no hay canales autorizados.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
