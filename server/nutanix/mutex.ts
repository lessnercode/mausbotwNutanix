/**
 * Serializes every Nutanix route and lifecycle action (connect/reconnect, deploy,
 * delete, wake/power-on, idle shutdown, and Prism Central check) on one promise chain.
 * Ponytail: actions serialize behind this single mutex — fine for one shared desktop VM;
 * revisit if OpenMausBot ever manages multiple Nutanix VMs concurrently.
 */
export class NutanixMutex {
  private tail: Promise<void> = Promise.resolve();
  private held = false;

  /** Claims the next slot synchronously (before any await) and runs `work` once prior holders settle. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(async () => {
      this.held = true;
      try {
        return await work();
      } finally {
        this.held = false;
        release();
      }
    });
  }

  /** Claims a slot synchronously, rejecting with `onTimeout()` and skipping `work` if `deadline` passes before the lock is free. */
  runWithDeadline<T>(deadline: number, onTimeout: () => Error, work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    return new Promise<T>((resolve, reject) => {
      let timedOut = false;
      const waitMs = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (waitMs <= 0) {
        timedOut = true;
        reject(onTimeout());
      } else {
        timer = setTimeout(() => {
          timedOut = true;
          reject(onTimeout());
        }, waitMs);
        timer.unref?.();
      }
      void previous.then(async () => {
        clearTimeout(timer);
        if (timedOut) {
          release();
          return;
        }
        this.held = true;
        try {
          resolve(await work());
        } catch (error) {
          reject(error);
        } finally {
          this.held = false;
          release();
        }
      });
    });
  }

  get locked(): boolean {
    return this.held;
  }
}
