const base = import.meta.env.BASE_URL;

/** Logo completo recortado a su contenido: para el encabezado. */
export function Logo() {
  return <img className="logo-wide" src={`${base}logo-wide.webp`} alt="StreamPets" width={178} height={132} />;
}

/** Logo completo: para la pantalla de entrada. */
export function LogoFull() {
  return <img className="login-logo" src={`${base}logo-full.webp`} alt="StreamPets" width={320} height={237} />;
}
