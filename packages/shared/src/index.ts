/**
 * Contratos compartidos entre servidor, overlay y (más adelante) dashboard.
 * Todo lo que cruza la red se valida con estos esquemas.
 */
import { z } from "zod";

/** Id de especie: minúsculas, números, guion y guion bajo. */
export const SpeciesIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "id de especie inválido");

export const SpeciesIndexSchema = z.object({
  species: z
    .array(
      z.object({
        id: SpeciesIdSchema,
        name: z.string().min(1).max(60),
        /** URL (relativa al servidor) del species.json de la especie. */
        url: z.string().min(1).max(300),
      }),
    )
    .min(1),
});
export type SpeciesIndex = z.infer<typeof SpeciesIndexSchema>;

/** Una mascota tal como la ve el overlay. */
export const PetViewSchema = z.object({
  viewerId: z.string().uuid(),
  name: z.string().min(1).max(40),
  speciesId: SpeciesIdSchema,
});
export type PetView = z.infer<typeof PetViewSchema>;

/** Mensajes servidor -> overlay. El overlay es de solo lectura: no envía nada. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    pets: z.array(PetViewSchema),
    maxPets: z.number().int().min(1).max(50),
  }),
  z.object({ type: z.literal("pet.appear"), pet: PetViewSchema }),
  z.object({ type: z.literal("pet.update"), pet: PetViewSchema }),
  z.object({ type: z.literal("pet.leave"), viewerId: z.string().uuid() }),
  /** Latido de aplicación: permite al overlay detectar conexiones muertas. */
  z.object({ type: z.literal("hb") }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Límites que usan servidor y dashboard. */
export const LIMITS = {
  maxPetsCap: 50,
  idleTimeoutMin: 15,
  idleTimeoutMax: 3600,
  ignoredLoginsMax: 200,
} as const;

/** Un login de Twitch: 1 a 25 caracteres alfanuméricos o guion bajo (se guarda en minúsculas). */
export const TwitchLoginSchema = z
  .string()
  .min(1)
  .max(25)
  .regex(/^[A-Za-z0-9_]+$/, "login de Twitch inválido")
  .transform((s) => s.toLowerCase());
