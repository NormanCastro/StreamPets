import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "../api";
import type { CustomPet } from "../api";
import { PetPreview } from "./PetPreview";

const W = 520;
const H = 280;
const MAX_BYTES = 120_000;

const STATUS: Record<CustomPet["status"], string> = {
  pending: "En revisión",
  approved: "Aprobada",
  rejected: "Rechazada",
};

/** Lee el ancho y alto del encabezado del PNG para avisar antes de subir. */
function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const ROWS: Array<[string, string]> = [
  ["0", "Rotaciones (1 cuadro por dirección, de izquierda a derecha): south, south-east, east, north-east, north, north-west, west, south-west"],
  ["1", "Idle (quieta) mirando south: 8 cuadros"],
  ["2", "Idle mirando east (derecha): 8 cuadros"],
  ["3", "Idle mirando west (izquierda): 8 cuadros"],
  ["4", "Walk (caminar) hacia south: 13 cuadros"],
  ["5", "Walk hacia east (derecha): 13 cuadros"],
  ["6", "Walk hacia west (izquierda): 13 cuadros"],
];

export function MyPetsPanel() {
  const [items, setItems] = useState<CustomPet[]>([]);
  const [quota, setQuota] = useState({ used: 0, max: 0 });
  const [name, setName] = useState("");
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [fileError, setFileError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.customPets();
      setItems(r.items);
      setQuota(r.quota);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function pick(f: File | undefined) {
    setFile(null);
    setFileError("");
    if (!f) return;
    if (f.size > MAX_BYTES) return setFileError("El PNG pesa demasiado (máximo 120 KB).");
    const bytes = new Uint8Array(await f.arrayBuffer());
    const size = pngSize(bytes);
    if (!size) return setFileError("El archivo no es un PNG.");
    if (size.w !== W || size.h !== H) return setFileError(`Mide ${size.w}×${size.h}: debe ser exactamente ${W}×${H}.`);
    setFile({ name: f.name, b64: toBase64(bytes) });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.uploadCustomPet(name.trim(), file.b64);
      setNotice("¡Listo! Tu mascota quedó en revisión. Te avisamos aquí cuando la aprueben.");
      setName("");
      setFile(null);
      if (input.current) input.current.value = "";
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: CustomPet) {
    if (!window.confirm(`¿Eliminar "${p.name}"? Quienes la tengan pasarán a otra mascota.`)) return;
    setBusy(true);
    setError("");
    try {
      await api.deleteCustomPet(p.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const noPlan = loaded && quota.max === 0;
  const full = quota.used >= quota.max;

  return (
    <section>
      <p className="muted">
        Sube tus propias mascotas. Un administrador las revisa antes de que aparezcan en tu stream, y solo tu canal puede usarlas.
        {quota.max > 0 && (
          <>
            {" "}
            Cupos usados: <strong>{quota.used}</strong> de <strong>{quota.max}</strong>.
          </>
        )}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="ok" role="status">{notice}</p>}

      {noPlan ? (
        <div className="card">
          <strong>Las mascotas propias son parte del plan premium.</strong>
          <p className="muted">Cuando tu canal tenga el plan premium podrás subir las tuyas desde aquí.</p>
        </div>
      ) : (
        <form className="card" onSubmit={(e) => void submit(e)}>
          <div className="row">
            <label>
              Nombre de la mascota
              <input value={name} maxLength={30} placeholder="Ej. Pollito" onChange={(e) => setName(e.target.value)} disabled={full} />
            </label>
            <label>
              Hoja de sprites (PNG {W}×{H})
              <input ref={input} type="file" accept="image/png" disabled={full} onChange={(e) => void pick(e.target.files?.[0])} />
            </label>
          </div>
          {fileError && <p className="error" role="alert">{fileError}</p>}
          {full && <p className="muted">Ya usaste todos tus cupos. Elimina una mascota para subir otra.</p>}
          <div className="row end">
            <button type="submit" disabled={busy || full || !file || name.trim() === ""}>
              Enviar a revisión
            </button>
          </div>
        </form>
      )}

      <div className="petgrid">
        {items.map((p) => (
          <div key={p.id} className="card petcard">
            {p.png && p.status !== "rejected" ? <PetPreview png={p.png} label={`Vista previa de ${p.name}`} /> : <div className="petprev empty" />}
            <div>
              <strong>{p.name}</strong>
              <div>
                <span className={`pill status-${p.status}`}>{STATUS[p.status]}</span>
              </div>
              {p.status === "rejected" && <p className="muted">Motivo: {p.rejectReason ?? "sin detalle"}</p>}
              {p.status === "pending" && <p className="muted">Aún no se ve en tu stream.</p>}
              {p.status === "approved" && <p className="muted">Ya puedes elegirla en «Mascotas» y en Ajustes.</p>}
            </div>
            <button className="danger" disabled={busy} onClick={() => void remove(p)}>
              Eliminar
            </button>
          </div>
        ))}
      </div>

      <details className="card guide" open={items.length === 0}>
        <summary>
          <strong>Cómo preparar tu mascota (guía y medidas)</strong>
        </summary>
        <ul>
          <li>
            Un único <strong>PNG de {W}×{H} píxeles</strong>, con fondo transparente, sin entrelazado y de hasta 120 KB.
          </li>
          <li>
            Está dividido en <strong>celdas de 40×40</strong> (13 columnas × 7 filas). Cada cuadro de animación va en una celda, de izquierda a derecha desde la primera
            columna. Las celdas que sobran se dejan vacías.
          </li>
          <li>
            Dibuja la mascota dentro de unos 32×32 y centrada en la celda. Los <strong>pies tocan el punto x=20, y=34</strong> de cada celda; ahí se apoya el nombre y la sombra.
          </li>
          <li>
            <strong>east</strong> es mirar a la derecha, <strong>west</strong> a la izquierda y <strong>south</strong> de frente a la cámara. Cuando camina por la pantalla se ve de lado
            (east y west).
          </li>
        </ul>
        <table className="guidetable">
          <thead>
            <tr>
              <th>Fila</th>
              <th>Qué va ahí</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([r, text]) => (
              <tr key={r}>
                <td>{r}</td>
                <td>{text}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Descarga la plantilla con las celdas marcadas y úsala como capa de referencia en tu editor (Aseprite, Piskel…). <strong>Bórrala antes de exportar</strong>.
        </p>
        <a className="btn dl" href="/admin/plantilla-pet.png" download="plantilla-pet.png">
          Descargar plantilla
        </a>
      </details>
    </section>
  );
}
