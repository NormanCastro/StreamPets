import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, describeError } from "../api";
import type { CustomPet, PackPreviewResult } from "../api";
import { PackStudio, PetPreview } from "./PetPreview";

const W = 520;
const H = 280;
const MAX_BYTES = 120_000;
const MAX_ZIP = 1_500_000;

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
  const [mode, setMode] = useState<"zip" | "png">("zip");
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [zip, setZip] = useState<{ name: string; b64: string } | null>(null);
  const [flip, setFlip] = useState(false);
  const [preview, setPreview] = useState<PackPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [fileError, setFileError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /** Último nombre rellenado solo a partir del archivo (si el usuario lo escribió, no se pisa). */
  const autoName = useRef("");

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

  /** Convierte el .zip en el servidor y muestra cómo se verá; todavía no se envía nada a revisión. */
  async function runPreview(b64: string, flipped: boolean) {
    setPreviewing(true);
    setFileError("");
    try {
      setPreview(await api.previewPetPack(b64, flipped));
    } catch (err) {
      setPreview(null);
      setFileError(describeError(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function pickZip(f: File | undefined) {
    setZip(null);
    setPreview(null);
    setFileError("");
    setFlip(false);
    if (!f) return;
    if (f.size > MAX_ZIP) return setFileError("El .zip pesa demasiado (máximo 1,5 MB).");
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return setFileError("El archivo no es un .zip. Si es .rar, ábrelo y comprime las imágenes en un .zip.");
    const b64 = toBase64(bytes);
    setZip({ name: f.name, b64 });
    const guess = f.name.replace(/\.zip$/i, "").replace(/[^\p{L}\p{N} _.'-]/gu, " ").trim().slice(0, 30);
    if (!name.trim() || name === autoName.current) {
      setName(guess);
      autoName.current = guess;
    }
    await runPreview(b64, false);
  }

  async function changeFlip(v: boolean) {
    setFlip(v);
    if (zip) await runPreview(zip.b64, v);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ready = mode === "zip" ? zip && preview : file;
    if (!ready || !name.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "zip" && zip) await api.uploadPetPack(name.trim(), zip.b64, flip);
      else if (file) await api.uploadCustomPet(name.trim(), file.b64);
      setNotice("¡Listo! Tu mascota quedó en revisión. Te avisamos aquí cuando la aprueben.");
      setName("");
      setFile(null);
      setZip(null);
      setPreview(null);
      setFlip(false);
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
          <strong>Tu plan no incluye mascotas propias.</strong>
          <p className="muted">Pídele a quien administra StreamPets que te habilite cupos para subir las tuyas.</p>
        </div>
      ) : (
        <form className="card" onSubmit={(e) => void submit(e)}>
          <div className="modeswitch" role="group" aria-label="Formato de la mascota">
            <button type="button" className={mode === "zip" ? "" : "ghost"} aria-pressed={mode === "zip"} onClick={() => setMode("zip")}>
              Imágenes sueltas (.zip)
            </button>
            <button type="button" className={mode === "png" ? "" : "ghost"} aria-pressed={mode === "png"} onClick={() => setMode("png")}>
              Hoja única (PNG {W}×{H})
            </button>
          </div>
          <div className="row">
            <label>
              Nombre de la mascota
              <input value={name} maxLength={30} placeholder="Ej. Pollito" onChange={(e) => setName(e.target.value)} disabled={full} />
            </label>
            {mode === "zip" ? (
              <label>
                Archivo .zip con tus imágenes
                <input type="file" accept=".zip,application/zip" disabled={full} onChange={(e) => void pickZip(e.target.files?.[0])} />
              </label>
            ) : (
              <label>
                Hoja de sprites (PNG {W}×{H})
                <input ref={input} type="file" accept="image/png" disabled={full} onChange={(e) => void pick(e.target.files?.[0])} />
              </label>
            )}
          </div>
          {fileError && <p className="error" role="alert">{fileError}</p>}
          {mode === "zip" && previewing && <p className="muted" role="status">Convirtiendo tu mascota…</p>}
          {mode === "zip" && preview && (
            <div className="packpreview">
              <h3>Así se verá en tu stream</h3>
              <PackStudio png={preview.png} pack={preview.pack} />
              <p className="muted">
                Usé <strong>{preview.used.idle}</strong> imágenes de Idle, <strong>{preview.used.walk}</strong> de Walk
                {preview.used.attack > 0 ? (
                  <>
                    {" "}
                    y <strong>{preview.used.attack}</strong> de Attack (el ataque queda guardado para futuras peleas entre mascotas)
                  </>
                ) : (
                  <> (no trae Attack, no es obligatorio)</>
                )}
                .{preview.pack.shrink > 1 && <> Se redujo a 1/{preview.pack.shrink} para que tenga el tamaño de las demás mascotas.</>}
              </p>
              {preview.ignored.length > 0 && (
                <p className="muted ignored">
                  No se usan: {preview.ignored.slice(0, 12).join(", ")}
                  {preview.ignored.length > 12 ? "…" : ""}
                </p>
              )}
              <label className="check">
                <input type="checkbox" checked={flip} disabled={previewing} onChange={(e) => void changeFlip(e.target.checked)} />
                En mi dibujo original la mascota mira hacia la izquierda
              </label>
              <p className="muted">Revisa que camine hacia el lado correcto y que no se corte nada. Si te gusta, envíala a revisión.</p>
            </div>
          )}
          {full && <p className="muted">Ya usaste todos tus cupos. Elimina una mascota para subir otra.</p>}
          <div className="row end">
            <button type="submit" disabled={busy || previewing || full || name.trim() === "" || (mode === "zip" ? !preview : !file)}>
              Enviar a revisión
            </button>
          </div>
        </form>
      )}

      <div className="petgrid">
        {items.map((p) => (
          <div key={p.id} className="card petcard">
            {p.png && p.status !== "rejected" ? <PetPreview png={p.png} pack={p.pack} label={`Vista previa de ${p.name}`} /> : <div className="petprev empty" />}
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
        <h3>Opción fácil: imágenes sueltas en un .zip</h3>
        <ul>
          <li>
            Comprime en un <strong>.zip</strong> las imágenes PNG de tu mascota, una por cuadro, con nombres como <code>Idle1.png</code>, <code>Idle2.png</code>… y <code>Walk1.png</code>, <code>Walk2.png</code>…
          </li>
          <li>
            <strong>Obligatorias:</strong> <code>Idle</code> (quieta, mínimo 1 imagen) y <code>Walk</code> (caminar, mínimo 2). <strong>Opcional:</strong> <code>Attack</code> (ataque; se guarda para futuras peleas entre mascotas).
            Las demás (Hurt, Death…) se ignoran.
          </li>
          <li>
            Todas las imágenes del mismo tamaño (entre 16 y 256 píxeles por lado), con fondo transparente, mirando <strong>hacia la derecha</strong> (si miran a la izquierda, marca la casilla en la vista previa).
            Hasta 24 imágenes por animación y 1,5 MB en total.
          </li>
          <li>
            Si tu mascota es grande, la app la reduce sola al tamaño de las demás y la recorta al contenido. Antes de enviar verás cómo queda.
          </li>
        </ul>
        <h3>Opción avanzada: una sola hoja PNG de {W}×{H}</h3>
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
