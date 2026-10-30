/**
 * Animador: decide qué frame mostrar en función del tiempo acumulado.
 * No sabe nada de Canvas ni de FPS de pantalla: solo avanza con dt (segundos).
 */
export class Animator {
  private time = 0;
  private frameCount = 1;
  private fps = 1;
  private loop = true;

  /** Cambia de clip y reinicia el tiempo. */
  play(frameCount: number, fps: number, loop: boolean, startAt = 0): void {
    this.frameCount = Math.max(1, Math.floor(frameCount));
    this.fps = fps > 0 ? fps : 1;
    this.loop = loop;
    this.time = Math.max(0, startAt);
  }

  update(dt: number): void {
    if (dt > 0) this.time += dt;
  }

  get frameIndex(): number {
    const raw = Math.floor(this.time * this.fps);
    return this.loop ? raw % this.frameCount : Math.min(raw, this.frameCount - 1);
  }

  get finished(): boolean {
    return !this.loop && Math.floor(this.time * this.fps) >= this.frameCount - 1;
  }

  get elapsed(): number {
    return this.time;
  }
}
