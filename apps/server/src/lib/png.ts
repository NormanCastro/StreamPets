import { crc32 } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Los únicos bloques que se conservan: imagen y paleta/transparencia. Todo lo demás (texto, EXIF…) se descarta. */
const KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

export type PngCheck =
  | { ok: true; png: Buffer }
  | { ok: false; error: "not_png" | "bad_size" | "too_large" | "corrupt" | "interlaced" };

/**
 * Valida un PNG subido por un usuario y devuelve una copia limpia (solo los bloques necesarios).
 * Exige las medidas exactas, que cada bloque tenga su CRC correcto y que no sea entrelazado.
 */
export function sanitizePng(input: Buffer, width: number, height: number, maxBytes: number): PngCheck {
  if (input.length > maxBytes) return { ok: false, error: "too_large" };
  if (input.length < 33 || !input.subarray(0, 8).equals(SIGNATURE)) return { ok: false, error: "not_png" };

  const out: Buffer[] = [SIGNATURE];
  let pos = 8;
  let first = true;
  let sawIdat = false;
  let sawIend = false;
  while (pos + 12 <= input.length) {
    const len = input.readUInt32BE(pos);
    const end = pos + 12 + len;
    if (len > 0x7fffffff || end > input.length) return { ok: false, error: "corrupt" };
    const type = input.subarray(pos + 4, pos + 8).toString("latin1");
    const data = input.subarray(pos + 8, pos + 8 + len);
    const crc = input.readUInt32BE(pos + 8 + len);
    if (crc32(input.subarray(pos + 4, pos + 8 + len)) !== crc) return { ok: false, error: "corrupt" };

    if (first) {
      if (type !== "IHDR" || len !== 13) return { ok: false, error: "not_png" };
      if (data.readUInt32BE(0) !== width || data.readUInt32BE(4) !== height) return { ok: false, error: "bad_size" };
      if (data[12] !== 0) return { ok: false, error: "interlaced" };
      first = false;
    }
    if (KEEP.has(type)) out.push(input.subarray(pos, end));
    if (type === "IDAT") sawIdat = true;
    pos = end;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (first || !sawIdat || !sawIend || pos !== input.length) return { ok: false, error: "corrupt" };
  return { ok: true, png: Buffer.concat(out) };
}
