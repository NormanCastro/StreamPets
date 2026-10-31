import type { CSSProperties } from "react";

/** Animación de la pet caminando hacia la derecha (fila 5 de la hoja), ampliada con píxeles nítidos. */
export function PetPreview({ png, row = 5, label }: { png: string; row?: number; label?: string }) {
  const style = { "--sheet": `url(${png})`, "--row": row } as CSSProperties;
  return <div className="petprev" style={style} role="img" aria-label={label ?? "Vista previa animada"} />;
}

/** La hoja completa (todas las filas y cuadros) para revisarla de punta a punta. */
export function SheetView({ png }: { png: string }) {
  return (
    <div className="sheetview">
      <img src={png} width={1040} height={560} alt="Hoja completa de la mascota" />
    </div>
  );
}
