# StreamPets

Mascotas animadas para overlays de Twitch (OBS). Este repositorio está en la **Fase 1: motor de mascotas + escenario de prueba**. Hoy incluye además backend, dashboard y lectura del chat de Twitch (ver más abajo).

## Qué hay

```
streampets/
├─ packages/engine/        Motor (TypeScript estricto, sin dependencias en runtime)
│  ├─ src/assets/          Parser del spritesheet de PixelLab y carga de especies
│  ├─ src/anim/            Animador (avanza por tiempo, no por cuadros de pantalla)
│  ├─ src/pet/             Mascota + máquina de estados (IDLE, WALK, RUN, SLEEP, JUMP, SIT)
│  ├─ src/world/           Escenario (límites, franja de profundidad) y proximidad
│  ├─ src/render/          Renderer Canvas 2D (escala entera, pixel art nítido)
│  ├─ src/engine.ts        PetEngine: bucle, mascotas, tope de FPS, redimensionado
│  └─ test/                35 tests (Vitest)
├─ apps/sandbox/           Página de prueba (Vite) con controles y comandos manuales
│  └─ public/assets/species/shiba/   PNG + JSON de PixelLab + species.json
└─ scripts/smoke.mjs       Prueba en navegador real (Chromium + Playwright)
```

## Cómo ejecutarlo

Requisitos: Node 20+ y pnpm 10 (`corepack enable` activa pnpm).

```bash
pnpm install
pnpm dev          # abre http://localhost:5173
pnpm typecheck    # TypeScript estricto en todo el repo
pnpm test         # tests del motor
pnpm build        # comprueba tipos y genera apps/sandbox/dist
```

`http://localhost:5173/?seed=7` hace el comportamiento reproducible.

### Prueba en navegador real (opcional)

Con el build servido (`pnpm --filter @streampets/sandbox exec vite preview --port 4173`) y Playwright instalado:

```bash
node scripts/smoke.mjs http://localhost:4173/?seed=7 ./smoke-out
```

Comprueba que se dibuja el canvas, que las mascotas se mueven, que los comandos funcionan, el límite de 20 mascotas, el redimensionado, el coste por cuadro y que no haya errores de consola. Guarda capturas en `./smoke-out`.

## Cómo funciona

- **Coordenadas**: el mundo se mide en píxeles de sprite. El renderer los multiplica por una escala **entera** (por defecto 3: 32 px → 96 px en pantalla), así el pixel art no se ve borroso.
- **Tiempo**: la simulación usa `dt` en segundos, con pasos de máximo 0.1 s. La distancia recorrida no depende de los FPS (hay un test que lo comprueba a 30, 144 y 240 FPS).
- **Especies por datos**: una especie es un `species.json` que apunta al PNG y al JSON exportados por PixelLab y mapea clips (`idle`, `walk`, `run`) a animaciones de la hoja. Añadir un animal no requiere tocar código.
- **Estados y prioridades**: los comandos externos usan `pet.requestState("JUMP")`. Se aceptan si el estado actual es interrumpible o el nuevo tiene mayor prioridad (el salto no se puede cortar). Las transiciones autónomas salen de una tabla de pesos configurable (`DEFAULT_BEHAVIOR.weights`).
- **Dirección**: cada mascota mira hacia donde camina usando las vistas `east`/`west` del propio spritesheet (no se espejea nada). SLEEP y SIT usan la vista `south` (de frente). Vistas obligatorias por animación: **Idle** = east, west y south; **Walk** (y Run, que reutiliza Walk) = east y west.
- **Profundidad**: cada mascota tiene una `lane` (0–10 px) y se dibujan ordenadas por ella.

## Alcance de la Fase 1 y límites conocidos

- **PLAY e INTERACT** están declarados en la máquina de estados, pero **no implementados** (los comandos los rechazan). La **detección de proximidad** sí existe (`findNearbyPairs`, visible con "Proximidad" en el sandbox), pero todavía no dispara ningún comportamiento.
- **Sleep, Sit y Jump no tienen animación propia**: el spritesheet solo trae Walk e Idle. SLEEP/SIT usan el idle de frente (SLEEP además apagado y con "Zzz"); JUMP es un arco calculado por código.
- **El idle exportado es prácticamente una imagen quieta** (South y North tienen los 8 frames idénticos). Por eso el motor añade una respiración de 1 px por código en IDLE/SIT/SLEEP.
- **Run reutiliza la animación Walk** a más velocidad y más fps.
- Las mascotas pueden **superponerse** (aún no hay comportamiento de separación) y se mezclan los nombres.
- Solo hay una especie (el perro). Todas las mascotas se ven iguales salvo por el nombre.
- Las posiciones de pies de cada frame de Walk varían 1–2 px (vaivén natural de la animación).
- No se probó en OBS ni con Twitch: solo en Chromium headless.

## Créditos y licencias

- Código: propio.
- Sprites del perro: generados con PixelLab. **Pendiente verificar los términos de licencia de PixelLab** antes de mostrarlos en un stream público.
- Si se usa el pack de Frakassets (CC BY 4.0), hay que acreditar a "Frakassets".

---

# Fase 2–3: servidor, base de datos y overlay para OBS

Cualquiera que escriba en el chat recibe una mascota automáticamente (se puede limitar a subs en los ajustes).
Las mascotas aparecen al escribir y se retiran tras un tiempo sin hablar (por defecto 5 min, máximo 20 en pantalla).

## Arrancar en local

```bash
pnpm install
pnpm build:web                               # compila overlay y dashboard
pnpm dev:server                              # http://localhost:3000 (base embebida PGlite)
```

El servidor imprime un `ADMIN_TOKEN` temporal de desarrollo.

**Dashboard:** abre `http://localhost:3000/admin`, entra con esa clave y desde ahí puedes ver a los espectadores, cambiar su mascota,
activar/desactivar, ajustar la configuración y crear el enlace del overlay (pestaña «Overlay para OBS»).
En desarrollo con recarga en caliente: `pnpm dev:dashboard` (http://localhost:5175/admin/, usa el servidor del puerto 3000).

Lo mismo por línea de comandos:

```bash
export ADMIN_TOKEN=dev-...
# 1) crear el enlace del overlay (el token solo se muestra esta vez)
curl -s -X POST localhost:3000/api/admin/overlays -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"OBS"}'
# 2) abrir http://localhost:3000<path> en el navegador y simular chat
pnpm simulate --count 10
```

En OBS: *Fuente > Navegador*, URL del overlay, ancho 1920, alto 1080, sin fondo. Parámetros opcionales:
`?scale=3` (tamaño de píxel; por defecto automático), `?fps=30`, `?names=0` (ocultar nombres).

## API de administración (`Authorization: Bearer ADMIN_TOKEN`)

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/api/admin/viewers?q=&limit=&offset=` | Listar/buscar espectadores y su mascota |
| PATCH | `/api/admin/viewers/:id/pet` | Cambiar especie (`speciesId`) o activar/desactivar (`enabled`) |
| GET/PATCH | `/api/admin/settings` | Ajustes: solo subs, ignorados, máximo, tiempo de inactividad, especie por defecto |
| GET/POST | `/api/admin/overlays` | Listar / crear enlaces de overlay |
| POST | `/api/admin/overlays/:id/rotate` | Nuevo token (el anterior deja de funcionar) |
| DELETE | `/api/admin/overlays/:id` | Revocar |
| POST | `/api/admin/dev/chat` | Chat simulado (solo con `ENABLE_DEV_CHAT`) |
| GET | `/api/species`, `/healthz` | Públicas |

Los tokens de overlay se guardan solo como hash SHA-256 y se ocultan en los logs.

## Tests

```bash
pnpm test                                                        # motor + servidor (PGlite)
TEST_DATABASE_URL=postgres://u:p@host/db pnpm --filter @streampets/server test   # contra Postgres real (vacía su esquema public)
NODE_PATH=$(npm root -g) node scripts/e2e-overlay.mjs            # navegador real: servidor + overlay + chat simulado
NODE_PATH=$(npm root -g) node scripts/e2e-dashboard.mjs          # navegador real: dashboard + overlay
```

## Despliegue en Render

1. Sube el contenido de esta carpeta a un repositorio de GitHub (`render.yaml` debe quedar en la raíz del repo).
2. En Render: *New > Blueprint*, elige el repo. Pide `STREAMER_LOGIN` (usuario de Twitch en minúsculas) y `STREAMER_DISPLAY_NAME`.
3. Al terminar el build, abre *Environment* y copia `ADMIN_TOKEN`: es la clave para entrar a `https://TU-SERVICIO.onrender.com/admin`.
4. Chat real: el Blueprint deja `TWITCH_CHAT_ENABLED=true` y lee el canal `STREAMER_LOGIN`. En *Logs* debe salir «Twitch: leyendo el chat», y `GET /api/admin/me` muestra el estado (`twitch.state` = `joined`).
5. Para ver el panel con datos de ejemplo (con `ENABLE_DEV_CHAT=true`):
   `ADMIN_TOKEN=... node apps/server/scripts/simulate-chat.mjs --url https://TU-SERVICIO.onrender.com --count 12`

Plan gratuito (según la documentación de Render): el servicio se duerme tras 15 min sin tráfico (despertar tarda ~1 min) y la base gratuita caduca a los 30 días.
Limitación del diseño: el estado de «quién está en pantalla» vive en la memoria del proceso, así que debe haber **una sola instancia**.

## Especies

Shiba, gato, pingüino, conejo, dino, dragón, honguito, momia y zorro (en `shared-public/assets/species/`). Para sumar otra: carpeta nueva con el PNG, el JSON de la hoja de PixelLab y un `species.json`, más una línea en `index.json`. El dragón usa sus diagonales (south-east/south-west) como east/west.

## Chat de Twitch

Solo lectura (IRC por WebSocket, `wss://irc-ws.chat.twitch.tv`). Nunca envía mensajes y no guarda el texto del chat, solo quién escribió, su nombre y si es sub.

| Variable | Qué hace |
|---|---|
| `TWITCH_CHAT_ENABLED` | `true` para activarlo (por defecto apagado) |
| `TWITCH_CHANNEL` | Canal a leer; si falta se usa `STREAMER_LOGIN` |
| `TWITCH_BOT_LOGIN` + `TWITCH_OAUTH_TOKEN` | Opcionales, juntos: entra con cuenta y token (`chat:read`) en vez de anónimo |

Verificado en la documentación oficial: conexión, `CAP REQ` de tags/commands, `PING/PONG`, `RECONNECT`, etiquetas `badges`/`user-id`/`display-name`, autenticación con token.
**No verificado:** el modo anónimo (`justinfan`) solo está respaldado por foros, no por la documentación; si Twitch lo rechaza, usa el modo con token. Que la insignia `founder` cuente como sub tampoco está confirmado. Tampoco se probó contra Twitch real (el entorno de desarrollo no llega a Twitch): solo contra un servidor IRC falso en los tests.
Twitch recomienda EventSub para chat nuevo; IRC sigue funcionando y no tiene fecha de retiro anunciada.

## Pendiente

- Login con Twitch para el dashboard (hoy se entra con una clave única `ADMIN_TOKEN`).
- Más especies; comprobar los términos de licencia de los sprites generados con PixelLab antes de usarlos en público.
