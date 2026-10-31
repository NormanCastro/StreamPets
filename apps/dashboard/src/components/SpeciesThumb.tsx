import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

interface Thumb {
  image: string;
  cell: number;
  sheetW: number;
  sheetH: number;
  /** Posición (en celdas) del cuadro «east» de la fila de rotaciones. */
  col: number;
  row: number;
}

const cache = new Map<string, Promise<Thumb | null>>();

/** Lee el species.json y la descripción de la hoja para recortar un cuadro de la mascota. */
function load(speciesUrl: string): Promise<Thumb | null> {
  let p = cache.get(speciesUrl);
  if (!p) {
    p = (async () => {
      try {
        const base = new URL(speciesUrl, window.location.href);
        const def = (await (await fetch(base.href)).json()) as { sheetImage: string; sheetMeta: string };
        const meta = (await (await fetch(new URL(def.sheetMeta, base).href)).json()) as {
          spritesheet: {
            cell_size: { width: number; height: number };
            sheet_size: { width: number; height: number };
            rows: Array<{ row: number; type: string; directions?: string[] }>;
          };
        };
        const sheet = meta.spritesheet;
        const rot = sheet.rows.find((r) => r.type === "rotations");
        const col = Math.max(0, rot?.directions?.indexOf("east") ?? 2);
        return {
          image: new URL(def.sheetImage, base).href,
          cell: sheet.cell_size.width,
          sheetW: sheet.sheet_size.width,
          sheetH: sheet.sheet_size.height,
          col,
          row: rot?.row ?? 0,
        };
      } catch {
        return null;
      }
    })();
    cache.set(speciesUrl, p);
  }
  return p;
}

/** Miniatura de una especie (mirando a la derecha). */
export function SpeciesThumb({ url, name, size = 56 }: { url: string; name: string; size?: number }) {
  const [t, setT] = useState<Thumb | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void load(url).then((v) => alive && setT(v));
    return () => {
      alive = false;
    };
  }, [url]);

  if (!t) return <span className="thumb empty" style={{ width: size, height: size }} aria-hidden="true" />;
  const k = size / t.cell;
  const style = {
    width: size,
    height: size,
    backgroundImage: `url(${t.image})`,
    backgroundSize: `${t.sheetW * k}px ${t.sheetH * k}px`,
    backgroundPosition: `${-t.col * size}px ${-t.row * size}px`,
  } as CSSProperties;
  return <span className="thumb" style={style} role="img" aria-label={`Vista de ${name}`} />;
}
