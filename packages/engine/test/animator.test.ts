import { describe, expect, it } from "vitest";
import { Animator } from "../src/anim/animator.js";

describe("Animator", () => {
  it("avanza por frames según fps y vuelve al inicio en bucle", () => {
    const a = new Animator();
    a.play(4, 10, true);
    expect(a.frameIndex).toBe(0);
    a.update(0.1);
    expect(a.frameIndex).toBe(1);
    a.update(0.3);
    expect(a.frameIndex).toBe(0); // 0.4 s * 10 fps = frame 4 -> 4 % 4
  });

  it("sin bucle se queda en el último frame y marca finished", () => {
    const a = new Animator();
    a.play(3, 10, false);
    a.update(5);
    expect(a.frameIndex).toBe(2);
    expect(a.finished).toBe(true);
  });

  it("el frame depende solo del tiempo acumulado, no de cuántos pasos se usaron", () => {
    const coarse = new Animator();
    const fine = new Animator();
    coarse.play(8, 10, true);
    fine.play(8, 10, true);
    for (let i = 0; i < 20; i++) coarse.update(0.05);
    for (let i = 0; i < 200; i++) fine.update(0.005);
    expect(fine.frameIndex).toBe(coarse.frameIndex);
  });

  it("ignora dt negativo o cero y respeta el desfase inicial", () => {
    const a = new Animator();
    a.play(4, 10, true, 0.25);
    expect(a.frameIndex).toBe(2);
    a.update(-1);
    a.update(0);
    expect(a.frameIndex).toBe(2);
  });
});
