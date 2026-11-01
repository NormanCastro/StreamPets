import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PackInfo } from "../api";

export type PackAnim = "idle" | "walk" | "attack";
export type PackSide = "east" | "west";

/** Fila de cada animación en la hoja convertida (la plantilla fija usa las mismas filas para Idle y Walk). */
const ROW: Record<PackSide, Record<PackAnim, number>> = {
  east: { idle: 2, walk: 5, attack: 7 },
  west: { idle: 3, walk: 6, attack: 8 },
};
const FPS: Record<PackAnim, number> = { idle: 6, walk: 12, attack: 12 };

/** Dibuja una animación de una hoja convertida desde un paquete, con píxeles nítidos. */
export function PackPlayer({
  png,
  pack,
  anim,
  side = "east",
  scale = 3,
  label,
}: {
  png: string;
  pack: PackInfo;
  anim: PackAnim;
  side?: PackSide;
  scale?: number;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    let raf = 0;
    let stopped = false;
    const frames = anim === "idle" ? pack.idle : anim === "walk" ? pack.walk : pack.attack;
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = (i: number) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      // Sombra bajo los pies, como en el escenario.
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      ctx.ellipse(pack.anchorX * scale, pack.anchorY * scale, pack.cellW * 0.28 * scale, pack.cellW * 0.08 * scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.drawImage(img, i * pack.cellW, ROW[side][anim] * pack.cellH, pack.cellW, pack.cellH, 0, 0, pack.cellW * scale, pack.cellH * scale);
    };
    img.onload = () => {
      if (stopped) return;
      if (still || frames <= 1) return draw(0);
      const t0 = performance.now();
      const tick = (t: number) => {
        const k = Math.floor(((t - t0) / 1000) * FPS[anim]);
        // El ataque se ve una vez y se queda quieto un momento antes de repetir.
        const i = anim === "attack" ? Math.min(k % (frames + 6), frames - 1) : k % frames;
        draw(i);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    img.src = png;
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [png, pack, anim, side, scale]);

  return (
    <canvas
      ref={ref}
      className="packplayer"
      width={pack.cellW * scale}
      height={pack.cellH * scale}
      role="img"
      aria-label={label ?? "Vista previa animada"}
    />
  );
}

/** Vista previa con botones para ver cada animación y hacia qué lado mira. */
export function PackStudio({ png, pack }: { png: string; pack: PackInfo }) {
  const [anim, setAnim] = useState<PackAnim>("walk");
  const [side, setSide] = useState<PackSide>("east");
  const scale = Math.max(2, Math.min(6, Math.floor(200 / pack.cellH)));
  const tabs: Array<[PackAnim, string, boolean]> = [
    ["idle", "Quieta", true],
    ["walk", "Caminar", true],
    ["attack", "Ataque", pack.attack > 0],
  ];
  return (
    <div className="packstudio">
      <div className="packstage">
        <PackPlayer png={png} pack={pack} anim={anim} side={side} scale={scale} label={`Vista previa: ${anim}`} />
      </div>
      <div className="row packtabs" role="group" aria-label="Animación a ver">
        {tabs.map(([id, text, on]) => (
          <button key={id} type="button" className={anim === id ? "" : "ghost"} aria-pressed={anim === id} disabled={!on} onClick={() => setAnim(id)}>
            {text}
          </button>
        ))}
        <button type="button" className="ghost" onClick={() => setSide(side === "east" ? "west" : "east")}>
          Mira a la {side === "east" ? "derecha →" : "← izquierda"}
        </button>
      </div>
    </div>
  );
}

/** Animación de la pet caminando hacia la derecha, ampliada con píxeles nítidos. */
export function PetPreview({ png, row = 5, label, pack }: { png: string; row?: number; label?: string; pack?: PackInfo | null }) {
  if (pack) return <PackPlayer png={png} pack={pack} anim="walk" scale={Math.max(1, Math.min(4, Math.floor(100 / pack.cellH)))} {...(label ? { label } : {})} />;
  const style = { "--sheet": `url(${png})`, "--row": row } as CSSProperties;
  return <div className="petprev" style={style} role="img" aria-label={label ?? "Vista previa animada"} />;
}

/** La hoja completa (todas las filas y cuadros) para revisarla de punta a punta. */
export function SheetView({ png, pack }: { png: string; pack?: PackInfo | null }) {
  const dims = pack
    ? { w: Math.max(pack.idle, pack.walk, pack.attack, 1) * pack.cellW * 3, h: (pack.attack > 0 ? 9 : 7) * pack.cellH * 3 }
    : { w: 1040, h: 560 };
  return (
    <div className="sheetview">
      <img src={png} width={dims.w} height={dims.h} alt="Hoja completa de la mascota" />
    </div>
  );
}
