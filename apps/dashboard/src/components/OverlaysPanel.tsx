import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "../api";
import type { OverlayItem, OverlayWithToken } from "../api";

export function OverlaysPanel() {
  const [items, setItems] = useState<OverlayItem[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<OverlayWithToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api.overlays()).items);
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

  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    void run(async () => {
      setFresh(await api.createOverlay(n));
      setCopied(false);
      setName("");
    });
  };

  const rotate = (o: OverlayItem) => {
    if (!window.confirm(`¿Cambiar el enlace de "${o.name}"? El actual dejará de funcionar y tendrás que actualizarlo en OBS.`)) return;
    void run(async () => {
      setFresh(await api.rotateOverlay(o.id));
      setCopied(false);
    });
  };

  const revoke = (o: OverlayItem) => {
    if (!window.confirm(`¿Eliminar "${o.name}"? Su enlace dejará de funcionar.`)) return;
    void run(async () => {
      await api.revokeOverlay(o.id);
      if (fresh?.id === o.id) setFresh(null);
    });
  };

  const url = fresh ? `${window.location.origin}${fresh.path}` : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section>
      <p className="muted">
        Cada enlace es una fuente <em>Navegador</em> de OBS (1920×1080). Si uno se filtra, cámbialo o elimínalo aquí.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      {fresh && (
        <div className="card notice" role="status">
          <strong>Enlace de «{fresh.name}»</strong>
          <p className="muted">Cópialo ahora: por seguridad no se vuelve a mostrar completo.</p>
          <input readOnly value={url} aria-label="Enlace del overlay" onFocus={(e) => e.currentTarget.select()} />
          <div className="row end">
            <button className="ghost" onClick={() => setFresh(null)}>
              Ya lo copié
            </button>
            <button onClick={() => void copy()}>{copied ? "¡Copiado!" : "Copiar enlace"}</button>
          </div>
        </div>
      )}

      <form className="toolbar" onSubmit={create}>
        <input
          placeholder="Nombre (ej. OBS principal)"
          aria-label="Nombre del nuevo overlay"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={busy || name.trim() === ""}>
          Crear enlace
        </button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Enlace</th>
              <th>Creado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id}>
                <td>
                  <strong>{o.name}</strong>
                </td>
                <td className="muted mono">{o.tokenPrefix}…</td>
                <td className="muted">{new Date(o.createdAt).toLocaleDateString("es-CL")}</td>
                <td className="actions">
                  <button className="ghost" disabled={busy} onClick={() => rotate(o)}>
                    Cambiar enlace
                  </button>
                  <button className="danger" disabled={busy} onClick={() => revoke(o)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  Aún no hay ningún enlace. Crea uno para ponerlo en OBS.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
