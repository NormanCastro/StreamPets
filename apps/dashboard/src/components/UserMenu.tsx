import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Me } from "../api";
import { THEMES, applyTheme, loadTheme, saveTheme } from "../theme";
import type { ThemeId } from "../theme";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Foto de perfil; si no hay (o no carga) se muestra la inicial en un círculo. */
function Avatar({ url, name }: { url?: string | null | undefined; name: string }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    return <img className="avatar" src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  }
  return (
    <span className="avatar initial" aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** Botón de menú (sándwich): perfil, color del panel y salir. */
export function UserMenu({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const isAdmin = me.role === "admin";
  const name = isAdmin ? "Admin" : capitalize(me.streamer?.login ?? "");
  const premium = me.role === "streamer" && me.plan === "premium";

  function pick(id: ThemeId) {
    setTheme(id);
    applyTheme(id);
    saveTheme(id);
  }

  return (
    <div className="usermenu" ref={box}>
      <button
        type="button"
        className="burger"
        aria-label="Menú de usuario"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span />
        <span />
        <span />
      </button>
      {open && (
        <div className="menu-pop" role="menu" aria-label="Menú de usuario">
          <div className="menu-profile">
            <Avatar url={isAdmin ? null : me.streamer?.avatarUrl} name={name} />
            <div className="menu-name">
              <strong>
                {name}
                {premium && (
                  <span className="star" role="img" aria-label="Plan premium" title="Plan premium">
                    ⭐
                  </span>
                )}
              </strong>
              <span className="muted">{isAdmin ? "Administración" : premium ? "Plan premium" : "Plan gratis"}</span>
            </div>
          </div>
          {me.role === "streamer" && (
            <div className="menu-section">
              <span className="muted">Color del panel</span>
              <div className="menu-swatches" role="group" aria-label="Color del panel">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="swatch"
                    style={{ "--sw": t.color } as CSSProperties}
                    aria-label={`Color ${t.label.toLowerCase()}`}
                    title={t.label}
                    aria-pressed={theme === t.id}
                    onClick={() => pick(t.id)}
                  />
                ))}
              </div>
            </div>
          )}
          <button type="button" role="menuitem" className="ghost menu-logout" onClick={onLogout}>
            Salir
          </button>
        </div>
      )}
    </div>
  );
}
