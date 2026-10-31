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

## Varios streamers y entrar con Twitch

El panel (`/admin`) tiene dos formas de entrar:

- **Con Twitch**: cada streamer entra con su cuenta, ve y administra **solo lo suyo** (sus mascotas, ajustes y enlaces de OBS) y se lee el chat de su canal.
- **Con la clave de administración** (`ADMIN_TOKEN`): respaldo y super-administrador. Actúa como el dueño de la instalación (`STREAMER_LOGIN`) y es la única vía que ve la pestaña **Canales**.

**Quién puede entrar:** solo los canales de la lista de la pestaña *Canales* (el del dueño ya viene dentro y no se puede quitar). Al primer ingreso el canal queda atado al **id numérico** de Twitch: si alguien más toma ese nombre después, no hereda el acceso; si la persona cambia de nombre, sigue entrando. Al quitar un canal se cierran sus sesiones y se deja de leer su chat (los enlaces de OBS que ya creó siguen funcionando hasta que los elimine el administrador).

**Configurarlo (una vez):**

1. En https://dev.twitch.tv/console → *Register Your Application* (la cuenta necesita verificación en 2 pasos). Nombre libre, categoría *Website Integration*, tipo de cliente *Confidential*.
2. *OAuth Redirect URL*: `https://TU-DOMINIO/auth/twitch/callback` (exacta, con https).
3. Copia el *Client ID* y genera un *Client Secret*.
4. En Render → Environment: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` y `PUBLIC_URL=https://TU-DOMINIO`. Los tres juntos.
5. En el panel (con la clave) → *Canales* → escribe el usuario de Twitch de cada invitado.

**Seguridad:** solo se pide el permiso `openid` (identificar a la persona; sin correo ni acceso a su cuenta) y los tokens de Twitch se descartan al instante. El `id_token` se verifica (firma RS256, emisor, audiencia, vencimiento y nonce) y el flujo lleva `state` de un solo uso. La sesión es una cookie `HttpOnly`, `Secure`, `SameSite=Lax` (con prefijo `__Host-`); en la base solo se guarda el hash. Los cambios hechos con cookie exigen una cabecera propia y un `Origin` válido (anti‑CSRF). Duración: `SESSION_TTL_DAYS` (14 por defecto).

```bash
node scripts/e2e-login.mjs   # login completo en Chromium contra un Twitch de mentira local
```

## Clave personal de respaldo

Si a alguien no le funciona el login con Twitch, el administrador puede darle una **clave personal** de su canal: pestaña **Canales** → *Generar clave*. Se muestra una sola vez (en la base solo queda su huella), y quien la tiene entra con **Entrar con clave** a la pantalla de acceso. Da acceso solo al panel de **ese** canal, nunca a *Canales*.

- *Regenerar* o *Revocar* anula la clave anterior y cierra las sesiones abiertas del canal. Quitar el canal de la lista también la anula.
- El campo «Clave de acceso» sirve también para la clave de administración (`ADMIN_TOKEN`): primero se prueba como clave de un canal y, si no lo es, como administración.
- Hay límite de intentos (10 por minuto) y la clave tiene 256 bits aleatorios.
- Es una clave tipo contraseña: enviarla por un medio privado y regenerarla si se filtra.

## Especies: generales, exclusivas, gratis y premium

Cada especie en `shared-public/assets/species/index.json` puede llevar dos datos (si faltan, valen `general` y `free`):

```json
{ "id": "dragon", "name": "Dragón", "url": "...", "scope": "general", "tier": "premium" }
```

- `scope`: `general` (cualquier canal) o `exclusive` (solo los canales que el administrador elija).
- `tier`: `free` (todos) o `premium` (solo canales con plan premium).
- Una especie `exclusive` y `premium` a la vez exige las dos cosas: estar listada para ese canal **y** tener plan premium.

El plan y las especies exclusivas se manejan en la pestaña **Canales** (solo con la clave de administración), también para canales que todavía no han entrado. El canal del dueño lo puede usar todo.

Lo aplica el **servidor**, no solo el panel: las mascotas nuevas se eligen solo entre las especies del canal, y elegir una bloqueada devuelve 403. Si un canal pierde una especie (le quitas el premium o el permiso), sus espectadores que la usaban pasan a otra especie permitida al instante. El overlay puede cargar cualquier sprite (los archivos son públicos): lo que se controla es quién puede *asignarla*.

## Mascotas propias de cada canal

Los canales con plan **premium** pueden subir hasta **3 mascotas propias** desde la pestaña «Mis pets» (el plan gratis no puede subir ninguna).

- Cada mascota es un único PNG de **520×280** (celdas de 40×40, 13 columnas × 7 filas, sin entrelazado, hasta 120 KB). El panel trae la guía de filas y una plantilla descargable (`/admin/plantilla-pet.png`).
  Fila 0: 8 rotaciones (south, south-east, east, north-east, north, north-west, west, south-west). Filas 1-3: idle south/east/west (8 cuadros). Filas 4-6: walk south/east/west (13 cuadros). Los pies van en x=20, y=34 de cada celda.
- Al subirla queda **en revisión** y no se ve en ningún stream. En la pestaña **Moderación** (la clave de administración, o el dueño de la instalación entrando con Twitch) se ve la hoja completa y la animación, y se puede **aprobar, rechazar (con motivo) o eliminar**.
- Una pet aprobada es exclusiva del canal que la subió (ni siquiera el dueño de la instalación la puede usar). Al rechazarla o eliminarla, quienes la tenían pasan a otra especie.
- El servidor valida el PNG (firma, medidas, CRC de cada bloque) y guarda una copia limpia, sin metadatos. Las imágenes se guardan en la base de datos (el disco de Render gratis se borra en cada reinicio) y solo las aprobadas se sirven, en `/api/custom-species/<id>/…`.
- Los cupos por plan están en `CUSTOM_PET.quota` (`packages/shared/src/index.ts`).

## Catálogo del administrador

La pestaña **Catálogo** (clave de administración, o el dueño entrando con Twitch) lista todas las mascotas separadas en Gratis, Premium y Exclusivas, de la más usada a la menos usada, con en cuántos canales y cuántas mascotas hay de cada una. Cada especie tiene un interruptor: al **desactivarla** deja de estar disponible para todos los canales (incluido el dueño), quienes la tenían pasan a otra especie al instante y nadie nuevo la recibe. El estado se guarda en la base de datos (`species_disabled`) y se mantiene al reiniciar.

## Pendiente

- Probar el login contra el Twitch real (en pruebas se usa un Twitch simulado); cambiar la clave `ADMIN_TOKEN` compartida cuando ya no haga falta.
- Más especies; comprobar los términos de licencia de los sprites generados con PixelLab antes de usarlos en público.
