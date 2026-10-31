import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "../api";
import type { CatalogItem } from "../api";
import { SpeciesThumb } from "./SpeciesThumb";

const GROUPS: Array<{ id: CatalogItem["category"]; title: string; hint: string }> = [
  { id: "free", title: "Gratis", hint: "Las puede usar cualquier canal." },
  { id: "premium", title: "Premium", hint: "Solo canales con plan premium." },
  { id: "exclusive", title: "Exclusivas", hint: "Solo los canales a los que se las des (o el canal que subió su propia pet)." },
];

export function CatalogPanel() {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.catalog()).items);
      setError("");
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(it: CatalogItem) {
    const turnOff = !it.disabled;
    if (
      turnOff &&
      !window.confirm(
        `¿Desactivar "${it.name}" en TODOS los canales? ${it.pets > 0 ? `Las ${it.pets} mascotas que la usan pasarán a otra especie ahora mismo.` : "Nadie la podrá usar ni recibir."}`,
      )
    ) {
      return;
    }
    setBusy(it.id);
    try {
      await api.setSpeciesDisabled(it.id, turnOff);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <p className="muted">
        Todas las mascotas, de la más usada a la menos usada (por cantidad de canales). Si algo sale mal, desactiva la especie: deja de estar disponible para todos y quienes la
        tenían pasan a otra al instante.
      </p>
      {error && <p className="error" role="alert">{error}</p>}

      {GROUPS.map((g) => {
        const list = items.filter((i) => i.category === g.id);
        return (
          <div key={g.id} className="catgroup">
            <h2 className="cattitle">
              {g.title} <span className="pill">{list.length}</span>
            </h2>
            <p className="muted small">{g.hint}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Mascota</th>
                    <th>En canales</th>
                    <th>Mascotas</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id} className={i.disabled ? "off" : ""}>
                      <td>
                        <div className="catname">
                          <SpeciesThumb url={i.url} name={i.name} />
                          <div>
                            <strong>{i.name}</strong>
                            <div className="muted small">
                              {i.custom ? `Propia de @${i.ownerLogin ?? "?"}` : i.id}
                              {i.premium && i.category === "exclusive" ? " · premium" : ""}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <strong>{i.channels}</strong>
                      </td>
                      <td className="muted">{i.pets}</td>
                      <td>
                        <div className="switchrow">
                          <label className="switch">
                            <input
                              type="checkbox"
                              role="switch"
                              checked={!i.disabled}
                              disabled={busy === i.id}
                              aria-label={`${i.disabled ? "Activar" : "Desactivar"} ${i.name}`}
                              onChange={() => void toggle(i)}
                            />
                            <span />
                          </label>
                          <span className={i.disabled ? "error" : "muted"}>{i.disabled ? "Desactivada" : "Activa"}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {list.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        No hay mascotas en esta categoría.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </section>
  );
}
