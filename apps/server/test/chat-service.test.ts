import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as repo from "../src/db/repo.js";
import { pets, viewers } from "../src/db/schema.js";
import { sanitizeName } from "../src/domain/chat-service.js";
import { chat, makeHarness } from "./helpers.js";
import type { Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.handle.close();
});

async function dbCounts(streamerId: string): Promise<{ viewers: number; pets: number }> {
  const v = await h.handle.db.select().from(viewers).where(eq(viewers.streamerId, streamerId));
  const p = await h.handle.db.select().from(pets).where(eq(pets.streamerId, streamerId));
  return { viewers: v.length, pets: p.length };
}

describe("alguien nuevo escribe", () => {
  it("se registra, recibe mascota, aparece en pantalla y queda guardado", async () => {
    const res = await h.service.handleMessage(chat(h.streamerId, "luna"));
    expect(res.outcome).toBe("spawned");
    expect(h.broadcaster.types()).toEqual(["pet.appear"]);

    const snap = await h.service.snapshot(h.streamerId);
    expect(snap.pets).toHaveLength(1);
    expect(snap.pets[0]?.name).toBe("luna");
    expect(h.catalog.has(snap.pets[0]?.speciesId ?? "")).toBe(true);
    expect(await dbCounts(h.streamerId)).toEqual({ viewers: 1, pets: 1 });
  });

  it("un segundo mensaje NO crea otra mascota ni vuelve a avisar", async () => {
    await h.service.handleMessage(chat(h.streamerId, "luna"));
    const again = await h.service.handleMessage(chat(h.streamerId, "luna"));
    expect(again.outcome).toBe("seen");
    expect(h.broadcaster.types()).toEqual(["pet.appear"]);
    expect(await dbCounts(h.streamerId)).toEqual({ viewers: 1, pets: 1 });
  });

  it("varios mensajes simultáneos de alguien nuevo crean una sola mascota", async () => {
    await Promise.all(Array.from({ length: 8 }, () => h.service.handleMessage(chat(h.streamerId, "kiko"))));
    expect(await dbCounts(h.streamerId)).toEqual({ viewers: 1, pets: 1 });
    expect(h.broadcaster.types()).toEqual(["pet.appear"]);
    expect(await h.service.activeCount(h.streamerId)).toBe(1);
  });

  it("al volver tras reiniciar el servidor conserva la misma especie", async () => {
    await h.service.handleMessage(chat(h.streamerId, "mochi"));
    const before = (await h.service.snapshot(h.streamerId)).pets[0];

    const restarted = h.newService();
    const res = await restarted.handleMessage(chat(h.streamerId, "mochi"));
    expect(res.outcome).toBe("seen");
    expect((await restarted.snapshot(h.streamerId)).pets[0]?.speciesId).toBe(before?.speciesId);
    expect(await dbCounts(h.streamerId)).toEqual({ viewers: 1, pets: 1 });
  });

  it("usa la especie por defecto de los ajustes si existe", async () => {
    await repo.updateSettings(h.handle.db, h.streamerId, { defaultSpeciesId: "bunny" });
    const service = h.newService();
    for (const name of ["a1", "a2", "a3", "a4"]) await service.handleMessage(chat(h.streamerId, name));
    const species = (await service.snapshot(h.streamerId)).pets.map((p) => p.speciesId);
    expect(species).toEqual(["bunny", "bunny", "bunny", "bunny"]);
  });

  it("sin especie por defecto reparte al azar entre las disponibles", async () => {
    for (let i = 0; i < 60; i++) await h.service.handleMessage(chat(h.streamerId, `user${i}`));
    h.broadcaster.clear();
    const used = new Set((await h.service.snapshot(h.streamerId)).pets.map((p) => p.speciesId));
    expect(used.size).toBeGreaterThan(1);
    for (const id of used) expect(h.catalog.has(id)).toBe(true);
  });
});

describe("a quién NO se le asigna mascota", () => {
  it("bots de la lista de ignorados (sin distinguir mayúsculas)", async () => {
    const res = await h.service.handleMessage(chat(h.streamerId, "Nightbot"));
    expect(res).toEqual({ outcome: "ignored", reason: "ignored-list" });
    expect(await dbCounts(h.streamerId)).toEqual({ viewers: 0, pets: 0 });
    expect(h.broadcaster.events).toHaveLength(0);
  });

  it("la propia streamer (por defecto)", async () => {
    const res = await h.service.handleMessage(chat(h.streamerId, "STREAMER"));
    expect(res).toEqual({ outcome: "ignored", reason: "streamer" });
  });

  it("la streamer sí recibe mascota si desactiva ignoreStreamer", async () => {
    await repo.updateSettings(h.handle.db, h.streamerId, { ignoreStreamer: false });
    const service = h.newService();
    expect((await service.handleMessage(chat(h.streamerId, "streamer"))).outcome).toBe("spawned");
  });

  it("no-subs cuando subsOnly está activo", async () => {
    await repo.updateSettings(h.handle.db, h.streamerId, { subsOnly: true });
    const service = h.newService();
    expect(await service.handleMessage(chat(h.streamerId, "pepa"))).toEqual({ outcome: "ignored", reason: "subs-only" });
    expect((await service.handleMessage(chat(h.streamerId, "sub1", { isSubscriber: true }))).outcome).toBe("spawned");
  });

  it("refreshSettings retira de pantalla a quien pasa a la lista de ignorados", async () => {
    await h.service.handleMessage(chat(h.streamerId, "molesto"));
    h.broadcaster.clear();
    const row = await repo.getSettings(h.handle.db, h.streamerId);
    await repo.updateSettings(h.handle.db, h.streamerId, { ignoredLogins: [...row.ignoredLogins, "molesto"] });
    await h.service.refreshSettings(h.streamerId);
    expect(h.broadcaster.types()).toEqual(["pet.leave"]);
    expect(await h.service.activeCount(h.streamerId)).toBe(0);
  });
});

describe("permanencia en pantalla", () => {
  it("se retira tras el tiempo de inactividad y vuelve (con la misma especie) al escribir", async () => {
    await repo.updateSettings(h.handle.db, h.streamerId, { idleTimeoutSec: 60 });
    const service = h.newService();
    await service.handleMessage(chat(h.streamerId, "luna"));
    const species = (await service.snapshot(h.streamerId)).pets[0]?.speciesId;
    h.broadcaster.clear();

    h.clock.advance(59_000);
    expect(await service.sweep()).toBe(0);
    h.clock.advance(2_000);
    expect(await service.sweep()).toBe(1);
    expect(h.broadcaster.types()).toEqual(["pet.leave"]);
    expect(await service.activeCount(h.streamerId)).toBe(0);

    await service.handleMessage(chat(h.streamerId, "luna"));
    expect(h.broadcaster.types()).toEqual(["pet.leave", "pet.appear"]);
    expect((await service.snapshot(h.streamerId)).pets[0]?.speciesId).toBe(species);
    expect(await dbCounts(h.streamerId)).toEqual({ viewers: 1, pets: 1 });
  });

  it("hablar renueva el plazo de inactividad", async () => {
    await repo.updateSettings(h.handle.db, h.streamerId, { idleTimeoutSec: 60 });
    const service = h.newService();
    await service.handleMessage(chat(h.streamerId, "luna"));
    h.clock.advance(50_000);
    await service.handleMessage(chat(h.streamerId, "luna"));
    h.clock.advance(50_000);
    expect(await service.sweep()).toBe(0);
  });

  it("respeta el máximo de mascotas retirando a quien lleva más sin hablar", async () => {
    await repo.updateSettings(h.handle.db, h.streamerId, { maxPets: 3 });
    const service = h.newService();
    const logins = ["u1", "u2", "u3", "u4", "u5"];
    for (const login of logins) {
      await service.handleMessage(chat(h.streamerId, login));
      h.clock.advance(1_000);
    }
    expect(await service.activeCount(h.streamerId)).toBe(3);
    const names = (await service.snapshot(h.streamerId)).pets.map((p) => p.name);
    expect(names).toEqual(["u3", "u4", "u5"]);
    expect(h.broadcaster.types().filter((t) => t === "pet.leave")).toHaveLength(2);
    // Los expulsados siguen registrados con su mascota: solo se quitan de pantalla.
    expect(await dbCounts(h.streamerId)).toEqual({ viewers: 5, pets: 5 });
  });

  it("al bajar maxPets desde el dashboard se recorta lo que sobra", async () => {
    for (const login of ["a", "b", "c", "d"]) {
      await h.service.handleMessage(chat(h.streamerId, login));
      h.clock.advance(1_000);
    }
    await repo.updateSettings(h.handle.db, h.streamerId, { maxPets: 2 });
    await h.service.refreshSettings(h.streamerId);
    expect((await h.service.snapshot(h.streamerId)).pets.map((p) => p.name)).toEqual(["c", "d"]);
  });
});

describe("cambios hechos desde el dashboard", () => {
  it("cambiar la especie de alguien en pantalla emite pet.update", async () => {
    await h.service.handleMessage(chat(h.streamerId, "luna"));
    const viewerId = (await h.service.snapshot(h.streamerId)).pets[0]?.viewerId ?? "";
    h.broadcaster.clear();

    await repo.updatePet(h.handle.db, h.streamerId, viewerId, { speciesId: "bunny" });
    await h.service.applyPetChange(h.streamerId, viewerId);
    expect(h.broadcaster.events.map((e) => e.message)).toEqual([
      { type: "pet.update", pet: { viewerId, name: "luna", speciesId: "bunny" } },
    ]);
  });

  it("desactivar la mascota la retira y no reaparece al escribir", async () => {
    await h.service.handleMessage(chat(h.streamerId, "luna"));
    const viewerId = (await h.service.snapshot(h.streamerId)).pets[0]?.viewerId ?? "";
    h.broadcaster.clear();

    await repo.updatePet(h.handle.db, h.streamerId, viewerId, { enabled: false });
    await h.service.applyPetChange(h.streamerId, viewerId);
    expect(h.broadcaster.types()).toEqual(["pet.leave"]);

    const res = await h.service.handleMessage(chat(h.streamerId, "luna"));
    expect(res.outcome).toBe("disabled");
    expect(h.broadcaster.types()).toEqual(["pet.leave"]);
    expect(await h.service.activeCount(h.streamerId)).toBe(0);
  });

  it("reactivarla estando conectada la hace aparecer", async () => {
    await h.service.handleMessage(chat(h.streamerId, "luna"));
    const viewerId = (await h.service.snapshot(h.streamerId)).pets[0]?.viewerId ?? "";
    await repo.updatePet(h.handle.db, h.streamerId, viewerId, { enabled: false });
    await h.service.applyPetChange(h.streamerId, viewerId);
    await repo.updatePet(h.handle.db, h.streamerId, viewerId, { enabled: true });
    await h.service.applyPetChange(h.streamerId, viewerId);
    await h.service.handleMessage(chat(h.streamerId, "luna"));
    expect(await h.service.activeCount(h.streamerId)).toBe(1);
  });

  it("si cambia su nombre en Twitch, el overlay y la base se actualizan", async () => {
    await h.service.handleMessage(chat(h.streamerId, "luna", { twitchUserId: "42", displayName: "Luna" }));
    h.broadcaster.clear();
    await h.service.handleMessage(chat(h.streamerId, "luna_nueva", { twitchUserId: "42", displayName: "LunaNueva" }));
    expect(h.broadcaster.types()).toEqual(["pet.update"]);
    const row = await repo.findViewerByTwitchId(h.handle.db, h.streamerId, "42");
    expect(row?.viewer.displayName).toBe("LunaNueva");
    expect(row?.viewer.login).toBe("luna_nueva");
    expect(await dbCounts(h.streamerId)).toEqual({ viewers: 1, pets: 1 });
  });

  it("una especie borrada del catálogo se muestra con la de reserva", async () => {
    await h.service.handleMessage(chat(h.streamerId, "luna"));
    const viewerId = (await h.service.snapshot(h.streamerId)).pets[0]?.viewerId ?? "";
    await repo.updatePet(h.handle.db, h.streamerId, viewerId, { speciesId: "dragon" });
    await h.service.applyPetChange(h.streamerId, viewerId);
    expect((await h.service.snapshot(h.streamerId)).pets[0]?.speciesId).toBe(h.catalog.fallbackId());
  });
});

describe("actividad y persistencia", () => {
  it("flush guarda el número de mensajes y la última vez visto", async () => {
    for (let i = 0; i < 5; i++) await h.service.handleMessage(chat(h.streamerId, "luna", { twitchUserId: "42" }));
    await h.service.flush();
    const row = await repo.findViewerByTwitchId(h.handle.db, h.streamerId, "42");
    expect(row?.viewer.messageCount).toBe(5);
    expect(row?.viewer.lastSeenAt.getTime()).toBe(h.clock.now());

    // Un segundo volcado sin mensajes nuevos no suma nada.
    await h.service.flush();
    const again = await repo.findViewerByTwitchId(h.handle.db, h.streamerId, "42");
    expect(again?.viewer.messageCount).toBe(5);
  });
});

describe("aislamiento entre streamers", () => {
  it("el mismo espectador en dos canales tiene dos registros y dos mascotas independientes", async () => {
    const other = await repo.ensureStreamer(h.handle.db, { login: "otra", displayName: "Otra" });
    await h.service.handleMessage(chat(h.streamerId, "luna", { twitchUserId: "42" }));
    await h.service.handleMessage(chat(other.id, "luna", { twitchUserId: "42" }));

    expect(await dbCounts(h.streamerId)).toEqual({ viewers: 1, pets: 1 });
    expect(await dbCounts(other.id)).toEqual({ viewers: 1, pets: 1 });

    const a = (await h.service.snapshot(h.streamerId)).pets[0];
    const b = (await h.service.snapshot(other.id)).pets[0];
    expect(a?.viewerId).not.toBe(b?.viewerId);

    // Los eventos de un canal no se mezclan con los del otro.
    expect(h.broadcaster.types(h.streamerId)).toEqual(["pet.appear"]);
    expect(h.broadcaster.types(other.id)).toEqual(["pet.appear"]);
  });

  it("no se puede cambiar la mascota de un espectador de otro streamer", async () => {
    const other = await repo.ensureStreamer(h.handle.db, { login: "otra", displayName: "Otra" });
    await h.service.handleMessage(chat(h.streamerId, "luna"));
    const viewerId = (await h.service.snapshot(h.streamerId)).pets[0]?.viewerId ?? "";

    const res = await repo.updatePet(h.handle.db, other.id, viewerId, { speciesId: "cat" });
    expect(res).toBeUndefined();
    expect(await repo.getViewerWithPet(h.handle.db, other.id, viewerId)).toBeUndefined();
  });

  it("la base impide que una mascota apunte a un espectador de otro streamer", async () => {
    const other = await repo.ensureStreamer(h.handle.db, { login: "otra", displayName: "Otra" });
    await h.service.handleMessage(chat(h.streamerId, "luna"));
    const viewerId = (await h.service.snapshot(h.streamerId)).pets[0]?.viewerId ?? "";
    await expect(
      h.handle.db.insert(pets).values({ streamerId: other.id, viewerId, speciesId: "cat" }),
    ).rejects.toThrow();
    // y la original sigue intacta
    const still = await h.handle.db.select().from(pets).where(and(eq(pets.viewerId, viewerId)));
    expect(still).toHaveLength(1);
  });
});

describe("sanitizeName", () => {
  it("quita caracteres de control y de formato invisibles", () => {
    expect(sanitizeName("Lu\u0000na​‮", "luna")).toBe("Luna");
  });
  it("recorta a 40 caracteres reales sin partir emojis", () => {
    const name = sanitizeName("🐶".repeat(60), "x");
    expect(Array.from(name)).toHaveLength(40);
    expect(name).toBe("🐶".repeat(40));
  });
  it("usa el login si el nombre queda vacío", () => {
    expect(sanitizeName("​​", "luna")).toBe("luna");
    expect(sanitizeName("   ", "luna")).toBe("luna");
  });
});
