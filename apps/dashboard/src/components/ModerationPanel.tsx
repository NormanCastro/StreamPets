import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../api";
import type { CustomPetStatus, ReviewPet } from "../api";
import { PetPreview, SheetView } from "./PetPreview";

const FILTERS: Array<{ id: CustomPetStatus | "all"; label: string }> = [
  { id: "pending", label: "Pendientes" },
  { id: "approved", label: "Aprobadas" },
  { id: "rejected", label: "Rechazadas" },
  { id: "all", label: "Todas" },
];
const STATUS: Record<CustomPetStatus, string> = { pending: "En revisión", approved: "Aprobada", rejected: "Rechazada" };

export function ModerationPanel() {
  const [filter, setFilter] = useState<CustomPetStatus | "all">("pending");
  const [items, setItems] = useState<ReviewPet[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setItems((await api.reviewPets(filter)).items);
      setError("");
    } catch (err) {
      setError(describeError(err));
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const reject = (p: ReviewPet) => run(() => api.rejectPet(p.id, (reasons[p.id] ?? "").trim()));
  const approve = (p: ReviewPet) => run(() => api.approvePet(p.id));
  const remove = (p: ReviewPet) => {
    if (!window.confirm(`¿Eliminar "${p.name}" de @${p.login}? No se puede deshacer.`)) return;
    void run(() => api.deleteCustomPet(p.id));
  };

  return (
    <section>
      <p className="muted">
        Revisa cada hoja completa (todas las filas y cuadros) antes de aprobar. Una pet aprobada solo la puede usar el canal que la subió; si la rechazas o eliminas, quienes la
        tenían pasan a otra mascota.
      </p>
      <div className="toolbar" role="group" aria-label="Filtro">
        {FILTERS.map((f) => (
          <button key={f.id} className={filter === f.id ? "" : "ghost"} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {items.length === 0 && <div className="card empty">No hay mascotas en esta lista.</div>}
      {items.map((p) => (
        <div key={p.id} className="card modcard">
          <div className="modhead">
            <div>
              <strong>{p.name}</strong> <span className="muted">de @{p.login}</span>
              <div>
                <span className={`pill status-${p.status}`}>{STATUS[p.status]}</span>{" "}
                <span className="muted">{new Date(p.createdAt).toLocaleString("es-CL")}</span>
              </div>
              {p.status === "rejected" && p.rejectReason && <p className="muted">Motivo: {p.rejectReason}</p>}
            </div>
            {p.png && <PetPreview png={p.png} label={`Vista previa de ${p.name}`} />}
          </div>
          {p.png && <SheetView png={p.png} />}
          <div className="row end modactions">
            {p.status !== "approved" && (
              <button disabled={busy} onClick={() => void approve(p)}>
                Aprobar
              </button>
            )}
            {p.status !== "rejected" && (
              <>
                <input
                  placeholder="Motivo (opcional, lo ve el canal)"
                  aria-label={`Motivo para rechazar ${p.name}`}
                  maxLength={200}
                  value={reasons[p.id] ?? ""}
                  onChange={(e) => setReasons({ ...reasons, [p.id]: e.target.value })}
                />
                <button className="danger" disabled={busy} onClick={() => void reject(p)}>
                  Rechazar
                </button>
              </>
            )}
            <button className="ghost" disabled={busy} onClick={() => remove(p)}>
              Eliminar
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
