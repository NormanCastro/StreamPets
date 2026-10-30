import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "../api";
import type { Role, Species, ViewerCounts, ViewerItem } from "../api";

const PAGE_SIZE = 25;
const REFRESH_MS = 10_000;

function formatSeen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" });
}

const ROLES: Array<{ id: Role; label: string }> = [
  { id: "all", label: "Todos" },
  { id: "subs", label: "Subs" },
  { id: "viewers", label: "Viewers" },
];

export function ViewersPanel({ species }: { species: Species[] }) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [role, setRole] = useState<Role>("all");
  const [counts, setCounts] = useState<ViewerCounts | null>(null);
  const [items, setItems] = useState<ViewerItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const controller = useRef<AbortController | null>(null);

  // Búsqueda con retraso para no consultar en cada tecla.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(input.trim());
      setPage(0);
    }, 300);
    return () => window.clearTimeout(t);
  }, [input]);

  const load = useCallback(
    async (showSpinner: boolean) => {
      controller.current?.abort();
      const ctl = new AbortController();
      controller.current = ctl;
      if (showSpinner) setLoading(true);
      try {
        const r = await api.viewers(query, role, PAGE_SIZE, page * PAGE_SIZE, ctl.signal);
        setItems(r.items);
        setTotal(r.total);
        setCounts(r.counts);
        setError("");
        // Si se vació la última página (p. ej. tras filtrar), volver a una válida.
        if (r.items.length === 0 && r.total > 0 && page > 0) setPage(Math.max(0, Math.ceil(r.total / PAGE_SIZE) - 1));
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(describeError(err));
      } finally {
        if (!ctl.signal.aborted) setLoading(false);
      }
    },
    [query, role, page],
  );

  useEffect(() => {
    void load(true);
    const t = window.setInterval(() => void load(false), REFRESH_MS);
    return () => {
      window.clearInterval(t);
      controller.current?.abort();
    };
  }, [load]);

  async function change(v: ViewerItem, body: { speciesId?: string; enabled?: boolean }) {
    setPending((p) => new Set(p).add(v.id));
    setError("");
    // Cambio visible al instante; si el servidor lo rechaza se recarga el estado real.
    setItems((list) =>
      list.map((i) => (i.id === v.id && i.pet ? { ...i, pet: { ...i.pet, ...body } } : i)),
    );
    try {
      const r = await api.patchPet(v.id, body);
      setItems((list) => list.map((i) => (i.id === v.id ? { ...i, pet: r.pet } : i)));
    } catch (err) {
      setError(`${v.displayName}: ${describeError(err)}`);
      void load(false);
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(v.id);
        return n;
      });
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const countOf = (r: Role): number | undefined => (counts ? counts[r] : undefined);

  return (
    <section>
      <div className="stats">
        <div className="stat">
          <span className="stat-value">{counts?.all ?? "–"}</span>
          <span className="stat-label">Total</span>
        </div>
        <div className="stat sub">
          <span className="stat-value">{counts?.subs ?? "–"}</span>
          <span className="stat-label">Subs</span>
        </div>
        <div className="stat live">
          <span className="stat-value">{counts?.online ?? "–"}</span>
          <span className="stat-label">En pantalla</span>
        </div>
      </div>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filtrar por tipo">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={role === r.id}
              className={role === r.id ? "seg active" : "seg"}
              onClick={() => {
                setRole(r.id);
                setPage(0);
              }}
            >
              {r.label}
              <span className="seg-count">{countOf(r.id) ?? "–"}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Buscar por nombre…"
          aria-label="Buscar espectador"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <span className="muted">
          {total} {total === 1 ? "espectador" : "espectadores"}
        </span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Espectador</th>
              <th>Mascota</th>
              <th>Activa</th>
              <th className="num">Mensajes</th>
              <th>Última vez</th>
            </tr>
          </thead>
          <tbody>
            {items.map((v) => {
              const busy = pending.has(v.id);
              const speciesId = v.pet?.speciesId ?? "";
              const known = species.some((s) => s.id === speciesId);
              return (
                <tr key={v.id} className={v.pet?.enabled === false ? "off" : undefined}>
                  <td>
                    <span className={v.online ? "dot on" : "dot"} title={v.online ? "En pantalla" : "No está en pantalla"} />
                    <strong>{v.displayName}</strong>
                    {v.displayName.toLowerCase() !== v.login && <span className="muted"> @{v.login}</span>}
                    {v.isSubscriber && <span className="pill sub">SUB</span>}
                  </td>
                  <td>
                    {v.pet ? (
                      <select
                        aria-label={`Especie de ${v.displayName}`}
                        value={speciesId}
                        disabled={busy}
                        onChange={(e) => void change(v, { speciesId: e.target.value })}
                      >
                        {!known && <option value={speciesId}>{speciesId} (no disponible)</option>}
                        {species.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">sin mascota</span>
                    )}
                  </td>
                  <td>
                    {v.pet && (
                      <label className="switch">
                        <input
                          type="checkbox"
                          aria-label={`Mascota activa de ${v.displayName}`}
                          checked={v.pet.enabled}
                          disabled={busy}
                          onChange={(e) => void change(v, { enabled: e.target.checked })}
                        />
                        <span />
                      </label>
                    )}
                  </td>
                  <td className="num">{v.messageCount}</td>
                  <td className="muted">{formatSeen(v.lastSeenAt)}</td>
                </tr>
              );
            })}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  {query || role !== "all"
                    ? "Nadie coincide con el filtro."
                    : "Aún no ha escrito nadie. Aparecerán aquí cuando lo hagan."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {loading && <p className="muted pad">Cargando…</p>}
      </div>
      {pages > 1 && (
        <div className="pager">
          <button className="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← Anterior
          </button>
          <span className="muted">
            Página {page + 1} de {pages}
          </span>
          <button className="ghost" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Siguiente →
          </button>
        </div>
      )}
    </section>
  );
}
