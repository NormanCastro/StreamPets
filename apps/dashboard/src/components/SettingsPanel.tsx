import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, describeError, speciesLabel } from "../api";
import type { Settings, Species } from "../api";

interface Draft {
  subsOnly: boolean;
  ignoreStreamer: boolean;
  defaultSpeciesId: string;
  maxPets: number;
  idleMinutes: number;
  ignoredText: string;
}

function toDraft(s: Settings): Draft {
  return {
    subsOnly: s.subsOnly,
    ignoreStreamer: s.ignoreStreamer,
    defaultSpeciesId: s.defaultSpeciesId ?? "",
    maxPets: s.maxPets,
    idleMinutes: Math.max(1, Math.round(s.idleTimeoutSec / 60)),
    ignoredText: s.ignoredLogins.join("\n"),
  };
}

export function SettingsPanel({ species }: { species: Species[] }) {
  const [saved, setSaved] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .settings()
      .then((s) => {
        if (cancelled) return;
        const d = toDraft(s);
        setSaved(d);
        setDraft(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!draft || !saved) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Cargando…</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft({ ...draft, [k]: v });
    setNotice("");
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const s = await api.saveSettings({
        subsOnly: draft.subsOnly,
        ignoreStreamer: draft.ignoreStreamer,
        defaultSpeciesId: draft.defaultSpeciesId === "" ? null : draft.defaultSpeciesId,
        maxPets: draft.maxPets,
        idleTimeoutSec: draft.idleMinutes * 60,
        ignoredLogins: draft.ignoredText.split(/[\s,]+/).filter(Boolean),
      });
      const d = toDraft(s);
      setSaved(d);
      setDraft(d);
      setNotice("Guardado. Ya está aplicado en el overlay.");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <label className="check">
        <input type="checkbox" checked={draft.subsOnly} onChange={(e) => set("subsOnly", e.target.checked)} />
        <span>
          <strong>Solo suscriptores</strong>
          <small className="muted">Si está apagado, cualquiera que escriba recibe una mascota.</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={draft.ignoreStreamer} onChange={(e) => set("ignoreStreamer", e.target.checked)} />
        <span>
          <strong>No dar mascota a la streamer</strong>
        </span>
      </label>
      <label>
        Especie para los nuevos
        <select value={draft.defaultSpeciesId} onChange={(e) => set("defaultSpeciesId", e.target.value)}>
          <option value="">Al azar entre las disponibles</option>
          {species.map((s) => (
            <option key={s.id} value={s.id} disabled={s.locked && s.id !== draft.defaultSpeciesId}>
              {speciesLabel(s)}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <label>
          Máximo en pantalla
          <input
            type="number"
            min={1}
            max={50}
            value={draft.maxPets}
            onChange={(e) => set("maxPets", Number(e.target.value))}
          />
        </label>
        <label>
          Se van tras (minutos sin escribir)
          <input
            type="number"
            min={1}
            max={60}
            value={draft.idleMinutes}
            onChange={(e) => set("idleMinutes", Number(e.target.value))}
          />
        </label>
      </div>
      <label>
        Cuentas ignoradas (bots), una por línea
        <textarea rows={6} value={draft.ignoredText} onChange={(e) => set("ignoredText", e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok" role="status">{notice}</p>}
      <div className="row end">
        <button type="button" className="ghost" disabled={!dirty || busy} onClick={() => { setDraft(saved); setNotice(""); setError(""); }}>
          Descartar
        </button>
        <button type="submit" disabled={!dirty || busy}>
          {busy ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </form>
  );
}
